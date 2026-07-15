package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type pendingInteractiveRequest struct {
	agentSessionID string
	requestID      string
	eventID        string
	callID         string
	callType       string
	turnID         string
	// providerTurnID is transport correlation; turnID remains canonical ownership.
	providerTurnID string
	input          map[string]any
	kind           string
	name           string
	toolName       string
	prompt         *SessionInteractivePrompt
	options        []map[string]any
	response       chan pendingInteractiveResponse
	stateMu        sync.Mutex
	state          pendingInteractiveRequestState
	done           chan struct{}
	onTerminal     func(*pendingInteractiveRequest, pendingInteractiveRequestState)
}

func (p *pendingInteractiveRequest) beginResolving() (pendingInteractiveRequestState, bool) {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	if p.state == "" {
		p.state = pendingInteractiveRequestStatePending
	}
	if p.done == nil {
		p.done = make(chan struct{})
	}
	if p.state == pendingInteractiveRequestStatePending {
		p.state = pendingInteractiveRequestStateResolving
		return pendingInteractiveRequestStateResolving, true
	}
	return p.state, false
}

func (p *pendingInteractiveRequest) releaseResolving() bool {
	if p == nil {
		return false
	}
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	if p.state != pendingInteractiveRequestStateResolving {
		return false
	}
	p.state = pendingInteractiveRequestStatePending
	return true
}

// dispatchResponse linearizes delivery to the provider-side responder with the
// pending -> resolving transition. A canceled caller that has not dispatched
// anything leaves the request pending so the durable operation can retry.
func (p *pendingInteractiveRequest) dispatchResponse(ctx context.Context, response pendingInteractiveResponse) (pendingInteractiveRequestState, error) {
	if p == nil {
		return "", errors.New("interactive request is not live")
	}
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	if p.state == "" {
		p.state = pendingInteractiveRequestStatePending
	}
	if p.done == nil {
		p.done = make(chan struct{})
	}
	if p.state != pendingInteractiveRequestStatePending {
		return p.state, interactiveDispositionError(p.requestID, p.state)
	}
	if err := ctx.Err(); err != nil {
		return p.state, err
	}
	select {
	case p.response <- response:
		p.state = pendingInteractiveRequestStateResolving
		return p.state, nil
	default:
		return p.state, fmt.Errorf("interactive response channel is unavailable for request %q", p.requestID)
	}
}

func (p *pendingInteractiveRequest) finish(state pendingInteractiveRequestState) bool {
	if p == nil {
		return false
	}
	p.stateMu.Lock()
	if p.done == nil {
		p.done = make(chan struct{})
	}
	if p.state == pendingInteractiveRequestStateAnswered ||
		p.state == pendingInteractiveRequestStateSuperseded ||
		p.state == pendingInteractiveRequestStateInterrupted {
		p.stateMu.Unlock()
		return false
	}
	p.state = state
	close(p.done)
	onTerminal := p.onTerminal
	p.stateMu.Unlock()
	if onTerminal != nil {
		onTerminal(p, state)
	}
	return true
}

func (p *pendingInteractiveRequest) disposition() pendingInteractiveRequestState {
	if p == nil {
		return ""
	}
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	if p.state == "" {
		return pendingInteractiveRequestStatePending
	}
	return p.state
}

func (p *pendingInteractiveRequest) waitForDisposition(ctx context.Context) (pendingInteractiveRequestState, error) {
	p.stateMu.Lock()
	if p.done == nil {
		p.done = make(chan struct{})
	}
	done := p.done
	p.stateMu.Unlock()
	select {
	case <-ctx.Done():
		return p.disposition(), ctx.Err()
	case <-done:
		return p.disposition(), nil
	}
}

func runtimeInteractiveDisposition(pending *pendingInteractiveRequest) InteractiveDisposition {
	if pending == nil {
		return InteractiveDispositionUnknown
	}
	return interactiveDispositionFromState(pending.disposition())
}

