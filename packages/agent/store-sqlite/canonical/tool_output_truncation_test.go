package canonical

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTruncateToolOutputTextKeepsValuesWithinLimit(t *testing.T) {
	t.Parallel()

	value := strings.Repeat("x", ToolOutputTextMaxBytes)
	if got := TruncateToolOutputText(value); got != value {
		t.Fatalf("value at limit changed: got %d bytes, want %d", len(got), len(value))
	}
}

func TestTruncateToolOutputTextKeepsValidUTF8PrefixAndMarker(t *testing.T) {
	t.Parallel()

	prefixLimit := ToolOutputTextMaxBytes -
		len(toolOutputTruncationSeparator) -
		len(ToolOutputTruncationMarker)
	value := strings.Repeat("a", prefixLimit-1) + "你" + strings.Repeat("z", 64)
	got := TruncateToolOutputText(value)

	if len(got) > ToolOutputTextMaxBytes {
		t.Fatalf("truncated value has %d bytes, limit is %d", len(got), ToolOutputTextMaxBytes)
	}
	if !utf8.ValidString(got) {
		t.Fatal("truncated value is not valid UTF-8")
	}
	if !strings.HasSuffix(got, "\n"+ToolOutputTruncationMarker) {
		t.Fatalf("truncated value suffix = %q", got[len(got)-64:])
	}
	if strings.Contains(got, "你") || strings.Contains(got, "z") {
		t.Fatal("truncated value retained content after the valid prefix boundary")
	}
	if repeated := TruncateToolOutputText(got); repeated != got {
		t.Fatal("truncation marker was not idempotent")
	}
}

func TestTruncateToolOutputBodyLimitsOnlyFormalTextFieldsAndNestedSteps(t *testing.T) {
	t.Parallel()

	large := strings.Repeat("x", ToolOutputTextMaxBytes+64)
	body := map[string]any{
		"text":    large,
		"stdout":  large,
		"stderr":  large,
		"message": large,
		"steps": []any{
			map[string]any{
				"toolResult": map[string]any{"text": large, "stdout": large},
				"toolError":  map[string]any{"stderr": large},
			},
		},
	}
	got := TruncateToolOutputBody(body)

	assertTruncatedToolTextFields(t, got, "text", "stdout", "stderr")
	if got["message"] != large {
		t.Fatal("non-target output field was truncated")
	}
	step := got["steps"].([]any)[0].(map[string]any)
	assertTruncatedToolTextFields(t, step["toolResult"].(map[string]any), "text", "stdout")
	assertTruncatedToolTextFields(t, step["toolError"].(map[string]any), "stderr")
	if body["text"] != large {
		t.Fatal("input body was mutated")
	}
}

func TestCompactToolCallPayloadLimitsOutputErrorAndStepBodiesWithoutChangingInput(t *testing.T) {
	t.Parallel()

	large := strings.Repeat("x", ToolOutputTextMaxBytes+64)
	inputText := "preserved input"
	got := CompactToolCallPayload("failed", map[string]any{
		"callId": "call-1",
		"input":  map[string]any{"text": inputText},
		"output": map[string]any{"text": large, "stdout": large},
		"error":  map[string]any{"text": large, "stderr": large},
		"steps": []any{
			map[string]any{
				"id":         "step-1",
				"status":     "failed",
				"toolResult": map[string]any{"stdout": large},
				"toolError":  map[string]any{"stderr": large},
			},
		},
	})

	if got["input"].(map[string]any)["text"] != inputText {
		t.Fatal("tool input was truncated")
	}
	assertTruncatedToolTextFields(t, got["output"].(map[string]any), "text", "stdout")
	assertTruncatedToolTextFields(t, got["error"].(map[string]any), "text", "stderr")
	step := got["steps"].([]any)[0].(map[string]any)
	assertTruncatedToolTextFields(t, step["toolResult"].(map[string]any), "stdout")
	assertTruncatedToolTextFields(t, step["toolError"].(map[string]any), "stderr")
}

func assertTruncatedToolTextFields(t *testing.T, body map[string]any, keys ...string) {
	t.Helper()
	for _, key := range keys {
		value, _ := body[key].(string)
		if len(value) > ToolOutputTextMaxBytes {
			t.Fatalf("%s has %d bytes, limit is %d", key, len(value), ToolOutputTextMaxBytes)
		}
		if !strings.HasSuffix(value, ToolOutputTruncationMarker) {
			t.Fatalf("%s does not end with truncation marker", key)
		}
	}
}
