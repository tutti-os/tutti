package agentruntime

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func standardACPEnv(session Session, host HostMetadata) []string {
	env := []string{
		codexAgentRoutingEnv,
		codexRoutingPreload,
		"NO_BROWSER=1",
	}
	env = append(env, workspaceEnv(session, host)...)
	return env
}

func defaultACPInitializeParams(host HostMetadata) map[string]any {
	return map[string]any{
		"protocolVersion": acpProtocolVersion,
		"clientCapabilities": map[string]any{
			"fs": map[string]any{
				"readTextFile":  false,
				"writeTextFile": false,
			},
			"terminal": false,
			"_meta": map[string]any{
				"terminal_output": true,
			},
		},
		"clientInfo": host.clientInfoParams(),
	}
}

func standardACPUpdateEvents(config standardACPConfig, session Session, turnID string, raw json.RawMessage, normalizer *acpTurnNormalizer) []activityshared.Event {
	var params struct {
		Update map[string]any `json:"update"`
	}
	if err := json.Unmarshal(raw, &params); err != nil || params.Update == nil {
		return nil
	}
	updateType := asString(params.Update["sessionUpdate"])
	switch updateType {
	case "user_message_chunk":
		return nil
	case "agent_message_chunk":
		if events, ok := acpSystemNoticeEvents(session, turnID, params.Update, normalizer, "agent_message_chunk", config.allowSyntheticNotice); ok {
			return events
		}
		content := acpTextContent(params.Update["content"])
		if content == "" || normalizer == nil {
			return nil
		}
		return normalizer.AppendAssistantChunk(session, turnID, content)
	case "agent_thought_chunk":
		if events, ok := acpSystemNoticeEvents(session, turnID, params.Update, normalizer, "agent_thought_chunk", config.allowSyntheticNotice); ok {
			return events
		}
		content := acpTextContent(params.Update["content"])
		if content == "" || normalizer == nil {
			return nil
		}
		return normalizer.AppendThinkingChunk(session, turnID, content)
	case "session_info_update":
		if event, ok := normalizedSessionTitleEvent(session, params.Update); ok {
			if shouldIgnoreStandardACPTitle(config, session.Title, event.Payload.Title) {
				return nil
			}
			return []activityshared.Event{event}
		}
		return nil
	case "tool_call", "tool_call_update":
		if diagnostics := config.messageDiagnostics; diagnostics != nil && diagnostics.observeUpdate != nil {
			diagnostics.observeUpdate(config, session, turnID, updateType, params.Update)
		}
		// Tool activity is turn-scoped. A nil normalizer means the notification
		// arrived outside the active session/prompt call (for example after the
		// provider already returned its prompt result). Do not attach that late
		// activity to a recently settled canonical turn or invent a new identity.
		if normalizer == nil || strings.TrimSpace(turnID) == "" {
			slog.Warn("agent session ACP dropped turn-scoped update outside active prompt",
				"event", "agent_session.acp.update.turn_scope_missing",
				"provider", config.provider,
				"adapter", config.adapterName,
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", session.ProviderSessionID,
				"recent_turn_id", strings.TrimSpace(turnID),
				"update_type", updateType,
				"tool_call_id", firstNonEmpty(asString(params.Update["toolCallId"]), asString(params.Update["callId"]), asString(params.Update["id"])),
			)
			return nil
		}
		applyStandardACPToolAlias(config, params.Update)
		if events, ok := normalizer.StandardToolCallEvents(session, turnID, updateType, params.Update); ok {
			return events
		}
		return nil
	case "config_option_update":
		if event, ok := normalizedConfigOptionsUpdatedEvent(session, params.Update); ok {
			return []activityshared.Event{event}
		}
		return nil
	case "usage_update":
		logACPUsageUpdate(config, session, turnID, params.Update)
		if event, ok := normalizedUsageUpdatedEvent(session); ok {
			return []activityshared.Event{event}
		}
		return nil
	case "thread_goal_update", "thread_goal_clear", "thread_goal_cleared":
		logACPGoalUpdate(config, session, turnID, updateType, params.Update)
		if event, ok := normalizedGoalUpdatedEvent(session, updateType); ok {
			return []activityshared.Event{event}
		}
		return nil
	case "stream_error", "warning", "system_notice":
		if events, ok := acpSystemNoticeEvents(session, turnID, params.Update, normalizer, updateType, config.allowSyntheticNotice); ok {
			return events
		}
		return nil
	case "current_mode_update":
		modeID := acpModeValue(params.Update)
		logACPCurrentModeUpdate(config, session, params.Update)
		// Cursor plan mode is orthogonal to permission tiers; mirror agent-driven
		// plan entry/exit into the session settings that drive the composer badge.
		if config.projectCurrentMode {
			if event, ok := acpCurrentModeUpdatedEvent(session, modeID); ok {
				return []activityshared.Event{event}
			}
		}
		return nil
	case "available_commands_update", "plan":
		return nil
	default:
		return nil
	}
}

