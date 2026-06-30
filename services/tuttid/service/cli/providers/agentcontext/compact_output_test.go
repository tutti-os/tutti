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

func TestMessageCompactValueIncludesImages(t *testing.T) {
	value := messageCompactValue(agentservice.SessionMessage{
		AgentSessionID:   "SESSION-1",
		Role:             "user",
		Kind:             "text",
		Status:           "completed",
		OccurredAtUnixMS: 123,
		Payload: map[string]any{
			"content": []any{
				map[string]any{"type": "text", "text": "look"},
				map[string]any{
					"type":         "image",
					"attachmentId": "attachment-1",
					"mimeType":     "image/png",
				},
			},
		},
	}, func(agentSessionID string, attachmentID string, mimeType string) (string, bool) {
		if agentSessionID != "SESSION-1" || attachmentID != "attachment-1" || mimeType != "image/png" {
			t.Fatalf("resolver input = %q %q %q", agentSessionID, attachmentID, mimeType)
		}
		return "/tmp/agent/attachments/SESSION-1/attachment-1.png", true
	})

	if value["text"] != "look" {
		t.Fatalf("value = %#v", value)
	}
	images, ok := value["images"].([]any)
	if !ok || len(images) != 1 {
		t.Fatalf("images = %#v", value["images"])
	}
	image := images[0].(map[string]any)
	if image["attachmentId"] != "attachment-1" ||
		image["mimeType"] != "image/png" ||
		image["name"] != "attachment-1.png" ||
		image["localPath"] != "/tmp/agent/attachments/SESSION-1/attachment-1.png" {
		t.Fatalf("image = %#v", image)
	}
}