func interactiveDispositionFromState(state pendingInteractiveRequestState) InteractiveDisposition {
	switch state {
	case pendingInteractiveRequestStatePending:
		return InteractiveDispositionPending
	case pendingInteractiveRequestStateResolving:
		return InteractiveDispositionResolving
	case pendingInteractiveRequestStateAnswered:
		return InteractiveDispositionAnswered
	case pendingInteractiveRequestStateSuperseded:
		return InteractiveDispositionSuperseded
	case pendingInteractiveRequestStateInterrupted:
		return InteractiveDispositionInterrupted
	default:
		return InteractiveDispositionUnknown
	}
}

const terminalInteractiveDispositionCapacity = 1024

type terminalInteractiveDispositionStore struct {
	entries map[interactiveRequestKey]InteractiveDisposition
	order   []interactiveRequestKey
}

func (s *terminalInteractiveDispositionStore) put(key interactiveRequestKey, disposition InteractiveDisposition) {
	if key.agentSessionID == "" || key.turnID == "" || key.requestID == "" {
		return
	}
	if disposition != InteractiveDispositionAnswered &&
		disposition != InteractiveDispositionSuperseded &&
		disposition != InteractiveDispositionInterrupted {
		return
	}
	if s.entries == nil {
		s.entries = make(map[interactiveRequestKey]InteractiveDisposition)
	}
	if _, exists := s.entries[key]; exists {
		return
	}
	s.order = append(s.order, key)
	s.entries[key] = disposition
	for len(s.order) > terminalInteractiveDispositionCapacity {
		oldest := s.order[0]
		s.order = s.order[1:]
		delete(s.entries, oldest)
	}
}

func (s *terminalInteractiveDispositionStore) get(key interactiveRequestKey) InteractiveDisposition {
	if s == nil || s.entries == nil {
		return InteractiveDispositionUnknown
	}
	if disposition, ok := s.entries[key]; ok {
		return disposition
	}
	return InteractiveDispositionUnknown
}

func interactiveDispositionError(requestID string, state pendingInteractiveRequestState) error {
	switch state {
	case pendingInteractiveRequestStateAnswered:
		return fmt.Errorf("%w: %q", ErrInteractiveAlreadyAnswered, requestID)
	case pendingInteractiveRequestStateResolving:
		return fmt.Errorf("%w: %q is resolving", ErrInteractiveAlreadyAnswered, requestID)
	default:
		return fmt.Errorf("%w: %q", ErrInteractiveRequestNotLive, requestID)
	}
}

type pendingInteractiveResponse struct {
	optionID          string
	action            string
	payload           map[string]any
	result            map[string]any
	err               error
	outOfBandResolved bool
}

func (p *pendingInteractiveRequest) wait(ctx context.Context) (pendingInteractiveResponse, error) {
	if p == nil {
		return pendingInteractiveResponse{}, errors.New("permission request is not live")
	}
	select {
	case <-ctx.Done():
		return pendingInteractiveResponse{}, ctx.Err()
	case selection := <-p.response:
		if selection.outOfBandResolved {
			return selection, nil
		}
		if selection.err != nil {
			return pendingInteractiveResponse{}, selection.err
		}
		return selection, nil
	}
}

func (p *pendingInteractiveRequest) reject(err error) {
	if p == nil {
		return
	}
	if err == nil {
		err = errPermissionRequestCanceled
	}
	if !p.finish(pendingInteractiveRequestStateInterrupted) {
		return
	}
	select {
	case p.response <- pendingInteractiveResponse{err: err}:
	default:
	}
}

func cloneOptionMaps(in []map[string]any) []map[string]any {
	if len(in) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(in))
	for _, item := range in {
		out = append(out, clonePayload(item))
	}
	return out
}

func (p *pendingInteractiveRequest) hasOption(optionID string) bool {
	optionID = strings.TrimSpace(optionID)
	if p == nil || optionID == "" {
		return false
	}
	for _, option := range p.options {
		if firstNonEmpty(asString(option["optionId"]), asString(option["id"])) == optionID {
			return true
		}
	}
	return false
}

