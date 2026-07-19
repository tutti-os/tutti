package agentruntime

import (
	"log/slog"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// codexThreadTokenTotal is one thread's latest cumulative
// ThreadTokenUsage.total split (output includes reasoning); a turn's token
// baseline snapshots its own thread's value at turn/started.
type codexThreadTokenTotal struct {
	input  int64
	output int64
}

// codexTurnTokenUsage tracks one turn's token counters as a diff against the
// thread-cumulative ThreadTokenUsage.total snapshot taken at turn/started.
// codex replays cumulative thread totals on resume, so a total below the
// recorded baseline means the baseline is stale: reset it down to the
// observed total and clamp the diff at zero rather than reporting negative
// tokens.
type codexTurnTokenUsage struct {
	baselineInput  int64
	baselineOutput int64
	inputTokens    int64
	outputTokens   int64
	lastFlushAt    time.Time
}

func (c *codexTurnTokenUsage) snapshotBaseline(inputTokens int64, outputTokens int64) {
	if c == nil {
		return
	}
	c.baselineInput = inputTokens
	c.baselineOutput = outputTokens
}

func (c *codexTurnTokenUsage) applyTotal(inputTokens int64, outputTokens int64) {
	if c == nil {
		return
	}
	if inputTokens < c.baselineInput {
		c.baselineInput = inputTokens
	}
	if outputTokens < c.baselineOutput {
		c.baselineOutput = outputTokens
	}
	c.inputTokens = inputTokens - c.baselineInput
	c.outputTokens = outputTokens - c.baselineOutput
}

// ensureCodexTurnTokenUsageLocked returns the turn's token counter, creating
// it on first use. Caller must hold the adapter mutex.
func (appSession *codexAppServerSession) ensureCodexTurnTokenUsageLocked(turnID string) *codexTurnTokenUsage {
	if appSession.turnTokenUsage == nil {
		appSession.turnTokenUsage = make(map[string]*codexTurnTokenUsage)
	}
	if counter := appSession.turnTokenUsage[turnID]; counter != nil {
		return counter
	}
	counter := &codexTurnTokenUsage{}
	appSession.turnTokenUsage[turnID] = counter
	return counter
}

// snapshotCodexTurnTokenBaseline records the current thread-cumulative totals
// as the turn's diff baseline at turn/started; with no total seen yet for the
// turn's thread the baseline is zero. Totals are keyed by thread: codex
// reports ThreadTokenUsage per thread, and subagent child threads share this
// session, so a shared slot would mix unrelated cumulative counters.
func (a *CodexAppServerAdapter) snapshotCodexTurnTokenBaseline(agentSessionID string, turnID string, threadID string) {
	turnID = strings.TrimSpace(turnID)
	if a == nil || turnID == "" {
		return
	}
	threadID = strings.TrimSpace(threadID)
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return
	}
	total := appSession.threadTokenTotals[threadID]
	appSession.ensureCodexTurnTokenUsageLocked(turnID).snapshotBaseline(total.input, total.output)
}

func (a *CodexAppServerAdapter) applyTokenUsage(agentSessionID string, turnID string, params map[string]any) (int64, int64, bool) {
	usage, usageOK := appServerTokenUsageState(params)
	totalInput, totalOutput, totalOK := appServerThreadTokenTotal(params)
	threadID := strings.TrimSpace(asString(params["threadId"]))
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return 0, 0, false
	}
	if usageOK {
		appSession.usage = mergeACPUsageState(appSession.usage, usage)
	}
	if !totalOK {
		return 0, 0, false
	}
	if appSession.threadTokenTotals == nil {
		appSession.threadTokenTotals = make(map[string]codexThreadTokenTotal)
	}
	appSession.threadTokenTotals[threadID] = codexThreadTokenTotal{input: totalInput, output: totalOutput}
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		return 0, 0, false
	}
	counter, tracked := appSession.turnTokenUsage[turnID]
	if !tracked {
		// turn/started never produced a baseline for this turn (for example a
		// notification buffered behind goal-turn adoption): treat the first
		// observed total as the baseline so earlier turns on the same thread
		// are not double counted.
		counter = appSession.ensureCodexTurnTokenUsageLocked(turnID)
		counter.snapshotBaseline(totalInput, totalOutput)
	}
	counter.applyTotal(totalInput, totalOutput)
	now := time.Now()
	if now.Sub(counter.lastFlushAt) < tokenUsageFlushInterval {
		return 0, 0, false
	}
	counter.lastFlushAt = now
	return counter.inputTokens, counter.outputTokens, true
}

