//revive:disable:file-length-limit
package agentruntime

import (
	"encoding/json"
	"errors"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/internal/titletext"
)

func acpModeValue(update map[string]any) string {
	return firstNonEmpty(
		// `currentModeId` is the ACP-canonical field on a current_mode_update
		// notification (claude-code/codex send the mode there); the rest are
		// tolerated fallbacks for other shapes.
		asString(update["currentModeId"]),
		asString(update["current_mode_id"]),
		asString(update["mode"]),
		asString(update["modeId"]),
		asString(update["mode_id"]),
		asString(update["name"]),
		asString(update["value"]),
	)
}

func acpCommandsValue(update map[string]any) ([]AgentSessionCommand, bool) {
	commands := make([]AgentSessionCommand, 0)
	found := false
	entryCount := 0
	appendCommand := func(command AgentSessionCommand) {
		command.Name = strings.TrimSpace(command.Name)
		command.Description = strings.TrimSpace(command.Description)
		command.InputHint = strings.TrimSpace(command.InputHint)
		if command.Name != "" {
			commands = append(commands, command)
		}
	}
	for _, key := range []string{"commands", "availableCommands", "available_commands"} {
		values, ok := update[key].([]any)
		if !ok {
			continue
		}
		found = true
		entryCount += len(values)
		for _, value := range values {
			switch typed := value.(type) {
			case string:
				appendCommand(AgentSessionCommand{Name: typed})
			case map[string]any:
				appendCommand(AgentSessionCommand{
					Name: firstNonEmpty(
						asString(typed["name"]),
						asString(typed["id"]),
						asString(typed["command"]),
					),
					Description: firstNonEmpty(
						asString(typed["description"]),
						asString(typed["summary"]),
					),
					InputHint: acpCommandInputHint(typed),
				})
			}
		}
	}
	if !found {
		return nil, false
	}
	commands = dedupeAgentSessionCommands(commands)
	if entryCount > 0 && len(commands) == 0 {
		return nil, false
	}
	return commands, true
}

func acpCommandInputHint(command map[string]any) string {
	if hint := firstNonEmpty(
		asString(command["inputHint"]),
		asString(command["input_hint"]),
		asString(command["hint"]),
	); hint != "" {
		return hint
	}
	if input, ok := command["input"].(map[string]any); ok {
		return firstNonEmpty(
			asString(input["hint"]),
			asString(input["inputHint"]),
			asString(input["input_hint"]),
		)
	}
	return ""
}

func dedupeAgentSessionCommands(commands []AgentSessionCommand) []AgentSessionCommand {
	if len(commands) == 0 {
		return []AgentSessionCommand{}
	}
	seen := make(map[string]struct{}, len(commands))
	out := make([]AgentSessionCommand, 0, len(commands))
	for _, command := range commands {
		command.Name = strings.TrimSpace(command.Name)
		command.Description = strings.TrimSpace(command.Description)
		command.InputHint = strings.TrimSpace(command.InputHint)
		if command.Name == "" {
			continue
		}
		if _, ok := seen[command.Name]; ok {
			continue
		}
		seen[command.Name] = struct{}{}
		out = append(out, command)
	}
	return out
}

func agentSessionCommandNames(commands []AgentSessionCommand) []string {
	if len(commands) == 0 {
		return []string{}
	}
	names := make([]string, 0, len(commands))
	for _, command := range commands {
		if name := strings.TrimSpace(command.Name); name != "" {
			names = append(names, name)
		}
	}
	return names
}

func acpConfigValues(update map[string]any) map[string]any {
	values := map[string]any{}
	for _, key := range []string{"config", "option", "options"} {
		if object, ok := update[key].(map[string]any); ok {
			for objectKey, objectValue := range object {
				if strings.TrimSpace(objectKey) != "" {
					values[objectKey] = objectValue
				}
			}
		}
	}
	configKey := firstNonEmpty(
		asString(update["key"]),
		asString(update["optionId"]),
		asString(update["option_id"]),
		asString(update["name"]),
	)
	if configKey != "" {
		if value, ok := update["value"]; ok {
			values[configKey] = value
		}
	}
	return values
}

func dedupeStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		normalized := strings.TrimSpace(value)
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	return out
}

func codexACPEnv(session Session, host HostMetadata) []string {
	env := []string{
		codexAgentRoutingEnv,
		codexRoutingPreload,
		"NO_BROWSER=1",
	}
	env = append(env, workspaceEnv(session, host)...)
	return env
}

func acpSessionID(raw json.RawMessage) (string, error) {
	var result struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", err
	}
	if strings.TrimSpace(result.SessionID) == "" {
		return "", errors.New("ACP session/new returned empty sessionId")
	}
	return strings.TrimSpace(result.SessionID), nil
}

