//revive:disable:file-length-limit
package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

// handleAppServerMessage routes codex app-server server->client traffic.
// Server requests (approvals, user-input questions) block until the user
// answers; notifications are translated into activity events through the
// shared ACP turn normalizer so the rest of the daemon sees one event shape.
func (a *CodexAppServerAdapter) handleAppServerMessage(
	ctx context.Context,
	client *acpClient,
	session Session,
	turnID string,
	message acpMessage,
	normalizer *acpTurnNormalizer,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) ([]activityshared.Event, error) {
	if message.Method == "" {
		return nil, nil
	}
	if len(message.ID) > 0 {
		switch message.Method {
		case appServerMethodCommandApproval,
			appServerMethodFileChangeApproval,
			appServerMethodPermissionsApproval,
			appServerMethodRequestUserInput,
			appServerMethodExecApprovalV1,
			appServerMethodPatchApprovalV1:
			return a.appServerServerRequest(ctx, client, session, turnID, message, emit)
		default:
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32601, Message: "method not supported"})
			return nil, nil
		}
	}
	return a.appServerNotificationEvents(client, session, turnID, message, normalizer, emitCommands), nil
}

func (a *CodexAppServerAdapter) appServerNotificationEvents(
	client *acpClient,
	session Session,
	turnID string,
	message acpMessage,
	normalizer *acpTurnNormalizer,
	emitCommands CommandSnapshotSink,
) []activityshared.Event {
	params := map[string]any{}
	if len(message.Params) > 0 {
		_ = json.Unmarshal(message.Params, &params)
	}
	if appServerNotificationThreadMismatch(session, message.Method, params) {
		return nil
	}
	switch message.Method {
	case appServerNotifyTurnStarted:
		// Record the provider turn id (needed for turn/interrupt and
		// turn/steer) only while a turn context is registered, so stray
		// turns (for example compaction) cannot block future prompts.
		if activeTurn := a.sessionActiveTurn(session.AgentSessionID); activeTurn != nil {
			if turn := payloadObject(params["turn"]); turn != nil {
				providerTurnID := asString(turn["id"])
				if a.setSessionActiveTurnID(session.AgentSessionID, providerTurnID) {
					a.interruptActiveTurnAsync(&codexAppServerSession{
						client:   client,
						threadID: firstNonEmpty(asString(params["threadId"]), session.ProviderSessionID),
					}, session, activeTurn, providerTurnID, "queued cancel")
				}
			}
		}
		return nil
	case appServerNotifyTurnCompleted:
		// Deliver the final turn payload to the goroutine waiting in Exec.
		a.completeActiveTurn(session.AgentSessionID, payloadObject(params["turn"]))
		return nil
	case appServerNotifyAgentMessageDelta:
		if normalizer == nil {
			return nil
		}
		return normalizer.AppendAssistantChunk(session, turnID, asStringRaw(params["delta"]))
	case appServerNotifyReasoningSummaryPart, appServerNotifyThreadSettingsUpdated:
		return nil
	case appServerNotifyReasoningDelta, appServerNotifyReasoningSummary:
		if normalizer == nil {
			return nil
		}
		return normalizer.AppendThinkingChunk(session, turnID, appServerReasoningDeltaText(params))
	case appServerNotifyItemStarted:
		return a.appServerItemEvents(session, turnID, payloadObject(params["item"]), false, normalizer)
	case appServerNotifyItemCompleted:
		return a.appServerItemEvents(session, turnID, payloadObject(params["item"]), true, normalizer)
	case appServerNotifyPlanUpdated:
		if normalizer == nil {
			return nil
		}
		update := appServerPlanUpdate(turnID, params)
		if update == nil {
			return nil
		}
		events, _ := normalizer.ToolCallEvents(session, turnID, update)
		return events
	case appServerNotifyTokenUsage:
		a.applyTokenUsage(session.AgentSessionID, params)
		if event, ok := acpUsageUpdatedEvent(session); ok {
			return []activityshared.Event{event}
		}
		return nil
	case appServerNotifyRateLimitsUpdated:
		a.applyRateLimits(session.AgentSessionID, payloadObject(params["rateLimits"]))
		if event, ok := acpUsageUpdatedEvent(session); ok {
			return []activityshared.Event{event}
		}
		return nil
	case appServerNotifyAccountUpdated:
		a.applyAccountUpdate(session.AgentSessionID, params)
		return nil
	case appServerNotifyThreadNameUpdated:
		if event, ok := acpSessionTitleEvent(session, map[string]any{
			"title": asString(params["threadName"]),
		}); ok {
			return []activityshared.Event{event}
		}
		return nil
	case appServerNotifyError:
		if willRetry, _ := params["willRetry"].(bool); willRetry {
			turnError := payloadObject(params["error"])
			detail := asString(turnError["message"])
			return []activityshared.Event{appServerSystemNoticeEvent(session, turnID, "transport_retry", "", detail)}
		}
		// Terminal turn failures already surface as agent_visible_error in the GUI.
		return nil
	case appServerNotifyWarning:
		return []activityshared.Event{appServerSystemNoticeEvent(session, turnID, "warning", "", asString(params["message"]))}
	case appServerNotifyDeprecation:
		return []activityshared.Event{appServerSystemNoticeEvent(session, turnID, "warning",
			asString(params["summary"]), asString(params["details"]))}
	case appServerNotifyModelRerouted:
		title := fmt.Sprintf("Codex rerouted the model from %s to %s.",
			asString(params["fromModel"]), asString(params["toModel"]))
		return []activityshared.Event{appServerSystemNoticeEvent(session, turnID, "system_notice", title, asString(params["reason"]))}
	case appServerNotifyThreadCompacted:
		return []activityshared.Event{appServerSystemNoticeEvent(session, turnID, "system_notice", "Context compacted.", "")}
	case appServerNotifyThreadGoalUpdated:
		a.applyGoalUpdate(session.AgentSessionID, payloadObject(params["goal"]))
		return nil
	case appServerNotifyThreadGoalCleared:
		a.applyGoalClear(session.AgentSessionID)
		return nil
	case appServerNotifyThreadStarted:
		return nil
	default:
		_ = emitCommands
		return nil
	}
}

// appServerNoticeItems maps review/compaction thread items to a one-line
// system-notice banner. emitOnCompleted selects which lifecycle event carries
// the banner: enteredReviewMode rides item/started (it always fires), while
// exitedReviewMode and contextCompaction ride the authoritative item/completed.
var appServerNoticeItems = map[string]struct {
	message         string
	emitOnCompleted bool
}{
	"enteredReviewMode": {message: "Code review started.", emitOnCompleted: false},
	"exitedReviewMode":  {message: "Code review finished.", emitOnCompleted: true},
	"contextCompaction": {message: "Context compacted.", emitOnCompleted: true},
}

