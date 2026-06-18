package agentcontext

import (
	"testing"

	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestMessageCompactTextPrefersPlainText(t *testing.T) {
	text := messageCompactText(map[string]any{
		"text":    "hello",
		"content": "ignored",
	}, "text")
	if text != "hello" {
		t.Fatalf("text = %q", text)
	}
}

func TestMessageCompactTextUsesStringContent(t *testing.T) {
	text := messageCompactText(map[string]any{"content": "Done."}, "text")
	if text != "Done." {
		t.Fatalf("text = %q", text)
	}
}

func TestMessageCompactTextUsesContentBlocks(t *testing.T) {
	text := messageCompactText(map[string]any{
		"content": []any{
			map[string]any{"type": "input_text", "text": "first"},
			map[string]any{"type": "input_text", "text": "second"},
		},
	}, "text")
	if text != "first\nsecond" {
		t.Fatalf("text = %q", text)
	}
}

func TestSessionSummaryValueOmitsRuntimeContext(t *testing.T) {
	value := sessionSummaryValue(agentserviceSessionWithRuntime())
	if value["agentSessionId"] != "SESSION-1" {
		t.Fatalf("value = %#v", value)
	}
	if _, ok := value["id"]; ok {
		t.Fatalf("session JSON should use typed id key: %#v", value)
	}
	if _, ok := value["runtimeContext"]; ok {
		t.Fatalf("value = %#v", value)
	}
	if _, ok := value["permissionConfig"]; ok {
		t.Fatalf("value = %#v", value)
	}
}

func agentserviceSessionWithRuntime() agentservice.Session {
	title := "Work"
	return agentservice.Session{
		ID:             "SESSION-1",
		Provider:       "codex",
		Status:         "working",
		Title:          &title,
		RuntimeContext: map[string]any{"model": "gpt-5"},
	}
}