func (p *pendingInteractiveRequest) resolvePermissionOptionID(optionID string) (string, bool) {
	optionID = strings.TrimSpace(optionID)
	if p == nil || optionID == "" {
		return "", false
	}
	if p.hasOption(optionID) {
		return optionID, true
	}
	decision := permissionOptionDecision(optionID)
	if decision == "" {
		return "", false
	}
	aliases := permissionOptionDecisionAliases(decision)
	for _, option := range p.options {
		resolvedOptionID := firstNonEmpty(asString(option["optionId"]), asString(option["id"]))
		if resolvedOptionID == "" {
			continue
		}
		for _, value := range []string{
			resolvedOptionID,
			asString(option["kind"]),
			asString(option["name"]),
			asString(option["label"]),
		} {
			token := normalizePermissionOptionToken(value)
			if token == "" {
				continue
			}
			for _, alias := range aliases {
				if token == alias {
					return resolvedOptionID, true
				}
			}
		}
	}
	return "", false
}

func permissionOptionDecision(value string) string {
	switch normalizePermissionOptionToken(value) {
	case "approve", "approved", "allow", "allowed", "allowonce", "accept", "accepted", "acceptedits", "confirm", "confirmed", "ok", "proceed", "yes":
		return "approved"
	case "deny", "denied", "disallow", "reject", "rejected", "rejectonce", "decline", "declined", "no":
		return "denied"
	default:
		return ""
	}
}

func permissionOptionDecisionAliases(decision string) []string {
	switch decision {
	case "approved":
		return []string{"approve", "approved", "allow", "allowed", "allowonce", "accept", "accepted", "acceptedits", "confirm", "confirmed", "ok", "proceed", "yes"}
	case "denied":
		return []string{"deny", "denied", "disallow", "reject", "rejected", "rejectonce", "decline", "declined", "no"}
	default:
		return nil
	}
}

func normalizePermissionOptionToken(value string) string {
	var builder strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(value)) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func normalizedPermissionResolvedEvents(session Session, turnID string, pending *pendingInteractiveRequest, response pendingInteractiveResponse, err error) []activityshared.Event {
	if pending == nil {
		return nil
	}
	callType := firstNonEmpty(strings.TrimSpace(pending.callType), "approval")
	if err != nil {
		return []activityshared.Event{normalizedInteractionSupersededEvent(session, turnID, pending), newTurnActivityEventWithID(session, pending.eventID, EventCallFailed, turnID, messageStreamStateFailed, "", pending.name, map[string]any{
			"callId":   pending.callID,
			"callType": callType,
			"name":     pending.name,
			"toolName": pending.toolName,
			"status":   messageStreamStateFailed,
			"error": map[string]any{
				"requestId": pending.requestID,
				"message":   err.Error(),
			},
		})}
	}
	return []activityshared.Event{
		newTurnActivityEventWithID(session, pending.eventID, EventCallCompleted, turnID, messageStreamStateCompleted, "", pending.name, map[string]any{
			"callId":   pending.callID,
			"callType": callType,
			"name":     pending.name,
			"toolName": pending.toolName,
			"status":   messageStreamStateCompleted,
			"output":   pending.resolvedOutput(response),
		}),
		newTurnActivityEvent(session, EventTurnUpdated, turnID, SessionStatusWorking, "", "", map[string]any{
			"phase":     string(activityshared.TurnPhaseWorking),
			"requestId": pending.requestID,
		}),
	}
}

func normalizedInteractionRequestedEvent(session Session, turnID string, pending *pendingInteractiveRequest) activityshared.Event {
	if pending == nil {
		return activityshared.Event{}
	}
	ctx, ok := activityEventContext(session, "interaction:"+pending.requestID+":requested", turnID)
	if !ok {
		return activityshared.Event{}
	}
	return activityshared.NewInteractionRequested(ctx, pendingInteractionTransition(turnID, pending))
}

