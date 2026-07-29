package agentruntime

import (
	"fmt"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func messageUpdateFromSessionEvent(
	source canonical.EventSource,
	event activityshared.Event,
	sessionID string,
	timestamp int64,
) (agentsessionstore.WorkspaceAgentMessageUpdate, bool) {
	switch event.Type {
	case activityshared.EventMessageAppended, activityshared.EventMessageCreated:
		return textMessageUpdateFromSessionEvent(event, sessionID, timestamp)
	case activityshared.EventCallStarted, activityshared.EventCallCompleted, activityshared.EventCallFailed:
		return callMessageUpdateFromSessionEvent(source, event, sessionID, timestamp)
	default:
		return agentsessionstore.WorkspaceAgentMessageUpdate{}, false
	}
}

func textMessageUpdateFromSessionEvent(
	event activityshared.Event,
	sessionID string,
	timestamp int64,
) (agentsessionstore.WorkspaceAgentMessageUpdate, bool) {
	messageID := firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "messageId"), event.EventID)
	if strings.TrimSpace(sessionID) == "" || messageID == "" || timestamp <= 0 {
		return agentsessionstore.WorkspaceAgentMessageUpdate{}, false
	}
	role := strings.TrimSpace(string(event.Payload.Role))
	if role == "" {
		role = string(activityshared.MessageRoleAssistant)
	}
	kind := "text"
	if role == string(activityshared.MessageRoleAssistantThinking) {
		role = string(activityshared.MessageRoleAssistant)
		kind = "reasoning"
	}
	payload := map[string]any{
		"source": "runtime",
	}
	if event.Payload.Content != "" {
		payload["content"] = event.Payload.Content
		payload["text"] = event.Payload.Content
	}
	if content, ok := event.Payload.Metadata["content"]; ok {
		payload["content"] = acpSanitizeImagePayload(content)
	}
	if displayPrompt := stringFromPayload(event.Payload.Metadata, "displayPrompt"); displayPrompt != "" {
		payload["displayPrompt"] = displayPrompt
	}
	if clientSubmitID := stringFromPayload(event.Payload.Metadata, "clientSubmitId"); clientSubmitID != "" {
		payload["clientSubmitId"] = clientSubmitID
	}
	update := agentsessionstore.WorkspaceAgentMessageUpdate{
		AgentSessionID:   strings.TrimSpace(sessionID),
		MessageID:        messageID,
		Seq:              uint64(timestamp),
		TurnID:           strings.TrimSpace(event.Payload.TurnID),
		Role:             role,
		Kind:             kind,
		Status:           firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "streamState"), event.Payload.Status),
		Payload:          payload,
		OccurredAtUnixMS: timestamp,
	}
	if contentMode := stringFromPayload(event.Payload.Metadata, "contentMode"); contentMode != "" {
		update.Payload["contentMode"] = contentMode
	}
	// Carry the adapter's message kind tag (e.g. codex plan proposals) so the
	// GUI can render dedicated treatments instead of a plain assistant bubble.
	if messageKind := stringFromPayload(event.Payload.Metadata, "messageKind"); messageKind != "" {
		update.Payload["messageKind"] = messageKind
	}
	update.Semantics = messageSemanticsFromMetadata(event.Payload.Metadata)
	forwardSystemNoticeMessageMetadata(update.Payload, event.Payload.Metadata)
	return update, true
}

func messageSemanticsFromMetadata(metadata map[string]any) *canonical.WorkspaceAgentMessageSemantics {
	if len(metadata) == 0 {
		return nil
	}
	semantics := canonical.WorkspaceAgentMessageSemantics{}
	if value, ok := metadata["userVisibleAssistantResponse"].(bool); ok {
		semantics.UserVisibleAssistantResponse = value
	}
	if value, ok := metadata["turnSettling"].(bool); ok {
		semantics.TurnSettling = value
	}
	semantics.NoticeCommand = stringFromPayload(metadata, "noticeCommand")
	semantics.NoticeCommandStatus = stringFromPayload(metadata, "noticeCommandStatus")
	if !semantics.UserVisibleAssistantResponse &&
		!semantics.TurnSettling &&
		semantics.NoticeCommand == "" &&
		semantics.NoticeCommandStatus == "" {
		return nil
	}
	return &semantics
}

