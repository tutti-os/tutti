package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

const defaultWorkspaceGeneratedFilesLimit = 30
const maxWorkspaceGeneratedFilesLimit = 100

func (s *SQLiteStore) ListWorkspaceGeneratedFiles(
	ctx context.Context,
	input agentactivitybiz.ListWorkspaceGeneratedFilesInput,
) (agentactivitybiz.GeneratedFileList, bool, error) {
	if s == nil || s.db == nil {
		return agentactivitybiz.GeneratedFileList{}, false, fmt.Errorf("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if workspaceID == "" {
		return agentactivitybiz.GeneratedFileList{}, false, nil
	}
	if _, err := s.Get(ctx, workspaceID); err != nil {
		return agentactivitybiz.GeneratedFileList{}, false, err
	}
	limit := input.Limit
	if limit <= 0 {
		limit = defaultWorkspaceGeneratedFilesLimit
	}
	if limit > maxWorkspaceGeneratedFilesLimit {
		limit = maxWorkspaceGeneratedFilesLimit
	}
	sessionCwd := normalizeGeneratedFileComparablePath(input.SessionCwd)
	query := strings.ToLower(strings.TrimSpace(input.Query))
	scanLimit := generatedFileMessageScanLimit(limit)

	rows, err := s.db.QueryContext(ctx, `
SELECT s.cwd, m.kind, m.status, m.payload_json
FROM workspace_agent_messages m
JOIN workspace_agent_sessions s
  ON s.workspace_id = m.workspace_id
 AND s.agent_session_id = m.agent_session_id
WHERE m.workspace_id = ?
  AND m.deleted_at_unix_ms = 0
  AND s.deleted_at_unix_ms = 0
  AND (? = '' OR s.cwd = ?)
ORDER BY m.updated_at_unix_ms DESC, m.id DESC
LIMIT ?
`, workspaceID, sessionCwd, sessionCwd, scanLimit)
	if err != nil {
		return agentactivitybiz.GeneratedFileList{}, false, fmt.Errorf("list workspace agent generated file messages: %w", err)
	}
	defer rows.Close()

	filesByPath := make(map[string]agentactivitybiz.GeneratedFile)
	files := make([]agentactivitybiz.GeneratedFile, 0, limit)
	for rows.Next() {
		var cwd string
		var kind string
		var status string
		var payloadJSON string
		if err := rows.Scan(&cwd, &kind, &status, &payloadJSON); err != nil {
			return agentactivitybiz.GeneratedFileList{}, false, fmt.Errorf("scan workspace agent generated file message: %w", err)
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
			return agentactivitybiz.GeneratedFileList{}, false, fmt.Errorf("decode workspace agent generated file payload: %w", err)
		}
		if !isSuccessfulGeneratedFileMessage(kind, status, payload) {
			continue
		}
		for _, filePath := range generatedFilePathsFromPayload(payload, cwd) {
			if _, exists := filesByPath[filePath]; exists {
				continue
			}
			file := agentactivitybiz.GeneratedFile{
				Path:  filePath,
				Label: generatedFileLabel(filePath),
			}
			if !matchesGeneratedFileQuery(file, query) {
				continue
			}
			filesByPath[filePath] = file
			files = append(files, file)
			if len(files) >= limit {
				return agentactivitybiz.GeneratedFileList{
					WorkspaceID: workspaceID,
					Files:       files,
				}, true, nil
			}
		}
	}
	if err := rows.Err(); err != nil {
		return agentactivitybiz.GeneratedFileList{}, false, fmt.Errorf("iterate workspace agent generated file messages: %w", err)
	}

	return agentactivitybiz.GeneratedFileList{
		WorkspaceID: workspaceID,
		Files:       files,
	}, true, nil
}

func generatedFileMessageScanLimit(limit int) int {
	if limit <= 0 {
		limit = defaultWorkspaceGeneratedFilesLimit
	}
	scanLimit := limit * 40
	if scanLimit < 500 {
		return 500
	}
	if scanLimit > 5000 {
		return 5000
	}
	return scanLimit
}

func isSuccessfulGeneratedFileMessage(kind string, status string, payload map[string]any) bool {
	if normalizeGeneratedFileToken(kind) != "tool_call" {
		return false
	}
	if !generatedFileStatusAllows(status) {
		return false
	}
	if !generatedFilePayloadStatusAllows(payload) {
		return false
	}
	return hasGeneratedFileChangeSignal(payload)
}

func generatedFilePayloadStatusAllows(payload map[string]any) bool {
	if payload == nil {
		return true
	}
	if !generatedFileRecordStatusAllows(payload) {
		return false
	}
	if output, ok := objectField(payload, "output"); ok {
		if !generatedFileRecordStatusAllows(output) {
			return false
		}
	}
	return true
}

func generatedFileRecordStatusAllows(record map[string]any) bool {
	if record == nil {
		return true
	}
	if status, ok := stringField(record, "status"); ok && !generatedFileStatusAllows(status) {
		return false
	}
	if success, ok := boolField(record, "success"); ok && !success {
		return false
	}
	return true
}

func generatedFileStatusAllows(status string) bool {
	normalized := normalizeGeneratedFileToken(status)
	if normalized == "" {
		return true
	}
	switch normalized {
	case "completed", "success", "succeeded", "ok":
		return true
	default:
		return false
	}
}

func hasGeneratedFileChangeSignal(payload map[string]any) bool {
	for _, record := range generatedFileSignalRecords(payload) {
		if recordHasGeneratedFileToolSignal(record) {
			return true
		}
	}
	return false
}

func generatedFileSignalRecords(payload map[string]any) []map[string]any {
	if payload == nil {
		return nil
	}
	records := []map[string]any{payload}
	if input, ok := objectField(payload, "input"); ok {
		records = append(records, input)
	}
	if output, ok := objectField(payload, "output"); ok {
		records = append(records, output)
	}
	if toolState, ok := objectField(payload, "tool_state"); ok {
		if input, ok := objectField(toolState, "input"); ok {
			records = append(records, input)
		}
	}
	return records
}

func recordHasGeneratedFileToolSignal(record map[string]any) bool {
	if record == nil {
		return false
	}
	if activityKind, ok := stringField(record, "activityKind"); ok &&
		isGeneratedFileChangeToolName(normalizeGeneratedFileToolName(activityKind)) {
		return true
	}
	if _, ok := stringField(record, "fileChangeKind"); ok {
		return true
	}
	if toolCall, ok := objectField(record, "toolCall"); ok {
		if kind, ok := stringField(toolCall, "kind"); ok {
			switch normalizeGeneratedFileToken(kind) {
			case "write", "edit", "delete":
				return true
			}
		}
	}
	for _, key := range []string{"toolName", "title", "name"} {
		if name, ok := stringField(record, key); ok &&
			isGeneratedFileChangeToolName(normalizeGeneratedFileToolName(name)) {
			return true
		}
	}
	return false
}

func isGeneratedFileChangeToolName(normalized string) bool {
	if normalized == "" {
		return false
	}
	for _, candidate := range []string{
		"write",
		"writefile",
		"create",
		"createfile",
		"delete",
		"deletefile",
		"edit",
		"editfile",
		"multiedit",
		"applypatch",
		"move",
		"notebookedit",
	} {
		if normalized == candidate || strings.HasPrefix(normalized, candidate+"/") {
			return true
		}
	}
	return false
}

func generatedFilePathsFromPayload(payload map[string]any, cwd string) []string {
	paths := make([]string, 0)
	appendPath := func(value any) {
		normalized := normalizeGeneratedFilePath(value, cwd)
		if normalized != "" {
			paths = append(paths, normalized)
		}
	}
	appendPathValues(payload, appendPath)
	if output, ok := objectField(payload, "output"); ok {
		appendPathValues(output, appendPath)
	}
	if input, ok := objectField(payload, "input"); ok {
		appendPathValues(input, appendPath)
	}
	if toolState, ok := objectField(payload, "tool_state"); ok {
		if input, ok := objectField(toolState, "input"); ok {
			appendPathValues(input, appendPath)
		}
	}
	return dedupeGeneratedFilePaths(paths)
}

func appendPathValues(payload map[string]any, appendPath func(any)) {
	for _, key := range []string{"path", "filePath", "file_path"} {
		appendPath(payload[key])
	}
	if values, ok := payload["paths"].([]any); ok {
		for _, value := range values {
			appendPath(value)
		}
	}
	if fileChanges, ok := objectField(payload, "fileChanges"); ok {
		if files, ok := fileChanges["files"].([]any); ok {
			for _, file := range files {
				if fileObject, ok := file.(map[string]any); ok {
					appendPathValues(fileObject, appendPath)
					continue
				}
				appendPath(file)
			}
		}
	}
	if changes, ok := objectField(payload, "changes"); ok {
		for key, value := range changes {
			appendPath(key)
			if valueObject, ok := value.(map[string]any); ok {
				appendPathValues(valueObject, appendPath)
			}
		}
	}
	if values, ok := payload["changes"].([]any); ok {
		for _, value := range values {
			if valueObject, ok := value.(map[string]any); ok {
				appendPathValues(valueObject, appendPath)
				continue
			}
			appendPath(value)
		}
	}
}

func objectField(payload map[string]any, key string) (map[string]any, bool) {
	value, ok := payload[key]
	if !ok {
		return nil, false
	}
	object, ok := value.(map[string]any)
	return object, ok
}

func stringField(payload map[string]any, key string) (string, bool) {
	value, ok := payload[key]
	if !ok {
		return "", false
	}
	text, ok := value.(string)
	if !ok {
		return "", false
	}
	text = strings.TrimSpace(text)
	return text, text != ""
}

func boolField(payload map[string]any, key string) (bool, bool) {
	value, ok := payload[key]
	if !ok {
		return false, false
	}
	boolValue, ok := value.(bool)
	return boolValue, ok
}

func normalizeGeneratedFileToken(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func normalizeGeneratedFileToolName(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	normalized = strings.ReplaceAll(normalized, "_", "")
	normalized = strings.ReplaceAll(normalized, "-", "")
	normalized = strings.ReplaceAll(normalized, " ", "")
	return normalized
}

func normalizeGeneratedFilePath(value any, cwd string) string {
	raw, ok := value.(string)
	if !ok {
		return ""
	}
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.HasPrefix(raw, "{") || strings.HasPrefix(raw, "[") {
		return ""
	}
	raw = strings.ReplaceAll(raw, "\\", "/")
	if strings.HasPrefix(raw, "/") || isWindowsAbsolutePath(raw) {
		return path.Clean(raw)
	}
	base := normalizeGeneratedFileComparablePath(cwd)
	if base == "" {
		return path.Clean(raw)
	}
	return path.Clean(base + "/" + strings.TrimPrefix(strings.TrimPrefix(raw, "./"), "/"))
}

func normalizeGeneratedFileComparablePath(raw string) string {
	return strings.TrimRight(strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/"), "/")
}

func isWindowsAbsolutePath(value string) bool {
	return len(value) >= 3 && value[1] == ':' && (value[2] == '/' || value[2] == '\\')
}

func dedupeGeneratedFilePaths(paths []string) []string {
	seen := make(map[string]struct{}, len(paths))
	out := make([]string, 0, len(paths))
	for _, filePath := range paths {
		if filePath == "" {
			continue
		}
		if _, ok := seen[filePath]; ok {
			continue
		}
		seen[filePath] = struct{}{}
		out = append(out, filePath)
	}
	return out
}

func generatedFileLabel(filePath string) string {
	trimmed := strings.TrimRight(filePath, "/")
	if trimmed == "" {
		return filePath
	}
	label := path.Base(trimmed)
	if label == "." || label == "/" {
		return filePath
	}
	return label
}

func matchesGeneratedFileQuery(file agentactivitybiz.GeneratedFile, query string) bool {
	if query == "" {
		return true
	}
	haystack := strings.ToLower(file.Label + "\n" + file.Path)
	for _, token := range strings.Fields(query) {
		if !strings.Contains(haystack, token) {
			return false
		}
	}
	return true
}
