package agentruntime

import (
	"encoding/json"
	"log/slog"
	"os"
	"strconv"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func acpToolCallEvent(session Session, turnID string, update map[string]any) (activityshared.Event, bool) {
	return acpToolCallEventWithID(session, newID(), turnID, update)
}

func acpToolCallEventWithID(session Session, eventID string, turnID string, update map[string]any) (activityshared.Event, bool) {
	callID := firstNonEmpty(asString(update["toolCallId"]), asString(update["callId"]), asString(update["id"]))
	name := firstNonEmpty(asString(update["title"]), asString(update["name"]), callID, "tool")
	kind := asString(update["kind"])
	status := acpResolvedToolCallStatus(update, string(activityshared.ActivityStatusRunning))
	rawInput := acpToolCallRawInput(update)
	rawOutput := acpToolCallRawOutput(update)
	locations := clonePayloadValue(update["locations"])
	content := acpSanitizeImagePayload(update["content"])
	eventType := EventCallStarted
	inputBody := acpNormalizeToolInput(rawInput, kind, locations)
	callBody := inputBody
	switch normalizedCallStatus(status) {
	case messageStreamStateCompleted:
		eventType = EventCallCompleted
		callBody = acpNormalizeToolOutput(rawOutput, content)
	case messageStreamStateFailed:
		eventType = EventCallFailed
		callBody = acpNormalizeToolOutput(rawOutput, content)
	default:
		status = string(activityshared.ActivityStatusRunning)
	}
	toolName := firstNonEmpty(
		asString(update["toolName"]),
		acpToolNameWithOutput(callID, name, kind, rawInput, rawOutput),
	)
	payload := map[string]any{
		"callId":   callID,
		"callType": "tool",
		"name":     name,
		"status":   status,
	}
	if toolName != "" {
		payload["toolName"] = toolName
	}
	if kind != "" {
		payload["kind"] = kind
		payload["acp"] = map[string]any{
			"sessionUpdate": asString(update["sessionUpdate"]),
			"kind":          kind,
		}
	} else if sessionUpdate := asString(update["sessionUpdate"]); sessionUpdate != "" {
		payload["acp"] = map[string]any{
			"sessionUpdate": sessionUpdate,
		}
	}
	if locations != nil {
		payload["locations"] = locations
	}
	if content != nil {
		payload["content"] = content
	}
	// Some tools (notably Codex web search) stream an empty input on the
	// `started` event and only populate the real input — the search query — on
	// the `completed` event. The terminal event must therefore carry the input
	// too, otherwise the empty start payload wins the merge and the query is lost.
	if eventType != EventCallStarted && len(inputBody) > 0 {
		payload["input"] = inputBody
	}
	if len(callBody) > 0 {
		switch eventType {
		case EventCallCompleted:
			payload["output"] = callBody
		case EventCallFailed:
			payload["error"] = callBody
			if mirroredOutput := acpMirrorFailedToolOutput(callBody); len(mirroredOutput) > 0 {
				payload["output"] = mirroredOutput
			}
		default:
			payload["input"] = callBody
		}
	}
	logACPToolCallDiagnostic(session, turnID, update, payload)
	return newTurnActivityEventWithID(session, eventID, eventType, turnID, status, "", name, payload), true
}

func acpToolCallRawInput(update map[string]any) any {
	if rawInput, ok := update["rawInput"]; ok {
		return clonePayloadValue(rawInput)
	}
	if input, ok := update["input"]; ok {
		return clonePayloadValue(input)
	}
	return nil
}

func acpToolCallRawOutput(update map[string]any) any {
	if rawOutput, ok := update["rawOutput"]; ok {
		return clonePayloadValue(rawOutput)
	}
	if output, ok := update["output"]; ok {
		return clonePayloadValue(output)
	}
	return nil
}

func acpToolName(callID string, title string, kind string, rawInput any) string {
	return acpToolNameWithOutput(callID, title, kind, rawInput, nil)
}

func acpToolNameWithOutput(callID string, title string, kind string, rawInput any, rawOutput any) string {
	input, _ := rawInput.(map[string]any)
	normalizedCallID := strings.ToLower(strings.TrimSpace(callID))
	normalizedKind := strings.ToLower(strings.TrimSpace(kind))
	trimmedTitle := strings.TrimSpace(title)
	normalizedTitle := strings.ToLower(trimmedTitle)
	if isOpaqueCallIdentifierString(trimmedTitle, callID) {
		trimmedTitle = ""
		normalizedTitle = ""
	}
	if syntheticToolName := acpSyntheticToolName(normalizedTitle); syntheticToolName != "" {
		return syntheticToolName
	}
	if strings.HasPrefix(normalizedCallID, "web_search_") {
		return "WebSearch"
	}
	if input != nil {
		if strings.TrimSpace(asString(input["cmd"])) != "" || acpExtractShellCommand(input["command"]) != "" {
			return "Bash"
		}
		if input["todos"] != nil {
			return "TodoWrite"
		}
		if strings.TrimSpace(asString(input["patchText"])) != "" {
			return "Edit"
		}
	}
	if fetchToolName := acpFetchToolName(input); fetchToolName != "" {
		return fetchToolName
	}
	if strings.HasPrefix(normalizedTitle, "searching for:") {
		return "WebSearch"
	}
	// Cursor ACP uses descriptive titles ("Find `path` `*.go`", `grep "x"`)
	// and kind=search for Glob/Grep. Prefer title/input/output shape over the
	// historical kind=search → Bash fallback that blanked the tool card.
	if toolName := acpToolNameFromSearchHints(normalizedTitle, normalizedKind, input, rawOutput); toolName != "" {
		return toolName
	}
	switch normalizedKind {
	case "think":
		if normalizedTitle == "update_todo" || input != nil && input["todos"] != nil {
			return "TodoWrite"
		}
		return "Think"
	case "read":
		if input != nil && (strings.TrimSpace(asString(input["pattern"])) != "" || strings.TrimSpace(asString(input["glob_pattern"])) != "" || strings.TrimSpace(asString(input["globPattern"])) != "") {
			return "Glob"
		}
		return "Read"
	case "search":
		switch normalizedTitle {
		case "glob", "find", "fd", "file_search":
			return "Glob"
		case "grep", "rg", "ripgrep", "codebase_search":
			return "Grep"
		default:
			// Unknown search tools are not shell commands (Cursor used to fall
			// through to Bash here, which blanked Glob/Grep cards).
			return "Grep"
		}
	case "other":
		switch normalizedTitle {
		case "task":
			return "Agent"
		case "agent":
			return "Agent"
		case "rg", "ripgrep":
			return "Grep"
		case "find", "fd":
			return "Glob"
		}
	case "edit", "move":
		return "Edit"
	case "delete":
		return "Write"
	case "execute":
		if input != nil {
			agentName := asString(input["agentName"])
			if controlToolName := appServerAgentControlToolName(agentName); controlToolName != "" {
				return controlToolName
			}
			if strings.TrimSpace(agentName) != "" {
				return "Agent"
			}
			if strings.TrimSpace(asString(input["task"])) != "" {
				return "Agent"
			}
		}
		return "Bash"
	case "fetch":
		return "WebFetch"
	}
	switch normalizedTitle {
	case "run_subagent":
		return "Agent"
	case "grep_search", "codebase_search":
		return "Grep"
	case "file_search":
		return "Glob"
	case "create_file", "create_new_file", "write_file", "write_to_file":
		return "Write"
	case "insert_text", "replace_in_file", "edit_file", "apply_patch":
		return "Edit"
	case "read_file", "list_dir":
		return "Read"
	}
	if trimmedTitle != "" {
		return trimmedTitle
	}
	return "Tool"
}

// acpToolNameFromSearchHints maps Cursor-style Glob/Grep ACP updates.
// Cursor sends kind=search with titles like `Find \`dir\` \`*.go\“ / `grep "x"`
// and rawInput `{pattern}` (Glob) or `{pattern,path}` (Grep), not exact tool names.
func acpToolNameFromSearchHints(normalizedTitle string, normalizedKind string, input map[string]any, rawOutput any) string {
	if strings.HasPrefix(normalizedTitle, "find ") || normalizedTitle == "find" ||
		strings.HasPrefix(normalizedTitle, "glob ") || normalizedTitle == "glob" {
		return "Glob"
	}
	if strings.HasPrefix(normalizedTitle, "grep") ||
		strings.HasPrefix(normalizedTitle, "rg ") || normalizedTitle == "rg" ||
		strings.HasPrefix(normalizedTitle, "ripgrep") {
		return "Grep"
	}
	if strings.HasPrefix(normalizedTitle, "search:") || strings.HasPrefix(normalizedTitle, "codebase search") {
		return "Grep"
	}
	if strings.HasPrefix(normalizedTitle, "web search") {
		return "WebSearch"
	}
	if strings.HasPrefix(normalizedTitle, "read ") || normalizedTitle == "read file" {
		return "Read"
	}
	output := acpMapFromValue(rawOutput, "output")
	if len(output) > 0 {
		if _, ok := output["totalFiles"]; ok {
			return "Glob"
		}
		if _, ok := output["totalMatches"]; ok {
			return "Grep"
		}
		if _, ok := output["resultCount"]; ok {
			return "Grep"
		}
	}
	if input == nil {
		return ""
	}
	globPattern := firstNonEmpty(
		asString(input["glob_pattern"]),
		asString(input["globPattern"]),
		asString(input["pattern"]),
	)
	hasPath := firstNonEmpty(asString(input["path"]), asString(input["file_path"]), asString(input["filePath"])) != ""
	hasQuery := firstNonEmpty(asString(input["query"]), asString(input["searchTerm"]), asString(input["search_query"])) != ""
	if hasQuery && strings.TrimSpace(asString(input["pattern"])) == "" {
		if normalizedKind == "search" || normalizedKind == "fetch" {
			return "WebSearch"
		}
	}
	if globPattern == "" {
		return ""
	}
	// Cursor Glob rawInput is typically `{pattern}` only; Grep includes path/glob flags.
	if hasPath || input["glob"] != nil || input["type"] != nil || input["multiline"] != nil ||
		input["A"] != nil || input["B"] != nil || input["C"] != nil || input["headLimit"] != nil ||
		input["outputMode"] != nil {
		return "Grep"
	}
	if normalizedKind == "search" || normalizedKind == "read" || normalizedKind == "other" || normalizedKind == "" {
		// Bare pattern on search/read is Glob from Cursor's extractToolCallInput.
		if !hasPath {
			return "Glob"
		}
	}
	return ""
}

func acpSyntheticToolName(normalizedTitle string) string {
	switch normalizedTitle {
	case "enterplanmode":
		return "EnterPlanMode"
	case "exitplanmode":
		return "ExitPlanMode"
	case "askuserquestion":
		return "AskUserQuestion"
	case "toolsearch":
		return "ToolSearch"
	case "skill":
		return "Skill"
	case "closeagent":
		return "CloseAgent"
	case "wait":
		return "Wait"
	default:
		return ""
	}
}

func acpFetchToolName(input map[string]any) string {
	if input == nil {
		return ""
	}
	action, _ := input["action"].(map[string]any)
	actionType := strings.ToLower(strings.TrimSpace(asString(action["type"])))
	switch actionType {
	case "search", "search_query", "web_search":
		return "WebSearch"
	case "open_page", "open", "fetch", "web_fetch":
		return "WebFetch"
	}
	if firstNonEmpty(asString(action["url"]), asString(input["url"])) != "" {
		return "WebFetch"
	}
	if firstNonEmpty(
		asString(action["query"]),
		asString(input["query"]),
		asString(input["search_query"]),
		asString(input["searchQuery"]),
	) != "" {
		return "WebSearch"
	}
	return ""
}

func acpNormalizeToolInput(rawInput any, kind string, locations any) map[string]any {
	body := acpMapFromValue(rawInput, "rawInput")
	if len(body) == 0 {
		return nil
	}
	if command := acpExtractShellCommand(firstNonEmptyShellCommand(body["command"], body["cmd"])); command != "" {
		body["command"] = command
		delete(body, "cmd")
	}
	if cwd := strings.TrimSpace(asString(body["cwd"])); cwd == "" {
		delete(body, "cwd")
	}
	locationList := acpLocationList(locations)
	normalizedKind := strings.ToLower(strings.TrimSpace(kind))
	switch normalizedKind {
	case "read":
		if path := acpFirstLocationPath(locationList); path != "" {
			body["file_path"] = path
		}
		if path := firstNonEmpty(asString(body["path"]), asString(body["file_path"]), asString(body["filePath"])); path != "" {
			body["path"] = path
			if strings.TrimSpace(asString(body["file_path"])) == "" {
				body["file_path"] = path
			}
		}
	case "search":
		if path := acpFirstLocationPath(locationList); path != "" {
			if strings.TrimSpace(asString(body["target_directory"])) == "" && strings.TrimSpace(asString(body["path"])) == "" {
				// Cursor Glob puts the search root in locations, not rawInput.
				if firstNonEmpty(asString(body["pattern"]), asString(body["glob_pattern"]), asString(body["globPattern"])) != "" &&
					strings.TrimSpace(asString(body["path"])) == "" {
					body["target_directory"] = path
				} else if strings.TrimSpace(asString(body["path"])) == "" {
					body["path"] = path
				}
			}
		}
		if pattern := firstNonEmpty(asString(body["glob_pattern"]), asString(body["globPattern"]), asString(body["pattern"])); pattern != "" {
			body["pattern"] = pattern
		}
	case "edit", "delete", "move":
		if path := acpFirstLocationPath(locationList); path != "" {
			body["file_path"] = path
		}
	case "execute":
		if task := strings.TrimSpace(asString(body["task"])); task != "" {
			body["prompt"] = task
			body["description"] = task
		}
		if agentName := strings.TrimSpace(asString(body["agentName"])); agentName != "" {
			body["subagent_type"] = agentName
		}
	case "fetch":
		action, _ := body["action"].(map[string]any)
		actionType := strings.ToLower(strings.TrimSpace(asString(action["type"])))
		switch actionType {
		case "search", "search_query", "web_search":
			if query := firstNonEmpty(
				asString(action["query"]),
				asString(body["query"]),
				asString(body["search_query"]),
				asString(body["searchQuery"]),
			); query != "" {
				body["query"] = query
			}
		case "open_page", "open", "fetch", "web_fetch":
			if url := firstNonEmpty(asString(action["url"]), asString(body["url"])); url != "" {
				body["url"] = url
			}
		}
	case "think":
		if todos := acpNormalizeTodos(body["todos"]); len(todos) > 0 {
			body["todos"] = todos
		}
	}
	return acpSanitizeImagePayloadMap(body)
}

func firstNonEmptyShellCommand(values ...any) any {
	for _, value := range values {
		if acpExtractShellCommand(value) != "" {
			return value
		}
	}
	return nil
}

func acpNormalizeToolOutput(rawOutput any, content any) map[string]any {
	body := acpMapFromValue(rawOutput, "output")
	if len(body) == 0 && content == nil {
		return nil
	}
	if body == nil {
		body = map[string]any{}
	}
	body = acpSanitizeImagePayloadMap(body)
	acpPromoteToolOutputMetadata(body)
	if content != nil {
		sanitizedContent := acpSanitizeImagePayload(content)
		body["content"] = sanitizedContent
		if stdout := strings.TrimSpace(asString(body["stdout"])); stdout == "" {
			if text := acpContentText(sanitizedContent); text != "" {
				body["stdout"] = text
			}
		}
		acpApplyDiffContent(body, sanitizedContent)
	}
	return body
}

func acpPromoteToolOutputMetadata(body map[string]any) {
	metadata, _ := body["metadata"].(map[string]any)
	if len(metadata) == 0 {
		return
	}
	for _, key := range []string{"diff", "files", "structuredPatch", "detailedContent", "changes"} {
		if _, exists := body[key]; !exists && metadata[key] != nil {
			body[key] = clonePayloadValue(metadata[key])
		}
	}
	if _, exists := body["exitCode"]; !exists && metadata["exit"] != nil {
		body["exitCode"] = clonePayloadValue(metadata["exit"])
	}
}

func acpSanitizeImagePayloadMap(value map[string]any) map[string]any {
	sanitized, _ := acpSanitizeImagePayload(value).(map[string]any)
	return sanitized
}

func acpSanitizeImagePayload(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		sanitized := make(map[string]any, len(typed))
		imageLike := acpLooksLikeImagePayload(typed)
		for key, entry := range typed {
			normalizedKey := strings.ToLower(strings.TrimSpace(key))
			if imageLike && normalizedKey == "data" {
				continue
			}
			if imageLike && (normalizedKey == "uri" || normalizedKey == "path") {
				if text, ok := entry.(string); ok && strings.HasPrefix(strings.ToLower(strings.TrimSpace(text)), "data:image/") {
					continue
				}
			}
			sanitized[key] = acpSanitizeImagePayload(entry)
		}
		return sanitized
	case []any:
		sanitized := make([]any, len(typed))
		for index, entry := range typed {
			sanitized[index] = acpSanitizeImagePayload(entry)
		}
		return sanitized
	default:
		return clonePayloadValue(value)
	}
}

