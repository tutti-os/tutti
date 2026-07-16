package automationrule

import (
	"strings"
	"testing"

	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
)

func TestAutomationAgentPromptIncludesWorkspaceScopedSourceMention(t *testing.T) {
	instruction := automationAgentInstruction(automationrulebiz.Rule{
		Action: automationrulebiz.ActionDelegate,
	})
	prompt := automationAgentPrompt(instruction, "workspace one", "session-1", "User: finish the task")

	if !strings.Contains(prompt, "mention://agent-session/session-1?workspaceId=workspace+one") {
		t.Fatalf("prompt source mention = %q", prompt)
	}
	if !strings.Contains(prompt, "Source conversation context") {
		t.Fatalf("prompt missing bounded source context = %q", prompt)
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