func normalizedInteractionSupersededEvent(session Session, turnID string, pending *pendingInteractiveRequest) activityshared.Event {
	if pending == nil {
		return activityshared.Event{}
	}
	ctx, ok := activityEventContext(session, "interaction:"+pending.requestID+":superseded", turnID)
	if !ok {
		return activityshared.Event{}
	}
	return activityshared.NewInteractionSuperseded(ctx, pendingInteractionTransition(turnID, pending))
}

func pendingInteractionTransition(turnID string, pending *pendingInteractiveRequest) activityshared.InteractionTransition {
	kind := "approval"
	switch strings.ToLower(strings.TrimSpace(pending.kind)) {
	case "ask-user", "question":
		kind = "question"
	case "exit-plan", "plan":
		kind = "plan"
	}
	metadata := map[string]any{
		"callId":   strings.TrimSpace(pending.callID),
		"callType": firstNonEmpty(strings.TrimSpace(pending.callType), "approval"),
	}
	if pending.prompt != nil {
		for key, value := range pending.prompt.Metadata {
			metadata[key] = value
		}
	}
	return activityshared.InteractionTransition{
		RequestID: strings.TrimSpace(pending.requestID),
		TurnID:    firstNonEmptyString(strings.TrimSpace(turnID), strings.TrimSpace(pending.turnID)),
		Kind:      kind,
		ToolName:  firstNonEmpty(strings.TrimSpace(pending.toolName), strings.TrimSpace(pending.name)),
		Input:     clonePayload(pending.input),
		Metadata:  clonePayload(metadata),
	}
}

func (p *pendingInteractiveRequest) snapshotPrompt() *SessionInteractivePrompt {
	if p == nil {
		return nil
	}
	state := p.disposition()
	if state != pendingInteractiveRequestStatePending && state != pendingInteractiveRequestStateResolving {
		return nil
	}
	if p.prompt != nil {
		prompt := *p.prompt
		prompt.RequestID = firstNonEmpty(strings.TrimSpace(prompt.RequestID), p.requestID)
		prompt.ToolName = firstNonEmpty(strings.TrimSpace(prompt.ToolName), p.toolName, p.name)
		prompt.Status = firstNonEmpty(strings.TrimSpace(prompt.Status), SessionStatusWaiting)
		prompt.Input = clonePayload(prompt.Input)
		prompt.Output = clonePayload(prompt.Output)
		prompt.Error = clonePayload(prompt.Error)
		prompt.Metadata = clonePayload(prompt.Metadata)
		return &prompt
	}
	return &SessionInteractivePrompt{
		Kind:      "approval",
		RequestID: p.requestID,
		ToolName:  p.name,
		Status:    SessionStatusWaiting,
		Input:     p.snapshotApprovalInput(),
		Metadata: map[string]any{
			"callType": "approval",
			"toolName": firstNonEmpty(strings.TrimSpace(p.toolName), p.name),
		},
	}
}

func (p *pendingInteractiveRequest) resolvedOutput(response pendingInteractiveResponse) map[string]any {
	output := map[string]any{
		"requestId": p.requestID,
	}
	if p.callType == "interactive" {
		if response.action != "" {
			output["action"] = response.action
		}
		if response.optionID != "" {
			output["selectedId"] = strings.TrimSpace(response.optionID)
		}
		if payload := clonePayload(response.payload); payload != nil {
			output["payload"] = payload
		}
		return output
	}
	output["selectedId"] = strings.TrimSpace(response.optionID)
	return output
}

func (p *pendingInteractiveRequest) snapshotApprovalInput() map[string]any {
	input := clonePayload(p.input)
	if input == nil {
		input = map[string]any{}
	}
	if _, ok := input["requestId"]; !ok && strings.TrimSpace(p.requestID) != "" {
		input["requestId"] = p.requestID
	}
	if _, ok := input["callId"]; !ok && strings.TrimSpace(p.callID) != "" {
		input["callId"] = p.callID
	}
	if _, ok := input["options"]; !ok {
		input["options"] = cloneOptionMaps(p.options)
	}
	return input
}

