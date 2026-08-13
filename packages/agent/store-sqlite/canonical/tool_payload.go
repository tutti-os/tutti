package canonical

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

var ErrToolCallPayloadTooLarge = errors.New("canonical tool call payload exceeds byte budget")

// ToolCallPayloadBudgetError reports a canonical payload that cannot fit even
// after every truncatable output string has been reduced to its marker.
type ToolCallPayloadBudgetError struct {
	EncodedBytes int
	MaxBytes     int
}

func (e *ToolCallPayloadBudgetError) Error() string {
	return fmt.Sprintf("%v: encoded bytes=%d max bytes=%d", ErrToolCallPayloadTooLarge, e.EncodedBytes, e.MaxBytes)
}

func (*ToolCallPayloadBudgetError) Unwrap() error { return ErrToolCallPayloadTooLarge }

func IsToolCallPayloadTooLarge(err error) bool {
	return errors.Is(err, ErrToolCallPayloadTooLarge)
}

var canonicalToolPayloadKeys = map[string]struct{}{
	"activityKind":    {},
	"approvalPurpose": {},
	"callId":          {},
	"callType":        {},
	"changes":         {},
	"command":         {},
	"cwd":             {},
	"description":     {},
	"detailedContent": {},
	"error":           {},
	"exitCode":        {},
	"fileChangeKind":  {},
	"fileChanges":     {},
	"filePath":        {},
	"input":           {},
	"locations":       {},
	"metadata":        {},
	"name":            {},
	"output":          {},
	"ownerCallId":     {},
	"ownerThreadId":   {},
	"options":         {},
	"parentCallId":    {},
	"paths":           {},
	"plan":            {},
	"provider":        {},
	"requestId":       {},
	"rootCallId":      {},
	"seq":             {},
	"sessionID":       {},
	"source":          {},
	"status":          {},
	"steps":           {},
	"structuredPatch": {},
	"summary":         {},
	"title":           {},
	"toolName":        {},
}

var canonicalToolBodyKeys = map[string]struct{}{
	"action":              {},
	"answers":             {},
	"answersByQuestionId": {},
	"changes":             {},
	"commandName":         {},
	"cwd":                 {},
	"detailedContent":     {},
	"diff":                {},
	"duration":            {},
	"durationMs":          {},
	"exitCode":            {},
	"file":                {},
	"fileChanges":         {},
	"filePath":            {},
	"filenames":           {},
	"files":               {},
	"imageMimeType":       {},
	"isError":             {},
	"links":               {},
	"matches":             {},
	"message":             {},
	"mode":                {},
	"newString":           {},
	"oldString":           {},
	"patch":               {},
	"payload":             {},
	"requestId":           {},
	"reason":              {},
	"savedPath":           {},
	"savedPaths":          {},
	"selectedId":          {},
	"status":              {},
	"stderr":              {},
	"stdout":              {},
	"steps":               {},
	"structuredPatch":     {},
	"structuredContent":   {},
	"success":             {},
	"summary":             {},
	"text":                {},
	"totalDeferredTools":  {},
	"type":                {},
}

var canonicalToolMetadataKeys = map[string]struct{}{
	"agentId":             {},
	"approvalPurpose":     {},
	"async":               {},
	"callType":            {},
	"childSessionID":      {},
	"child_session_id":    {},
	"cwd":                 {},
	"durationMs":          {},
	"interactiveKind":     {},
	"kind":                {},
	"mcpServer":           {},
	"options":             {},
	"outputFile":          {},
	"parentToolUseId":     {},
	"server":              {},
	"serverName":          {},
	"steps":               {},
	"subagentAgentId":     {},
	"subagentAsync":       {},
	"subagentOutputFile":  {},
	"subagentSessionID":   {},
	"subagentStatus":      {},
	"subagent_session_id": {},
	"taskId":              {},
	"taskStatus":          {},
	"tool":                {},
	"toolName":            {},
}