func applyStandardACPToolAlias(config standardACPConfig, update map[string]any) {
	if len(config.toolAliases) == 0 || strings.TrimSpace(asString(update["toolName"])) != "" {
		return
	}
	for _, value := range []string{asString(update["name"]), asString(update["title"]), asString(update["toolCallId"]), asString(update["id"])} {
		if canonical := config.toolAliases[strings.ToLower(strings.TrimSpace(value))]; canonical != "" {
			update["toolName"] = canonical
			return
		}
	}
}

func logACPCurrentModeUpdate(config standardACPConfig, session Session, update map[string]any) {
	slog.Info("agent session ACP current mode update",
		"event", "agent_session.acp.current_mode_update",
		"provider", config.provider,
		"adapter", config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"mode_id", strings.TrimSpace(acpModeValue(update)),
	)
}

func logACPUsageUpdate(
	config standardACPConfig,
	session Session,
	turnID string,
	update map[string]any,
) {
	parsed, parsedOK := acpUsageValue(update)
	slog.Info("agent session ACP usage update",
		"event", "agent_session.acp.usage_update",
		"provider", config.provider,
		"adapter", config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"turn_id", turnID,
		"raw_used", firstInt64ValueLogValue(update, "used"),
		"raw_size", firstInt64ValueLogValue(update, "size"),
		"raw_cost_amount", nestedACPFloatLogValue(update, "cost", "amount"),
		"raw_cost_currency", nestedACPStringLogValue(update, "cost", "currency"),
		"parsed_ok", parsedOK,
		"context_known", parsed.contextKnown,
		"context_used_tokens", parsed.contextUsedTokens,
		"context_window_tokens", parsed.contextWindowTokens,
		"quota_count", len(parsed.quotas),
	)
}

func firstInt64ValueLogValue(source map[string]any, keys ...string) any {
	if value, ok := firstInt64Value(source, keys...); ok {
		return value
	}
	return nil
}

func nestedACPFloatLogValue(source map[string]any, key string, nestedKey string) any {
	nested, _ := source[key].(map[string]any)
	if len(nested) == 0 {
		return nil
	}
	if value, ok := acpFloatValue(nested[nestedKey]); ok {
		return value
	}
	return nil
}

func nestedACPStringLogValue(source map[string]any, key string, nestedKey string) any {
	nested, _ := source[key].(map[string]any)
	if len(nested) == 0 {
		return nil
	}
	value := strings.TrimSpace(asString(nested[nestedKey]))
	if value == "" {
		return nil
	}
	return value
}

func logACPGoalUpdate(config standardACPConfig, session Session, turnID string, updateType string, update map[string]any) {
	goal := payloadObject(update["goal"])
	slog.Info("agent session ACP goal update",
		"event", "agent_session.acp.goal_update",
		"provider", config.provider,
		"adapter", config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"turn_id", turnID,
		"update_type", strings.TrimSpace(updateType),
		"goal_status", strings.TrimSpace(asString(goal["status"])),
		"goal_objective_len", len(strings.TrimSpace(asString(goal["objective"]))),
		"goal_has_reason", strings.TrimSpace(asString(goal["reason"])) != "",
	)
}

func standardACPToolCallEvent(session Session, turnID string, updateType string, update map[string]any) (activityshared.Event, bool) {
	return standardACPToolCallEventWithID(session, newID(), turnID, updateType, update)
}

func standardACPToolCallEventWithID(session Session, eventID string, turnID string, _ string, update map[string]any) (activityshared.Event, bool) {
	return acpToolCallEventWithID(session, eventID, turnID, update)
}

func acpCanonicalImageGenerationToolName(candidate string, _ any) string {
	normalized := strings.ToLower(strings.TrimSpace(candidate))
	switch normalized {
	case "image_generation", "image generation", "imagegen", "generate_image", "generateimage", "image_generator", "imagegenerator":
		return "ImageGeneration"
	}
	if strings.HasPrefix(normalized, "ig_") {
		return "ImageGeneration"
	}
	return ""
}

