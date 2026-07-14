package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

const claudeSDKInteractiveAckTimeout = 30 * time.Second

type claudeSDKInteractiveAck struct {
	disposition InteractiveDisposition
	conflict    bool
	err         error
}

func (a *ClaudeCodeSDKAdapter) SubmitInteractive(ctx context.Context, session Session, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
	turnID := strings.TrimSpace(input.TurnID)
	if turnID == "" {
		return SubmitInteractiveResult{}, errors.New("interactive turn id is required")
	}
	requestID := strings.TrimSpace(input.RequestID)
	if requestID == "" {
		return SubmitInteractiveResult{}, errors.New("interactive request id is required")
	}
	adapterSession, pending := a.getClaudeSDKPendingRequestWithSession(session.AgentSessionID, turnID, requestID)
	if pending == nil {
		return SubmitInteractiveResult{}, fmt.Errorf("%w: %q", ErrInteractiveRequestNotLive, requestID)
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
	response := pendingInteractiveResponse{
		optionID: optionID,
		action:   strings.TrimSpace(input.Action),
		payload:  clonePayload(input.Payload),
	}
	if state, claimed := pending.beginResolving(); !claimed {
		if state == pendingInteractiveRequestStateResolving {
			ack := a.queryClaudeSDKInteractiveDisposition(ctx, session, adapterSession, pending, response)
			a.applyClaudeSDKInteractiveAck(adapterSession, session, pending, response, ack)
			if ack.conflict {
				return claudeSDKInteractiveConflictResult(session, requestID, optionID, ack.err)
			}
			return claudeSDKInteractiveSubmitResult(session, requestID, optionID, pending, ack.err)
		}
		return SubmitInteractiveResult{}, interactiveDispositionError(requestID, state)
	}
	if err := ctx.Err(); err != nil {
		pending.releaseResolving()
		return SubmitInteractiveResult{}, err
	}

	payload := map[string]any{
		"agentSessionId": session.AgentSessionID,
		"turnId":         turnID,
		"requestId":      requestID,
		"action":         response.action,
		"optionId":       optionID,
		"payload":        response.payload,
	}
	acknowledged := make(chan claudeSDKInteractiveAck, 1)
	go func() {
		ackTimeout := a.interactiveAckTimeout
		if ackTimeout <= 0 {
			ackTimeout = claudeSDKInteractiveAckTimeout
		}
		ackCtx, cancel := context.WithTimeout(context.Background(), ackTimeout)
		defer cancel()
		event, err := a.roundTripClaudeSDKResponse(ackCtx, session.AgentSessionID, adapterSession, claudeSDKSidecarRequest{
			ID:      newID(),
			Type:    "submit_interactive",
			Payload: payload,
		})
		ack := claudeSDKSubmitAckFromResponse(event, err)
		if err != nil && (event.Type != "error" || payloadBoolValue(event.Payload, "transport")) {
			queryCtx, queryCancel := context.WithTimeout(context.Background(), ackTimeout)
			ack = a.queryClaudeSDKInteractiveDisposition(queryCtx, session, adapterSession, pending, response)
			queryCancel()
			if ack.err != nil {
				ack.err = fmt.Errorf("submit interactive acknowledgment is uncertain (%v); disposition query failed: %w", err, ack.err)
			}
		}
		a.applyClaudeSDKInteractiveAck(adapterSession, session, pending, response, ack)
		acknowledged <- ack
	}()
	select {
	case ack := <-acknowledged:
		if ack.conflict {
			return claudeSDKInteractiveConflictResult(session, requestID, optionID, ack.err)
		}
		if ack.disposition == InteractiveDispositionPending {
			return claudeSDKInteractiveSubmitResult(session, requestID, optionID, pending, ack.err)
		}
		if ack.err != nil && runtimeInteractiveDisposition(pending) != InteractiveDispositionAnswered {
			return claudeSDKInteractiveSubmitResult(session, requestID, optionID, pending, ack.err)
		}
	case <-ctx.Done():
		return SubmitInteractiveResult{}, ctx.Err()
	}
	if state, err := pending.waitForDisposition(ctx); err != nil {
		return claudeSDKInteractiveSubmitResult(session, requestID, optionID, pending, err)
	} else if state != pendingInteractiveRequestStateAnswered {
		return claudeSDKInteractiveSubmitResult(session, requestID, optionID, pending, interactiveDispositionError(requestID, state))
	}
	return claudeSDKInteractiveSubmitResult(session, requestID, optionID, pending, nil)
}

func claudeSDKInteractiveConflictResult(session Session, requestID string, optionID string, err error) (SubmitInteractiveResult, error) {
	return SubmitInteractiveResult{
		AgentSessionID: session.AgentSessionID,
		RequestID:      requestID,
		OptionID:       optionID,
		Disposition:    InteractiveDispositionUnknown,
	}, err
}

func claudeSDKInteractiveSubmitResult(session Session, requestID string, optionID string, pending *pendingInteractiveRequest, err error) (SubmitInteractiveResult, error) {
	disposition := runtimeInteractiveDisposition(pending)
	if err == nil && disposition != InteractiveDispositionAnswered {
		err = interactiveDispositionError(requestID, pending.disposition())
	}
	return SubmitInteractiveResult{
		AgentSessionID: session.AgentSessionID,
		RequestID:      requestID,
		Accepted:       disposition == InteractiveDispositionAnswered,
		OptionID:       optionID,
		Disposition:    disposition,
	}, err
}

func claudeSDKSubmitAckFromResponse(event claudeSDKSidecarEvent, err error) claudeSDKInteractiveAck {
	if event.Type == "error" {
		if payloadBoolValue(event.Payload, "transport") {
			return claudeSDKInteractiveAck{disposition: InteractiveDispositionResolving, err: err}
		}
		return claudeSDKInteractiveAck{disposition: InteractiveDispositionSuperseded, err: err}
	}
	return claudeSDKDispositionFromResponse(event, err)
}

func claudeSDKDispositionQueryFromResponse(event claudeSDKSidecarEvent, err error) claudeSDKInteractiveAck {
	if event.Type == "error" {
		if err == nil {
			err = errors.New("interactive disposition query failed")
		}
		return claudeSDKInteractiveAck{disposition: InteractiveDispositionResolving, err: err}
	}
	return claudeSDKDispositionFromResponse(event, err)
}

func claudeSDKDispositionFromResponse(event claudeSDKSidecarEvent, err error) claudeSDKInteractiveAck {
	switch payloadString(event.Payload, "disposition") {
	case string(InteractiveDispositionPending):
		return claudeSDKInteractiveAck{disposition: InteractiveDispositionPending, err: err}
	case string(InteractiveDispositionAnswered):
		return claudeSDKInteractiveAck{disposition: InteractiveDispositionAnswered, err: err}
	case string(InteractiveDispositionSuperseded):
		return claudeSDKInteractiveAck{disposition: InteractiveDispositionSuperseded, err: err}
	case "conflict":
		return claudeSDKInteractiveAck{disposition: InteractiveDispositionUnknown, conflict: true, err: errors.New("interactive response conflicts with the sidecar terminal result")}
	case "unknown":
		if err == nil {
			err = errors.New("interactive request has unknown sidecar disposition")
		}
		return claudeSDKInteractiveAck{disposition: InteractiveDispositionResolving, err: err}
	default:
		return claudeSDKInteractiveAck{disposition: InteractiveDispositionUnknown, err: err}
	}
}

func (a *ClaudeCodeSDKAdapter) queryClaudeSDKInteractiveDisposition(
	ctx context.Context,
	session Session,
	adapterSession *claudeSDKAdapterSession,
	pending *pendingInteractiveRequest,
	response pendingInteractiveResponse,
) claudeSDKInteractiveAck {
	event, err := a.roundTripClaudeSDKResponse(ctx, session.AgentSessionID, adapterSession, claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "interactive_disposition",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
			"turnId":         pending.turnID,
			"requestId":      pending.requestID,
			"action":         response.action,
			"optionId":       response.optionID,
			"payload":        response.payload,
		},
	})
	ack := claudeSDKDispositionQueryFromResponse(event, err)
	if ack.disposition == InteractiveDispositionUnknown {
		ack.disposition = InteractiveDispositionResolving
		if ack.err == nil {
			ack.err = errors.New("interactive disposition query returned no disposition")
		}
	}
	return ack
}