func acpAgentInfo(raw json.RawMessage) map[string]any {
	var result struct {
		AgentInfo map[string]any `json:"agentInfo"`
	}
	if err := json.Unmarshal(raw, &result); err != nil || result.AgentInfo == nil {
		return map[string]any{}
	}
	return result.AgentInfo
}

func acpResumeMethod(raw json.RawMessage) string {
	var result map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &result) != nil {
		return ""
	}
	if truthyNested(result, "sessionCapabilities", "resume") ||
		truthyNested(result, "agentCapabilities", "resumeSession") ||
		truthyNested(result, "agentCapabilities", "resume") {
		return acpMethodResume
	}
	if truthyNested(result, "sessionCapabilities", "load") ||
		truthyNested(result, "sessionCapabilities", "loadSession") ||
		truthyNested(result, "agentCapabilities", "loadSession") ||
		truthyNested(result, "agentCapabilities", "load") {
		return acpMethodLoadSession
	}
	return ""
}

func truthyNested(value map[string]any, objectKey, fieldKey string) bool {
	nested, ok := value[objectKey].(map[string]any)
	if !ok {
		return false
	}
	switch field := nested[fieldKey].(type) {
	case bool:
		return field
	case string:
		return strings.EqualFold(strings.TrimSpace(field), "true")
	default:
		return false
	}
}

