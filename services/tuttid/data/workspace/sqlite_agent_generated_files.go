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
SELECT s.cwd, m.payload_json
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
		var payloadJSON string
		if err := rows.Scan(&cwd, &payloadJSON); err != nil {
			return agentactivitybiz.GeneratedFileList{}, false, fmt.Errorf("scan workspace agent generated file message: %w", err)
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
			return agentactivitybiz.GeneratedFileList{}, false, fmt.Errorf("decode workspace agent generated file payload: %w", err)
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