func (a *ClaudeCodeSDKAdapter) applyClaudeSDKInteractiveAck(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	pending *pendingInteractiveRequest,
	response pendingInteractiveResponse,
	ack claudeSDKInteractiveAck,
) {
	var state pendingInteractiveRequestState
	var terminalErr error
	switch ack.disposition {
	case InteractiveDispositionAnswered:
		state = pendingInteractiveRequestStateAnswered
	case InteractiveDispositionSuperseded:
		state = pendingInteractiveRequestStateSuperseded
		terminalErr = ack.err
		if terminalErr == nil {
			terminalErr = errors.New("interactive request was superseded by the provider")
		}
	case InteractiveDispositionPending:
		pending.releaseResolving()
		return
	default:
		return
	}
	if !pending.finish(state) {
		return
	}
	events := normalizedPermissionResolvedEvents(session, pending.turnID, pending, response, terminalErr)
	events = a.stampTurnLifecycleSnapshots(adapterSession, events)
	a.updateClaudeSDKSessionSnapshot(adapterSession, events)
	if waiter := a.claudeSDKTurnWaiter(adapterSession, pending.turnID); waiter != nil {
		a.completeClaudeSDKWaiterEvent(adapterSession, waiter, pending.turnID, events, false, nil)
		return
	}
	a.emitClaudeSDKSessionEvents(session.AgentSessionID, events)
}

func (a *ClaudeCodeSDKAdapter) InteractiveDisposition(session Session, turnID string, requestID string) InteractiveDisposition {
	if pending := a.getClaudeSDKPendingRequest(session.AgentSessionID, turnID, requestID); pending != nil {
		return runtimeInteractiveDisposition(pending)
	}
	return a.terminalInteractiveDisposition(session.AgentSessionID, turnID, requestID)
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
	input := normalizedApprovalInput(toolCall, options, requestID, nil)
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
		normalizedInteractionRequestedEvent(session, turnID, pending),
	}, nil
}