// takeCodexTurnTokenUsageFinal removes the turn's counter and reports its
// final cumulative values. A settled turn rejects later transitions, so the
// caller must emit this flush before the turn's completing events.
func (a *CodexAppServerAdapter) takeCodexTurnTokenUsageFinal(agentSessionID string, turnID string) (int64, int64, bool) {
	turnID = strings.TrimSpace(turnID)
	if a == nil || turnID == "" {
		return 0, 0, false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return 0, 0, false
	}
	counter := appSession.turnTokenUsage[turnID]
	if counter == nil {
		return 0, 0, false
	}
	delete(appSession.turnTokenUsage, turnID)
	return counter.inputTokens, counter.outputTokens, true
}

// appServerThreadTokenTotal extracts the thread-cumulative totals used for
// per-turn diffs: total.inputTokens, and total.outputTokens +
// total.reasoningOutputTokens (reasoning is model output the turn paid for).
func appServerThreadTokenTotal(params map[string]any) (int64, int64, bool) {
	total := payloadObject(payloadObject(params["tokenUsage"])["total"])
	if len(total) == 0 {
		return 0, 0, false
	}
	input, inputOK := firstInt64Value(total, "inputTokens")
	output, outputOK := firstInt64Value(total, "outputTokens")
	reasoning, _ := firstInt64Value(total, "reasoningOutputTokens")
	if !inputOK && !outputOK {
		return 0, 0, false
	}
	if input < 0 {
		input = 0
	}
	if output += reasoning; output < 0 {
		output = 0
	}
	return input, output, true
}

// appServerTokenUsageState parses a thread/tokenUsage/updated payload into the
// context-window portion of acpUsageState. It is shared between the live
// notification path (applyTokenUsage) and the resume handshake, where codex
// replays token usage before the session is stored.
//
// ThreadTokenUsage schema: "last" = most-recent API call breakdown, "total" =
// cumulative thread totals. Use last.inputTokens (context fill sent to the
// model) as the most accurate indicator of how full the window is. Fall back to
// last.totalTokens (includes response tokens — slightly high but still
// per-request), then total.totalTokens only when "last" is absent entirely.
// Using total.totalTokens as primary causes a false compact alert: after 10
// calls of 27 K tokens each the cumulative reaches 270 K and exceeds the 258 K
// per-request window even though each call individually used only ~10 %.
//
// A non-positive last.inputTokens also triggers the fallback chain: the
// post-compaction frame reports last.inputTokens=0 while last.totalTokens holds
// the real compacted context size. Treating that literal 0 as the context fill
// would display "0" right after a compaction instead of the compacted size.
func appServerTokenUsageState(params map[string]any) (acpUsageState, bool) {
	tokenUsage := payloadObject(params["tokenUsage"])
	if len(tokenUsage) == 0 {
		return acpUsageState{}, false
	}
	last := payloadObject(tokenUsage["last"])
	used, usedOK := firstInt64Value(last, "inputTokens")
	if !usedOK || used <= 0 {
		used, usedOK = firstInt64Value(last, "totalTokens")
	}
	if !usedOK || used <= 0 {
		used, usedOK = firstInt64Value(payloadObject(tokenUsage["total"]), "totalTokens")
	}
	window, windowOK := firstInt64Value(tokenUsage, "modelContextWindow")
	if !usedOK || !windowOK {
		return acpUsageState{}, false
	}
	return acpUsageState{
		contextUsedTokens:   used,
		contextWindowTokens: window,
		contextKnown:        true,
	}, true
}

func (a *CodexAppServerAdapter) applyRateLimits(agentSessionID string, snapshot map[string]any) bool {
	if len(snapshot) == 0 {
		return false
	}
	quotas := appServerRateLimitQuotas(snapshot)
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return false
	}
	appSession.rateLimits = clonePayload(snapshot)
	appSession.startupRateLimitsReady = true
	if len(quotas) > 0 {
		appSession.usage = mergeACPUsageState(appSession.usage, acpUsageState{quotas: quotas})
	}
	return true
}

func (a *CodexAppServerAdapter) applyAccountUpdate(agentSessionID string, params map[string]any) {
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return
	}
	if appSession.account == nil {
		appSession.account = map[string]any{}
	}
	if authMode := asString(params["authMode"]); authMode != "" {
		appSession.account["authMode"] = authMode
	}
	if planType := asString(params["planType"]); planType != "" {
		appSession.account["planType"] = planType
	}
}

