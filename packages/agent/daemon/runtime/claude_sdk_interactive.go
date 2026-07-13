package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *ClaudeCodeSDKAdapter) SubmitInteractive(ctx context.Context, session Session, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
	requestID := strings.TrimSpace(input.RequestID)
	if requestID == "" {
		return SubmitInteractiveResult{}, errors.New("interactive request id is required")
	}
	pending := a.getClaudeSDKPendingRequest(session.AgentSessionID, requestID)
	if pending == nil {
		return SubmitInteractiveResult{}, fmt.Errorf("%w: %q", ErrInteractiveRequestNotLive, requestID)
	}
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return SubmitInteractiveResult{}, ErrSessionDisconnected
	}

	optionID := strings.TrimSpace(input.OptionID)
	if optionID == "" && input.Payload != nil {
		optionID = strings.TrimSpace(asString(input.Payload["optionId"]))
	}
	if pending.callType == "approval" {
		if optionID == "" {
			return SubmitInteractiveResult{}, errors.New("interactive option id is required")
		}
		resolvedOptionID, ok := pending.resolvePermissionOptionID(optionID)
		if !ok {
			return SubmitInteractiveResult{}, fmt.Errorf("permission option %q is not available for request %q", optionID, requestID)
		}
		optionID = resolvedOptionID
	}

	payload := map[string]any{
		"agentSessionId": session.AgentSessionID,
		"requestId":      requestID,
		"action":         strings.TrimSpace(input.Action),
		"optionId":       optionID,
		"payload":        clonePayload(input.Payload),
	}
	select {
	case <-ctx.Done():
		return SubmitInteractiveResult{}, ctx.Err()
	default:
	}
	if err := adapterSession.send(claudeSDKSidecarRequest{
		ID:      newID(),
		Type:    "submit_interactive",
		Payload: payload,
	}); err != nil {
		return SubmitInteractiveResult{}, err
	}
	return SubmitInteractiveResult{
		AgentSessionID: session.AgentSessionID,
		RequestID:      requestID,
		Accepted:       true,
		OptionID:       optionID,
	}, nil
}

func (*ClaudeCodeSDKAdapter) StateAfterInteractiveSelection(
	_ Session,
	optionID string,
) (InteractiveSelectionState, bool) {
	planMode, permissionMode, ok := claudeCodeModeFromID(optionID)
	return InteractiveSelectionState{
		PlanMode:       planMode,
		PermissionMode: permissionMode,
	}, ok
}

func (*ClaudeCodeSDKAdapter) ControllerSendsInteractiveDenyFollowUp() bool {
	return false
}

// claudeCodeModeFromID owns the SDK's interactive option vocabulary. The
// controller only receives the generic settings projection above.
func claudeCodeModeFromID(optionID string) (bool, string, bool) {
	switch strings.TrimSpace(optionID) {
	case "plan":
		return true, "", true
	case "default", "acceptEdits", "dontAsk", "bypassPermissions":
		return false, strings.TrimSpace(optionID), true
	case "auto":
		// Older sidecars used "auto" for the accept-edits exit-plan choice.
		return false, "acceptEdits", true
	default:
		return false, "", false
	}
}