func (a *CodexAppServerAdapter) appServerItemEvents(
	session Session,
	turnID string,
	item map[string]any,
	completed bool,
	normalizer *acpTurnNormalizer,
) []activityshared.Event {
	if len(item) == 0 || normalizer == nil {
		return nil
	}
	itemType := asString(item["type"])
	// Review/compaction items stream both item/started and item/completed.
	// Gate each banner to a single lifecycle event so the GUI shows it once.
	if notice, ok := appServerNoticeItems[itemType]; ok {
		if notice.emitOnCompleted != completed {
			return nil
		}
		return []activityshared.Event{appServerSystemNoticeEvent(session, turnID, "system_notice", notice.message, "")}
	}
	switch itemType {
	case "agentMessage":
		if !completed {
			return nil
		}
		normalizer.ApplyAssistantFinalText(asStringRaw(item["text"]))
		return normalizer.Finish(session, turnID, messageStreamStateCompleted)
	case "plan":
		if !completed {
			return nil
		}
		// Render the proposed plan as a dedicated card instead of merging it
		// into the assistant bubble: close any streaming text first, then
		// emit a standalone message tagged messageKind=plan for the GUI.
		events := normalizer.Finish(session, turnID, messageStreamStateCompleted)
		planMessageID := "plan:" + firstNonEmpty(asString(item["id"]), newID())
		events = append(events, newTurnActivityEventWithID(
			session,
			planMessageID,
			EventMessage,
			turnID,
			messageStreamStateCompleted,
			RoleAssistant,
			asStringRaw(item["text"]),
			map[string]any{
				"messageId":   planMessageID,
				"contentMode": messageContentModeSnapshot,
				"streamState": messageStreamStateCompleted,
				"messageKind": "plan",
			},
		))
		return events
	case "reasoning":
		if !completed {
			return nil
		}
		// Surface review/inline reasoning as a finalized thinking row. The
		// normalizer dedupes against any reasoning that already streamed as
		// textDelta chunks, so this is safe for both delivery modes.
		return normalizer.FinalizeThinkingItem(session, turnID, appServerReasoningText(item))
	case "userMessage", "hookPrompt":
		return nil
	default:
		update, ok := appServerItemToolCallUpdate(item, completed)
		if !ok {
			return nil
		}
		if completed && itemType == "collabAgentToolCall" {
			a.completeAppServerCollabAgentToolOutput(session, item, update)
		}
		events, _ := normalizer.ToolCallEvents(session, turnID, update)
		return events
	}
}

// appServerItemToolCallUpdate converts an app-server thread item into the
// ACP-style tool_call update shape consumed by the shared normalizer.
func appServerItemToolCallUpdate(item map[string]any, completed bool) (map[string]any, bool) {
	itemID := asString(item["id"])
	status := asString(item["status"])
	if status == "" {
		if completed {
			status = "completed"
		} else {
			status = "in_progress"
		}
	}
	update := map[string]any{
		"sessionUpdate": "tool_call",
		"toolCallId":    itemID,
		"status":        appServerItemStatus(status),
	}
	if completed {
		update["sessionUpdate"] = "tool_call_update"
	}
	switch asString(item["type"]) {
	case "commandExecution":
		command := asStringRaw(item["command"])
		update["title"] = firstNonEmpty(command, "Run command")
		update["kind"] = "execute"
		update["rawInput"] = map[string]any{
			"command": command,
			"cwd":     asString(item["cwd"]),
		}
		if completed {
			output := map[string]any{}
			if stdout := asStringRaw(item["aggregatedOutput"]); stdout != "" {
				output["stdout"] = stdout
			}
			if exitCode, ok := acpIntFromValue(item["exitCode"]); ok {
				output["exitCode"] = exitCode
			}
			if len(output) > 0 {
				update["rawOutput"] = output
			}
		}
	case "fileChange":
		update["title"] = "Edit"
		update["kind"] = "edit"
		changes, _ := item["changes"].([]any)
		locations := make([]any, 0, len(changes))
		for _, change := range changes {
			if path := asString(payloadObject(change)["path"]); path != "" {
				locations = append(locations, map[string]any{"path": path})
			}
		}
		if len(locations) > 0 {
			update["locations"] = locations
		}
		rawInput := map[string]any{"changes": item["changes"]}
		if cwd := asString(item["cwd"]); cwd != "" {
			rawInput["cwd"] = cwd
		}
		update["rawInput"] = rawInput
	case "mcpToolCall":
		server := asString(item["server"])
		tool := asString(item["tool"])
		update["title"] = strings.TrimPrefix(server+"."+tool, ".")
		update["kind"] = "other"
		if arguments := item["arguments"]; arguments != nil {
			update["rawInput"] = map[string]any{"arguments": arguments}
		}
		if completed {
			output := map[string]any{}
			if result := item["result"]; result != nil {
				output["result"] = result
			}
			if errText := asStringRaw(item["error"]); errText != "" {
				output["error"] = errText
				update["status"] = messageStreamStateFailed
			}
			if len(output) > 0 {
				update["rawOutput"] = output
			}
		}
	case "webSearch":
		// Per the Codex app-server schema, a webSearch item is {id, query, action?}
		// and for a `search` action the real query lives in action.query or the
		// action.queries[] array; the top-level `query` is often empty. Read the
		// action first and fall back to the top-level field so the query is not
		// silently dropped (which previously rendered an empty web-search row).
		action := payloadObject(item["action"])
		queries := appServerSearchQueries(action["queries"])
		query := firstNonEmpty(
			firstAppServerQuery(queries),
			asString(action["query"]),
			asString(item["query"]),
		)
		url := asString(action["url"])
		actionType := firstNonEmpty(asString(action["type"]), "search")

		rawInput := map[string]any{}
		if query != "" {
			rawInput["query"] = query
		}
		if len(queries) > 0 {
			rawInput["search_query"] = queries
		}
		actionOut := map[string]any{"type": actionType}
		if query != "" {
			actionOut["query"] = query
		}
		if len(queries) > 0 {
			actionOut["queries"] = queries
		}
		if url != "" {
			actionOut["url"] = url
		}
		rawInput["action"] = actionOut

		switch {
		case query != "":
			update["title"] = "Searching for: " + query
		case url != "":
			update["title"] = "Visiting: " + url
		default:
			update["title"] = "WebSearch"
		}
		update["kind"] = "fetch"
		update["rawInput"] = rawInput

		if query == "" && url == "" && len(queries) == 0 {
			// Confirmed via exported logs: the Codex app-server streams web-search
			// items as {query:"", action:{type:"other"}} for some models (e.g.
			// gpt-5.x) — it never sends the query or results, so there is nothing
			// for the daemon or GUI to render. Keep this at debug level (it can fire
			// once per search) to aid future diagnosis without flooding info logs.
			slog.Debug(
				"agent session app-server web search has no query/results from provider",
				"itemId", itemID,
				"status", status,
				"rawItem", appServerItemJSON(item),
			)
		}
	case "dynamicToolCall":
		update["title"] = firstNonEmpty(asString(item["tool"]), "Tool")
		update["kind"] = "other"
		if arguments := item["arguments"]; arguments != nil {
			update["rawInput"] = map[string]any{"arguments": arguments}
		}
		if success, ok := item["success"].(bool); ok && completed && !success {
			update["status"] = messageStreamStateFailed
		}
	case "collabAgentToolCall":
		tool := firstNonEmpty(asString(item["tool"]), "agent")
		update["title"] = tool
		if appServerAgentControlToolName(tool) != "" {
			update["kind"] = "other"
		} else {
			update["kind"] = "execute"
		}
		rawInput := map[string]any{
			"task":      asStringRaw(item["prompt"]),
			"agentName": tool,
		}
		if targets := appServerStringList(item["receiverThreadIds"], item["receiver_thread_ids"], item["targets"]); len(targets) > 0 {
			rawInput["targets"] = targets
			rawInput["target"] = targets[0]
		}
		update["rawInput"] = rawInput
		if completed {
			output := appServerCollabAgentRawOutput(item, tool)
			if appServerCollabAgentHasMeaningfulOutput(output) {
				update["rawOutput"] = output
			}
		}
	case "imageGeneration":
		update["title"] = "Generate image"
		update["kind"] = "other"
		if completed {
			output := map[string]any{}
			if savedPath := asString(item["savedPath"]); savedPath != "" {
				output["savedPath"] = savedPath
			}
			if result := asStringRaw(item["result"]); result != "" {
				output["result"] = result
			}
			if len(output) > 0 {
				update["rawOutput"] = output
			}
		}
	case "imageView":
		update["title"] = "View image"
		update["kind"] = "read"
		if path := asString(item["path"]); path != "" {
			update["locations"] = []any{map[string]any{"path": path}}
		}
	default:
		return nil, false
	}
	return update, true
}