func normalizedInteractivePrompt(toolCall map[string]any, options []map[string]any, requestID string) *SessionInteractivePrompt {
	toolName := normalizedInteractiveToolName(toolCall)
	switch toolName {
	case "AskUserQuestion":
		input := clonePayload(payloadObject(toolCall["input"]))
		if input == nil {
			input = map[string]any{}
		}
		if _, ok := input["questions"]; !ok {
			if questions := payloadArray(toolCall["questions"]); len(questions) > 0 {
				input["questions"] = questions
			}
		}
		return &SessionInteractivePrompt{
			Kind:      "ask-user",
			RequestID: requestID,
			ToolName:  toolName,
			Status:    "waiting_input",
			Input:     input,
			Metadata: map[string]any{
				"callType":        "interactive",
				"interactiveKind": "ask-user",
				"toolName":        toolName,
				"options":         cloneOptionMaps(options),
			},
		}
	case "ExitPlanMode":
		input := clonePayload(payloadObject(toolCall["input"]))
		if input == nil {
			input = map[string]any{}
		}
		return &SessionInteractivePrompt{
			Kind:      "exit-plan",
			RequestID: requestID,
			ToolName:  toolName,
			Status:    "waiting_input",
			Input:     input,
			Metadata: map[string]any{
				"callType":        "interactive",
				"interactiveKind": "exit-plan",
				"toolName":        toolName,
				"options":         cloneOptionMaps(options),
			},
		}
	default:
		return nil
	}
}

func normalizedApprovalInput(toolCall map[string]any, options []map[string]any, requestID string, knownInput map[string]any) map[string]any {
	input := map[string]any{
		"requestId": requestID,
		"toolCall":  clonePayload(toolCall),
		"options":   cloneOptionMaps(options),
	}
	for key, value := range normalizedApprovalDisplayInput(toolCall, knownInput) {
		if _, exists := input[key]; !exists {
			input[key] = clonePayloadValue(value)
		}
	}
	return input
}

// normalizedApprovalDisplayInput builds the preview detail (command, path,
// query, reason, ...) shown on an approval card. Some ACP providers (Cursor) omit
// `rawInput` on the permission request's own `toolCall` and only repeat
// `toolCallId`/`title`/`kind`, so `knownInput` — the input captured from an
// earlier `tool_call`/`tool_call_update` for the same call id, when available
// — is used as a last-resort fallback per field.
func normalizedApprovalDisplayInput(toolCall map[string]any, knownInput map[string]any) map[string]any {
	if len(toolCall) == 0 && len(knownInput) == 0 {
		return nil
	}
	displayInput := clonePayload(payloadObject(toolCall["input"]))
	if displayInput == nil {
		displayInput = clonePayload(payloadObject(toolCall["rawInput"]))
	}
	if displayInput == nil {
		displayInput = clonePayload(payloadObject(toolCall["raw_input"]))
	}
	if displayInput == nil {
		displayInput = clonePayload(payloadObject(toolCall["arguments"]))
	}
	if displayInput == nil {
		displayInput = clonePayload(payloadObject(toolCall["args"]))
	}
	if displayInput == nil {
		displayInput = map[string]any{}
	}
	for _, key := range []string{
		"command",
		"cmd",
		"description",
		"reason",
		"grantRoot",
		"file_path",
		"filePath",
		"path",
		"notebook_path",
		"query",
		"search_query",
		"searchQuery",
		"pattern",
		"cwd",
		"changes",
		"fileChanges",
	} {
		if _, exists := displayInput[key]; exists {
			continue
		}
		if value, exists := toolCall[key]; exists {
			displayInput[key] = clonePayloadValue(value)
			continue
		}
		if value, exists := knownInput[key]; exists {
			displayInput[key] = clonePayloadValue(value)
		}
	}
	if command := normalizedApprovalDisplayCommand(firstNonEmptyShellCommand(displayInput["command"], displayInput["cmd"])); command != "" {
		displayInput["command"] = command
		delete(displayInput, "cmd")
	}
	if len(displayInput) == 0 {
		return nil
	}
	return displayInput
}

