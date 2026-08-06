package agenthost

import (
	"errors"
	"testing"
)

func TestNormalizePromptContentAcceptsConnectorOnlyInput(t *testing.T) {
	content, text, err := normalizePromptContent([]PromptContentBlock{{
		Type: "connector", ConnectorKey: " lark-cli ",
	}})
	if err != nil {
		t.Fatalf("normalizePromptContent() error = %v, want nil", err)
	}
	if len(content) != 1 || content[0].ConnectorKey != "lark-cli" || text != "" {
		t.Fatalf("normalized connector = %#v, text = %q", content, text)
	}
}

func TestNormalizePromptContentRejectsInvalidConnectorKey(t *testing.T) {
	_, _, err := normalizePromptContent([]PromptContentBlock{{
		Type: "connector", ConnectorKey: "Global Lark CLI",
	}})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("normalizePromptContent() error = %v, want ErrInvalidArgument", err)
	}
}