// CompactToolCallPayload turns provider-shaped tool data into the canonical
// stored business projection. Callers that persist its result must use
// CompactToolCallPayloadChecked so an impossible budget is not ignored.
func CompactToolCallPayload(status string, payload map[string]any) map[string]any {
	result, _ := CompactToolCallPayloadChecked(status, payload)
	return result
}

// CompactToolCallPayloadChecked returns an error instead of allowing a
// replication-unsafe payload to be persisted when required non-truncatable
// data alone exceeds the byte budget.
func CompactToolCallPayloadChecked(status string, payload map[string]any) (map[string]any, error) {
	if len(payload) == 0 {
		return payload, nil
	}

	result := cloneToolMap(payload)
	input := compactToolInput(result["input"])
	output := compactToolBody(result["output"])
	toolError := compactToolBody(result["error"])
	metadata := compactToolMetadata(result["metadata"])
	steps := compactToolSteps(result["steps"])
	if len(steps) == 0 {
		steps = compactToolSteps(output["steps"])
	}
	if len(steps) == 0 {
		steps = compactToolSteps(metadata["steps"])
	}
	delete(output, "steps")
	delete(toolError, "steps")
	delete(metadata, "steps")

	projection := toolContentProjection{}
	projection.add(result["content"])

	if len(projection.texts) > 0 {
		target := &output
		if isFailedToolStatus(status) {
			target = &toolError
		}
		if *target == nil {
			*target = map[string]any{}
		}
		if toolString((*target)["text"]) == "" {
			(*target)["text"] = strings.Join(projection.texts, "\n")
		}
	}
	if len(projection.toolReferences) > 0 {
		if output == nil {
			output = map[string]any{}
		}
		if len(toolStringSlice(output["matches"])) == 0 {
			output["matches"] = stringsToAny(projection.toolReferences)
		}
		if _, exists := output["totalDeferredTools"]; !exists {
			output["totalDeferredTools"] = len(projection.toolReferences)
		}
	}
	if len(projection.imagePaths) > 0 {
		if output == nil {
			output = map[string]any{}
		}
		savedPaths := append(toolStringSlice(output["savedPaths"]), projection.imagePaths...)
		savedPaths = uniqueToolStrings(savedPaths)
		output["savedPaths"] = stringsToAny(savedPaths)
		if toolString(output["savedPath"]) == "" {
			output["savedPath"] = savedPaths[0]
		}
		if toolString(output["imageMimeType"]) == "" && projection.imageMimeType != "" {
			output["imageMimeType"] = projection.imageMimeType
		}
	}
	if len(projection.fileChanges) > 0 {
		result["fileChanges"] = mergeToolFileChanges(result["fileChanges"], projection.fileChanges)
	}
	if fileChanges := normalizeToolFileChanges(result["fileChanges"]); fileChanges != nil {
		result["fileChanges"] = fileChanges
	} else {
		delete(result, "fileChanges")
	}

	// Compare aliases before per-field truncation can make equal source
	// strings diverge at the byte boundary.
	if isTerminalToolStatus(status) && isTerminalCommandPayload(result, input) {
		compactTerminalCommandBodyAlias(output)
		compactTerminalCommandBodyAlias(toolError)
	}
	CompactToolStructuredContentAliases(map[string]any{
		"output": output,
		"error":  toolError,
		"steps":  steps,
	})
	if output != nil {
		delete(output, "content")
		output = TruncateToolOutputBody(selectToolKeys(output, canonicalToolBodyKeys))
	}
	if toolError != nil {
		delete(toolError, "content")
		toolError = TruncateToolOutputBody(selectToolKeys(toolError, canonicalToolBodyKeys))
	}

	delete(result, "content")
	delete(result, "error")
	delete(result, "input")
	delete(result, "metadata")
	delete(result, "output")
	delete(result, "steps")
	if len(input) > 0 {
		result["input"] = input
	}
	if len(output) > 0 {
		result["output"] = output
	}
	if len(toolError) > 0 && !isCompletedToolStatus(status) {
		result["error"] = toolError
	}
	if len(metadata) > 0 {
		result["metadata"] = metadata
	}
	if len(steps) > 0 {
		result["steps"] = steps
	}

	result = selectToolKeys(result, canonicalToolPayloadKeys)
	CompactTerminalCommandOutputAliases(status, result)
	CompactToolStructuredContentAliases(result)
	_, fits := FitToolCallPayloadOutputBudget(result, ToolCallPayloadMaxBytes)
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("encode canonical tool call payload: %w", err)
	}
	if !fits || len(encoded) > ToolCallPayloadMaxBytes {
		return nil, &ToolCallPayloadBudgetError{
			EncodedBytes: len(encoded),
			MaxBytes:     ToolCallPayloadMaxBytes,
		}
	}
	return result, nil
}