func normalizedApprovalDisplayCommand(command any) string {
	switch typed := command.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []any:
		if len(typed) >= 3 {
			flag := strings.TrimSpace(asString(typed[len(typed)-2]))
			if flag == "-c" || flag == "-lc" {
				return strings.TrimSpace(asString(typed[len(typed)-1]))
			}
		}
		parts := make([]string, 0, len(typed))
		for _, part := range typed {
			if text := strings.TrimSpace(asString(part)); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, " ")
	default:
		return ""
	}
}

func interactivePromptKind(prompt *SessionInteractivePrompt) string {
	if prompt == nil {
		return ""
	}
	return strings.TrimSpace(prompt.Kind)
}

func normalizedInteractiveToolName(toolCall map[string]any) string {
	name := firstNonEmpty(
		asString(toolCall["name"]),
		asString(toolCall["toolName"]),
		asString(toolCall["title"]),
	)
	switch normalizeInteractiveName(name) {
	case "askuserquestion":
		return "AskUserQuestion"
	case "exitplanmode":
		return "ExitPlanMode"
	default:
		return ""
	}
}

func normalizeInteractiveName(name string) string {
	return strings.NewReplacer("_", "", "-", "", " ", "").Replace(strings.ToLower(strings.TrimSpace(name)))
}

func payloadObject(value any) map[string]any {
	obj, _ := value.(map[string]any)
	return obj
}

func payloadArray(value any) []map[string]any {
	items, _ := value.([]map[string]any)
	if items != nil {
		return cloneOptionMaps(items)
	}
	if generic, ok := value.([]any); ok {
		out := make([]map[string]any, 0, len(generic))
		for _, item := range generic {
			if obj, ok := item.(map[string]any); ok {
				out = append(out, clonePayload(obj))
			}
		}
		return out
	}
	return nil
}

func asString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	default:
		return ""
	}
}

func newSessionActivityEvent(session Session, eventType string, status string, metadata map[string]any) activityshared.Event {
	ctx, ok := activityEventContext(session, newID(), "")
	if !ok {
		return activityshared.Event{}
	}
	var event activityshared.Event
	switch eventType {
	case EventSessionStarted:
		event = activityshared.NewSessionStarted(ctx)
	case EventSessionUpdated:
		event = activityshared.NewSessionUpdated(ctx, activityshared.SessionStatus(status))
	case EventSessionCompleted:
		event = activityshared.NewSessionCompleted(ctx)
	case EventSessionFailed:
		event = activityshared.NewSessionFailed(ctx)
	case EventSessionCanceled:
		event = activityshared.NewSessionUpdated(ctx, activityshared.SessionStatusPaused)
	default:
		return activityshared.Event{}
	}
	event.Payload.Metadata = clonePayload(metadata)
	return event
}

func newTurnActivityEvent(session Session, eventType string, turnID string, status string, role string, content string, payload map[string]any) activityshared.Event {
	return newTurnActivityEventWithID(session, newID(), eventType, turnID, status, role, content, payload)
}

func newSessionAuditEventWithID(session Session, eventID string, role string, content string, payload map[string]any) activityshared.Event {
	ctx, ok := activityEventContext(session, eventID, "")
	if !ok {
		return activityshared.Event{}
	}
	if strings.TrimSpace(role) == "" {
		role = RoleUser
	}
	metadata := clonePayload(payload)
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["auditId"] = strings.TrimSpace(eventID)
	return activityshared.NewSessionAudit(ctx, activityshared.MessageRole(strings.TrimSpace(role)), content, metadata)
}

func goalControlSessionAuditEvent(session Session, input GoalApplyInput) activityshared.Event {
	action := strings.TrimSpace(string(input.Action))
	content := "/goal " + action
	if input.Action == GoalControlSet {
		content = "/goal " + strings.TrimSpace(input.Objective)
	}
	eventID := strings.TrimSpace(input.OperationID)
	if eventID == "" {
		eventID = newID()
	}
	return newSessionAuditEventWithID(session, "goal-control:"+eventID, RoleUser, content, map[string]any{
		"goalControl":     true,
		"action":          action,
		"operationId":     strings.TrimSpace(input.OperationID),
		"goalRevision":    input.Revision,
		"goalRepairEpoch": input.RepairEpoch,
	})
}