func forwardSystemNoticeMessageMetadata(payload map[string]any, metadata map[string]any) {
	if stringFromPayload(metadata, "kind") != "agent_system_notice" {
		return
	}
	for _, key := range []string{
		"kind",
		"noticeKind",
		"severity",
		"title",
		"detail",
		"additionalDetails",
		"code",
		"noticeCommand",
		"noticeCommandStatus",
	} {
		if value := stringFromPayload(metadata, key); value != "" {
			payload[key] = value
		}
	}
	if retryable, ok := metadata["retryable"].(bool); ok {
		payload["retryable"] = retryable
	}
	for _, key := range []string{"acp", "codexErrorInfo", "extra"} {
		if value, ok := metadata[key]; ok && !payloadValueIsEmpty(value) {
			payload[key] = clonePayloadValue(value)
		}
	}
}

func callMessageUpdateFromSessionEvent(
	source canonical.EventSource,
	event activityshared.Event,
	sessionID string,
	timestamp int64,
) (agentsessionstore.WorkspaceAgentMessageUpdate, bool) {
	if strings.TrimSpace(sessionID) == "" || timestamp <= 0 {
		return agentsessionstore.WorkspaceAgentMessageUpdate{}, false
	}
	callID := strings.TrimSpace(event.Payload.CallID)
	messageID := toolCallMessageUpdateID(event, sessionID, timestamp)
	if messageID == "" {
		return agentsessionstore.WorkspaceAgentMessageUpdate{}, false
	}
	status := callMessageUpdateStatus(event)
	payload := map[string]any{
		"source": "runtime",
	}
	rawName := callMessageUpdateDisplayName(event, callID)
	toolName := callMessageUpdateToolName(event, callID, rawName)
	name := firstNonEmptyString(toolName, rawName)
	if name != "" {
		payload["name"] = name
	}
	if callType := firstNonEmptyString(event.Payload.CallType, stringFromPayload(event.Payload.Metadata, "callType")); callType != "" {
		payload["callType"] = callType
	}
	for _, key := range []string{
		"toolName",
		"activityKind",
		"fileChangeKind",
		"fileChanges",
		"command",
		"status",
		"exitCode",
		"exit_code",
		"sessionID",
		"paths",
		"requestId",
	} {
		if value, ok := event.Payload.Metadata[key]; ok && !payloadValueIsEmpty(value) {
			if key == "toolName" {
				continue
			}
			payload[key] = clonePayloadValue(value)
		}
	}
	if toolName != "" {
		payload["toolName"] = toolName
	}
	if metadata, ok := event.Payload.Metadata["metadata"].(map[string]any); ok && len(metadata) > 0 {
		payload["metadata"] = clonePayloadValue(metadata)
	}
	for _, key := range []string{"input", "output", "error", "content", "locations"} {
		if value, ok := event.Payload.Metadata[key]; ok && !payloadValueIsEmpty(value) {
			switch key {
			case "output", "error":
				payload[key] = canonicalToolBodyPayload(value)
			default:
				payload[key] = clonePayloadValue(value)
			}
		}
	}
	switch event.Type {
	case activityshared.EventCallStarted:
		if len(event.Payload.Input) > 0 {
			payload["input"] = clonePayload(event.Payload.Input)
		}
	case activityshared.EventCallCompleted:
		// Cursor ACP completes with empty rawInput; the normalizer merges the
		// earlier start input into Metadata/Input. Keep copying Payload.Input so
		// a completed update cannot drop Glob/Grep/Read args when Metadata omit
		// them during projection.
		if len(event.Payload.Input) > 0 {
			if _, exists := payload["input"]; !exists {
				payload["input"] = clonePayload(event.Payload.Input)
			}
		}
		if len(event.Payload.Output) > 0 {
			payload["output"] = canonicalToolBodyPayload(event.Payload.Output)
		}
	case activityshared.EventCallFailed:
		if len(event.Payload.Input) > 0 {
			if _, exists := payload["input"]; !exists {
				payload["input"] = clonePayload(event.Payload.Input)
			}
		}
		if len(event.Payload.Output) > 0 {
			payload["output"] = canonicalToolBodyPayload(event.Payload.Output)
		}
		if len(event.Payload.Error) > 0 {
			payload["error"] = canonicalToolBodyPayload(event.Payload.Error)
		}
	}
	update := agentsessionstore.WorkspaceAgentMessageUpdate{
		AgentSessionID:   strings.TrimSpace(sessionID),
		MessageID:        messageID,
		Seq:              uint64(timestamp),
		TurnID:           strings.TrimSpace(event.Payload.TurnID),
		Role:             string(activityshared.MessageRoleAssistant),
		Kind:             "tool_call",
		Status:           status,
		CallID:           callID,
		Title:            name,
		Payload:          payload,
		OccurredAtUnixMS: timestamp,
	}
	if provider := firstNonEmptyString(string(event.Provider), source.Provider); provider != "" {
		update.Payload["provider"] = provider
	}
	switch event.Type {
	case activityshared.EventCallStarted:
		update.StartedAtUnixMS = timestamp
	case activityshared.EventCallCompleted, activityshared.EventCallFailed:
		update.CompletedAtUnixMS = timestamp
	}
	return update, true
}

