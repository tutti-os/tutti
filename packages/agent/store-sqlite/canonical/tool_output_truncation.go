package canonical

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

const (
	// ToolOutputTextMaxBytes is the per-field persisted and live projection bound.
	ToolOutputTextMaxBytes = 1 << 20
	// ToolCallPayloadMaxBytes leaves deterministic headroom below the 1 MiB
	// replication request limit for mutation identity, scope, and batch framing.
	ToolCallPayloadMaxBytes = 768 << 10
	// ToolOutputTruncationMarker identifies a tool output prefix with omitted bytes.
	ToolOutputTruncationMarker    = "[Output truncated]"
	toolOutputTruncationSeparator = "\n"
)

var truncatedToolOutputTextKeys = [...]string{"text", "stdout", "stderr"}

// TruncateToolOutputText bounds one canonical tool output field while
// preserving a valid UTF-8 prefix and an explicit truncation marker.
func TruncateToolOutputText(value string) string {
	return truncateToolOutputTextToBytes(value, ToolOutputTextMaxBytes)
}

func truncateToolOutputTextToBytes(value string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(value) <= maxBytes {
		return value
	}

	value = strings.ToValidUTF8(value, string(utf8.RuneError))
	if len(value) <= maxBytes {
		return value
	}

	if maxBytes <= len(ToolOutputTruncationMarker) {
		marker := ToolOutputTruncationMarker
		for len(marker) > maxBytes || !utf8.ValidString(marker) {
			marker = marker[:len(marker)-1]
		}
		return marker
	}

	prefixLimit := maxBytes -
		len(toolOutputTruncationSeparator) -
		len(ToolOutputTruncationMarker)
	for prefixLimit > 0 && !utf8.RuneStart(value[prefixLimit]) {
		prefixLimit--
	}
	prefix := value[:prefixLimit]
	separator := toolOutputTruncationSeparator
	if prefix == "" || strings.HasSuffix(prefix, "\n") {
		separator = ""
	}
	return prefix + separator + ToolOutputTruncationMarker
}

type toolOutputTextField struct {
	body     map[string]any
	key      string
	original string
}

// FitToolCallPayloadOutputBudget bounds the encoded canonical tool payload by
// fairly reducing only formal output/error text streams. It preserves inputs
// and structured fields, emits the standard truncation marker, and reports
// both whether a field changed and whether the final encoded payload fits.
// A false fits result means non-textual payload data alone exceeds the budget.
func FitToolCallPayloadOutputBudget(
	payload map[string]any,
	maxBytes int,
) (bool, bool) {
	if len(payload) == 0 || maxBytes <= 0 {
		return false, len(payload) == 0
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return false, false
	}
	fields := collectToolOutputTextFields(payload)
	if len(fields) == 0 {
		return false, len(encoded) <= maxBytes
	}

	applyCap := func(capBytes int) {
		for _, field := range fields {
			field.body[field.key] = truncateToolOutputTextToBytes(
				field.original,
				capBytes,
			)
		}
	}
	encodedSize := func() (int, bool) {
		value, marshalErr := json.Marshal(payload)
		return len(value), marshalErr == nil
	}
	changed := func() bool {
		for _, field := range fields {
			if field.body[field.key] != field.original {
				return true
			}
		}
		return false
	}

	applyCap(ToolOutputTextMaxBytes)
	if size, ok := encodedSize(); ok && size <= maxBytes {
		return changed(), true
	}

	minimumCap := len(ToolOutputTruncationMarker)
	applyCap(minimumCap)
	if size, ok := encodedSize(); !ok || size > maxBytes {
		for _, field := range fields {
			field.body[field.key] = truncateToolOutputTextToBytes(
				field.original,
				ToolOutputTextMaxBytes,
			)
		}
		return changed(), false
	}

	best := minimumCap
	low, high := minimumCap+1, ToolOutputTextMaxBytes
	for low <= high {
		middle := low + (high-low)/2
		applyCap(middle)
		size, ok := encodedSize()
		if ok && size <= maxBytes {
			best = middle
			low = middle + 1
			continue
		}
		high = middle - 1
	}
	applyCap(best)
	return changed(), true
}

func collectToolOutputTextFields(payload map[string]any) []toolOutputTextField {
	fields := make([]toolOutputTextField, 0, 4)
	var collectBody func(any)
	var collectSteps func(any)

	collectBody = func(value any) {
		body, _ := value.(map[string]any)
		if len(body) == 0 {
			return
		}
		for _, key := range truncatedToolOutputTextKeys {
			if text, ok := body[key].(string); ok {
				fields = append(fields, toolOutputTextField{
					body: body, key: key, original: text,
				})
			}
		}
		collectSteps(body["steps"])
		if metadata, _ := body["metadata"].(map[string]any); metadata != nil {
			collectSteps(metadata["steps"])
		}
	}
	collectSteps = func(value any) {
		steps, _ := value.([]any)
		for _, item := range steps {
			step, _ := item.(map[string]any)
			if len(step) == 0 {
				continue
			}
			for _, key := range []string{
				"toolResult",
				"tool_result",
				"toolError",
				"tool_error",
				"output",
				"error",
			} {
				collectBody(step[key])
			}
			collectSteps(step["steps"])
			if metadata, _ := step["metadata"].(map[string]any); metadata != nil {
				collectSteps(metadata["steps"])
			}
			if nested, _ := step["payload"].(map[string]any); nested != nil {
				collectBody(nested["output"])
				collectBody(nested["error"])
				collectSteps(nested["steps"])
				if metadata, _ := nested["metadata"].(map[string]any); metadata != nil {
					collectSteps(metadata["steps"])
				}
			}
		}
	}

	collectBody(payload["output"])
	collectBody(payload["error"])
	collectSteps(payload["steps"])
	if metadata, _ := payload["metadata"].(map[string]any); metadata != nil {
		collectSteps(metadata["steps"])
	}
	return fields
}

// TruncateToolOutputBody clones one canonical output/error body and applies
// the same text-field bound to its nested canonical tool steps.
func TruncateToolOutputBody(body map[string]any) map[string]any {
	result := cloneToolMap(body)
	truncateToolOutputBodyInPlace(result)
	return result
}

func truncateToolOutputBodyInPlace(body map[string]any) {
	if len(body) == 0 {
		return
	}
	for _, key := range truncatedToolOutputTextKeys {
		if value, ok := body[key].(string); ok {
			body[key] = TruncateToolOutputText(value)
		}
	}
	steps, _ := body["steps"].([]any)
	for _, value := range steps {
		step, _ := value.(map[string]any)
		truncateToolOutputStepInPlace(step)
	}
}

func truncateToolOutputStepInPlace(step map[string]any) {
	if len(step) == 0 {
		return
	}
	for _, key := range []string{
		"toolResult",
		"tool_result",
		"toolError",
		"tool_error",
		"output",
		"error",
	} {
		if body, ok := step[key].(map[string]any); ok {
			truncateToolOutputBodyInPlace(body)
		}
	}
	if payload, ok := step["payload"].(map[string]any); ok {
		for _, key := range []string{"output", "error"} {
			if body, ok := payload[key].(map[string]any); ok {
				truncateToolOutputBodyInPlace(body)
			}
		}
	}
}
