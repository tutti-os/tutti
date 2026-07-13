package agent

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

func externalToolText(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	return "[Tool: " + name + "]"
}

func externalContentText(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := externalContentText(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.TrimSpace(strings.Join(parts, "\n"))
	case map[string]any:
		blockType := stringField(typed, "type")
		switch blockType {
		case "text", "input_text", "output_text":
			return strings.TrimSpace(stringField(typed, "text"))
		case "tool_use", "function_call":
			return externalToolText(firstNonEmptyString(stringField(typed, "name"), stringField(typed, "id")))
		case "tool_result":
			return firstNonEmptyString(externalContentText(typed["content"]), stringField(typed, "text"))
		default:
			return firstNonEmptyString(
				stringField(typed, "text"),
				externalContentText(typed["content"]),
				externalContentText(typed["message"]),
			)
		}
	default:
		return ""
	}
}

func isPureExternalToolResult(value any) bool {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return false
	}
	for _, item := range items {
		block, ok := item.(map[string]any)
		if !ok || stringField(block, "type") != "tool_result" {
			return false
		}
	}
	return true
}

func unixMSFromAny(value any) int64 {
	switch typed := value.(type) {
	case string:
		typed = strings.TrimSpace(typed)
		if typed == "" {
			return 0
		}
		if parsed, err := time.Parse(time.RFC3339Nano, typed); err == nil {
			return parsed.UnixMilli()
		}
	case float64:
		if typed > 1_000_000_000_000 {
			return int64(typed)
		}
		return int64(typed * 1000)
	case int64:
		if typed > 1_000_000_000_000 {
			return typed
		}
		return typed * 1000
	case json.Number:
		if parsed, err := parsedJSONNumberUnixMS(typed); err == nil {
			return parsed
		}
	}
	return 0
}

func parsedJSONNumberUnixMS(number json.Number) (int64, error) {
	if value, err := number.Int64(); err == nil {
		if value > 1_000_000_000_000 {
			return value, nil
		}
		return value * 1000, nil
	}
	value, err := number.Float64()
	if err != nil {
		return 0, err
	}
	if value > 1_000_000_000_000 {
		return int64(value), nil
	}
	return int64(value * 1000), nil
}

func stringField(values map[string]any, key string) string {
	if values == nil {
		return ""
	}
	value, ok := values[key]
	if !ok {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	default:
		return ""
	}
}

func mapField(values map[string]any, key string) map[string]any {
	if values == nil {
		return nil
	}
	value, ok := values[key].(map[string]any)
	if !ok {
		return nil
	}
	return value
}