func acpLooksLikeImagePayload(value map[string]any) bool {
	normalizedType := strings.ToLower(strings.TrimSpace(asString(value["type"])))
	normalizedMimeType := strings.ToLower(strings.TrimSpace(asString(value["mimeType"])))
	uri := strings.TrimSpace(firstNonEmpty(asString(value["uri"]), asString(value["path"])))
	_, hasData := value["data"]
	return normalizedType == "image" || strings.HasPrefix(normalizedMimeType, "image/") || (uri != "" && hasData)
}

func acpMirrorFailedToolOutput(body map[string]any) map[string]any {
	if len(body) == 0 {
		return nil
	}
	mirrored := map[string]any{}
	for _, key := range []string{"stdout", "stderr", "aggregated_output", "formatted_output", "content", "changes", "status", "call_id", "turn_id", "cwd", "parsed_cmd", "command", "exit_code", "duration", "duration_ms", "completed_at_ms", "source", "process_id"} {
		if value, ok := body[key]; ok && value != nil {
			mirrored[key] = clonePayloadValue(value)
		}
	}
	if len(mirrored) == 0 {
		return nil
	}
	return mirrored
}

func acpMapFromValue(value any, scalarKey string) map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		return clonePayloadDeep(typed)
	case nil:
		return nil
	default:
		return map[string]any{scalarKey: clonePayloadValue(value)}
	}
}