func appServerAgentControlToolName(tool string) string {
	switch normalizeAgentToolToken(tool) {
	case "closeagent":
		return "CloseAgent"
	case "wait":
		return "Wait"
	default:
		return ""
	}
}

func appServerOutputText(value any) string {
	if text := asStringRaw(value); strings.TrimSpace(text) != "" {
		return text
	}
	record := payloadObject(value)
	return firstNonEmpty(
		asStringRaw(record["message"]),
		asStringRaw(record["text"]),
		asStringRaw(record["output"]),
		asStringRaw(record["result"]),
	)
}

func appServerNotificationThreadMismatch(session Session, method string, params map[string]any) bool {
	expectedThreadID := strings.TrimSpace(session.ProviderSessionID)
	eventThreadID := asString(params["threadId"])
	if expectedThreadID == "" || eventThreadID == "" || eventThreadID == expectedThreadID {
		return false
	}
	item := payloadObject(params["item"])
	slog.Debug(
		"agent session app-server notification ignored for foreign thread",
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", expectedThreadID,
		"event_thread_id", eventThreadID,
		"event_turn_id", asString(params["turnId"]),
		"method", method,
		"item_id", asString(item["id"]),
		"item_type", asString(item["type"]),
		"item_status", asString(item["status"]),
	)
	return true
}

func appServerItemStatus(status string) string {
	switch strings.TrimSpace(status) {
	case "inProgress", "in_progress", "":
		return "in_progress"
	case "declined":
		return "failed"
	default:
		return status
	}
}

func appServerPlanUpdate(turnID string, params map[string]any) map[string]any {
	steps, _ := params["plan"].([]any)
	if len(steps) == 0 {
		return nil
	}
	todos := make([]any, 0, len(steps))
	for _, step := range steps {
		entry := payloadObject(step)
		text := asStringRaw(entry["step"])
		if text == "" {
			continue
		}
		todos = append(todos, map[string]any{
			"content": text,
			"status":  appServerPlanStepStatus(asString(entry["status"])),
		})
	}
	if len(todos) == 0 {
		return nil
	}
	return map[string]any{
		"sessionUpdate": "tool_call",
		"toolCallId":    "plan:" + strings.TrimSpace(turnID),
		"title":         "update_todo",
		"kind":          "think",
		"status":        "completed",
		"rawInput":      map[string]any{"todos": todos},
	}
}

func appServerPlanStepStatus(status string) string {
	switch strings.TrimSpace(status) {
	case "inProgress", "in_progress":
		return "in_progress"
	case "completed":
		return "completed"
	default:
		return "pending"
	}
}

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
	used, usedOK := firstACPInt64(last, "inputTokens")
	if !usedOK || used <= 0 {
		used, usedOK = firstACPInt64(last, "totalTokens")
	}
	if !usedOK || used <= 0 {
		used, usedOK = firstACPInt64(payloadObject(tokenUsage["total"]), "totalTokens")
	}
	window, windowOK := firstACPInt64(tokenUsage, "modelContextWindow")
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

func (a *CodexAppServerAdapter) applyGoalUpdate(agentSessionID string, goal map[string]any) {
	if len(goal) == 0 {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return
	}
	appSession.goal = clonePayload(goal)
}

