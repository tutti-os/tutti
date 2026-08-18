package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// Cursor exposes these as blocking JSON-RPC requests rather than ACP
// session/request_permission calls. Keep them on the same pending interaction
// state machine so the GUI, cancellation, and terminal-disposition paths do
// not diverge by provider.
type cursorAskQuestionRequest struct {
	ToolCallID string              `json:"toolCallId"`
	Title      string              `json:"title"`
	Questions  []cursorAskQuestion `json:"questions"`
}

type cursorAskQuestion struct {
	ID            string                 `json:"id"`
	Prompt        string                 `json:"prompt"`
	Question      string                 `json:"question"`
	Options       []cursorQuestionOption `json:"options"`
	AllowMultiple bool                   `json:"allowMultiple"`
}

type cursorQuestionOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type cursorCreatePlanRequest struct {
	ToolCallID string `json:"toolCallId"`
	Name       string `json:"name"`
	Overview   string `json:"overview"`
	Plan       string `json:"plan"`
}

func (a *standardACPAdapter) handleCursorInteractiveMessage(
	ctx context.Context,
	client *acpClient,
	session Session,
	turnID string,
	message acpMessage,
	normalizer *acpTurnNormalizer,
	emit EventSink,
) ([]activityshared.Event, error) {
	if client == nil {
		return nil, errors.New("cursor interactive request has no ACP client")
	}
	if normalizer == nil || strings.TrimSpace(turnID) == "" {
		err := errors.New("cursor interactive request arrived outside an active prompt turn")
		_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32000, Message: err.Error()})
		return nil, err
	}

	requestID := acpRequestID(message.ID)
	if requestID == "" {
		err := errors.New("cursor interactive request id is required")
		_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32602, Message: err.Error()})
		return nil, err
	}

	var (
		kind     string
		toolName string
		callID   string
		title    string
		input    map[string]any
		options  []map[string]any
		response string
	)
	switch message.Method {
	case cursorACPMethodAskQuestion:
		parsed, normalized, err := parseCursorAskQuestionRequest(message.Params)
		if err != nil {
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32602, Message: err.Error()})
			return nil, err
		}
		kind = "ask-user"
		// Keep the provider-independent UI identity used by the existing
		// AskUserQuestion surface; providerMethod below retains the native
		// Cursor response contract.
		toolName = "AskUserQuestion"
		callID = parsed.ToolCallID
		title = firstNonEmpty(parsed.Title, toolName)
		input = normalized
		response = cursorACPMethodAskQuestion
	case cursorACPMethodCreatePlan:
		parsed, normalized, planOptions, err := parseCursorCreatePlanRequest(message.Params)
		if err != nil {
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32602, Message: err.Error()})
			return nil, err
		}
		kind = "exit-plan"
		toolName = "CreatePlan"
		callID = parsed.ToolCallID
		title = firstNonEmpty(parsed.Name, toolName)
		input = normalized
		options = planOptions
		response = cursorACPMethodCreatePlan
	default:
		return nil, fmt.Errorf("unsupported Cursor interactive method %q", message.Method)
	}

	if input == nil {
		input = map[string]any{}
	}
	input["requestId"] = requestID
	if len(options) > 0 {
		input["options"] = cloneOptionMaps(options)
	}
	prompt := &SessionInteractivePrompt{
		Kind:      kind,
		RequestID: requestID,
		ToolName:  toolName,
		Status:    "waiting_input",
		Input:     clonePayload(input),
		Metadata: map[string]any{
			"callType":        "interactive",
			"interactiveKind": kind,
			"toolName":        toolName,
			"providerMethod":  response,
		},
	}
	pending := &pendingACPApproval{
		agentSessionID:       strings.TrimSpace(session.AgentSessionID),
		requestID:            requestID,
		eventID:              newID(),
		callID:               callID,
		callType:             "interactive",
		turnID:               strings.TrimSpace(turnID),
		input:                clonePayload(input),
		kind:                 kind,
		providerMethod:       response,
		name:                 title,
		toolName:             toolName,
		prompt:               prompt,
		options:              cloneOptionMaps(options),
		response:             make(chan pendingInteractiveResponse, 1),
		interactionRequested: true,
	}
	a.storePendingApproval(pending)

	payload := map[string]any{
		"callId":   callID,
		"callType": "interactive",
		"name":     title,
		"toolName": toolName,
		"status":   "waiting_input",
		"input":    clonePayload(input),
	}
	events := []activityshared.Event{
		newTurnActivityEvent(session, EventTurnUpdated, turnID, SessionStatusWaiting, "", "", map[string]any{
			"phase":     string(activityshared.TurnPhaseWaitingApproval),
			"requestId": requestID,
		}),
		newTurnActivityEventWithID(session, pending.eventID, EventCallStarted, turnID, SessionStatusWaiting, "", title, payload),
		normalizedInteractionRequestedEvent(session, turnID, pending),
	}
	if emit != nil {
		emit(events)
	}
	go a.respondACPPermissionRequest(ctx, client, session, turnID, message.ID, pending, emit)
	return nil, nil
}