func canonicalToolBodyPayload(value any) any {
	body, ok := clonePayloadValue(value).(map[string]any)
	if !ok || len(body) == 0 {
		return clonePayloadValue(value)
	}
	if strings.TrimSpace(asString(body["text"])) == "" {
		if text := canonicalToolBodyText(body); text != "" {
			body["text"] = text
		}
	}
	return body
}

func canonicalToolBodyText(body map[string]any) string {
	for _, key := range []string{"text", "output", "stdout", "aggregated_output", "formatted_output", "stderr", "message"} {
		if text := strings.TrimSpace(asString(body[key])); text != "" {
			return text
		}
	}
	return strings.TrimSpace(acpContentText(body["content"]))
}

func callMessageUpdateDisplayName(event activityshared.Event, callID string) string {
	for _, candidate := range []string{
		event.Payload.Name,
		stringFromPayload(event.Payload.Metadata, "name"),
	} {
		if trimmed := strings.TrimSpace(candidate); trimmed != "" && !isOpaqueCallIdentifierString(trimmed, callID) {
			return trimmed
		}
	}
	return ""
}

func callMessageUpdateToolName(event activityshared.Event, callID string, displayName string) string {
	for _, candidate := range []string{
		stringFromPayload(event.Payload.Metadata, "toolName"),
		stringFromPayload(event.Payload.Metadata, "tool"),
		displayName,
		event.Payload.Name,
		stringFromPayload(event.Payload.Metadata, "name"),
		stringFromPayload(event.Payload.Metadata, "activityKind"),
		stringFromPayload(event.Payload.Metadata, "activity_kind"),
		stringFromPayload(event.Payload.Metadata, "kind"),
	} {
		if toolName := canonicalAgentToolName(candidate, callID); toolName != "" {
			return toolName
		}
	}
	if commandFromPayload(event.Payload.Input) != "" {
		return "Bash"
	}
	return ""
}

func canonicalAgentToolName(value string, callID string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || isOpaqueCallIdentifierString(trimmed, callID) {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(trimmed), "mcp__") {
		return trimmed
	}
	normalized := normalizeAgentToolToken(trimmed)
	switch normalized {
	case "approval":
		return "Approval"
	case "askuserquestion":
		return "AskUserQuestion"
	case "enterplanmode":
		return "EnterPlanMode"
	case "exitplanmode":
		return "ExitPlanMode"
	case "toolsearch":
		return "ToolSearch"
	case "skill":
		return "Skill"
	case "think":
		return "Think"
	case "bash", "shell", "exec", "execcommand", "runshellcommand", "terminal", "command", "runcommand":
		return "Bash"
	case "read", "readfile", "openfile", "listdir", "listdirectory", "listfiles", "ls":
		return "Read"
	case "write", "writefile", "createfile", "createnewfile", "writetofile":
		return "Write"
	case "edit", "editfile", "multiedit", "replaceinfile", "inserttext", "applypatch", "move":
		return "Edit"
	case "grep", "rg", "ripgrep", "search", "searchfiles", "searchfilecontent", "codebasesearch":
		return "Grep"
	case "glob", "find", "fd", "file_search", "filesearch", "findfiles":
		return "Glob"
	case "websearch", "googlesearch", "googlewebsearch", "websearchpreview":
		return "WebSearch"
	case "webfetch", "fetch", "fetchurl", "openpage":
		return "WebFetch"
	case "todowrite", "todo", "todowritefile", "updatetodo", "updatetodos", "writetodos":
		return "TodoWrite"
	case "task", "agent", "subagent", "runsubagent", "delegatetask", "delegateagent", "executeagent":
		return "Agent"
	case "run_command":
		return "Bash"
	case "read_file", "read_notebook", "list_files":
		return "Read"
	case "write_file":
		return "Write"
	case "edit_file", "edit_notebook", "apply_patch":
		return "Edit"
	case "find_files":
		return "Glob"
	case "search_files":
		return "Grep"
	case "web_search":
		return "WebSearch"
	case "web_fetch":
		return "WebFetch"
	case "update_todos":
		return "TodoWrite"
	case "delegate_agent":
		return "Agent"
	default:
		return trimmed
	}
}