func (a *CodexAppServerAdapter) applyGoalClear(agentSessionID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return
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
			"quotaType":        window.quotaType,
			"percentRemaining": 100 - usedPercent,
		}
		if resetsAt, ok := acpInt64Value(entry["resetsAt"]); ok && resetsAt > 0 {
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

func appServerSystemNoticeEvent(session Session, turnID string, noticeKind string, title string, detail string, metadata ...map[string]any) activityshared.Event {
	update := map[string]any{
		"sessionUpdate": "system_notice",
		"kind":          "agent_system_notice",
		"noticeKind":    noticeKind,
	}
	if title != "" {
		update["title"] = title
	}
	if title == "Context compacted." {
		update["noticeCommand"] = "compact"
		update["noticeCommandStatus"] = "completed"
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

func (a *CodexAppServerAdapter) appServerServerRequest(
	ctx context.Context,
	client *acpClient,
	session Session,
	turnID string,
	message acpMessage,
	emit EventSink,
) ([]activityshared.Event, error) {
	if strings.TrimSpace(turnID) == "" || emit == nil {
		err := errors.New("approval request outside active prompt turn is not supported")
		_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32000, Message: err.Error()})
		return nil, err
	}
	params := map[string]any{}
	if len(message.Params) > 0 {
		if err := json.Unmarshal(message.Params, &params); err != nil {
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32602, Message: err.Error()})
			return nil, fmt.Errorf("invalid approval request: %w", err)
		}
	}
	events, pending, err := a.appServerApprovalRequested(session, turnID, message.ID, message.Method, params)
	if err != nil {
		_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32602, Message: err.Error()})
		return events, err
	}
	if len(events) > 0 {
		emit(events)
	}
	defer a.deletePendingRequest(session.AgentSessionID, pending.requestID)
	selection, err := pending.wait(ctx)
	if err != nil {
		resolved := acpPermissionResolvedEvents(session, turnID, pending, pendingACPResponse{}, err)
		_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32000, Message: err.Error()})
		return resolved, err
	}
	result, responseErr := appServerApprovalResult(message.Method, params, selection)
	if err := client.Respond(ctx, message.ID, result, responseErr); err != nil {
		return acpPermissionResolvedEvents(session, turnID, pending, selection, err), err
	}
	return acpPermissionResolvedEvents(session, turnID, pending, selection, nil), nil
}

func (a *CodexAppServerAdapter) appServerApprovalRequested(
	session Session,
	turnID string,
	rawRequestID json.RawMessage,
	method string,
	params map[string]any,
) ([]activityshared.Event, *pendingACPRequest, error) {
	requestID := acpRequestID(rawRequestID)
	if requestID == "" {
		return nil, nil, errors.New("approval request id is required")
	}
	if method == appServerMethodRequestUserInput {
		return a.appServerUserInputRequested(session, turnID, requestID, params)
	}
	toolCall := appServerApprovalToolCall(method, params)
	options := appServerApprovalOptions(method)
	title := firstNonEmpty(asString(toolCall["title"]), "Permission requested")
	callID := firstNonEmpty(asString(toolCall["toolCallId"]), newID())
	status := string(activityshared.TurnPhaseWaitingApproval)
	input := acpApprovalInput(toolCall, options, requestID)
	payload := map[string]any{
		"callId":   callID,
		"callType": "approval",
		"name":     title,
		"toolName": "Approval",
		"status":   status,
		"input":    input,
	}
	pending := &pendingACPRequest{
		agentSessionID: strings.TrimSpace(session.AgentSessionID),
		requestID:      requestID,
		eventID:        newID(),
		callID:         callID,
		callType:       "approval",
		input:          input,
		kind:           "approval",
		name:           title,
		toolName:       "Approval",
		options:        options,
		response:       make(chan pendingACPResponse, 1),
	}
	a.storePendingRequest(pending)
	return []activityshared.Event{
		newTurnActivityEvent(session, EventTurnUpdated, turnID, SessionStatusWaiting, "", "", map[string]any{
			"phase":     string(activityshared.TurnPhaseWaitingApproval),
			"requestId": requestID,
		}),
		newTurnActivityEventWithID(
			session,
			pending.eventID,
			EventCallStarted,
			turnID,
			SessionStatusWaiting,
			"",
			title,
			payload,
		),
	}, pending, nil
}

func (a *CodexAppServerAdapter) appServerUserInputRequested(
	session Session,
	turnID string,
	requestID string,
	params map[string]any,
) ([]activityshared.Event, *pendingACPRequest, error) {
	questions, _ := params["questions"].([]any)
	input := map[string]any{
		"requestId": requestID,
		"questions": clonePayloadValue(questions),
	}
	prompt := &SessionInteractivePrompt{
		Kind:      "ask-user",
		RequestID: requestID,
		ToolName:  "AskUserQuestion",
		Status:    "waiting_input",
		Input:     clonePayload(input),
		Metadata: map[string]any{
			"callType":        "interactive",
			"interactiveKind": "ask-user",
			"toolName":        "AskUserQuestion",
		},
	}
	callID := firstNonEmpty(asString(params["itemId"]), newID())
	payload := map[string]any{
		"callId":   callID,
		"callType": "interactive",
		"name":     "AskUserQuestion",
		"toolName": "AskUserQuestion",
		"status":   "waiting_input",
		"input":    clonePayload(input),
		"metadata": clonePayload(prompt.Metadata),
	}
	pending := &pendingACPRequest{
		agentSessionID: strings.TrimSpace(session.AgentSessionID),
		requestID:      requestID,
		eventID:        newID(),
		callID:         callID,
		callType:       "interactive",
		input:          input,
		kind:           "ask-user",
		name:           "AskUserQuestion",
		toolName:       "AskUserQuestion",
		prompt:         prompt,
		response:       make(chan pendingACPResponse, 1),
	}
	a.storePendingRequest(pending)
	return []activityshared.Event{
		newTurnActivityEvent(session, EventTurnUpdated, turnID, SessionStatusWaiting, "", "", map[string]any{
			"phase":     string(activityshared.TurnPhaseWaitingApproval),
			"requestId": requestID,
		}),
		newTurnActivityEventWithID(
			session,
			pending.eventID,
			EventCallStarted,
			turnID,
			SessionStatusWaiting,
			"",
			"AskUserQuestion",
			payload,
		),
	}, pending, nil
}

func appServerApprovalToolCall(method string, params map[string]any) map[string]any {
	switch method {
	case appServerMethodCommandApproval:
		command := asStringRaw(params["command"])
		input := map[string]any{
			"command": command,
			"cwd":     asString(params["cwd"]),
		}
		if reason := asStringRaw(params["reason"]); reason != "" {
			input["reason"] = reason
		}
		return map[string]any{
			"toolCallId": firstNonEmpty(asString(params["itemId"]), asString(params["approvalId"])),
			"title":      firstNonEmpty(command, "Run command"),
			"kind":       "execute",
			"input":      input,
		}
	case appServerMethodExecApprovalV1:
		command := acpApprovalDisplayCommand(params["command"])
		input := map[string]any{
			"command": command,
			"cwd":     asString(params["cwd"]),
		}
		if reason := asStringRaw(params["reason"]); reason != "" {
			input["reason"] = reason
		}
		return map[string]any{
			"toolCallId": firstNonEmpty(asString(params["callId"]), asString(params["approvalId"])),
			"title":      firstNonEmpty(command, "Run command"),
			"kind":       "execute",
			"input":      input,
		}
	case appServerMethodFileChangeApproval, appServerMethodPatchApprovalV1:
		input := map[string]any{}
		if reason := asStringRaw(params["reason"]); reason != "" {
			input["reason"] = reason
		}
		if grantRoot := asString(params["grantRoot"]); grantRoot != "" {
			input["grantRoot"] = grantRoot
		}
		if fileChanges := params["fileChanges"]; fileChanges != nil {
			input["fileChanges"] = clonePayloadValue(fileChanges)
		}
		return map[string]any{
			"toolCallId": firstNonEmpty(asString(params["itemId"]), asString(params["callId"])),
			"title":      "Apply file changes",
			"kind":       "edit",
			"input":      input,
		}
	case appServerMethodPermissionsApproval:
		input := map[string]any{
			"permissions": clonePayloadValue(params["permissions"]),
			"cwd":         asString(params["cwd"]),
		}
		if reason := asStringRaw(params["reason"]); reason != "" {
			input["reason"] = reason
		}
		return map[string]any{
			"toolCallId": firstNonEmpty(asString(params["itemId"]), newID()),
			"title":      "Grant additional permissions",
			"kind":       "other",
			"input":      input,
		}
	default:
		return map[string]any{
			"toolCallId": newID(),
			"title":      "Permission requested",
		}
	}
}

