package agentruntime

import (
	"errors"
	"fmt"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

const (
	appServerMCPElicitationApprovalKindKey  = "codex_approval_kind"
	appServerMCPElicitationToolApprovalKind = "mcp_tool_call"
	appServerMCPElicitationToolSuggestKind  = "tool_suggestion"
	appServerMCPElicitationPersistKey       = "persist"
	appServerMCPElicitationPersistSession   = "session"
	appServerMCPElicitationPersistAlways    = "always"
)

func (a *CodexAppServerAdapter) appServerMCPElicitationRequested(
	session Session,
	turnID string,
	requestID string,
	params map[string]any,
) ([]activityshared.Event, *pendingInteractiveRequest, error) {
	if err := validateMessageOnlyMCPElicitation(params); err != nil {
		return nil, nil, err
	}

	message, ok := params["message"].(string)
	if !ok {
		return nil, nil, errors.New("MCP elicitation message must be a string")
	}
	message = strings.TrimSpace(message)
	if message == "" {
		message = "MCP server requests permission."
	}
	serverName, ok := params["serverName"].(string)
	if !ok {
		return nil, nil, errors.New("MCP elicitation serverName must be a string")
	}
	serverName = strings.TrimSpace(serverName)
	if serverName == "" {
		return nil, nil, errors.New("MCP elicitation serverName is required")
	}
	meta := payloadObject(params["_meta"])
	if asString(meta[appServerMCPElicitationApprovalKindKey]) == appServerMCPElicitationToolSuggestKind {
		return nil, nil, errors.New("MCP tool-suggestion elicitation is not supported")
	}
	options := appServerMCPElicitationApprovalOptions(meta)
	input := map[string]any{
		"requestId":       requestID,
		"reason":          message,
		"serverName":      serverName,
		"mode":            "form",
		"requestedSchema": clonePayloadValue(params["requestedSchema"]),
		"options":         cloneOptionMaps(options),
	}
	pending := &pendingInteractiveRequest{
		agentSessionID: strings.TrimSpace(session.AgentSessionID),
		turnID:         strings.TrimSpace(turnID),
		requestID:      requestID,
		eventID:        newID(),
		callID:         requestID,
		callType:       "approval",
		input:          input,
		kind:           "approval",
		providerTurnID: strings.TrimSpace(
			asString(params["turnId"]),
		),
		name:     message,
		toolName: serverName,
		options:  options,
		response: make(chan pendingInteractiveResponse, 1),
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
			message,
			map[string]any{
				"callId":   pending.callID,
				"callType": pending.callType,
				"name":     pending.name,
				"toolName": pending.toolName,
				"status":   string(activityshared.TurnPhaseWaitingApproval),
				"input":    clonePayload(input),
				"metadata": map[string]any{
					"callType":  pending.callType,
					"mcpServer": serverName,
				},
			},
		),
		normalizedInteractionRequestedEvent(session, turnID, pending),
	}, pending, nil
}

func validateMessageOnlyMCPElicitation(params map[string]any) error {
	mode := strings.TrimSpace(asString(params["mode"]))
	if mode != "form" {
		return fmt.Errorf("MCP elicitation mode %q is not supported", mode)
	}
	schema, ok := params["requestedSchema"].(map[string]any)
	if !ok {
		return errors.New("MCP elicitation requestedSchema must be an object")
	}
	if strings.TrimSpace(asString(schema["type"])) != "object" {
		return errors.New("MCP elicitation requestedSchema type must be object")
	}
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		return errors.New("MCP elicitation requestedSchema properties must be an object")
	}
	if len(properties) > 0 {
		return errors.New("MCP elicitation forms with fields are not supported")
	}
	if required, exists := schema["required"]; exists {
		values, valid := appServerMCPStringArray(required)
		if !valid {
			return errors.New("MCP elicitation requestedSchema required must be a string array")
		}
		if len(values) > 0 {
			return errors.New("MCP elicitation message-only schema cannot require fields")
		}
	}
	for key := range schema {
		switch key {
		case "$schema", "type", "properties", "required":
		default:
			return fmt.Errorf("MCP elicitation requestedSchema field %q is not supported", key)
		}
	}
	return nil
}

func appServerMCPElicitationApprovalOptions(meta map[string]any) []map[string]any {
	options := []map[string]any{
		{"optionId": "approve", "name": "Allow", "kind": "allow_once"},
	}
	if appServerMCPElicitationSupportsPersist(meta, appServerMCPElicitationPersistSession) {
		options = append(options, map[string]any{
			"optionId": "approve_for_session",
			"name":     "Allow for this session",
			"kind":     "allow_always",
		})
	}
	if appServerMCPElicitationSupportsPersist(meta, appServerMCPElicitationPersistAlways) {
		options = append(options, map[string]any{
			"optionId": "approve_always",
			"name":     "Always allow",
			"kind":     "allow_always",
		})
	}
	if asString(meta[appServerMCPElicitationApprovalKindKey]) == appServerMCPElicitationToolApprovalKind {
		return append(options, map[string]any{
			"optionId": "cancel",
			"name":     "Cancel",
			"kind":     "reject_once",
		})
	}
	return append(options,
		map[string]any{"optionId": "deny", "name": "Deny", "kind": "reject_once"},
		map[string]any{"optionId": "cancel", "name": "Cancel", "kind": "reject_once"},
	)
}

func appServerMCPElicitationSupportsPersist(meta map[string]any, expected string) bool {
	persist := meta[appServerMCPElicitationPersistKey]
	if asString(persist) == expected {
		return true
	}
	values, _ := appServerMCPStringArray(persist)
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func appServerMCPStringArray(value any) ([]string, bool) {
	switch typed := value.(type) {
	case nil:
		return nil, true
	case []string:
		return append([]string(nil), typed...), true
	case []any:
		values := make([]string, 0, len(typed))
		for _, entry := range typed {
			text, ok := entry.(string)
			if !ok {
				return nil, false
			}
			values = append(values, text)
		}
		return values, true
	default:
		return nil, false
	}
}

func appServerMCPElicitationResult(selection pendingInteractiveResponse) map[string]any {
	result := map[string]any{}
	switch strings.TrimSpace(selection.optionID) {
	case "approve":
		result["action"] = "accept"
	case "approve_for_session":
		result["action"] = "accept"
		result["_meta"] = map[string]any{appServerMCPElicitationPersistKey: appServerMCPElicitationPersistSession}
	case "approve_always":
		result["action"] = "accept"
		result["_meta"] = map[string]any{appServerMCPElicitationPersistKey: appServerMCPElicitationPersistAlways}
	case "deny":
		result["action"] = "decline"
	case "cancel":
		result["action"] = "cancel"
	default:
		result["action"] = "cancel"
	}
	return result
}