func compactToolSteps(value any) []any {
	rawSteps, ok := value.([]any)
	if !ok {
		return nil
	}
	steps := make([]any, 0, len(rawSteps))
	for _, value := range rawSteps {
		rawStep := toolMap(value)
		if rawStep == nil {
			continue
		}
		payload := toolMap(rawStep["payload"])
		input := compactToolInput(firstToolValue(
			rawStep["toolInput"],
			rawStep["tool_input"],
			payload["input"],
		))
		output := compactToolBody(firstToolValue(
			rawStep["toolResult"],
			rawStep["tool_result"],
			payload["output"],
		))
		toolError := compactToolBody(firstToolValue(
			rawStep["toolError"],
			rawStep["tool_error"],
			payload["error"],
		))
		metadata := compactToolMetadata(firstToolValue(
			rawStep["metadata"],
			payload["metadata"],
		))
		status := firstToolString(rawStep["status"], output["status"], toolError["status"])
		step := map[string]any{}
		for _, key := range []string{
			"id",
			"toolUseId",
			"name",
			"toolName",
			"callType",
			"status",
			"summary",
			"locations",
			"occurredAtUnixMs",
		} {
			if rawStep[key] != nil {
				step[key] = cloneToolValue(rawStep[key])
			}
		}
		if step["toolUseId"] == nil && rawStep["tool_use_id"] != nil {
			step["toolUseId"] = cloneToolValue(rawStep["tool_use_id"])
		}
		if step["toolName"] == nil && rawStep["tool_name"] != nil {
			step["toolName"] = cloneToolValue(rawStep["tool_name"])
		}
		if step["callType"] == nil && rawStep["call_type"] != nil {
			step["callType"] = cloneToolValue(rawStep["call_type"])
		}
		if status != "" {
			step["status"] = status
		}
		if len(input) > 0 {
			step["toolInput"] = input
		}
		if len(metadata) > 0 {
			step["metadata"] = metadata
		}
		if isTerminalToolStatus(status) && isTerminalCommandPayload(step, input) {
			compactTerminalCommandBodyAlias(output)
			compactTerminalCommandBodyAlias(toolError)
		}
		output = TruncateToolOutputBody(output)
		toolError = TruncateToolOutputBody(toolError)
		if len(output) > 0 {
			step["toolResult"] = output
		}
		if len(toolError) > 0 && !isCompletedToolStatus(status) {
			step["toolError"] = toolError
		}
		if fileChanges := normalizeToolFileChanges(firstToolValue(rawStep["fileChanges"], payload["fileChanges"])); fileChanges != nil {
			step["fileChanges"] = fileChanges
		}
		if len(step) > 0 {
			steps = append(steps, step)
		}
	}
	return steps
}

