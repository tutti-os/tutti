package agentruntime

import (
	"encoding/json"
	"strconv"
	"strings"
)

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