func newTurnActivityEventWithID(session Session, eventID string, eventType string, turnID string, status string, role string, content string, payload map[string]any) activityshared.Event {
	ctx, ok := activityEventContext(session, eventID, turnID)
	if !ok {
		return activityshared.Event{}
	}
	switch eventType {
	case EventTurnStarted:
		event := activityshared.NewTurnStarted(ctx, turnID)
		event.Payload.Metadata = clonePayload(payload)
		return event
	case EventTurnUpdated:
		phase := activityshared.TurnPhase(firstNonEmpty(payloadString(payload, "phase"), string(activityshared.TurnPhaseWorking)))
		event := activityshared.NewTurnUpdated(ctx, turnID, phase)
		event.Payload.Metadata = clonePayload(payload)
		return event
	case EventTurnCompleted:
		event := activityshared.NewTurnCompleted(ctx, turnID, activityshared.TurnOutcomeCompleted)
		event.Payload.Metadata = clonePayload(payload)
		return event
	case EventTurnFailed:
		event := activityshared.NewTurnFailed(ctx, turnID)
		event.Payload.Metadata = clonePayload(payload)
		return event
	case EventTurnCanceled:
		event := activityshared.NewTurnCompleted(ctx, turnID, activityshared.TurnOutcomeInterrupted)
		event.Payload.Metadata = clonePayload(payload)
		return event
	case EventMessage:
		messageRole := activityshared.MessageRole(strings.TrimSpace(role))
		if messageRole == "" {
			messageRole = activityshared.MessageRoleAssistant
		}
		if status == "" && messageRole == activityshared.MessageRoleUser {
			status = messageStreamStateCompleted
		}
		event := activityshared.NewMessageAppended(ctx, messageRole, content)
		event.Payload.Metadata = clonePayload(payload)
		if event.Payload.Metadata == nil {
			event.Payload.Metadata = map[string]any{}
		}
		if strings.TrimSpace(payloadString(event.Payload.Metadata, "messageId")) == "" {
			event.Payload.Metadata["messageId"] = eventID
		}
		if strings.TrimSpace(payloadString(event.Payload.Metadata, "contentMode")) == "" {
			event.Payload.Metadata["contentMode"] = messageContentModeSnapshot
		}
		if status != "" {
			event.Payload.Metadata["streamState"] = status
		}
		return event
	case EventCallStarted:
		event := activityshared.NewCallStarted(
			ctx,
			payloadString(payload, "callId"),
			firstNonEmpty(payloadString(payload, "callType"), "tool"),
			payloadString(payload, "name"),
			payloadMap(payload, "input"),
		)
		if status := payloadString(payload, "status"); status != "" {
			event.Payload.Status = status
		}
		event.Payload.Metadata = clonePayload(payload)
		return event
	case EventCallCompleted:
		event := activityshared.NewCallCompleted(
			ctx,
			payloadString(payload, "callId"),
			firstNonEmpty(payloadString(payload, "callType"), "tool"),
			payloadString(payload, "name"),
			payloadMap(payload, "output"),
		)
		if status := payloadString(payload, "status"); status != "" {
			event.Payload.Status = status
		}
		event.Payload.Metadata = clonePayload(payload)
		return event
	case EventCallFailed:
		event := activityshared.NewCallFailed(
			ctx,
			payloadString(payload, "callId"),
			firstNonEmpty(payloadString(payload, "callType"), "tool"),
			payloadString(payload, "name"),
			payloadMap(payload, "error"),
		)
		if output := payloadMap(payload, "output"); len(output) > 0 {
			event.Payload.Output = output
		}
		if status := payloadString(payload, "status"); status != "" {
			event.Payload.Status = status
		}
		event.Payload.Metadata = clonePayload(payload)
		return event
	default:
		return activityshared.Event{}
	}
}