func normalizeAgentToolToken(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	normalized = strings.TrimPrefix(normalized, "tool.")
	normalized = strings.ReplaceAll(normalized, "-", "")
	normalized = strings.ReplaceAll(normalized, "_", "")
	normalized = strings.ReplaceAll(normalized, " ", "")
	return normalized
}

func commandFromPayload(payload map[string]any) string {
	return firstNonEmptyString(asString(payload["command"]), asString(payload["cmd"]), asString(payload["shell_command"]))
}

func isOpaqueCallIdentifierString(value string, callID string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return false
	}
	if normalizedCallID := strings.TrimSpace(callID); normalizedCallID != "" && trimmed == normalizedCallID {
		return true
	}
	// Cursor ACP call ids are `call-<uuid>-N\nfc_<uuid>_N`. Treat any value that
	// equals / starts as that opaque id as non-displayable so merge logic does
	// not re-derive tool names from the call id after an empty tool_call_update.
	if callID = strings.TrimSpace(callID); callID != "" {
		if primary, _, ok := strings.Cut(callID, "\n"); ok && primary != "" && (trimmed == primary || strings.HasPrefix(trimmed, primary+"\n")) {
			return true
		}
	}
	lower := strings.ToLower(trimmed)
	switch {
	case strings.HasPrefix(lower, "call_"):
		return isOpaqueIdentifierTail(trimmed[len("call_"):])
	case strings.HasPrefix(lower, "call-"):
		rest := trimmed[len("call-"):]
		if primary, _, ok := strings.Cut(rest, "\n"); ok {
			rest = primary
		}
		return len(rest) >= 12
	case strings.HasPrefix(lower, "ws_"):
		return isOpaqueIdentifierTail(trimmed[len("ws_"):])
	default:
		return false
	}
}

func isOpaqueIdentifierTail(value string) bool {
	if len(value) < 12 {
		return false
	}
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			continue
		}
		return false
	}
	return true
}

func toolCallMessageUpdateID(event activityshared.Event, sessionID string, timestamp int64) string {
	if callID := strings.TrimSpace(event.Payload.CallID); callID != "" {
		return "toolcall:" + callID
	}
	if eventID := strings.TrimSpace(event.EventID); eventID != "" {
		return "toolcall:" + eventID
	}
	fallback := firstNonEmptyString(event.Payload.TurnID, sessionID, fmt.Sprintf("%d", timestamp))
	if fallback == "" {
		return ""
	}
	return "toolcall:" + fallback
}

func callMessageUpdateStatus(event activityshared.Event) string {
	switch event.Type {
	case activityshared.EventCallCompleted:
		return string(activityshared.ActivityStatusCompleted)
	case activityshared.EventCallFailed:
		return string(activityshared.ActivityStatusFailed)
	case activityshared.EventCallStarted:
		status := firstNonEmptyString(event.Payload.Status, stringFromPayload(event.Payload.Metadata, "status"))
		switch strings.ToLower(status) {
		case string(activityshared.TurnPhaseWaitingApproval), string(activityshared.TurnPhaseWaitingInput), "waiting":
			return status
		default:
			return string(activityshared.ActivityStatusRunning)
		}
	default:
		return ""
	}
}