func acpStopReason(raw json.RawMessage) string {
	var result struct {
		StopReason string `json:"stopReason"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return ""
	}
	return canonicalACPStopReason(result.StopReason)
}

func canonicalACPStopReason(reason string) string {
	trimmed := strings.TrimSpace(reason)
	switch strings.ToLower(trimmed) {
	case "cancelled":
		return SessionStatusCanceled
	default:
		return trimmed
	}
}

func acpPromptResultAssistantText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return ""
	}
	return strings.TrimSpace(acpTextFromValue(decoded))
}

func acpTextFromValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := strings.TrimSpace(acpTextFromValue(item)); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "")
	case map[string]any:
		if role := strings.TrimSpace(asString(typed["role"])); role != "" && role != "assistant" && role != "agent" {
			return ""
		}
		if text := strings.TrimSpace(asString(typed["text"])); text != "" {
			return text
		}
		for _, key := range []string{"content", "message", "output", "result"} {
			if text := strings.TrimSpace(acpTextFromValue(typed[key])); text != "" {
				return text
			}
		}
		if messages, ok := typed["messages"].([]any); ok {
			for i := len(messages) - 1; i >= 0; i-- {
				if text := strings.TrimSpace(acpTextFromValue(messages[i])); text != "" {
					return text
				}
			}
		}
	}
	return ""
}

func acpSystemNoticeEvents(session Session, turnID string, update map[string]any, _ *acpTurnNormalizer, fallbackKind string, allowSyntheticNotice bool) ([]activityshared.Event, bool) {
	event, ok := acpSystemNoticeEvent(session, turnID, update, fallbackKind, allowSyntheticNotice)
	if !ok {
		return nil, false
	}
	return []activityshared.Event{event}, true
}

func acpFailureMetadata(err error) map[string]any {
	if err == nil {
		return nil
	}
	payload := map[string]any{
		"error": err.Error(),
	}
	var callErr *acpCallError
	if !errors.As(err, &callErr) {
		return payload
	}
	payload["acpErrorCode"] = callErr.Err.Code
	if message := strings.TrimSpace(callErr.Err.Message); message != "" {
		payload["acpErrorMessage"] = message
	}
	data := acpErrorDataPayload(callErr.Err.Data)
	if message := strings.TrimSpace(asString(data["message"])); message != "" {
		payload["error"] = message
		payload["errorMessage"] = message
	}
	if codexErrorInfo := firstNonEmpty(asString(data["codex_error_info"]), asString(data["codexErrorInfo"])); codexErrorInfo != "" {
		payload["codexErrorInfo"] = codexErrorInfo
	}
	return payload
}

func acpErrorDataPayload(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil
	}
	return payload
}

func acpSystemNoticeEvent(session Session, turnID string, update map[string]any, fallbackKind string, allowSyntheticNotice bool) (activityshared.Event, bool) {
	notice := acpSystemNoticePayload(update)
	updateType := asString(update["sessionUpdate"])
	if len(notice) == 0 {
		if !allowSyntheticNotice {
			return activityshared.Event{}, false
		}
		switch updateType {
		case "stream_error", "warning", "system_notice":
			notice = map[string]any{}
		default:
			if textNotice, ok := acpSystemNoticeFromAgentText(acpTextContent(update["content"])); ok {
				notice = textNotice
			} else {
				return activityshared.Event{}, false
			}
		}
	}
	payload := map[string]any{
		"kind": "agent_system_notice",
		"acp": map[string]any{
			"sessionUpdate": firstNonEmpty(updateType, fallbackKind),
		},
	}
	copyStringPayload(payload, notice, "noticeKind")
	copyStringPayload(payload, notice, "severity")
	copyStringPayload(payload, notice, "source")
	copyStringPayload(payload, notice, "title")
	copyStringPayload(payload, notice, "detail")
	copyStringPayload(payload, notice, "code")
	// A caller-provided messageId lets related notices (e.g. compaction
	// started/completed) share one transcript row instead of stacking.
	copyStringPayload(payload, notice, "messageId")
	copyBoolPayload(payload, notice, "retryable")
	if extra := clonePayloadValue(notice["extra"]); extra != nil {
		payload["extra"] = extra
	}
	if codexErrorInfo := clonePayloadValue(firstPresentAny(notice["codexErrorInfo"], notice["codex_error_info"], update["codexErrorInfo"], update["codex_error_info"])); codexErrorInfo != nil {
		payload["codexErrorInfo"] = codexErrorInfo
	}
	if additionalDetails := firstNonEmpty(asString(notice["additionalDetails"]), asString(notice["additional_details"]), asString(update["additionalDetails"]), asString(update["additional_details"])); additionalDetails != "" {
		payload["additionalDetails"] = additionalDetails
	}
	noticeKind := firstNonEmpty(asString(payload["noticeKind"]), acpNoticeKindFromUpdate(firstNonEmpty(updateType, fallbackKind)))
	severity := firstNonEmpty(asString(payload["severity"]), acpNoticeSeverity(noticeKind))
	detail := firstNonEmpty(asString(payload["detail"]), acpTextContent(update["content"]), asString(update["text"]), asString(payload["additionalDetails"]), asString(update["message"]))
	title := firstNonEmpty(asString(payload["title"]), acpNoticeTitle(noticeKind, detail))
	payload["noticeKind"] = noticeKind
	payload["severity"] = severity
	payload["title"] = title
	if detail != "" {
		payload["detail"] = detail
	}
	payload["content"] = title
	payload["text"] = title
	return newTurnActivityEvent(session, EventMessage, turnID, messageStreamStateCompleted, RoleAssistant, title, payload), true
}

func acpSystemNoticePayload(update map[string]any) map[string]any {
	if asString(update["kind"]) == "agent_system_notice" {
		return update
	}
	meta, _ := update["_meta"].(map[string]any)
	if meta == nil {
		return nil
	}
	if tsh, ok := meta["tsh"].(map[string]any); ok && asString(tsh["kind"]) == "agent_system_notice" {
		return tsh
	}
	if asString(meta["kind"]) == "agent_system_notice" {
		return meta
	}
	return nil
}

func acpSystemNoticeFromAgentText(text string) (map[string]any, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, false
	}
	normalized := strings.ToLower(text)
	if acpAgentTextLooksLikeTransportRetry(normalized) {
		return map[string]any{
			"kind":       "agent_system_notice",
			"noticeKind": "transport_retry",
			"severity":   "warning",
			"title":      "Codex connection interrupted. Reconnecting...",
			"detail":     text,
			"retryable":  true,
			"source":     "agent_text",
		}, true
	}
	if strings.Contains(normalized, "falling back from websockets to https transport") ||
		strings.Contains(normalized, "switched to https transport") {
		return map[string]any{
			"kind":       "agent_system_notice",
			"noticeKind": "transport_fallback",
			"severity":   "warning",
			"title":      "Codex switched to HTTPS transport.",
			"detail":     text,
			"source":     "agent_message_chunk",
		}, true
	}
	return nil, false
}

func acpAgentTextLooksLikeTransportRetry(normalized string) bool {
	if !strings.Contains(normalized, "reconnecting") {
		return false
	}
	if strings.Contains(normalized, "responsestreamdisconnected") ||
		strings.Contains(normalized, "broken pipe") ||
		strings.Contains(normalized, "handled error during turn") ||
		strings.Contains(normalized, "response stream") ||
		strings.Contains(normalized, "websocket") {
		return true
	}
	return strings.Contains(normalized, "/5") || strings.Contains(normalized, "/ 5")
}

func copyStringPayload(payload map[string]any, source map[string]any, key string) {
	if value := asString(source[key]); value != "" {
		payload[key] = value
	}
}

func copyBoolPayload(payload map[string]any, source map[string]any, key string) {
	if value, ok := source[key].(bool); ok {
		payload[key] = value
	}
}

func firstPresentAny(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func acpNoticeKindFromUpdate(updateType string) string {
	switch strings.TrimSpace(updateType) {
	case "stream_error":
		return "transport_retry"
	case "warning":
		return "warning"
	default:
		return "system_notice"
	}
}

func acpNoticeSeverity(noticeKind string) string {
	switch strings.TrimSpace(noticeKind) {
	case "transport_retry", "transport_fallback", "warning":
		return "warning"
	default:
		return "info"
	}
}

func acpNoticeTitle(noticeKind string, detail string) string {
	switch strings.TrimSpace(noticeKind) {
	case "transport_retry":
		return "Codex connection interrupted. Reconnecting..."
	case "transport_fallback":
		return "Codex switched to HTTPS transport."
	case "warning":
		return firstNonEmpty(detail, "Codex warning")
	default:
		return firstNonEmpty(detail, "Agent notice")
	}
}

func acpSessionTitleEvent(session Session, update map[string]any) (activityshared.Event, bool) {
	title := titletext.Normalize(firstNonEmpty(
		asString(update["title"]),
		asString(update["name"]),
		asString(update["summary"]),
	))
	if title == "" || title == strings.TrimSpace(session.Title) {
		return activityshared.Event{}, false
	}
	return newSessionTitleActivityEvent(session, title), true
}

func acpConfigOptionsUpdatedEvent(session Session, update map[string]any) (activityshared.Event, bool) {
	ctx, ok := activityEventContext(session, newID(), "")
	if !ok {
		return activityshared.Event{}, false
	}
	event := activityshared.NewSessionUpdated(ctx, "")
	metadata := map[string]any{
		"acpSessionUpdate": "config_option_update",
	}
	if key := asString(update["key"]); key != "" {
		metadata["configOptionKey"] = key
	}
	event.Payload.Metadata = metadata
	return event, true
}

func acpUsageUpdatedEvent(session Session) (activityshared.Event, bool) {
	ctx, ok := activityEventContext(session, newID(), "")
	if !ok {
		return activityshared.Event{}, false
	}
	event := activityshared.NewSessionUpdated(ctx, "")
	event.Payload.Metadata = map[string]any{
		"acpSessionUpdate": "usage_update",
	}
	return event, true
}

func acpGoalUpdatedEvent(session Session, updateType string) (activityshared.Event, bool) {
	ctx, ok := activityEventContext(session, newID(), "")
	if !ok {
		return activityshared.Event{}, false
	}
	event := activityshared.NewSessionUpdated(ctx, "")
	event.Payload.Metadata = map[string]any{
		"acpSessionUpdate": strings.TrimSpace(updateType),
	}
	return event, true
}

func acpCurrentModeUpdatedEvent(session Session, modeID string) (activityshared.Event, bool) {
	ctx, ok := activityEventContext(session, newID(), "")
	if !ok {
		return activityshared.Event{}, false
	}
	modeID = strings.TrimSpace(modeID)
	if modeID == "" {
		return activityshared.Event{}, false
	}
	event := activityshared.NewSessionUpdated(ctx, "")
	event.Payload.Metadata = map[string]any{
		"acpSessionUpdate": "current_mode_update",
		"acpModeId":        modeID,
	}
	return event, true
}

func hasACPCurrentModeUpdatedEvent(events []activityshared.Event) bool {
	for _, event := range events {
		if event.Type != activityshared.EventSessionUpdated {
			continue
		}
		if strings.TrimSpace(asString(event.Payload.Metadata["acpSessionUpdate"])) != "current_mode_update" {
			continue
		}
		return true
	}
	return false
}

func newSessionTitleActivityEvent(session Session, title string) activityshared.Event {
	ctx, ok := activityEventContext(session, newID(), "")
	if !ok {
		return activityshared.Event{}
	}
	ctx.Title = titletext.Normalize(title)
	return activityshared.NewSessionTitleUpdated(ctx)
}

func fallbackACPFamilySessionTitle(currentTitle string, prompt string, fallbackTitles ...string) string {
	if !shouldUseFallbackACPTitle(currentTitle, fallbackTitles...) {
		return ""
	}
	return promptTitleSnippet(prompt)
}

func shouldUseFallbackACPTitle(title string, fallbackTitles ...string) bool {
	normalizedTitle := strings.ToLower(strings.TrimSpace(title))
	for _, fallbackTitle := range fallbackTitles {
		if normalizedTitle == strings.ToLower(strings.TrimSpace(fallbackTitle)) {
			return true
		}
	}
	return false
}

func promptTitleSnippet(prompt string) string {
	fields := strings.Fields(titletext.Normalize(prompt))
	if len(fields) == 0 {
		return ""
	}
	title := strings.Join(fields, " ")
	const maxRunes = 160
	runes := []rune(title)
	if len(runes) <= maxRunes {
		return title
	}
	return strings.TrimSpace(string(runes[:maxRunes])) + "..."
}