func compactToolBody(value any) map[string]any {
	body := toolBodyMap(value)
	if body == nil {
		return nil
	}
	for _, rawKey := range []string{"rawOutput", "raw_output"} {
		switch raw := body[rawKey].(type) {
		case map[string]any:
			body = mergeMissingToolValues(body, raw)
		case string:
			if toolString(body["text"]) == "" && strings.TrimSpace(raw) != "" {
				body["text"] = raw
			}
		}
		delete(body, rawKey)
	}

	if metadata := toolMap(body["metadata"]); len(metadata) > 0 {
		for _, key := range []string{"changes", "detailedContent", "diff", "files", "steps", "structuredPatch"} {
			if _, exists := body[key]; !exists && metadata[key] != nil {
				body[key] = cloneToolValue(metadata[key])
			}
		}
		if _, exists := body["exitCode"]; !exists && metadata["exit"] != nil {
			body["exitCode"] = cloneToolValue(metadata["exit"])
		}
	}

	projection := toolContentProjection{}
	projection.add(body["content"])
	if toolString(body["text"]) == "" {
		if text := firstToolBodyText(body, projection.texts); text != "" {
			body["text"] = text
		}
	}
	if len(toolStringSlice(body["matches"])) == 0 && len(projection.toolReferences) > 0 {
		body["matches"] = stringsToAny(projection.toolReferences)
		if _, exists := body["totalDeferredTools"]; !exists {
			body["totalDeferredTools"] = len(projection.toolReferences)
		}
	}
	if len(projection.imagePaths) > 0 {
		savedPaths := append(toolStringSlice(body["savedPaths"]), projection.imagePaths...)
		savedPaths = uniqueToolStrings(savedPaths)
		body["savedPaths"] = stringsToAny(savedPaths)
		if toolString(body["savedPath"]) == "" {
			body["savedPath"] = savedPaths[0]
		}
		if projection.imageMimeType != "" {
			body["imageMimeType"] = projection.imageMimeType
		}
	}
	if len(projection.fileChanges) > 0 {
		body["fileChanges"] = mergeToolFileChanges(body["fileChanges"], projection.fileChanges)
	}
	if fileChanges := normalizeToolFileChanges(body["fileChanges"]); fileChanges != nil {
		body["fileChanges"] = fileChanges
	} else {
		delete(body, "fileChanges")
	}

	if value, exists := body["exit_code"]; exists {
		if _, canonicalExists := body["exitCode"]; !canonicalExists {
			body["exitCode"] = cloneToolValue(value)
		}
	}
	if value, exists := body["duration_ms"]; exists {
		if _, canonicalExists := body["durationMs"]; !canonicalExists {
			body["durationMs"] = cloneToolValue(value)
		}
	}
	if value, exists := body["saved_path"]; exists && toolString(body["savedPath"]) == "" {
		body["savedPath"] = cloneToolValue(value)
	}
	if value, exists := body["total_deferred_tools"]; exists {
		if _, canonicalExists := body["totalDeferredTools"]; !canonicalExists {
			body["totalDeferredTools"] = cloneToolValue(value)
		}
	}
	if steps := compactToolSteps(body["steps"]); len(steps) > 0 {
		body["steps"] = steps
	} else {
		delete(body, "steps")
	}
	delete(body, "_meta")
	delete(body, "content")
	delete(body, "metadata")
	delete(body, "toolResponse")
	return selectToolKeys(body, canonicalToolBodyKeys)
}

func compactToolMetadata(value any) map[string]any {
	metadata := toolMap(value)
	if metadata == nil {
		return nil
	}
	delete(metadata, "adapter")
	delete(metadata, "fileChange")
	if steps := compactToolSteps(metadata["steps"]); len(steps) > 0 {
		metadata["steps"] = steps
	} else {
		delete(metadata, "steps")
	}
	return selectToolKeys(metadata, canonicalToolMetadataKeys)
}

func firstToolBodyText(body map[string]any, contentTexts []string) string {
	for _, key := range []string{
		"output",
		"aggregated_output",
		"formatted_output",
		"result",
	} {
		if text := toolString(body[key]); text != "" {
			return text
		}
	}
	if len(contentTexts) > 0 {
		return strings.Join(contentTexts, "\n")
	}
	return ""
}