func acpContainsImageContent(value any) bool {
	entries, ok := value.([]any)
	if !ok {
		return false
	}
	for _, entry := range entries {
		entryMap, _ := entry.(map[string]any)
		if len(entryMap) == 0 {
			continue
		}
		target := entryMap
		if nested, ok := entryMap["content"].(map[string]any); ok && len(nested) > 0 {
			target = nested
		}
		if acpLooksLikeImagePayload(target) {
			return true
		}
	}
	return false
}

func shouldIgnoreStandardACPTitle(_ standardACPConfig, _ string, title string) bool {
	return isInternalMentionRoutingTitle(title)
}

func standardACPPermissionRequested(
	adapter *standardACPAdapter,
	session Session,
	turnID string,
	rawRequestID json.RawMessage,
	raw json.RawMessage,
	normalizer *acpTurnNormalizer,
) ([]activityshared.Event, *pendingACPApproval, error) {
	var params struct {
		ToolCall map[string]any   `json:"toolCall"`
		Options  []map[string]any `json:"options"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, nil, fmt.Errorf("invalid permission request: %w", err)
	}
	requestID := acpRequestID(rawRequestID)
	if requestID == "" {
		return nil, nil, errors.New("permission request id is required")
	}
	interactivePrompt := normalizedInteractivePrompt(params.ToolCall, params.Options, requestID)
	if len(params.Options) == 0 && interactivePrompt == nil {
		return []activityshared.Event{newTurnActivityEvent(session, EventCallFailed, turnID, messageStreamStateFailed, "", "Permission requested", map[string]any{
			"callId":   requestID,
			"callType": "approval",
			"name":     "Permission requested",
			"status":   messageStreamStateFailed,
			"error": map[string]any{
				"requestId": requestID,
				"message":   "permission request did not include options",
			},
		})}, nil, errors.New("permission request did not include options")
	}
	title := firstNonEmpty(
		asString(params.ToolCall["title"]),
		asString(params.ToolCall["name"]),
		asString(params.ToolCall["toolCallId"]),
		"Permission requested",
	)
	callID := firstNonEmpty(asString(params.ToolCall["toolCallId"]), asString(params.ToolCall["id"]), newID())
	callType := "approval"
	status := string(activityshared.TurnPhaseWaitingApproval)
	rawToolCallID := asString(params.ToolCall["toolCallId"])
	knownInput := normalizer.KnownToolCallInput(rawToolCallID)
	input := normalizedApprovalInput(params.ToolCall, params.Options, requestID, knownInput)
	approvalPurpose := ""
	if interactivePrompt == nil {
		approvalPurpose = normalizedApprovalPurpose(params.ToolCall)
	}
	payload := map[string]any{
		"callId":   callID,
		"callType": "approval",
		"name":     title,
		"toolName": "Approval",
		"status":   status,
		"input":    input,
	}
	if approvalPurpose != "" {
		payload["approvalPurpose"] = approvalPurpose
	}
	if interactivePrompt != nil {
		callType = "interactive"
		title = firstNonEmpty(interactivePrompt.ToolName, title)
		status = firstNonEmpty(interactivePrompt.Status, "waiting_input")
		input = clonePayload(interactivePrompt.Input)
		if input == nil {
			input = map[string]any{}
		}
		input["requestId"] = requestID
		if len(params.Options) > 0 {
			input["options"] = cloneOptionMaps(params.Options)
		}
		payload = map[string]any{
			"callId":   callID,
			"callType": callType,
			"name":     title,
			"toolName": interactivePrompt.ToolName,
			"status":   status,
			"input":    input,
		}
		if metadata := clonePayload(interactivePrompt.Metadata); metadata != nil {
			payload["metadata"] = metadata
		}
	}
	pending := &pendingACPApproval{
		agentSessionID:  strings.TrimSpace(session.AgentSessionID),
		turnID:          strings.TrimSpace(turnID),
		requestID:       requestID,
		eventID:         newID(),
		callID:          callID,
		callType:        callType,
		input:           input,
		kind:            firstNonEmpty(interactivePromptKind(interactivePrompt), "approval"),
		approvalPurpose: approvalPurpose,
		name:            title,
		toolName:        firstNonEmpty(asString(payload["toolName"]), title),
		prompt:          interactivePrompt,
		options:         params.Options,
		response:        make(chan pendingInteractiveResponse, 1),
	}
	adapter.storePendingApproval(pending)
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
		normalizedInteractionRequestedEvent(session, turnID, pending),
	}, pending, nil
}