// applyGoalUpdate stores the latest goal snapshot and reports the status
// transition so callers can emit user-visible notices when the goal stops
// progressing (paused/blocked/usageLimited/budgetLimited).
func (a *CodexAppServerAdapter) applyGoalUpdate(agentSessionID string, goal map[string]any) (oldStatus, newStatus string, statusChanged bool) {
	goal = normalizedCodexGoal(goal)
	if len(goal) == 0 {
		return "", "", false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return "", "", false
	}
	oldStatus = strings.TrimSpace(asString(appSession.goal["status"]))
	appSession.goal = clonePayload(goal)
	newStatus = strings.TrimSpace(asString(appSession.goal["status"]))
	if newStatus != "active" {
		appSession.goalContinuationClaim = nil
	}
	if oldStatus != newStatus {
		slog.Info("agent session app-server goal status changed",
			"event", "agent_session.app_server.goal.status_changed",
			"agent_session_id", agentSessionID,
			"old_status", oldStatus,
			"new_status", newStatus,
		)
	}
	return oldStatus, newStatus, oldStatus != newStatus
}

func (a *CodexAppServerAdapter) applyGoalClear(agentSessionID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return
	}
	if appSession.goal != nil {
		slog.Info("agent session app-server goal cleared",
			"event", "agent_session.app_server.goal.cleared",
			"agent_session_id", agentSessionID,
			"old_status", strings.TrimSpace(asString(appSession.goal["status"])),
		)
	}
	appSession.goal = nil
	appSession.goalContinuationClaim = nil
}

func appServerRateLimitQuotas(snapshot map[string]any) []map[string]any {
	quotas := make([]map[string]any, 0, 2)
	for _, window := range []struct {
		key       string
		quotaType string
	}{
		{key: "primary", quotaType: "session"},
		{key: "secondary", quotaType: "weekly"},
	} {
		entry := payloadObject(snapshot[window.key])
		if len(entry) == 0 {
			continue
		}
		usedPercent, ok := acpFloatValue(entry["usedPercent"])
		if !ok {
			continue
		}
		if usedPercent < 0 {
			usedPercent = 0
		}
		if usedPercent > 100 {
			usedPercent = 100
		}
		quota := map[string]any{
			"quotaType":        appServerRateLimitQuotaType(entry, window.quotaType),
			"percentRemaining": 100 - usedPercent,
		}
		if resetsAt, ok := int64Value(entry["resetsAt"]); ok && resetsAt > 0 {
			if resetsAt < 1_000_000_000_000 {
				resetsAt *= 1000
			}
			quota["resetsAtUnixMs"] = resetsAt
		}
		quotas = append(quotas, quota)
	}
	if len(quotas) == 0 {
		return nil
	}
	return quotas
}

// Keep duration semantics aligned with codexUsageQuotaType in
// apps/desktop/src/main/agentProviderUsageProbe.ts. Active sessions use this
// daemon mapper; empty-session /status uses the desktop probe.
func appServerRateLimitQuotaType(entry map[string]any, fallback string) string {
	durationMins, ok := int64Value(entry["windowDurationMins"])
	if !ok {
		return fallback
	}
	switch durationMins {
	case 5 * 60:
		return "session"
	case 7 * 24 * 60:
		return "weekly"
	default:
		return fallback
	}
}

func appServerSystemNoticeEvent(session Session, turnID string, noticeKind string, title string, detail string, metadata ...map[string]any) activityshared.Event {
	update := map[string]any{
		"sessionUpdate": "system_notice",
		"kind":          "agent_system_notice",
		"noticeKind":    noticeKind,
	}
	if title != "" {
		update["title"] = title
	}
	if title == appServerContextCompactedTitle {
		update["noticeCommand"] = "compact"
		update["noticeCommandStatus"] = "completed"
	}
	if title == appServerCompactingContextTitle {
		update["noticeCommand"] = "compact"
		update["noticeCommandStatus"] = "running"
	}
	if detail != "" {
		update["detail"] = detail
	}
	for _, extra := range metadata {
		for key, value := range extra {
			if value != nil {
				update[key] = value
			}
		}
	}
	event, _ := acpSystemNoticeEvent(session, turnID, update, "system_notice", true)
	return event
}

// --- server -> client requests (approvals, user input) ---