func appServerApprovalOptions(method string) []map[string]any {
	switch method {
	case appServerMethodPermissionsApproval:
		return []map[string]any{
			{"optionId": "approve", "name": "Approve", "kind": "allow_once"},
			{"optionId": "deny", "name": "Deny", "kind": "reject_once"},
		}
	default:
		return []map[string]any{
			{"optionId": "approve", "name": "Approve", "kind": "allow_once"},
			{"optionId": "approve_for_session", "name": "Approve for session", "kind": "allow_always"},
			{"optionId": "deny", "name": "Deny", "kind": "reject_once"},
			{"optionId": "abort", "name": "Deny and stop the turn", "kind": "reject_always"},
		}
	}
}

func appServerApprovalResult(method string, params map[string]any, selection pendingACPResponse) (any, *acpError) {
	optionID := strings.TrimSpace(selection.optionID)
	switch method {
	case appServerMethodCommandApproval, appServerMethodFileChangeApproval:
		decision := map[string]string{
			"approve":             "accept",
			"approve_for_session": "acceptForSession",
			"deny":                "decline",
			"abort":               "cancel",
		}[optionID]
		if decision == "" {
			decision = "decline"
		}
		return map[string]any{"decision": decision}, nil
	case appServerMethodExecApprovalV1, appServerMethodPatchApprovalV1:
		decision := map[string]string{
			"approve":             "approved",
			"approve_for_session": "approved_for_session",
			"deny":                "denied",
			"abort":               "abort",
		}[optionID]
		if decision == "" {
			decision = "denied"
		}
		return map[string]any{"decision": decision}, nil
	case appServerMethodPermissionsApproval:
		if optionID == "approve" {
			return map[string]any{
				"permissions": clonePayloadValue(params["permissions"]),
				"scope":       "session",
			}, nil
		}
		return nil, &acpError{Code: -32000, Message: "user denied the permission request"}
	case appServerMethodRequestUserInput:
		return map[string]any{
			"answers": appServerUserInputAnswers(params, selection),
		}, nil
	default:
		return map[string]any{}, nil
	}
}

func appServerUserInputAnswers(params map[string]any, selection pendingACPResponse) map[string]any {
	answers := map[string]any{}
	// The GUI sends per-question answers keyed by question id under
	// answersByQuestionId (its `answers` field is a flat display list, not a
	// map). Accept a bare `answers` map too for callers that inline it.
	keyed := payloadObject(selection.payload["answersByQuestionId"])
	if len(keyed) == 0 {
		keyed = payloadObject(selection.payload["answers"])
	}
	if len(keyed) > 0 {
		for questionID, value := range keyed {
			answers[questionID] = map[string]any{"answers": appServerAnswerValues(value)}
		}
		return answers
	}
	questions, _ := params["questions"].([]any)
	answerText := firstNonEmpty(
		asString(selection.payload["answer"]),
		strings.TrimSpace(selection.optionID),
	)
	for _, question := range questions {
		questionID := asString(payloadObject(question)["id"])
		if questionID == "" {
			continue
		}
		answers[questionID] = map[string]any{"answers": appServerAnswerValues(answerText)}
	}
	return answers
}

func appServerAnswerValues(value any) []string {
	switch typed := value.(type) {
	case string:
		if trimmed := strings.TrimSpace(typed); trimmed != "" {
			return []string{trimmed}
		}
		return []string{}
	case []any:
		out := make([]string, 0, len(typed))
		for _, entry := range typed {
			if text := strings.TrimSpace(asString(entry)); text != "" {
				out = append(out, text)
			}
		}
		return out
	default:
		return []string{}
	}
}

// --- request parameter builders ---

// appServerThreadReasoningSummaryConfig selects the thread-level reasoning
// summary mode for codex app-server. Inline /review turns interleave readable
// reasoning via summaryTextDelta; the legacy ACP adapter disables summaries for
// spark, but app-server review still needs them.
func appServerThreadReasoningSummaryConfig(model string) string {
	model = strings.TrimSpace(model)
	if model == "" || codexACPModelDisablesReasoningSummary(model) {
		return "auto"
	}
	return ""
}

func appServerThreadStartParams(session Session, cwd string) map[string]any {
	settings := session.SettingsValue()
	params := map[string]any{
		"cwd": firstNonEmpty(cwd, "/"),
	}
	if model := strings.TrimSpace(settings.Model); model != "" {
		params["model"] = model
	}
	config := map[string]any{}
	if reasoning := codexACPReasoningEffortValue(settings.ReasoningEffort); reasoning != "" {
		config["model_reasoning_effort"] = reasoning
	}
	if summary := appServerThreadReasoningSummaryConfig(settings.Model); summary != "" {
		config[codexACPConfigModelReasoningSummary] = summary
	}
	if serviceTier := codexServiceTierValue(settings.Speed); serviceTier != "" {
		config["service_tier"] = serviceTier
	}
	if len(config) > 0 {
		params["config"] = config
	}
	if approvalPolicy := codexAppServerApprovalPolicy(session.PermissionModeID); approvalPolicy != "" {
		params["approvalPolicy"] = approvalPolicy
	}
	if sandbox := codexAppServerSandboxMode(session.PermissionModeID); sandbox != "" {
		params["sandbox"] = sandbox
	}
	if approvalsReviewer := codexAppServerApprovalsReviewer(session.PermissionModeID); approvalsReviewer != "" {
		params["approvalsReviewer"] = approvalsReviewer
	}
	return params
}

