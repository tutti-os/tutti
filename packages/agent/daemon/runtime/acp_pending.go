package agentruntime

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// ACP permission requests carry provider-defined option IDs. This file owns
// only ACP decoding and response-envelope details; shared interactive state
// and activity projection live in interactive_projection.go.
func acpPermissionRequestDecisionOptionID(
	raw json.RawMessage,
	decision string,
	filter func([]map[string]any) []map[string]any,
) (string, bool) {
	var params struct {
		Options []map[string]any `json:"options"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return "", false
	}
	if filter != nil {
		params.Options = filter(params.Options)
	}
	return resolveACPPermissionDecisionOptionID(params.Options, decision)
}

func resolveACPPermissionDecisionOptionID(options []map[string]any, decision string) (string, bool) {
	aliases := permissionOptionDecisionAliases(decision)
	if len(aliases) == 0 {
		return "", false
	}
	for _, option := range options {
		resolvedOptionID := firstNonEmpty(asString(option["optionId"]), asString(option["id"]))
		if resolvedOptionID == "" {
			continue
		}
		for _, value := range []string{resolvedOptionID, asString(option["kind"]), asString(option["name"]), asString(option["label"])} {
			token := normalizePermissionOptionToken(value)
			for _, alias := range aliases {
				if token != "" && token == alias {
					return resolvedOptionID, true
				}
			}
		}
	}
	return "", false
}

func acpPermissionResponseResult(optionID string) map[string]any {
	return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": strings.TrimSpace(optionID)}}
}

func acpInteractiveResponseResult(action string, optionID string, payload map[string]any) map[string]any {
	outcome := map[string]any{"outcome": firstNonEmpty(strings.TrimSpace(action), "submitted")}
	if optionID = strings.TrimSpace(optionID); optionID != "" {
		outcome["optionId"] = optionID
	}
	if payload = clonePayload(payload); payload != nil {
		outcome["payload"] = payload
	}
	return map[string]any{"outcome": outcome}
}

type acpAskUserPermissionBridgeState uint8

const (
	acpAskUserPermissionBridgeIncomplete acpAskUserPermissionBridgeState = iota
	acpAskUserPermissionBridgeSupported
	acpAskUserPermissionBridgeUnsupported
)

type acpAskUserPermissionBridge struct {
	questionID      string
	optionIDByLabel map[string]string
	rejectionOption string
}

// normalizeACPAskUserPermissionBridge validates the question surface before
// it becomes a canonical Interaction. This is the one-shot permission bridge:
// one request_permission response returns one option ID and completes the
// question transaction. Providers that implement questions as a sequence of
// permission requests need a separate correlated state machine before those
// richer shapes can be published.
func normalizeACPAskUserPermissionBridge(
	pending *pendingInteractiveRequest,
) (acpAskUserPermissionBridge, acpAskUserPermissionBridgeState, error) {
	if pending == nil || pending.kind != "ask-user" || len(pending.options) == 0 {
		return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, errors.New("ask-user permission bridge is unavailable")
	}
	rawQuestions, questionsPresent := pending.input["questions"]
	questions, validQuestions := acpAskUserStrictObjectArray(rawQuestions)
	if questionsPresent && !validQuestions {
		return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, errors.New(
			"ACP ask-user permission bridge contains a malformed question list",
		)
	}
	if len(questions) == 0 {
		return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeIncomplete, nil
	}
	if len(questions) != 1 {
		return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, fmt.Errorf(
			"ACP ask-user permission bridge supports exactly one question, received %d",
			len(questions),
		)
	}
	question := questions[0]
	if firstNonEmpty(asString(question["question"]), asString(question["header"])) == "" {
		return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeIncomplete, nil
	}
	multiSelect, validMultiSelect := acpAskUserQuestionBooleanFlag(question, "multiSelect", "multi_select")
	if !validMultiSelect {
		return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, errors.New(
			"ACP ask-user permission bridge contains an invalid multi-select flag",
		)
	}
	if multiSelect {
		return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, errors.New(
			"ACP ask-user permission bridge does not support multi-select questions",
		)
	}
	allowFreeText, validAllowFreeText := acpAskUserQuestionBooleanFlag(question, "allowFreeText", "allow_free_text")
	if !validAllowFreeText {
		return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, errors.New(
			"ACP ask-user permission bridge contains an invalid free-text flag",
		)
	}
	if allowFreeText {
		return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, errors.New(
			"ACP ask-user permission bridge does not support free-text answers",
		)
	}

	optionIDByLabel := make(map[string]string)
	optionIDs := make(map[string]struct{})
	rejectionOptionID := ""
	for _, option := range pending.options {
		optionID := firstNonEmpty(asString(option["optionId"]), asString(option["id"]))
		if optionID == "" {
			return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, errors.New(
				"ACP ask-user permission bridge contains an option without an id",
			)
		}
		if _, duplicate := optionIDs[optionID]; duplicate {
			return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, fmt.Errorf(
				"ACP ask-user permission bridge contains duplicate option id %q",
				optionID,
			)
		}
		optionIDs[optionID] = struct{}{}
		if acpAskUserPermissionOptionRejected(option) {
			if rejectionOptionID != "" {
				return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, errors.New(
					"ACP ask-user permission bridge contains multiple rejection options",
				)
			}
			rejectionOptionID = optionID
			continue
		}
		label := firstNonEmpty(asString(option["name"]), asString(option["label"]))
		if label == "" {
			return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, errors.New(
				"ACP ask-user permission bridge contains an incomplete selectable option",
			)
		}
		if _, duplicate := optionIDByLabel[label]; duplicate {
			return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, fmt.Errorf(
				"ACP ask-user permission bridge contains duplicate option label %q",
				label,
			)
		}
		optionIDByLabel[label] = optionID
	}
	if len(optionIDByLabel) == 0 {
		return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, errors.New(
			"ACP ask-user permission bridge does not provide selectable options",
		)
	}
	questionOptions, validQuestionOptions := acpAskUserStrictObjectArray(question["options"])
	if !validQuestionOptions {
		return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, errors.New(
			"ACP ask-user permission bridge contains a malformed question option list",
		)
	}
	if len(questionOptions) == 0 {
		return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeIncomplete, nil
	}
	if len(questionOptions) != len(optionIDByLabel) {
		return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, errors.New(
			"ACP ask-user permission options do not match the question options",
		)
	}
	questionLabels := make(map[string]struct{}, len(questionOptions))
	for _, option := range questionOptions {
		label := firstNonEmpty(asString(option["label"]), asString(option["name"]))
		if label == "" {
			return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, errors.New(
				"ACP ask-user question contains an option without a label",
			)
		}
		if _, duplicate := questionLabels[label]; duplicate {
			return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, fmt.Errorf(
				"ACP ask-user question contains duplicate option label %q",
				label,
			)
		}
		if _, available := optionIDByLabel[label]; !available {
			return acpAskUserPermissionBridge{}, acpAskUserPermissionBridgeUnsupported, fmt.Errorf(
				"ACP ask-user question option %q has no provider permission option",
				label,
			)
		}
		questionLabels[label] = struct{}{}
	}

	questionID := firstNonEmpty(asString(question["id"]), "question-1")
	question["id"] = questionID
	question["multiSelect"] = false
	question["allowFreeText"] = false
	if pending.input == nil {
		pending.input = map[string]any{}
	}
	pending.input["questions"] = []map[string]any{question}
	if pending.prompt != nil {
		pending.prompt.Input = clonePayload(pending.input)
	}
	return acpAskUserPermissionBridge{
		questionID:      questionID,
		optionIDByLabel: optionIDByLabel,
		rejectionOption: rejectionOptionID,
	}, acpAskUserPermissionBridgeSupported, nil
}

func acpAskUserQuestionBooleanFlag(question map[string]any, keys ...string) (bool, bool) {
	found := false
	resolved := false
	for _, key := range keys {
		rawValue, exists := question[key]
		if !exists || rawValue == nil {
			continue
		}
		value, valid := false, true
		switch typed := rawValue.(type) {
		case bool:
			value = typed
		case string:
			switch strings.ToLower(strings.TrimSpace(typed)) {
			case "true":
				value = true
			case "false":
				value = false
			default:
				valid = false
			}
		default:
			valid = false
		}
		if !valid || (found && value != resolved) {
			return false, false
		}
		found = true
		resolved = value
	}
	return resolved, true
}

func acpAskUserStrictObjectArray(value any) ([]map[string]any, bool) {
	switch typed := value.(type) {
	case nil:
		return nil, true
	case []map[string]any:
		items := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			if item == nil {
				return nil, false
			}
			items = append(items, clonePayload(item))
		}
		return items, true
	case []any:
		items := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			object, ok := item.(map[string]any)
			if !ok || object == nil {
				return nil, false
			}
			items = append(items, clonePayload(object))
		}
		return items, true
	default:
		return nil, false
	}
}

func acpAskUserPermissionOptionRejected(option map[string]any) bool {
	switch normalizePermissionOptionToken(asString(option["kind"])) {
	case "rejectonce", "rejectalways", "deny", "denied":
		return true
	case "allowonce", "allowalways", "approve", "approved":
		return false
	}
	for _, key := range []string{"optionId", "id"} {
		if permissionOptionDecision(asString(option[key])) == "denied" {
			return true
		}
	}
	return false
}

// A one-shot ACP AskUserQuestion bridge has only one selected provider option
// ID as its affirmative response. Resolve only the canonical per-question
// answer; the flat answers list is display data and must never decide provider
// routing.
func acpAskUserPermissionOptionID(
	pending *pendingInteractiveRequest,
	optionID string,
	action string,
	payload map[string]any,
) (string, error) {
	if pending == nil || pending.kind != "ask-user" || len(pending.options) == 0 {
		return "", errors.New("ask-user permission bridge is unavailable")
	}
	bridge, state, err := normalizeACPAskUserPermissionBridge(pending)
	if err != nil {
		return "", err
	}
	if state != acpAskUserPermissionBridgeSupported {
		return "", errors.New("ask-user permission bridge input is incomplete")
	}
	switch normalizePermissionOptionToken(action) {
	case "cancel", "cancelled", "dismiss", "dismissed", "skip":
		if bridge.rejectionOption != "" {
			return bridge.rejectionOption, nil
		}
		return "", errors.New("ask-user permission bridge does not provide a dismissal option")
	}
	answersByQuestionID := payloadObject(payload["answersByQuestionId"])
	if len(answersByQuestionID) != 1 {
		return "", fmt.Errorf(
			"ask-user permission bridge requires exactly one canonical answer, received %d",
			len(answersByQuestionID),
		)
	}
	rawAnswer, exists := answersByQuestionID[bridge.questionID]
	if !exists {
		return "", fmt.Errorf("ask-user answer for question %q is required", bridge.questionID)
	}
	answer, ok := rawAnswer.(string)
	if !ok || strings.TrimSpace(answer) == "" {
		return "", fmt.Errorf("ask-user answer for question %q must be one selected option", bridge.questionID)
	}
	resolvedOptionID, ok := bridge.optionIDByLabel[strings.TrimSpace(answer)]
	if !ok {
		return "", fmt.Errorf("ask-user answer %q does not match an available provider option", strings.TrimSpace(answer))
	}
	if optionID = strings.TrimSpace(optionID); optionID != "" {
		explicitOptionID, available := pending.resolvePermissionOptionID(optionID)
		if !available || explicitOptionID != resolvedOptionID {
			return "", errors.New("ask-user option id conflicts with the canonical answer")
		}
	}
	return resolvedOptionID, nil
}

func acpPermissionOutOfBandResolvedEvents(session Session, turnID string, pending *pendingInteractiveRequest) []activityshared.Event {
	if pending == nil {
		return nil
	}
	callType := firstNonEmpty(strings.TrimSpace(pending.callType), "approval")
	return []activityshared.Event{
		normalizedInteractionSupersededEvent(session, turnID, pending),
		newTurnActivityEventWithID(session, pending.eventID, EventCallFailed, turnID, messageStreamStateFailed, "", pending.name, map[string]any{
			"callId": pending.callID, "callType": callType, "name": pending.name, "toolName": pending.toolName,
			"status": messageStreamStateFailed,
			"error":  map[string]any{"requestId": pending.requestID, "message": "Codex resolved this request without a response from tutti (it may have timed out or been canceled); outcome unknown."},
		}),
		newTurnActivityEvent(session, EventTurnUpdated, turnID, SessionStatusWorking, "", "", map[string]any{
			"phase": string(activityshared.TurnPhaseWorking), "requestId": pending.requestID,
		}),
	}
}

func acpRequestID(raw json.RawMessage) string {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return strings.TrimSpace(text)
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err == nil {
		return strings.TrimSpace(number.String())
	}
	return strings.TrimSpace(string(raw))
}