func TestMessageCompactImageLocalPathPrefersResolverOverPayloadPath(t *testing.T) {
	value := messageCompactValue(agentservice.SessionMessage{
		AgentSessionID: "SESSION-1",
		Role:           "user",
		Kind:           "text",
		Status:         "completed",
		Payload: map[string]any{
			"content": []any{
				map[string]any{
					"type":         "image",
					"attachmentId": "attachment-1",
					"mimeType":     "image/png",
					"localPath":    "/tmp/stale-or-untrusted.png",
				},
			},
		},
	}, func(agentSessionID string, attachmentID string, mimeType string) (string, bool) {
		if agentSessionID != "SESSION-1" || attachmentID != "attachment-1" || mimeType != "image/png" {
			t.Fatalf("resolver input = %q %q %q", agentSessionID, attachmentID, mimeType)
		}
		return "/tmp/agent/attachments/SESSION-1/attachment-1.png", true
	})

	images, ok := value["images"].([]any)
	if !ok || len(images) != 1 {
		t.Fatalf("images = %#v", value["images"])
	}
	image := images[0].(map[string]any)
	if image["localPath"] != "/tmp/agent/attachments/SESSION-1/attachment-1.png" {
		t.Fatalf("image = %#v", image)
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
	if _, ok := value["turnLifecycle"]; ok {
		t.Fatalf("nil turn lifecycle should be omitted: %#v", value)
	}
	if _, ok := value["submitAvailability"]; ok {
		t.Fatalf("nil submit availability should be omitted: %#v", value)
	}
}

func TestSessionSummaryValueIncludesTurnLifecycleAndSubmitAvailability(t *testing.T) {
	value := sessionSummaryValue(agentserviceSessionWithLifecycle())

	lifecycle, ok := value["turnLifecycle"].(map[string]any)
	if !ok {
		t.Fatalf("turnLifecycle = %#v", value["turnLifecycle"])
	}
	if lifecycle["activeTurnId"] != "TURN-1" {
		t.Fatalf("turnLifecycle = %#v", lifecycle)
	}
	if lifecycle["phase"] != "completed" {
		t.Fatalf("turnLifecycle phase = %#v", lifecycle["phase"])
	}
	if lifecycle["settling"] != true {
		t.Fatalf("turnLifecycle settling = %#v", lifecycle["settling"])
	}
	if lifecycle["outcome"] != "success" {
		t.Fatalf("turnLifecycle outcome = %#v", lifecycle["outcome"])
	}
	completedCommand, ok := lifecycle["completedCommand"].(map[string]any)
	if !ok {
		t.Fatalf("completedCommand = %#v", lifecycle["completedCommand"])
	}
	if completedCommand["status"] != "succeeded" {
		t.Fatalf("completedCommand status = %#v", completedCommand["status"])
	}

	availability, ok := value["submitAvailability"].(map[string]any)
	if !ok {
		t.Fatalf("submitAvailability = %#v", value["submitAvailability"])
	}
	if availability["state"] != "blocked" {
		t.Fatalf("submitAvailability state = %#v", availability["state"])
	}
	if availability["reason"] != "turn_running" {
		t.Fatalf("submitAvailability reason = %#v", availability["reason"])
	}
}

func TestSessionInspectValueIncludesTurnLifecycleAndSubmitAvailability(t *testing.T) {
	value := sessionInspectValue(agentserviceSessionWithLifecycle())

	lifecycle, ok := value["turnLifecycle"].(map[string]any)
	if !ok {
		t.Fatalf("turnLifecycle = %#v", value["turnLifecycle"])
	}
	if lifecycle["phase"] != "completed" {
		t.Fatalf("turnLifecycle phase = %#v", lifecycle["phase"])
	}
	completedCommand, ok := lifecycle["completedCommand"].(map[string]any)
	if !ok {
		t.Fatalf("completedCommand = %#v", lifecycle["completedCommand"])
	}
	if completedCommand["status"] != "succeeded" {
		t.Fatalf("completedCommand status = %#v", completedCommand["status"])
	}
	if _, ok := value["submitAvailability"].(map[string]any); !ok {
		t.Fatalf("submitAvailability = %#v", value["submitAvailability"])
	}
}

func TestSessionSummaryValueOmitsOptionalEmptyRuntimeProtocolFields(t *testing.T) {
	value := sessionSummaryValue(agentservice.Session{
		ID:       "SESSION-1",
		Provider: "codex",
		Status:   "ready",
		TurnLifecycle: &agentservice.TurnLifecycle{
			Phase:    " ready ",
			Settling: false,
		},
		SubmitAvailability: &agentservice.SubmitAvailability{
			State:  " available ",
			Reason: " ",
		},
	})

	lifecycle, ok := value["turnLifecycle"].(map[string]any)
	if !ok {
		t.Fatalf("turnLifecycle = %#v", value["turnLifecycle"])
	}
	if lifecycle["phase"] != "ready" {
		t.Fatalf("turnLifecycle phase = %#v", lifecycle["phase"])
	}
	if _, ok := lifecycle["settling"]; ok {
		t.Fatalf("false settling should be omitted: %#v", lifecycle)
	}

	availability, ok := value["submitAvailability"].(map[string]any)
	if !ok {
		t.Fatalf("submitAvailability = %#v", value["submitAvailability"])
	}
	if availability["state"] != "available" {
		t.Fatalf("submitAvailability state = %#v", availability["state"])
	}
	if _, ok := availability["reason"]; ok {
		t.Fatalf("blank reason should be omitted: %#v", availability)
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

func agentserviceSessionWithLifecycle() agentservice.Session {
	title := "Work"
	activeTurnID := " TURN-1 "
	outcome := " success "
	return agentservice.Session{
		ID:       "SESSION-1",
		Provider: "codex",
		Status:   "working",
		Title:    &title,
		TurnLifecycle: &agentservice.TurnLifecycle{
			ActiveTurnID: &activeTurnID,
			Phase:        " completed ",
			Settling:     true,
			Outcome:      &outcome,
			CompletedCommand: &agentservice.CompletedCommand{
				Kind:   " exec ",
				Status: " succeeded ",
			},
		},
		SubmitAvailability: &agentservice.SubmitAvailability{
			State:  " blocked ",
			Reason: " turn_running ",
		},
	}
}