func acpExtractShellCommand(command any) string {
	switch typed := command.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []any:
		for index := len(typed) - 1; index >= 0; index-- {
			if candidate := strings.TrimSpace(asString(typed[index])); candidate != "" {
				return candidate
			}
		}
	}
	return ""
}

func acpLocationList(value any) []map[string]any {
	items, _ := value.([]any)
	if len(items) == 0 {
		return nil
	}
	locations := make([]map[string]any, 0, len(items))
	for _, item := range items {
		location, _ := item.(map[string]any)
		if len(location) == 0 {
			continue
		}
		locations = append(locations, location)
	}
	return locations
}

func acpFirstLocationPath(locations []map[string]any) string {
	if len(locations) == 0 {
		return ""
	}
	return strings.TrimSpace(asString(locations[0]["path"]))
}

func acpNormalizeTodos(value any) []map[string]any {
	switch typed := value.(type) {
	case []any:
		out := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			todo, _ := item.(map[string]any)
			if len(todo) == 0 {
				continue
			}
			out = append(out, clonePayloadDeep(todo))
		}
		return out
	case string:
		lines := strings.Split(typed, "\n")
		out := make([]map[string]any, 0, len(lines))
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "- [") {
				continue
			}
			status := "pending"
			if strings.HasPrefix(strings.ToLower(line), "- [x]") {
				status = "completed"
			}
			content := strings.TrimSpace(line[5:])
			if content == "" {
				continue
			}
			out = append(out, map[string]any{
				"content": content,
				"status":  status,
			})
		}
		return out
	default:
		return nil
	}
}