func appServerTurnStartParams(
	session Session,
	threadID string,
	content []PromptContentBlock,
	planModeMask map[string]any,
	defaultModeMask map[string]any,
	defaultModel string,
) map[string]any {
	settings := session.SettingsValue()
	params := map[string]any{
		"threadId": threadID,
		"input":    appServerUserInput(content),
	}
	if collaborationMode := appServerCollaborationMode(settings, planModeMask, defaultModeMask, defaultModel); collaborationMode != nil {
		params["collaborationMode"] = collaborationMode
	}
	if model := strings.TrimSpace(settings.Model); model != "" {
		params["model"] = model
	}
	if reasoning := codexACPReasoningEffortValue(settings.ReasoningEffort); reasoning != "" {
		params["effort"] = reasoning
	}
	if summary := codexACPReasoningSummaryOverride(settings.Model); summary != "" {
		params["summary"] = summary
	}
	if approvalPolicy := codexAppServerApprovalPolicy(session.PermissionModeID); approvalPolicy != "" {
		params["approvalPolicy"] = approvalPolicy
	}
	if sandboxPolicy := codexAppServerSandboxPolicy(session.PermissionModeID); sandboxPolicy != nil {
		params["sandboxPolicy"] = sandboxPolicy
	}
	if approvalsReviewer := codexAppServerApprovalsReviewer(session.PermissionModeID); approvalsReviewer != "" {
		params["approvalsReviewer"] = approvalsReviewer
	}
	return params
}

// appServerCollaborationMode assembles the turn/start collaborationMode
// payload. Collaboration mode is sticky thread state on the codex side, so
// once negotiation succeeded every turn declares its mode explicitly: the
// Plan preset while plan mode is on, the default mode otherwise (mirrors the
// codex TUI, which switches modes by submitting with the target mask). The
// schema requires a concrete settings.model — session override first, then
// the session default model, then the mask's own model; without any model
// the field is omitted rather than sending an invalid request.
func appServerCollaborationMode(
	settings SessionSettings,
	planModeMask map[string]any,
	defaultModeMask map[string]any,
	defaultModel string,
) map[string]any {
	if planModeMask == nil && defaultModeMask == nil {
		return nil
	}
	mode := "default"
	modeMask := defaultModeMask
	if settings.PlanMode {
		if planModeMask == nil {
			return nil
		}
		modeMask = planModeMask
		mode = strings.ToLower(strings.TrimSpace(firstNonEmpty(asString(planModeMask["mode"]), "plan")))
	}
	model := strings.TrimSpace(firstNonEmpty(settings.Model, defaultModel, asString(modeMask["model"])))
	if model == "" {
		return nil
	}
	collaborationSettings := map[string]any{
		"model":                  model,
		"developer_instructions": appServerCollaborationModeDeveloperInstructions(modeMask),
	}
	if effort := codexACPReasoningEffortValue(settings.ReasoningEffort); effort != "" {
		collaborationSettings["reasoning_effort"] = effort
	} else if settings.PlanMode {
		if presetEffort := strings.TrimSpace(asString(modeMask["reasoning_effort"])); presetEffort != "" {
			collaborationSettings["reasoning_effort"] = presetEffort
		} else {
			collaborationSettings["reasoning_effort"] = nil
		}
	} else {
		collaborationSettings["reasoning_effort"] = nil
	}
	return map[string]any{
		"mode":     mode,
		"settings": collaborationSettings,
	}
}

func appServerCollaborationModeDeveloperInstructions(modeMask map[string]any) any {
	if modeMask == nil {
		return nil
	}
	if text, ok := modeMask["developer_instructions"].(string); ok && strings.TrimSpace(text) != "" {
		return text
	}
	if settings := payloadObject(modeMask["settings"]); settings != nil {
		if text, ok := settings["developer_instructions"].(string); ok && strings.TrimSpace(text) != "" {
			return text
		}
	}
	return nil
}

func appServerUserInput(content []PromptContentBlock) []map[string]any {
	out := make([]map[string]any, 0, len(content))
	for _, block := range content {
		switch block.Type {
		case "text":
			out = append(out, map[string]any{
				"type": "text",
				"text": block.Text,
			})
		case "image":
			out = append(out, map[string]any{
				"type": "image",
				"url":  "data:" + firstNonEmpty(block.MimeType, "image/png") + ";base64," + block.Data,
			})
		case "skill", "mention":
			item := map[string]any{
				"type": block.Type,
				"name": block.Name,
				"path": block.Path,
			}
			out = append(out, item)
		}
	}
	return out
}

func appServerGoalSlashRequest(args string, threadID string) (string, map[string]any) {
	params := map[string]any{"threadId": threadID}
	args = strings.TrimSpace(args)
	if args == "" {
		return appServerMethodThreadGoalGet, params
	}
	if strings.EqualFold(args, "clear") {
		return appServerMethodThreadGoalClear, params
	}
	if status := appServerGoalStatus(args); status != "" {
		params["status"] = status
		return appServerMethodThreadGoalSet, params
	}
	params["objective"] = args
	params["status"] = "active"
	return appServerMethodThreadGoalSet, params
}

func appServerGoalStatus(value string) string {
	normalized := strings.ToLower(strings.NewReplacer("-", "", "_", "", " ", "").Replace(strings.TrimSpace(value)))
	switch normalized {
	case "active":
		return "active"
	case "pause", "paused":
		return "paused"
	case "block", "blocked":
		return "blocked"
	case "usagelimited":
		return "usageLimited"
	case "budgetlimited":
		return "budgetLimited"
	case "done", "complete", "completed":
		return "complete"
	default:
		return ""
	}
}

func appServerGoalFromResult(result json.RawMessage) map[string]any {
	if len(result) == 0 {
		return nil
	}
	var payload map[string]any
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil
	}
	return payloadObject(payload["goal"])
}

func appServerGoalNoticeEvent(session Session, turnID string, method string, result json.RawMessage) *activityshared.Event {
	switch method {
	case appServerMethodThreadGoalClear:
		event := appServerSystemNoticeEvent(session, turnID, "system_notice", "Goal cleared.", "")
		return &event
	case appServerMethodThreadGoalGet:
		goal := appServerGoalFromResult(result)
		if len(goal) == 0 {
			event := appServerSystemNoticeEvent(session, turnID, "system_notice", "No active goal.", "")
			return &event
		}
		event := appServerSystemNoticeEvent(session, turnID, "system_notice", "Current goal: "+asStringRaw(goal["objective"]), appServerGoalStatusDetail(goal))
		return &event
	case appServerMethodThreadGoalSet:
		goal := appServerGoalFromResult(result)
		detail := appServerGoalStatusDetail(goal)
		event := appServerSystemNoticeEvent(session, turnID, "system_notice", "Goal updated.", detail)
		return &event
	default:
		return nil
	}
}