func (a *ClaudeCodeSDKAdapter) claudeSDKInteractiveRequested(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	turnID string,
	payload map[string]any,
) ([]activityshared.Event, error) {
	requestID := firstNonEmpty(payloadString(payload, "requestId"), payloadString(payload, "id"), newID())
	toolCall := claudeSDKInteractiveToolCall(payload, requestID)
	options := claudeSDKInteractiveOptions(payload, toolCall)
	interactivePrompt := normalizedInteractivePrompt(toolCall, options, requestID)
	title := firstNonEmpty(
		asString(toolCall["title"]),
		asString(toolCall["name"]),
		asString(toolCall["toolName"]),
		asString(toolCall["toolCallId"]),
		"Permission requested",
	)
	callID := "approval:" + requestID
	callType := "approval"
	status := string(activityshared.TurnPhaseWaitingApproval)
	input := normalizedApprovalInput(toolCall, options, requestID)
	eventPayload := map[string]any{
		"callId":   callID,
		"callType": "approval",
		"name":     title,
		"toolName": "Approval",
		"status":   status,
		"input":    input,
	}
	if interactivePrompt != nil {
		callType = "interactive"
		callID = firstNonEmpty(asString(toolCall["toolCallId"]), asString(toolCall["id"]), requestID)
		title = firstNonEmpty(interactivePrompt.ToolName, title)
		status = firstNonEmpty(interactivePrompt.Status, "waiting_input")
		input = clonePayload(interactivePrompt.Input)
		if input == nil {
			input = map[string]any{}
		}
		input["requestId"] = requestID
		if len(options) > 0 {
			input["options"] = cloneOptionMaps(options)
		}
		eventPayload = map[string]any{
			"callId":   callID,
			"callType": callType,
			"name":     title,
			"toolName": interactivePrompt.ToolName,
			"status":   status,
			"input":    input,
		}
		if metadata := clonePayload(interactivePrompt.Metadata); metadata != nil {
			eventPayload["metadata"] = metadata
		}
	}
	pending := &pendingInteractiveRequest{
		agentSessionID: strings.TrimSpace(session.AgentSessionID),
		requestID:      requestID,
		eventID:        newID(),
		callID:         callID,
		callType:       callType,
		turnID:         strings.TrimSpace(turnID),
		input:          input,
		kind:           firstNonEmpty(interactivePromptKind(interactivePrompt), "approval"),
		name:           title,
		toolName:       firstNonEmpty(asString(eventPayload["toolName"]), title),
		prompt:         interactivePrompt,
		options:        options,
		response:       make(chan pendingInteractiveResponse, 1),
	}
	a.storeClaudeSDKPendingRequest(adapterSession, pending)
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
			eventPayload,
		),
	}, nil
}

func (a *ClaudeCodeSDKAdapter) claudeSDKInteractiveResolved(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	turnID string,
	payload map[string]any,
) []activityshared.Event {
	requestID := payloadString(payload, "requestId")
	pending := a.deleteClaudeSDKPendingRequest(adapterSession, requestID)
	if pending == nil {
		return nil
	}
	effectiveTurnID := firstNonEmptyString(
		strings.TrimSpace(turnID),
		payloadString(payload, "turnId"),
		payloadString(payload, "turnID"),
		pending.turnID,
	)
	if adapterSession != nil {
		effectiveTurnID = adapterSession.backgroundAgentTurnID(payload, effectiveTurnID)
	}
	response := pendingInteractiveResponse{
		optionID: firstNonEmpty(payloadString(payload, "optionId"), payloadString(payload, "selectedId")),
		action:   payloadString(payload, "action"),
		payload:  payloadMap(payload, "payload"),
	}
	if errText := payloadString(payload, "error"); errText != "" {
		return normalizedPermissionResolvedEvents(session, effectiveTurnID, pending, pendingInteractiveResponse{}, errors.New(errText))
	}
	return normalizedPermissionResolvedEvents(session, effectiveTurnID, pending, response, nil)
}

func (a *ClaudeCodeSDKAdapter) claudeSDKPendingRequestFailureEvents(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	turnID string,
	err error,
) []activityshared.Event {
	if a == nil || adapterSession == nil {
		return nil
	}
	a.mu.Lock()
	pending := make([]*pendingInteractiveRequest, 0, len(adapterSession.pendingRequests))
	for requestID, request := range adapterSession.pendingRequests {
		pending = append(pending, request)
		delete(adapterSession.pendingRequests, requestID)
	}
	a.mu.Unlock()
	events := make([]activityshared.Event, 0, len(pending))
	for _, request := range pending {
		effectiveTurnID := firstNonEmptyString(strings.TrimSpace(turnID), request.turnID)
		events = append(events, normalizedPermissionResolvedEvents(session, effectiveTurnID, request, pendingInteractiveResponse{}, err)...)
	}
	return events
}

