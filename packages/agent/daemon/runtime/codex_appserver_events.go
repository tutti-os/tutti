//revive:disable:file-length-limit
package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	switch message.Method {
	case appServerNotifyTurnStarted:
		// Record the provider turn id (needed for turn/interrupt and
		// turn/steer) only while a turn context is registered, so stray
		// turns (for example compaction) cannot block future prompts.
		if a.sessionActiveTurn(session.AgentSessionID) != nil {
			if turn := payloadObject(params["turn"]); turn != nil {
				providerTurnID := asString(turn["id"])
				if a.setSessionActiveTurnID(session.AgentSessionID, providerTurnID) {
					a.interruptActiveTurnAsync(&codexAppServerSession{
						client:   client,
						threadID: firstNonEmpty(asString(params["threadId"]), session.ProviderSessionID),
					}, session, providerTurnID, "queued cancel")
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
	case appServerNotifyReasoningDelta, appServerNotifyReasoningSummary:
		if normalizer == nil {
			return nil
		}
		return normalizer.AppendThinkingChunk(session, turnID, asStringRaw(params["delta"]))
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
		turnError := payloadObject(params["error"])
		detail := asString(turnError["message"])
		if willRetry, _ := params["willRetry"].(bool); willRetry {
			return []activityshared.Event{appServerSystemNoticeEvent(session, turnID, "transport_retry", "", detail)}
		}
		return []activityshared.Event{appServerSystemNoticeEvent(session, turnID, "warning", "Codex reported an error.", detail)}
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
	case appServerNotifyThreadStarted:
		return nil
	default:
		_ = emitCommands
		return nil
	}
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
	switch asString(item["type"]) {
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
	case "reasoning", "userMessage", "hookPrompt":
		return nil
	case "enteredReviewMode":
		return []activityshared.Event{appServerSystemNoticeEvent(session, turnID, "system_notice", "Code review started.", "")}
	case "exitedReviewMode":
		return []activityshared.Event{appServerSystemNoticeEvent(session, turnID, "system_notice", "Code review finished.", "")}
	case "contextCompaction":
		return []activityshared.Event{appServerSystemNoticeEvent(session, turnID, "system_notice", "Context compacted.", "")}
	default:
		update, ok := appServerItemToolCallUpdate(item, completed)
		if !ok {
			return nil
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
		update["rawInput"] = map[string]any{"changes": item["changes"]}
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
		query := asStringRaw(item["query"])
		update["title"] = "Searching for: " + query
		update["kind"] = "fetch"
		update["rawInput"] = map[string]any{
			"query":  query,
			"action": map[string]any{"type": "search", "query": query},
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
		update["title"] = firstNonEmpty(asString(item["tool"]), "agent")
		update["kind"] = "execute"
		update["rawInput"] = map[string]any{
			"task":      asStringRaw(item["prompt"]),
			"agentName": firstNonEmpty(asString(item["tool"]), "agent"),
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
	tokenUsage := payloadObject(params["tokenUsage"])
	if len(tokenUsage) == 0 {
		return
	}
	used, usedOK := firstACPInt64(payloadObject(tokenUsage["total"]), "totalTokens")
	if !usedOK {
		used, usedOK = firstACPInt64(payloadObject(tokenUsage["last"]), "totalTokens")
	}
	window, windowOK := firstACPInt64(tokenUsage, "modelContextWindow")
	if !usedOK || !windowOK {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return
	}
	appSession.usage = mergeACPUsageState(appSession.usage, acpUsageState{
		contextUsedTokens:   used,
		contextWindowTokens: window,
		contextKnown:        true,
	})
}

func (a *CodexAppServerAdapter) applyRateLimits(agentSessionID string, snapshot map[string]any) {
	if len(snapshot) == 0 {
		return
	}
	quotas := appServerRateLimitQuotas(snapshot)
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return
	}
	appSession.rateLimits = clonePayload(snapshot)
	if len(quotas) > 0 {
		appSession.usage = mergeACPUsageState(appSession.usage, acpUsageState{quotas: quotas})
	}
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

func appServerSystemNoticeEvent(session Session, turnID string, noticeKind string, title string, detail string) activityshared.Event {
	update := map[string]any{
		"sessionUpdate": "system_notice",
		"kind":          "agent_system_notice",
		"noticeKind":    noticeKind,
	}
	if title != "" {
		update["title"] = title
	}
	if detail != "" {
		update["detail"] = detail
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
	if summary := codexACPReasoningSummaryOverride(settings.Model); summary != "" {
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
	return params
}

func appServerTurnStartParams(session Session, threadID string, content []PromptContentBlock, planModeMask map[string]any, defaultModel string) map[string]any {
	settings := session.SettingsValue()
	params := map[string]any{
		"threadId": threadID,
		"input":    appServerUserInput(content),
	}
	if collaborationMode := appServerPlanCollaborationMode(settings, planModeMask, defaultModel); collaborationMode != nil {
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
	return params
}

// appServerPlanCollaborationMode assembles the turn/start collaborationMode
// payload. Collaboration mode is sticky thread state on the codex side, so
// once negotiation succeeded every turn declares its mode explicitly: the
// Plan preset while plan mode is on, the default mode otherwise (mirrors the
// codex TUI, which switches modes by submitting with the target mask). The
// schema requires a concrete settings.model — session override first, then
// the session default model, then the mask's own model; without any model
// the field is omitted rather than sending an invalid request.
func appServerPlanCollaborationMode(settings SessionSettings, planModeMask map[string]any, defaultModel string) map[string]any {
	if planModeMask == nil {
		return nil
	}
	model := strings.TrimSpace(firstNonEmpty(settings.Model, defaultModel, asString(planModeMask["model"])))
	if model == "" {
		return nil
	}
	collaborationSettings := map[string]any{
		"model": model,
		// null selects the built-in instructions for the mode.
		"developer_instructions": nil,
	}
	if effort := codexACPReasoningEffortValue(settings.ReasoningEffort); effort != "" {
		collaborationSettings["reasoning_effort"] = effort
	} else if settings.PlanMode {
		if presetEffort := strings.TrimSpace(asString(planModeMask["reasoning_effort"])); presetEffort != "" {
			collaborationSettings["reasoning_effort"] = presetEffort
		} else {
			collaborationSettings["reasoning_effort"] = nil
		}
	} else {
		collaborationSettings["reasoning_effort"] = nil
	}
	mode := "default"
	if settings.PlanMode {
		mode = strings.ToLower(strings.TrimSpace(firstNonEmpty(asString(planModeMask["mode"]), "plan")))
	}
	return map[string]any{
		"mode":     mode,
		"settings": collaborationSettings,
	}
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
		}
	}
	return out
}

func appServerReviewTarget(args string) map[string]any {
	args = strings.TrimSpace(args)
	if args == "" {
		return map[string]any{"type": "uncommittedChanges"}
	}
	return map[string]any{
		"type":         "custom",
		"instructions": args,
	}
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