func appServerGoalStatusDetail(goal map[string]any) string {
	status := strings.TrimSpace(asString(goal["status"]))
	if status == "" {
		return ""
	}
	if objective := strings.TrimSpace(asStringRaw(goal["objective"])); objective != "" {
		return "status: " + status + "\nobjective: " + objective
	}
	return "status: " + status
}

func splitSlashCommand(prompt string) (string, string) {
	trimmed := strings.TrimSpace(prompt)
	if !strings.HasPrefix(trimmed, "/") {
		return "", ""
	}
	command, args, _ := strings.Cut(trimmed, " ")
	return strings.ToLower(strings.TrimSpace(command)), strings.TrimSpace(args)
}

// codexAppServerApprovalPolicy maps Tutti permission modes onto the
// app-server AskForApproval policy.
func codexAppServerApprovalPolicy(modeID string) string {
	switch codexACPModeID(modeID) {
	case "read-only", "auto":
		return "on-request"
	case "full-access":
		return "never"
	default:
		return ""
	}
}

func codexAppServerSandboxMode(modeID string) string {
	switch codexACPModeID(modeID) {
	case "read-only":
		return "read-only"
	case "auto":
		return "workspace-write"
	case "full-access":
		return "danger-full-access"
	default:
		return ""
	}
}

func codexAppServerSandboxPolicy(modeID string) map[string]any {
	switch codexACPModeID(modeID) {
	case "read-only":
		return map[string]any{"type": "readOnly"}
	case "auto":
		return map[string]any{"type": "workspaceWrite"}
	case "full-access":
		return map[string]any{"type": "dangerFullAccess"}
	default:
		return nil
	}
}

func codexAppServerApprovalsReviewer(modeID string) string {
	switch codexACPModeID(modeID) {
	case "read-only":
		return "user"
	case "auto":
		return "auto_review"
	default:
		return ""
	}
}

// --- response decoding helpers ---

func appServerInfo(raw json.RawMessage) map[string]any {
	info := map[string]any{
		"name":  "codex-app-server",
		"title": "Codex",
	}
	if len(raw) == 0 {
		return info
	}
	var result struct {
		UserAgent      string `json:"userAgent"`
		CodexHome      string `json:"codexHome"`
		PlatformOS     string `json:"platformOs"`
		PlatformFamily string `json:"platformFamily"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return info
	}
	if result.UserAgent != "" {
		info["userAgent"] = result.UserAgent
	}
	if result.CodexHome != "" {
		info["codexHome"] = result.CodexHome
	}
	if result.PlatformOS != "" {
		info["platformOs"] = result.PlatformOS
	}
	return info
}

func appServerThreadID(raw json.RawMessage) (string, error) {
	var result struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", err
	}
	if strings.TrimSpace(result.Thread.ID) == "" {
		return "", errors.New("app-server thread/start returned empty thread id")
	}
	return strings.TrimSpace(result.Thread.ID), nil
}

func appServerTurnFromResult(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var result struct {
		Turn map[string]any `json:"turn"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil
	}
	return result.Turn
}

func appServerTurnFinalAssistantText(turn map[string]any) string {
	items, _ := turn["items"].([]any)
	for index := len(items) - 1; index >= 0; index-- {
		item := payloadObject(items[index])
		if asString(item["type"]) == "agentMessage" {
			return strings.TrimSpace(asStringRaw(item["text"]))
		}
	}
	return ""
}

func appServerTurnTerminalEvents(
	session Session,
	turnID string,
	turn map[string]any,
	normalizer *acpTurnNormalizer,
) []activityshared.Event {
	status := asString(turn["status"])
	switch status {
	case "interrupted":
		events := normalizer.FinishInterrupted(session, turnID, "interrupted")
		return append(events, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
			"stopReason": "canceled",
		}))
	case "failed":
		events := normalizer.FinishFailed(session, turnID)
		metadata := map[string]any{
			"stopReason": "failed",
		}
		if turnError := payloadObject(turn["error"]); len(turnError) > 0 {
			if message := asStringRaw(turnError["message"]); message != "" {
				metadata["error"] = message
				metadata["errorMessage"] = message
			}
			if codexErrorInfo := turnError["codexErrorInfo"]; codexErrorInfo != nil {
				metadata["codexErrorInfo"] = clonePayloadValue(codexErrorInfo)
			}
			if details := asStringRaw(turnError["additionalDetails"]); details != "" {
				metadata["additionalDetails"] = details
			}
		}
		return append(events, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", metadata))
	default:
		events := normalizer.FinishCompleted(session, turnID)
		return append(events, newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", map[string]any{
			"stopReason": "end_turn",
		}))
	}
}

// --- session capability metadata ---

func codexAppServerCommands() []AgentSessionCommand {
	return []AgentSessionCommand{
		{Name: "review", Description: "Review code changes", InputHint: "instructions (optional)"},
		{Name: "goal", Description: "Show or update the thread goal", InputHint: "objective, status, or clear"},
		{Name: "compact", Description: "Compact the conversation context"},
		{Name: "undo", Description: "Drop the last turn from the conversation"},
	}
}

func codexAppServerCapabilities(planMode bool) []string {
	capabilities := []string{
		CapabilityImageInput,
		CapabilitySkills,
		CapabilityInterrupt,
		CapabilityCompact,
		CapabilityRateLimits,
		CapabilityTokenUsage,
		"steer",
		"review",
		"goal",
		"rollback",
		"fork",
		"perTurnModelOverride",
	}
	if planMode {
		// Negotiated at session start via the experimental
		// collaborationMode/list probe.
		capabilities = append(capabilities, CapabilityPlanMode)
	}
	return capabilities
}

