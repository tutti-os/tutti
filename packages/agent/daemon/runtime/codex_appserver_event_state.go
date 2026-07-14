package agentruntime

import (
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *CodexAppServerAdapter) applyTokenUsage(agentSessionID string, params map[string]any) {
	usage, ok := appServerTokenUsageState(params)
	if !ok {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return
	}
	appSession.usage = mergeACPUsageState(appSession.usage, usage)
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
		update["noticeCommandStatus"] = "inProgress"
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
