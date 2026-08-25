package agentruntime

import "strings"

const maxACPErrorEnvelopeDepth = 8

func acpResolvedToolCallStatus(update map[string]any, fallback string) string {
	if acpToolCallReportsError(update, acpToolCallRawOutput(update)) {
		return messageStreamStateFailed
	}
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

func acpToolCallReportsError(update map[string]any, rawOutput any) bool {
	return acpMapOwnReportsError(update) ||
		acpValueReportsError(update["error"]) ||
		acpValueReportsTextualError(update["error"]) ||
		acpValueReportsError(update["content"]) ||
		acpValueReportsTextualError(update["content"]) ||
		acpValueReportsError(rawOutput) ||
		acpValueReportsTextualError(rawOutput) ||
		acpValueReportsTextualError(update["result"]) ||
		acpValueReportsTextualError(update["rawErrorMessages"]) ||
		acpValueReportsTextualError(update["raw_error_messages"])
}

func acpValueReportsError(value any) bool {
	return acpValueReportsErrorAtDepth(value, 0)
}

func acpMapOwnReportsError(body map[string]any) bool {
	for _, key := range []string{"isError", "is_error"} {
		if reported, ok := body[key].(bool); ok && reported {
			return true
		}
	}
	return false
}

func acpValueReportsErrorAtDepth(value any, depth int) bool {
	body, ok := value.(map[string]any)
	if ok {
		if acpMapOwnReportsError(body) {
			return true
		}
		if depth >= maxACPErrorEnvelopeDepth {
			return false
		}
		for _, nested := range body {
			if acpValueReportsErrorAtDepth(nested, depth+1) {
				return true
			}
		}
		return false
	}
	entries, ok := value.([]any)
	if !ok || depth >= maxACPErrorEnvelopeDepth {
		return false
	}
	for _, nested := range entries {
		if acpValueReportsErrorAtDepth(nested, depth+1) {
			return true
		}
	}
	return false
}

// acpValueReportsTextualError handles providers that return a successful
// JSON-RPC envelope but put the actual tool failure in result/rawErrorMessages
// instead of setting isError. It intentionally only inspects output/error
// envelopes; tool input can legitimately contain the word "error".
func acpValueReportsTextualError(value any) bool {
	return acpValueReportsTextualErrorAtDepth(value, 0)
}

func acpValueReportsTextualErrorAtDepth(value any, depth int) bool {
	if depth >= maxACPErrorEnvelopeDepth {
		return false
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, nested := range typed {
			normalizedKey := strings.ToLower(strings.TrimSpace(key))
			switch normalizedKey {
			case "error", "err", "errormessage", "error_message", "message", "detail":
				if acpTextualToolErrorValue(nested, normalizedKey) {
					return true
				}
			case "result":
				if acpTextualToolErrorValue(nested, normalizedKey) {
					return true
				}
			case "rawerrormessages", "raw_error_messages":
				if acpTextualToolErrorValue(nested, normalizedKey) {
					return true
				}
			}
			if normalizedKey == "input" || normalizedKey == "rawinput" {
				continue
			}
			if acpValueReportsTextualErrorAtDepth(nested, depth+1) {
				return true
			}
		}
	case []any:
		for _, nested := range typed {
			if acpValueReportsTextualErrorAtDepth(nested, depth+1) {
				return true
			}
		}
	}
	return false
}

func acpTextualToolErrorValue(value any, field string) bool {
	switch typed := value.(type) {
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return false
		}
		if field == "rawerrormessages" || field == "raw_error_messages" || field == "error" || field == "err" ||
			field == "errormessage" || field == "error_message" || field == "detail" {
			return true
		}
		return acpTextLooksLikeKnownToolError(text)
	case []any:
		for _, nested := range typed {
			if acpTextualToolErrorValue(nested, field) || acpValueReportsTextualErrorAtDepth(nested, 1) {
				return true
			}
		}
	case map[string]any:
		return acpValueReportsTextualErrorAtDepth(typed, 1)
	}
	return false
}

func acpTextLooksLikeKnownToolError(text string) bool {
	normalized := strings.ToLower(strings.TrimSpace(text))
	if normalized == "" {
		return false
	}
	for _, marker := range []string{
		"error: aborted",
		"[aborted]",
		"retriableerror",
		"client network socket disconnected",
		"network socket disconnected",
		"socket disconnected before secure tls connection",
		"socket hang up",
		"econnreset",
		"econnrefused",
		"enotfound",
		"etimedout",
		"connection reset",
		"connection refused",
	} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return strings.HasPrefix(normalized, "error:") && strings.Contains(normalized, "failed")
}
