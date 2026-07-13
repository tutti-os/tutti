package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *CodexAppServerAdapter) appServerServerRequest(
	ctx context.Context,
	client *codexAppServerClient,
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
	go a.respondAppServerServerRequest(ctx, client, session, turnID, message, params, pending, emit)
	return nil, nil
}

func (a *CodexAppServerAdapter) respondAppServerServerRequest(
	ctx context.Context,
	client *codexAppServerClient,
	session Session,
	turnID string,
	message acpMessage,
	params map[string]any,
	pending *pendingInteractiveRequest,
	emit EventSink,
) {
	if pending == nil {
		return
	}
	defer a.deletePendingRequest(session.AgentSessionID, pending.requestID)
	selection, err := pending.wait(ctx)
	if err != nil {
		resolved := normalizedPermissionResolvedEvents(session, turnID, pending, pendingInteractiveResponse{}, err)
		// The shared error path emits only call.failed; append the
		// back-to-running turn.updated so the lifecycle cannot strand in
		// waiting_approval when a request is rejected or canceled.
		resolved = append(resolved, newTurnActivityEvent(session, EventTurnUpdated, turnID, SessionStatusWorking, "", "", map[string]any{
			"phase":     string(activityshared.TurnPhaseWorking),
			"requestId": pending.requestID,
		}))
		if emit != nil {
			emit(resolved)
		}
		_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32000, Message: err.Error()})
		return
	}
	if selection.outOfBandResolved {
		resolved := acpPermissionOutOfBandResolvedEvents(session, turnID, pending)
		if emit != nil {
			emit(resolved)
		}
		return
	}
	resolved := normalizedPermissionResolvedEvents(session, turnID, pending, selection, nil)
	if emit != nil {
		emit(resolved)
	}
	result, responseErr := appServerApprovalResult(message.Method, params, selection)
	if err := client.Respond(ctx, message.ID, result, responseErr); err != nil {
		if emit != nil {
			emit(normalizedPermissionResolvedEvents(session, turnID, pending, selection, err))
		}
		return
	}
}

func (a *CodexAppServerAdapter) appServerApprovalRequested(
	session Session,
	turnID string,
	rawRequestID json.RawMessage,
	method string,
	params map[string]any,
) ([]activityshared.Event, *pendingInteractiveRequest, error) {
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
	input := normalizedApprovalInput(toolCall, options, requestID)
	payload := map[string]any{
		"callId":   callID,
		"callType": "approval",
		"name":     title,
		"toolName": "Approval",
		"status":   status,
		"input":    input,
	}
	pending := &pendingInteractiveRequest{
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
		response:       make(chan pendingInteractiveResponse, 1),
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

func appServerUnsupportedServerRequestEvents(
	session Session,
	turnID string,
	message acpMessage,
	err error,
) []activityshared.Event {
	if strings.TrimSpace(turnID) == "" || err == nil {
		return nil
	}
	requestID := acpRequestID(message.ID)
	callID := firstNonEmpty(requestID, newID())
	return []activityshared.Event{
		newTurnActivityEventWithID(
			session,
			"server-request:"+callID,
			EventCallFailed,
			turnID,
			messageStreamStateFailed,
			"",
			"Unsupported server request",
			map[string]any{
				"callId":   callID,
				"callType": "server_request",
				"name":     "Unsupported server request",
				"toolName": "ServerRequest",
				"status":   messageStreamStateFailed,
				"error": map[string]any{
					"requestId": requestID,
					"method":    message.Method,
					"message":   err.Error(),
				},
			},
		),
	}
}

func (a *CodexAppServerAdapter) appServerUserInputRequested(
	session Session,
	turnID string,
	requestID string,
	params map[string]any,
) ([]activityshared.Event, *pendingInteractiveRequest, error) {
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
	pending := &pendingInteractiveRequest{
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
		response:       make(chan pendingInteractiveResponse, 1),
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
		command := normalizedApprovalDisplayCommand(params["command"])
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

func appServerApprovalResult(method string, params map[string]any, selection pendingInteractiveResponse) (any, *acpError) {
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

func appServerUserInputAnswers(params map[string]any, selection pendingInteractiveResponse) map[string]any {
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
// reasoning via summaryTextDelta; the ACP transport disables summaries for
// spark, but app-server review still needs them.