func parseCursorAskQuestionRequest(raw json.RawMessage) (cursorAskQuestionRequest, map[string]any, error) {
	var request cursorAskQuestionRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return cursorAskQuestionRequest{}, nil, fmt.Errorf("invalid cursor ask_question request: %w", err)
	}
	request.ToolCallID = strings.TrimSpace(request.ToolCallID)
	if request.ToolCallID == "" {
		return cursorAskQuestionRequest{}, nil, errors.New("cursor ask_question toolCallId is required")
	}
	if len(request.Questions) == 0 {
		return cursorAskQuestionRequest{}, nil, errors.New("cursor ask_question requires at least one question")
	}

	questions := make([]map[string]any, 0, len(request.Questions))
	for index, question := range request.Questions {
		question.ID = strings.TrimSpace(question.ID)
		question.Prompt = strings.TrimSpace(firstNonEmpty(question.Prompt, question.Question))
		if question.ID == "" {
			return cursorAskQuestionRequest{}, nil, fmt.Errorf("cursor ask_question question %d id is required", index+1)
		}
		if question.Prompt == "" {
			return cursorAskQuestionRequest{}, nil, fmt.Errorf("cursor ask_question question %q prompt is required", question.ID)
		}
		if question.AllowMultiple {
			return cursorAskQuestionRequest{}, nil, fmt.Errorf("cursor ask_question question %q uses multi-select, which is not supported yet", question.ID)
		}
		if len(question.Options) == 0 {
			return cursorAskQuestionRequest{}, nil, fmt.Errorf("cursor ask_question question %q requires options", question.ID)
		}
		seenOptions := make(map[string]struct{}, len(question.Options))
		optionMaps := make([]map[string]any, 0, len(question.Options))
		for optionIndex, option := range question.Options {
			option.ID = strings.TrimSpace(option.ID)
			option.Label = strings.TrimSpace(option.Label)
			if option.ID == "" || option.Label == "" {
				return cursorAskQuestionRequest{}, nil, fmt.Errorf("cursor ask_question question %q option %d requires id and label", question.ID, optionIndex+1)
			}
			if _, exists := seenOptions[option.ID]; exists {
				return cursorAskQuestionRequest{}, nil, fmt.Errorf("cursor ask_question question %q contains duplicate option id %q", question.ID, option.ID)
			}
			seenOptions[option.ID] = struct{}{}
			optionMaps = append(optionMaps, map[string]any{"id": option.ID, "label": option.Label})
		}
		questions = append(questions, map[string]any{
			"id":            question.ID,
			"header":        question.Prompt,
			"question":      question.Prompt,
			"prompt":        question.Prompt,
			"options":       optionMaps,
			"multiSelect":   false,
			"allowMultiple": false,
			"allowFreeText": false,
		})
	}
	return request, map[string]any{
		"toolCallId": request.ToolCallID,
		"title":      strings.TrimSpace(request.Title),
		"questions":  questions,
	}, nil
}

func parseCursorCreatePlanRequest(raw json.RawMessage) (cursorCreatePlanRequest, map[string]any, []map[string]any, error) {
	var request cursorCreatePlanRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return cursorCreatePlanRequest{}, nil, nil, fmt.Errorf("invalid cursor create_plan request: %w", err)
	}
	request.ToolCallID = strings.TrimSpace(request.ToolCallID)
	request.Plan = strings.TrimSpace(request.Plan)
	if request.ToolCallID == "" {
		return cursorCreatePlanRequest{}, nil, nil, errors.New("cursor create_plan toolCallId is required")
	}
	if request.Plan == "" {
		return cursorCreatePlanRequest{}, nil, nil, errors.New("cursor create_plan plan is required")
	}
	var rawInput map[string]any
	if err := json.Unmarshal(raw, &rawInput); err != nil {
		return cursorCreatePlanRequest{}, nil, nil, fmt.Errorf("invalid cursor create_plan payload: %w", err)
	}
	input := clonePayload(rawInput)
	input["toolCall"] = map[string]any{
		"toolCallId": request.ToolCallID,
		"title":      firstNonEmpty(strings.TrimSpace(request.Name), "Create plan"),
		"kind":       "switch_mode",
	}
	options := []map[string]any{
		{"optionId": "accept", "id": "accept", "name": "Implement plan", "label": "Implement plan", "kind": "allow_once"},
		{"optionId": "plan", "id": "plan", "name": "Keep planning", "label": "Keep planning", "kind": "reject_once"},
	}
	return request, input, options, nil
}