func acpContentText(value any) string {
	items, _ := value.([]any)
	parts := make([]string, 0, len(items))
	for _, item := range items {
		if text := acpExtractContentText(item); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func acpExtractContentText(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case map[string]any:
		if text := strings.TrimSpace(asString(typed["text"])); text != "" {
			return text
		}
		if content := strings.TrimSpace(asString(typed["content"])); content != "" {
			return content
		}
		if nested, ok := typed["content"].(map[string]any); ok {
			if text := strings.TrimSpace(asString(nested["text"])); text != "" {
				return text
			}
		}
	}
	return ""
}

func acpApplyDiffContent(body map[string]any, value any) {
	items, _ := value.([]any)
	for _, item := range items {
		diff, _ := item.(map[string]any)
		if strings.TrimSpace(asString(diff["type"])) != "diff" {
			continue
		}
		if path := strings.TrimSpace(asString(diff["path"])); path != "" {
			body["filePath"] = path
		}
		if oldText, ok := diff["oldText"].(string); ok && oldText != "" {
			body["oldString"] = oldText
		}
		if newText, ok := diff["newText"].(string); ok && newText != "" {
			body["newString"] = newText
		}
		return
	}
}

func acpToolCallDiagnosticEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("TUTTI_ACP_TOOL_DEBUG"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func logACPToolCallDiagnostic(session Session, turnID string, raw map[string]any, normalized map[string]any) {
	if !acpToolCallDiagnosticEnabled() {
		return
	}
	slog.Info(
		"acp tool call normalized",
		"event", "agent_session.acp_tool_call.normalized",
		"room_id", strings.TrimSpace(session.RoomID),
		"agent_session_id", strings.TrimSpace(session.AgentSessionID),
		"turn_id", strings.TrimSpace(turnID),
		"raw", clonePayloadDeep(raw),
		"normalized", clonePayload(normalized),
	)
}

func clonePayloadDeep(payload map[string]any) map[string]any {
	if len(payload) == 0 {
		return nil
	}
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		out[key] = clonePayloadValue(value)
	}
	return out
}

func normalizedCallStatus(status string) string {
	switch canonicalACPStatusToken(status) {
	case "completed", "complete", "success", "succeeded", "ok", "done":
		return messageStreamStateCompleted
	case "failed", "failure", "error", "errored", "canceled", "cancel":
		return messageStreamStateFailed
	default:
		return messageStreamStateStreaming
	}
}

func canonicalACPStatusToken(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "cancelled":
		return SessionStatusCanceled
	default:
		return strings.ToLower(strings.TrimSpace(status))
	}
}

