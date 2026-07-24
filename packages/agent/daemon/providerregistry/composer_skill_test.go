package providerregistry

import "testing"

func TestProjectComposerSkillUsesProviderDescriptorSemantics(t *testing.T) {
	tests := []struct {
		name           string
		provider       string
		skillName      string
		pluginName     string
		wantTrigger    string
		wantInvocation SkillInvocation
	}{
		{
			name:           "codex prompt item",
			provider:       CodexProviderID,
			skillName:      "review",
			wantTrigger:    "$review",
			wantInvocation: SkillInvocationPromptItem,
		},
		{
			name:           "claude personal skill",
			provider:       ClaudeCodeProviderID,
			skillName:      "review",
			wantTrigger:    "/review",
			wantInvocation: SkillInvocationTextTrigger,
		},
		{
			name:           "claude plugin skill",
			provider:       ClaudeCodeProviderID,
			skillName:      "shot",
			pluginName:     "pua",
			wantTrigger:    "/pua:shot",
			wantInvocation: SkillInvocationTextTrigger,
		},
		{
			name:           "cursor text trigger",
			provider:       CursorProviderID,
			skillName:      "review",
			wantTrigger:    "$review",
			wantInvocation: SkillInvocationTextTrigger,
		},
		{
			name:           "opencode text trigger",
			provider:       OpenCodeProviderID,
			skillName:      "review",
			wantTrigger:    "/review",
			wantInvocation: SkillInvocationTextTrigger,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := ProjectComposerSkill(test.provider, test.skillName, test.pluginName)
			if !ok {
				t.Fatal("ProjectComposerSkill() did not resolve a supported skill")
			}
			if got.Trigger != test.wantTrigger || got.Invocation != test.wantInvocation {
				t.Fatalf("ProjectComposerSkill() = %#v, want trigger %q invocation %q", got, test.wantTrigger, test.wantInvocation)
			}
		})
	}
}

func TestProjectComposerSkillRejectsUnknownOrBlankInputs(t *testing.T) {
	for _, test := range []struct {
		provider string
		name     string
	}{
		{provider: "unknown", name: "review"},
		{provider: CodexProviderID, name: " "},
	} {
		if got, ok := ProjectComposerSkill(test.provider, test.name, ""); ok {
			t.Fatalf("ProjectComposerSkill(%q, %q) = %#v, want unresolved", test.provider, test.name, got)
		}
	}
}
