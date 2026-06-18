package issuemanager

import (
	"encoding/json"
	"mime"
	"path/filepath"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

func parseRunOutputs(raw string) ([]workspaceissues.CompleteRunOutputInput, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var decoded []map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, workspaceissues.ErrInvalidArgument
	}
	outputs := make([]workspaceissues.CompleteRunOutputInput, 0, len(decoded))
	for _, item := range decoded {
		pathValue := stringMapValue(item, "path")
		if strings.TrimSpace(pathValue) == "" {
			return nil, workspaceissues.ErrInvalidArgument
		}
		displayName := stringMapValue(item, "displayName")
		if displayName == "" {
			displayName = stringMapValue(item, "title")
		}
		mediaType := stringMapValue(item, "mediaType")
		if mediaType == "" {
			mediaType = mediaTypeByPath(pathValue)
		}
		outputs = append(outputs, workspaceissues.CompleteRunOutputInput{
			OutputID:    stringMapValue(item, "outputId"),
			Path:        pathValue,
			DisplayName: displayName,
			MediaType:   mediaType,
			SizeBytes:   int64MapValue(item, "sizeBytes"),
		})
	}
	return outputs, nil
}

func mediaTypeByPath(path string) string {
	mediaType := mime.TypeByExtension(filepath.Ext(path))
	if mediaType != "" {
		return mediaType
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".md", ".markdown":
		return "text/markdown; charset=utf-8"
	case ".json":
		return "application/json"
	case ".txt", ".log":
		return "text/plain; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}

func stringMapValue(item map[string]any, key string) string {
	value, ok := item[key]
	if !ok || value == nil {
		return ""
	}
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func int64MapValue(item map[string]any, key string) int64 {
	value, ok := item[key]
	if !ok || value == nil {
		return 0
	}
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case string:
		var decoded int64
		if err := json.Unmarshal([]byte(typed), &decoded); err == nil {
			return decoded
		}
	}
	return 0
}