func codexAppServerConfigOptionDescriptors(
	models []map[string]any,
	session Session,
	threadResult json.RawMessage,
) []map[string]any {
	settings := session.SettingsValue()
	currentModel := strings.TrimSpace(settings.Model)
	currentEffort := codexACPReasoningEffortValue(settings.ReasoningEffort)
	var threadInfo struct {
		Model           string `json:"model"`
		ReasoningEffort string `json:"reasoningEffort"`
	}
	if len(threadResult) > 0 {
		if err := json.Unmarshal(threadResult, &threadInfo); err == nil {
			currentModel = firstNonEmpty(currentModel, strings.TrimSpace(threadInfo.Model))
			currentEffort = firstNonEmpty(currentEffort, strings.TrimSpace(threadInfo.ReasoningEffort))
		}
	}

	modelOptions := make([]any, 0, len(models))
	modelOptionValues := map[string]struct{}{}
	var effortValues []string
	for _, model := range models {
		if hidden, _ := model["hidden"].(bool); hidden {
			continue
		}
		value := firstNonEmpty(asString(model["model"]), asString(model["id"]))
		if value == "" {
			continue
		}
		modelOptions = append(modelOptions, map[string]any{
			"value": value,
			"name":  firstNonEmpty(asString(model["displayName"]), value),
		})
		modelOptionValues[value] = struct{}{}
		if value == currentModel || (currentModel == "" && truthyBool(model["isDefault"])) {
			effortValues = appServerSupportedEfforts(model)
			if currentModel == "" {
				currentModel = value
			}
			if currentEffort == "" {
				currentEffort = asString(model["defaultReasoningEffort"])
			}
		}
	}
	if currentModel != "" {
		if _, ok := modelOptionValues[currentModel]; !ok {
			modelOptions = append(modelOptions, map[string]any{
				"value": currentModel,
				"name":  currentModel,
			})
		}
	}
	if len(effortValues) == 0 {
		effortValues = []string{"minimal", "low", "medium", "high", "xhigh"}
	}
	effortOptions := make([]any, 0, len(effortValues))
	for _, value := range effortValues {
		effortOptions = append(effortOptions, map[string]any{
			"value": value,
			"name":  strings.ToUpper(value[:1]) + value[1:],
		})
	}

	descriptors := make([]map[string]any, 0, 2)
	if len(modelOptions) > 0 {
		descriptors = append(descriptors, map[string]any{
			"id":           "model",
			"name":         "Model",
			"type":         "select",
			"category":     "model",
			"currentValue": currentModel,
			"options":      modelOptions,
		})
	}
	descriptors = append(descriptors, map[string]any{
		"id":           "reasoning_effort",
		"name":         "Reasoning Effort",
		"type":         "select",
		"category":     "thought_level",
		"currentValue": firstNonEmpty(currentEffort, "medium"),
		"options":      effortOptions,
	})
	descriptors = append(descriptors, map[string]any{
		"id":           "service_tier",
		"name":         "Speed",
		"type":         "select",
		"category":     "speed",
		"currentValue": firstNonEmpty(strings.TrimSpace(settings.Speed), "standard"),
		"options": []any{
			map[string]any{"value": "standard", "name": "Standard"},
			map[string]any{"value": "fast", "name": "Fast"},
		},
	})
	return descriptors
}

func appServerSupportedEfforts(model map[string]any) []string {
	raw, _ := model["supportedReasoningEfforts"].([]any)
	out := make([]string, 0, len(raw))
	for _, entry := range raw {
		switch typed := entry.(type) {
		case string:
			if trimmed := strings.TrimSpace(typed); trimmed != "" {
				out = append(out, trimmed)
			}
		case map[string]any:
			if value := firstNonEmpty(asString(typed["reasoningEffort"]), asString(typed["effort"]), asString(typed["value"])); value != "" {
				out = append(out, value)
			}
		}
	}
	return dedupeStrings(out)
}

func truthyBool(value any) bool {
	typed, _ := value.(bool)
	return typed
}

// asStringRaw returns string values without trimming, so streaming deltas keep
// their whitespace. Non-strings return "".
func asStringRaw(value any) string {
	typed, _ := value.(string)
	return typed
}

// appServerSearchQueries reads action.queries[] (Codex app-server webSearch
// schema) into a []any of non-empty trimmed strings, suitable for the GUI's
// search_query rendering. Returns nil when absent or empty.
func appServerSearchQueries(value any) []any {
	raw, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]any, 0, len(raw))
	for _, entry := range raw {
		if text := asString(entry); text != "" {
			out = append(out, text)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// firstAppServerQuery returns the first non-empty query string from a
// search_query list produced by appServerSearchQueries.
func firstAppServerQuery(queries []any) string {
	for _, q := range queries {
		if text := asString(q); text != "" {
			return text
		}
	}
	return ""
}

// appServerItemJSON renders a raw thread item as compact JSON for diagnostics,
// falling back to Go formatting if the item is not JSON-serializable.
func appServerItemJSON(item map[string]any) string {
	if encoded, err := json.Marshal(item); err == nil {
		return string(encoded)
	}
	return fmt.Sprintf("%+v", item)
}

// appServerReasoningText pulls the human-readable text out of a completed
// `reasoning` thread item. Per the Codex app-server schema, the ThreadItem
// reasoning variant is {id, summary, content} where summary and content are
// usually string arrays. Some app-server versions also stream reasoning via
// summaryTextDelta/textDelta and may emit completed items before those arrays
// are populated, so callers should still handle streaming deltas.
func appServerReasoningText(item map[string]any) string {
	if text := reasoningSectionsText(item["summary"]); text != "" {
		return text
	}
	if text := reasoningSectionsText(item["content"]); text != "" {
		return text
	}
	return firstNonEmpty(asStringRaw(item["text"]), asString(item["text"]))
}

// appServerReasoningDeltaText reads a reasoning delta payload. Most app-server
// versions use `delta`, but some event shapes expose the chunk as `text`.
// Streaming chunks must preserve their leading/trailing whitespace (e.g. a
// "Need " token followed by "context.") so concatenated reasoning text keeps
// word boundaries; do not trim here.
func appServerReasoningDeltaText(params map[string]any) string {
	if delta := asStringRaw(params["delta"]); delta != "" {
		return delta
	}
	return asStringRaw(params["text"])
}

// reasoningSectionsText joins the non-empty sections of a reasoning
// summary/content value, separating sections with a blank line.
func reasoningSectionsText(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []string:
		return joinReasoningSectionTexts(typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, raw := range typed {
			if text := reasoningSectionText(raw); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n\n")
	default:
		return ""
	}
}

func joinReasoningSectionTexts(values []string) string {
	var b strings.Builder
	for _, value := range values {
		text := asStringRaw(value)
		if text == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString(text)
	}
	return b.String()
}

func reasoningSectionText(raw any) string {
	if text := asStringRaw(raw); text != "" {
		return text
	}
	item, ok := raw.(map[string]any)
	if !ok {
		return ""
	}
	return firstNonEmpty(
		asStringRaw(item["text"]),
		asStringRaw(item["summary_text"]),
		asStringRaw(item["summaryText"]),
		asStringRaw(item["summary"]),
		asStringRaw(item["content"]),
		asString(item["text"]),
		asString(item["summary_text"]),
		asString(item["summaryText"]),
		asString(item["summary"]),
		asString(item["content"]),
	)
}