func (a *ClaudeCodeSDKAdapter) claudeSDKInteractiveResolved(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	turnID string,
	payload map[string]any,
) []activityshared.Event {
	requestID := payloadString(payload, "requestId")
	eventTurnID := firstNonEmptyString(
		strings.TrimSpace(turnID),
		payloadString(payload, "turnId"),
		payloadString(payload, "turnID"),
	)
	pending := a.getClaudeSDKPendingRequest(session.AgentSessionID, eventTurnID, requestID)
	if pending == nil && eventTurnID == "" {
		pending = a.getUniqueClaudeSDKPendingRequestByRequestID(session.AgentSessionID, requestID)
	}
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
		if !pending.finish(pendingInteractiveRequestStateSuperseded) {
			return nil
		}
		return normalizedPermissionResolvedEvents(session, effectiveTurnID, pending, pendingInteractiveResponse{}, errors.New(errText))
	}
	if !pending.finish(pendingInteractiveRequestStateAnswered) {
		return nil
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
	for _, request := range adapterSession.pendingRequests {
		pending = append(pending, request)
	}
	a.mu.Unlock()
	events := make([]activityshared.Event, 0, len(pending))
	for _, request := range pending {
		if !request.finish(pendingInteractiveRequestStateSuperseded) {
			continue
		}
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
	pending.onTerminal = a.recordTerminalInteractiveRequest
	a.mu.Lock()
	defer a.mu.Unlock()
	if adapterSession.pendingRequests == nil {
		adapterSession.pendingRequests = make(map[string]*pendingInteractiveRequest)
	}
	adapterSession.pendingRequests[claudeSDKPendingRequestKey(pending.turnID, pending.requestID)] = pending
}

func (a *ClaudeCodeSDKAdapter) getClaudeSDKPendingRequest(agentSessionID string, turnID string, requestID string) *pendingInteractiveRequest {
	_, pending := a.getClaudeSDKPendingRequestWithSession(agentSessionID, turnID, requestID)
	return pending
}

func (a *ClaudeCodeSDKAdapter) getClaudeSDKPendingRequestWithSession(agentSessionID string, turnID string, requestID string) (*claudeSDKAdapterSession, *pendingInteractiveRequest) {
	if a == nil {
		return nil, nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	adapterSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if adapterSession == nil || adapterSession.invalid {
		return nil, nil
	}
	return adapterSession, adapterSession.pendingRequests[claudeSDKPendingRequestKey(turnID, requestID)]
}

func (a *ClaudeCodeSDKAdapter) getUniqueClaudeSDKPendingRequestByRequestID(agentSessionID string, requestID string) *pendingInteractiveRequest {
	adapterSession := a.getSession(agentSessionID)
	if adapterSession == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if adapterSession.pendingRequests == nil {
		return nil
	}
	requestID = strings.TrimSpace(requestID)
	var match *pendingInteractiveRequest
	for _, pending := range adapterSession.pendingRequests {
		if strings.TrimSpace(pending.requestID) != requestID {
			continue
		}
		if match != nil {
			return nil
		}
		match = pending
	}
	return match
}

func claudeSDKPendingRequestKey(turnID string, requestID string) string {
	return strings.TrimSpace(turnID) + "\x00" + strings.TrimSpace(requestID)
}

func (a *ClaudeCodeSDKAdapter) recordTerminalInteractiveRequest(pending *pendingInteractiveRequest, state pendingInteractiveRequestState) {
	if a == nil || pending == nil {
		return
	}
	disposition := interactiveDispositionFromState(state)
	key := newInteractiveRequestKey(pending.agentSessionID, pending.turnID, pending.requestID)
	a.mu.Lock()
	if adapterSession := a.sessions[key.agentSessionID]; adapterSession != nil && adapterSession.pendingRequests != nil {
		mapKey := claudeSDKPendingRequestKey(key.turnID, key.requestID)
		if adapterSession.pendingRequests[mapKey] == pending {
			delete(adapterSession.pendingRequests, mapKey)
		}
	}
	a.terminalInteractions.put(key, disposition)
	sink := a.interactiveDispositionSink
	a.mu.Unlock()
	if sink != nil {
		sink(key.agentSessionID, key.turnID, key.requestID, disposition)
	}
}

func (a *ClaudeCodeSDKAdapter) SetInteractiveDispositionSink(sink InteractiveDispositionSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.interactiveDispositionSink = sink
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) terminalInteractiveDisposition(agentSessionID string, turnID string, requestID string) InteractiveDisposition {
	if a == nil {
		return InteractiveDispositionUnknown
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.terminalInteractions.get(newInteractiveRequestKey(agentSessionID, turnID, requestID))
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
		if prompt := pending.snapshotPrompt(); prompt != nil {
			return prompt
		}
	}
	return nil
}
