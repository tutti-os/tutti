package automationrule

import (
	"strings"
	"testing"

	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
)

func TestAutomationLaunchPromptComposesInstructionMentionAndEventNote(t *testing.T) {
	prompt := automationLaunchPrompt(automationrulebiz.Rule{
		Trigger: automationrulebiz.TriggerOnTaskComplete,
		Prompt:  "Review the finished work and file follow-up issues.",
	}, "workspace one", "session-1")

	sections := strings.Split(prompt, "\n\n")
	if len(sections) != 3 {
		t.Fatalf("prompt sections = %d, want 3: %q", len(sections), prompt)
	}
	if sections[0] != "Review the finished work and file follow-up issues." {
		t.Fatalf("prompt instruction = %q", sections[0])
	}
	if sections[1] != "Source session: mention://agent-session/session-1?workspaceId=workspace+one" {
		t.Fatalf("prompt source mention = %q", sections[1])
	}
	if !strings.Contains(sections[2], "task completed") {
		t.Fatalf("prompt event note = %q", sections[2])
	}
	if strings.Contains(prompt, "Source conversation context") {
		t.Fatalf("prompt must not inline a transcript copy: %q", prompt)
	}
}

func TestAutomationLaunchPromptUsesFailureNoteAndDefaultInstruction(t *testing.T) {
	prompt := automationLaunchPrompt(automationrulebiz.Rule{
		Trigger: automationrulebiz.TriggerOnTaskFailed,
	}, "ws", "session-9")

	if !strings.Contains(prompt, "failed or was interrupted") {
		t.Fatalf("failure prompt event note missing: %q", prompt)
	}
	if !strings.HasPrefix(prompt, "Take over the follow-up work") {
		t.Fatalf("default instruction missing: %q", prompt)
	}
}

func TestAutomationOriginDepthDefaultsLegacyRowsAndReadsNestedDepth(t *testing.T) {
	if depth, ok := automationOriginDepth(map[string]any{"automationRuleId": "legacy"}); !ok || depth != 1 {
		t.Fatalf("legacy automation origin = %d, %v", depth, ok)
	}
	if depth, ok := automationOriginDepth(map[string]any{"automation": map[string]any{"ruleId": "rule", "depth": float64(2)}}); !ok || depth != 2 {
		t.Fatalf("nested automation origin = %d, %v", depth, ok)
	}
}
