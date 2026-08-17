package agentruntime

import (
	"encoding/json"
	"testing"
)

func TestACPPromptResultAssistantTextPreservesMarkdownWhitespace(t *testing.T) {
	raw := json.RawMessage("{\"role\":\"assistant\",\"content\":[" +
		"{\"type\":\"text\",\"text\":\"# Result\\n\\n\"}," +
		"{\"type\":\"text\",\"text\":\"- first\\n- second\\n\\n\"}," +
		"{\"type\":\"text\",\"text\":\"```go\\nfmt.Println(\\\"ok\\\")\\n```\\n\"}" +
		"]}")
	want := "# Result\n\n- first\n- second\n\n```go\nfmt.Println(\"ok\")\n```\n"

	if got := acpPromptResultAssistantText(raw); got != want {
		t.Fatalf("acpPromptResultAssistantText() = %q, want %q", got, want)
	}
}

func TestACPTextFromValueSkipsWhitespaceOnlyBlocksWithoutTrimmingContent(t *testing.T) {
	value := []any{
		map[string]any{"text": " \n\t"},
		map[string]any{"text": "  indented\n"},
	}

	if got, want := acpTextFromValue(value), "  indented\n"; got != want {
		t.Fatalf("acpTextFromValue() = %q, want %q", got, want)
	}
}