func acpResolvedToolCallStatus(update map[string]any, fallback string) string {
	status := normalizedCallStatus(firstNonEmpty(asString(update["status"]), fallback))
	if status != messageStreamStateStreaming {
		return status
	}
	rawOutput := acpToolCallRawOutput(update)
	if inferred := acpInferTerminalToolStatus(rawOutput); inferred != "" {
		return inferred
	}
	if inferred := acpInferImageGenerationTerminalStatus(update, rawOutput); inferred != "" {
		return inferred
	}
	return status
}

func acpInferTerminalToolStatus(rawOutput any) string {
	body := acpMapFromValue(rawOutput, "output")
	if len(body) == 0 {
		return ""
	}
	if status := normalizedCallStatus(asString(body["status"])); status != messageStreamStateStreaming {
		return status
	}
	if status := normalizedCallStatus(asString(body["state"])); status != messageStreamStateStreaming {
		return status
	}
	if exitCode, ok := acpIntFromValue(body["exitCode"]); ok {
		if exitCode == 0 {
			return messageStreamStateCompleted
		}
		return messageStreamStateFailed
	}
	if exitCode, ok := acpIntFromValue(body["exit_code"]); ok {
		if exitCode == 0 {
			return messageStreamStateCompleted
		}
		return messageStreamStateFailed
	}
	if exitCode, ok := acpExitCodeFromText(body["output"]); ok {
		if exitCode == 0 {
			return messageStreamStateCompleted
		}
		return messageStreamStateFailed
	}
	return ""
}

