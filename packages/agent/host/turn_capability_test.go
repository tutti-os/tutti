package agenthost

import "testing"

func TestMergeTurnCapabilityPromptContent(t *testing.T) {
	t.Parallel()
	content, text, err := mergeTurnCapabilityPromptContent(
		[]PromptContentBlock{{Type: "text", Text: "open tutti.dev"}},
		[]PromptContentBlock{{Type: "mention", Name: "browser@openai-bundled", Path: "plugin://browser@openai-bundled"}},
	)
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if text != "open tutti.dev" || len(content) != 2 {
		t.Fatalf("content = %#v, text = %q", content, text)
	}
}

func TestMergeTurnCapabilityPromptContentRejectsInvalidMention(t *testing.T) {
	t.Parallel()
	_, _, err := mergeTurnCapabilityPromptContent(
		[]PromptContentBlock{{Type: "text", Text: "task"}},
		[]PromptContentBlock{{Type: "skill", Name: "unexpected", Path: "skill://unexpected"}},
	)
	if err == nil {
		t.Fatal("merge succeeded for an invalid capability augmentation")
	}
}