type toolContentProjection struct {
	texts          []string
	toolReferences []string
	imagePaths     []string
	imageMimeType  string
	fileChanges    []map[string]any
}

func (projection *toolContentProjection) add(value any) {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			projection.add(item)
		}
	case map[string]any:
		itemType := strings.ToLower(toolString(typed["type"]))
		nested := toolMap(typed["content"])
		nestedType := strings.ToLower(toolString(nested["type"]))

		if text := toolString(typed["text"]); text != "" {
			projection.texts = appendUniqueToolString(projection.texts, text)
		}
		if text := toolString(typed["content"]); text != "" {
			projection.texts = appendUniqueToolString(projection.texts, text)
		}
		if nested != nil {
			if text := toolString(nested["text"]); text != "" {
				projection.texts = appendUniqueToolString(projection.texts, text)
			}
		}

		if itemType == "tool_reference" {
			if name := firstToolString(typed["tool_name"], typed["toolName"], typed["name"]); name != "" {
				projection.toolReferences = appendUniqueToolString(projection.toolReferences, name)
			}
		}
		if itemType == "image" || nestedType == "image" {
			image := typed
			if nestedType == "image" {
				image = nested
			}
			if path := firstToolString(image["uri"], image["path"]); path != "" && !strings.HasPrefix(strings.ToLower(path), "data:image/") {
				projection.imagePaths = appendUniqueToolString(projection.imagePaths, path)
			}
			if projection.imageMimeType == "" {
				projection.imageMimeType = firstToolString(image["mimeType"], image["media_type"], image["mediaType"])
			}
		}
		if itemType == "file_change" || itemType == "diff" {
			projection.fileChanges = append(projection.fileChanges, toolFileChangesFromContent(typed)...)
		}

		if content, ok := typed["content"].([]any); ok {
			projection.add(content)
		}
	}
}

func toolFileChangesFromContent(value map[string]any) []map[string]any {
	paths := toolStringSlice(value["paths"])
	if path := firstToolString(value["path"], value["filePath"], value["file_path"]); path != "" {
		paths = append([]string{path}, paths...)
	}
	paths = uniqueToolStrings(paths)
	if len(paths) == 0 {
		return nil
	}

	oldString, hasOld := firstPresentToolString(value["oldString"], value["old_string"], value["oldText"])
	newString, hasNew := firstPresentToolString(value["newString"], value["new_string"], value["newText"])
	content, hasContent := firstPresentToolString(value["content"])
	change := firstToolChange(value["change"], value["status"], value["kind"], value["type"])
	if change == "" {
		switch {
		case hasOld && !hasNew:
			change = "deleted"
		case hasNew && (!hasOld || oldString == ""):
			change = "added"
		case hasContent:
			change = "added"
		default:
			change = "modified"
		}
	}

	files := make([]map[string]any, 0, len(paths))
	for _, path := range paths {
		file := map[string]any{"path": path, "change": change}
		if hasOld {
			file["oldString"] = oldString
		}
		if hasNew {
			file["newString"] = newString
		}
		if hasContent {
			file["content"] = content
		}
		for _, key := range []string{"diff", "patch", "unifiedDiff", "unified_diff"} {
			if text, ok := value[key].(string); ok {
				file[key] = text
			}
		}
		files = append(files, file)
	}
	return files
}

func mergeToolFileChanges(existing any, incoming []map[string]any) map[string]any {
	filesByPath := map[string]map[string]any{}
	order := make([]string, 0)
	if existingMap := normalizeToolFileChanges(existing); existingMap != nil {
		for _, raw := range toolFileChangeMaps(existingMap["files"]) {
			path := toolString(raw["path"])
			if path == "" {
				continue
			}
			order = append(order, path)
			filesByPath[path] = raw
		}
	}
	for _, raw := range incoming {
		file := normalizeToolFileChange(raw)
		if file == nil {
			continue
		}
		path := toolString(file["path"])
		if path == "" {
			continue
		}
		if current, exists := filesByPath[path]; exists {
			filesByPath[path] = mergeToolFileChangeValues(current, file)
			continue
		}
		order = append(order, path)
		filesByPath[path] = cloneToolMap(file)
	}
	files := make([]any, 0, len(order))
	for _, path := range order {
		files = append(files, filesByPath[path])
	}
	if len(files) == 0 {
		return nil
	}
	return map[string]any{"files": files}
}