func claudeSDKInteractiveToolCall(payload map[string]any, requestID string) map[string]any {
	toolCall := clonePayload(payloadMap(payload, "toolCall"))
	if toolCall == nil {
		toolCall = map[string]any{}
	}
	toolName := firstNonEmpty(
		payloadString(payload, "toolName"),
		asString(toolCall["toolName"]),
		asString(toolCall["name"]),
		asString(toolCall["title"]),
	)
	if toolName == "" {
		toolName = "Approval"
	}
	toolCall["toolName"] = toolName
	toolCall["name"] = firstNonEmpty(asString(toolCall["name"]), toolName)
	toolCall["title"] = firstNonEmpty(asString(toolCall["title"]), toolName)
	toolCall["toolCallId"] = firstNonEmpty(
		payloadString(payload, "toolCallId"),
		asString(toolCall["toolCallId"]),
		asString(toolCall["id"]),
		requestID,
	)
	if input := payloadMap(payload, "input"); len(input) > 0 {
		toolCall["input"] = clonePayload(input)
	}
	return toolCall
}

func claudeSDKInteractiveOptions(payload map[string]any, toolCall map[string]any) []map[string]any {
	if options := cloneOptionMaps(payloadArray(payload["options"])); len(options) > 0 {
		return options
	}
	switch normalizedInteractiveToolName(toolCall) {
	case "AskUserQuestion":
		return nil
	case "ExitPlanMode":
		return []map[string]any{
			{"kind": "allow_always", "name": "Yes, and auto-accept edits", "optionId": "acceptEdits"},
			{"kind": "allow_once", "name": "Yes, and manually approve edits", "optionId": "default"},
			{"kind": "reject_once", "name": "No, keep planning", "optionId": "plan"},
		}
	default:
		return []map[string]any{
			{"kind": "allow_always", "name": "Allow for session", "optionId": "allow_always"},
			{"kind": "allow_once", "name": "Allow", "optionId": "allow"},
			{"kind": "reject_once", "name": "Reject", "optionId": "reject"},
		}
	}
}

func (a *ClaudeCodeSDKAdapter) storeClaudeSDKPendingRequest(adapterSession *claudeSDKAdapterSession, pending *pendingInteractiveRequest) {
	if a == nil || adapterSession == nil || pending == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if adapterSession.pendingRequests == nil {
		adapterSession.pendingRequests = make(map[string]*pendingInteractiveRequest)
	}
	adapterSession.pendingRequests[strings.TrimSpace(pending.requestID)] = pending
}

func (a *ClaudeCodeSDKAdapter) getClaudeSDKPendingRequest(agentSessionID string, requestID string) *pendingInteractiveRequest {
	adapterSession := a.getSession(agentSessionID)
	if adapterSession == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if adapterSession.pendingRequests == nil {
		return nil
	}
	return adapterSession.pendingRequests[strings.TrimSpace(requestID)]
}

func (a *ClaudeCodeSDKAdapter) deleteClaudeSDKPendingRequest(adapterSession *claudeSDKAdapterSession, requestID string) *pendingInteractiveRequest {
	if a == nil || adapterSession == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if adapterSession.pendingRequests == nil {
		return nil
	}
	pending := adapterSession.pendingRequests[strings.TrimSpace(requestID)]
	delete(adapterSession.pendingRequests, strings.TrimSpace(requestID))
	return pending
}

func (a *ClaudeCodeSDKAdapter) claudeSDKPendingInteractive(adapterSession *claudeSDKAdapterSession) *SessionInteractivePrompt {
	if a == nil || adapterSession == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(adapterSession.pendingRequests) == 0 {
		return nil
	}
	for _, pending := range adapterSession.pendingRequests {
		return pending.snapshotPrompt()
	}
	return nil
}
