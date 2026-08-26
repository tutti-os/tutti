package agentruntime

import (
	"encoding/json"
	"testing"
)

func TestACPResumeMethodUnderstandsObjectFormSessionCapabilities(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "top-level object resume wins over legacy load",
			raw:  `{"agentCapabilities":{"loadSession":true},"sessionCapabilities":{"resume":{}}}`,
			want: acpMethodResume,
		},
		{
			name: "nested object resume wins over legacy load",
			raw:  `{"agentCapabilities":{"loadSession":true,"sessionCapabilities":{"resume":{}}}}`,
			want: acpMethodResume,
		},
		{
			name: "explicit false resume falls back to legacy load",
			raw:  `{"agentCapabilities":{"loadSession":true},"sessionCapabilities":{"resume":false}}`,
			want: acpMethodLoadSession,
		},
		{
			name: "object load is supported",
			raw:  `{"sessionCapabilities":{"load":{}}}`,
			want: acpMethodLoadSession,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := acpResumeMethod(json.RawMessage(tt.raw)); got != tt.want {
				t.Fatalf("acpResumeMethod() = %q, want %q", got, tt.want)
			}
		})
	}
}

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
