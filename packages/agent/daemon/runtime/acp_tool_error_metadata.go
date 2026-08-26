package agentruntime

import "strings"

func acpPromoteToolErrorMetadata(body map[string]any) {
	if len(body) == 0 || !acpToolCallReportsError(body, body) {
		return
	}
	message := acpToolErrorMessage(body)
	if message == "" {
		return
	}
	if _, exists := body["error"]; !exists {
		body["error"] = message
	}
	if _, exists := body["errorMessage"]; !exists {
		body["errorMessage"] = message
	}
}

func acpToolErrorMessage(body map[string]any) string {
	if len(body) == 0 {
		return ""
	}
	parts := make([]string, 0, 2)
	for _, key := range []string{
		"error",
		"err",
		"errorMessage",
		"error_message",
		"message",
		"detail",
		"result",
		"rawErrorMessages",
		"raw_error_messages",
	} {
		value, ok := body[key]
		if !ok {
			continue
		}
		text := acpToolErrorValueText(value, strings.ToLower(key))
		if text == "" || containsACPString(parts, text) {
			continue
		}
		parts = append(parts, text)
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func acpToolErrorValueText(value any, field string) string {
	switch typed := value.(type) {
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return ""
		}
		if field == "error" || field == "err" || field == "errormessage" || field == "error_message" ||
			field == "rawerrormessages" || field == "raw_error_messages" || acpTextLooksLikeKnownToolError(text) {
			return text
		}
	case []any:
		parts := make([]string, 0, len(typed))
		for _, nested := range typed {
			if text := acpToolErrorValueText(nested, field); text != "" && !containsACPString(parts, text) {
				parts = append(parts, text)
			}
		}
		return strings.TrimSpace(strings.Join(parts, "\n"))
	case map[string]any:
		return acpToolErrorMessage(typed)
	}
	return ""
}

func containsACPString(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}
