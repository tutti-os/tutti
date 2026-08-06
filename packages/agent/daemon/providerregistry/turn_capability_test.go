package providerregistry

import "testing"

func TestSupportsNativePluginTurn(t *testing.T) {
	tests := []struct {
		name     string
		provider string
		want     bool
	}{
		{name: "codex", provider: CodexProviderID, want: true},
		{name: "tutti agent", provider: TuttiAgentProviderID, want: false},
		{name: "claude", provider: ClaudeCodeProviderID, want: false},
		{name: "cursor", provider: CursorProviderID, want: false},
		{name: "unknown", provider: "unknown", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SupportsNativePluginTurn(tt.provider); got != tt.want {
				t.Fatalf("SupportsNativePluginTurn(%q) = %v, want %v", tt.provider, got, tt.want)
			}
		})
	}
}