func toolBodyMap(value any) map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		return cloneToolMap(typed)
	case string:
		if strings.TrimSpace(typed) == "" {
			return nil
		}
		return map[string]any{"text": typed}
	case nil:
		return nil
	default:
		return map[string]any{"text": fmt.Sprint(typed)}
	}
}

func toolMap(value any) map[string]any {
	typed, ok := value.(map[string]any)
	if !ok || len(typed) == 0 {
		return nil
	}
	return cloneToolMap(typed)
}

func cloneToolMap(input map[string]any) map[string]any {
	if len(input) == 0 {
		return nil
	}
	output := make(map[string]any, len(input))
	for key, value := range input {
		output[key] = cloneToolValue(value)
	}
	return output
}

func cloneToolValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return cloneToolMap(typed)
	case []any:
		output := make([]any, len(typed))
		for index, item := range typed {
			output[index] = cloneToolValue(item)
		}
		return output
	default:
		return typed
	}
}

func mergeMissingToolValues(current map[string]any, fallback map[string]any) map[string]any {
	result := cloneToolMap(current)
	if result == nil {
		result = map[string]any{}
	}
	for key, value := range fallback {
		if _, exists := result[key]; !exists {
			result[key] = cloneToolValue(value)
		}
	}
	return result
}

func selectToolKeys(input map[string]any, allowed map[string]struct{}) map[string]any {
	if len(input) == 0 {
		return nil
	}
	output := make(map[string]any)
	for key, value := range input {
		if _, ok := allowed[key]; !ok || toolValueEmpty(value) {
			continue
		}
		output[key] = value
	}
	if len(output) == 0 {
		return nil
	}
	return output
}

func toolValueEmpty(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(typed) == ""
	case map[string]any:
		return len(typed) == 0
	case []any:
		return len(typed) == 0
	default:
		return false
	}
}

func toolString(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func firstToolString(values ...any) string {
	for _, value := range values {
		if text := toolString(value); text != "" {
			return text
		}
	}
	return ""
}

func firstToolValue(values ...any) any {
	for _, value := range values {
		if !toolValueEmpty(value) {
			return value
		}
	}
	return nil
}

func firstPresentToolString(values ...any) (string, bool) {
	for _, value := range values {
		if text, ok := value.(string); ok {
			return text, true
		}
	}
	return "", false
}

func toolStringSlice(value any) []string {
	switch typed := value.(type) {
	case []any:
		values := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := toolString(item); text != "" {
				values = appendUniqueToolString(values, text)
			}
		}
		return values
	case []string:
		return uniqueToolStrings(typed)
	default:
		return nil
	}
}

func appendUniqueToolString(values []string, value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return values
	}
	for _, current := range values {
		if current == value {
			return values
		}
	}
	return append(values, value)
}

func uniqueToolStrings(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = appendUniqueToolString(result, value)
	}
	return result
}

func stringsToAny(values []string) []any {
	result := make([]any, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}

func normalizeToolChange(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "add", "added", "create", "created", "new", "write_file":
		return "added"
	case "delete", "deleted", "remove", "removed", "delete_file":
		return "deleted"
	case "modify", "modified", "update", "updated", "edit", "edited", "change", "changed", "edit_file":
		return "modified"
	default:
		return ""
	}
}

func isCompletedToolStatus(status string) bool {
	return strings.TrimSpace(status) == "completed"
}

func isFailedToolStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "failed", "errored", "canceled":
		return true
	default:
		return false
	}
}
