package agent

import "testing"

func TestCodexNativeTurnCapability(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		provider     string
		prompt       string
		wantSemantic string
		wantPrompt   string
	}{
		{name: "browser on Codex", provider: "codex", prompt: "/browser open tutti.dev", wantSemantic: "browser", wantPrompt: "open tutti.dev"},
		{name: "computer on Codex", provider: "codex", prompt: "/computer open Notes", wantSemantic: "computer", wantPrompt: "open Notes"},
		{name: "sites on Codex", provider: "codex", prompt: "/sites\ncreate a landing page", wantSemantic: "sites", wantPrompt: "create a landing page"},
		{name: "legacy browser palette prompt on Codex", provider: "codex", prompt: legacyBrowserUsePromptPrefix + "\n\nopen tutti.dev", wantSemantic: "browser", wantPrompt: "open tutti.dev"},
		{name: "other provider unchanged", provider: "claude-code", prompt: "/browser open tutti.dev", wantPrompt: "/browser open tutti.dev"},
		{name: "bare command unchanged", provider: "codex", prompt: "/browser", wantPrompt: "/browser"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			content, invocation := codexNativeTurnCapability(test.provider, TextPromptContent(test.prompt))
			if content[0].Text != test.wantPrompt {
				t.Fatalf("text = %q, want %q", content[0].Text, test.wantPrompt)
			}
			if test.wantSemantic == "" {
				if invocation != nil {
					t.Fatalf("invocation = %#v, want nil", invocation)
				}
				return
			}
			if invocation == nil || invocation.Semantic != test.wantSemantic {
				t.Fatalf("invocation = %#v, want semantic %q", invocation, test.wantSemantic)
			}
		})
	}
}