func cursorNativeInteractiveResult(pending *pendingInteractiveRequest, action string, optionID string, payload map[string]any) (map[string]any, string, error) {
	if pending == nil {
		return nil, "", errors.New("cursor interactive request is unavailable")
	}
	switch pending.providerMethod {
	case cursorACPMethodAskQuestion:
		return cursorAskQuestionResult(pending, action, payload)
	case cursorACPMethodCreatePlan:
		return cursorCreatePlanResult(action, optionID, payload)
	default:
		return nil, "", fmt.Errorf("unsupported Cursor interactive provider method %q", pending.providerMethod)
	}
}

func cursorAskQuestionResult(pending *pendingInteractiveRequest, action string, payload map[string]any) (map[string]any, string, error) {
	switch normalizePermissionOptionToken(action) {
	case "cancel", "cancelled", "dismiss", "dismissed":
		return map[string]any{"outcome": map[string]any{"outcome": "cancelled"}}, "", nil
	case "skip", "skipped":
		return map[string]any{"outcome": map[string]any{"outcome": "skipped", "reason": "user_skipped"}}, "", nil
	}
	answersByQuestionID := payloadObject(payload["answersByQuestionId"])
	if len(answersByQuestionID) == 0 {
		return nil, "", errors.New("cursor ask_question requires answersByQuestionId")
	}
	questions := payloadArrayOfMaps(pending.input["questions"])
	if len(questions) == 0 || len(answersByQuestionID) != len(questions) {
		return nil, "", errors.New("cursor ask_question requires exactly one answer for every question")
	}
	answers := make([]map[string]any, 0, len(questions))
	for _, question := range questions {
		questionID := strings.TrimSpace(asString(question["id"]))
		rawAnswer, exists := answersByQuestionID[questionID]
		if !exists {
			return nil, "", fmt.Errorf("cursor ask_question answer for question %q is required", questionID)
		}
		answer, ok := cursorSingleSelectAnswer(rawAnswer)
		if !ok {
			return nil, "", fmt.Errorf("cursor ask_question answer for question %q must be one selected option", questionID)
		}
		resolvedID, ok := cursorQuestionOptionID(question, answer)
		if !ok {
			return nil, "", fmt.Errorf("cursor ask_question answer %q is not an available option for question %q", answer, questionID)
		}
		answers = append(answers, map[string]any{
			"questionId":        questionID,
			"selectedOptionIds": []string{resolvedID},
		})
	}
	return map[string]any{"outcome": map[string]any{"outcome": "answered", "answers": answers}}, "", nil
}

func cursorCreatePlanResult(action string, optionID string, payload map[string]any) (map[string]any, string, error) {
	actionToken := normalizePermissionOptionToken(action)
	optionID = strings.TrimSpace(optionID)
	if actionToken == "cancel" || actionToken == "cancelled" || actionToken == "dismiss" || actionToken == "dismissed" {
		return map[string]any{"outcome": map[string]any{"outcome": "cancelled"}}, optionID, nil
	}
	if actionToken == "deny" || actionToken == "reject" || actionToken == "rejected" || optionID == "plan" {
		outcome := map[string]any{"outcome": "rejected"}
		if reason := strings.TrimSpace(asString(payload["denyMessage"])); reason != "" {
			outcome["reason"] = reason
		}
		return map[string]any{"outcome": outcome}, firstNonEmpty(optionID, "plan"), nil
	}
	return map[string]any{"outcome": map[string]any{"outcome": "accepted"}}, firstNonEmpty(optionID, "accept"), nil
}

func cursorSingleSelectAnswer(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		value := strings.TrimSpace(typed)
		return value, value != ""
	case []any:
		if len(typed) != 1 {
			return "", false
		}
		return cursorSingleSelectAnswer(typed[0])
	case []string:
		if len(typed) != 1 {
			return "", false
		}
		value := strings.TrimSpace(typed[0])
		return value, value != ""
	default:
		return "", false
	}
}

func cursorQuestionOptionID(question map[string]any, answer string) (string, bool) {
	for _, option := range payloadArrayOfMaps(question["options"]) {
		id := strings.TrimSpace(asString(option["id"]))
		label := strings.TrimSpace(asString(option["label"]))
		if answer == id || answer == label {
			return id, id != ""
		}
	}
	return "", false
}

func payloadArrayOfMaps(value any) []map[string]any {
	switch typed := value.(type) {
	case []map[string]any:
		return typed
	case []any:
		result := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			if object, ok := item.(map[string]any); ok && object != nil {
				result = append(result, object)
			}
		}
		return result
	default:
		return nil
	}
}