func acpInferImageGenerationTerminalStatus(update map[string]any, rawOutput any) string {
	if !acpToolCallLooksLikeImageGeneration(update) {
		return ""
	}
	if acpContainsImageContent(update["content"]) {
		return messageStreamStateCompleted
	}
	if strings.TrimSpace(firstNonEmpty(
		asString(update["saved_path"]),
		asString(update["savedPath"]),
		asString(update["result"]),
	)) != "" {
		return messageStreamStateCompleted
	}
	body := acpMapFromValue(rawOutput, "output")
	if len(body) == 0 {
		return ""
	}
	if strings.TrimSpace(firstNonEmpty(
		asString(body["saved_path"]),
		asString(body["savedPath"]),
		asString(body["result"]),
	)) != "" {
		return messageStreamStateCompleted
	}
	return ""
}

func acpToolCallLooksLikeImageGeneration(update map[string]any) bool {
	for _, candidate := range []string{
		asString(update["toolName"]),
		asString(update["title"]),
		asString(update["name"]),
		asString(update["toolCallId"]),
		asString(update["id"]),
	} {
		normalized := strings.ToLower(strings.TrimSpace(candidate))
		if strings.HasPrefix(normalized, "ig_") {
			return true
		}
		if toolName := acpCanonicalImageGenerationToolName(candidate, update["content"]); toolName != "" {
			return true
		}
	}
	return false
}

func acpIntFromValue(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case int32:
		return int(typed), true
	case int64:
		return int(typed), true
	case float64:
		return int(typed), true
	case json.Number:
		n, err := typed.Int64()
		if err != nil {
			return 0, false
		}
		return int(n), true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(typed))
		if err != nil {
			return 0, false
		}
		return n, true
	default:
		return 0, false
	}
}

func acpExitCodeFromText(value any) (int, bool) {
	text := strings.TrimSpace(asString(value))
	if text == "" {
		return 0, false
	}
	lower := strings.ToLower(text)
	if !strings.HasPrefix(lower, "exit code ") {
		return 0, false
	}
	return acpIntFromValue(strings.TrimSpace(text[len("Exit code "):]))
}
