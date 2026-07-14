package agentcontext

import (
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
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
	if value["agentTargetId"] != "local:codex" {
		t.Fatalf("agentTargetId = %#v", value["agentTargetId"])
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

func TestSessionSummaryValueIncludesTurnEntitiesAndInteractions(t *testing.T) {
	value := sessionSummaryValue(agentserviceSessionWithLifecycle())

	turn, ok := value["latestTurn"].(map[string]any)
	if !ok {
		t.Fatalf("latestTurn = %#v", value["latestTurn"])
	}
	if value["activeTurnId"] != "TURN-1" || turn["turnId"] != "TURN-1" {
		t.Fatalf("turn projection = %#v", value)
	}
	if turn["phase"] != "settled" || turn["outcome"] != "completed" {
		t.Fatalf("turn = %#v", turn)
	}
	if interactions, ok := value["pendingInteractions"].([]any); !ok || len(interactions) != 1 {
		t.Fatalf("pending interactions = %#v", value["pendingInteractions"])
	}
}

func TestSessionInspectValueIncludesTurnEntities(t *testing.T) {
	value := sessionInspectValue(agentserviceSessionWithLifecycle())
	if _, ok := value["latestTurn"].(map[string]any); !ok {
		t.Fatalf("latestTurn = %#v", value["latestTurn"])
	}
}

func TestSessionActionValueIncludesExactAgentTarget(t *testing.T) {
	value := sessionActionValue(agentserviceSessionWithRuntime())
	if value["agentTargetId"] != "local:codex" {
		t.Fatalf("agentTargetId = %#v", value["agentTargetId"])
	}
}

func TestSessionSummaryValueOmitsOptionalEmptyRuntimeProtocolFields(t *testing.T) {
	value := sessionSummaryValue(agentservice.Session{
		ID:           "SESSION-1",
		Provider:     "codex",
		ActiveTurnID: "",
	})
	if value["activeTurnId"] != nil {
		t.Fatalf("activeTurnId = %#v", value["activeTurnId"])
	}
	if interactions, ok := value["pendingInteractions"].([]any); !ok || len(interactions) != 0 {
		t.Fatalf("pendingInteractions = %#v", value["pendingInteractions"])
	}
}

func agentserviceSessionWithRuntime() agentservice.Session {
	title := "Work"
	return agentservice.Session{
		ID:            "SESSION-1",
		AgentTargetID: "local:codex",
		Provider:      "codex",
		Title:         &title,
	}
}

func agentserviceSessionWithLifecycle() agentservice.Session {
	title := "Work"
	turn := agentactivitybiz.Turn{TurnID: " TURN-1 ", Phase: " settled ", Outcome: " completed "}
	return agentservice.Session{
		ID: "SESSION-1", Provider: "codex", Title: &title, ActiveTurnID: " TURN-1 ",
		ActiveTurn: &turn, LatestTurn: &turn,
		PendingInteractions: []agentactivitybiz.Interaction{{TurnID: "TURN-1", RequestID: "request-1", Kind: "question", Status: "pending"}},
	}
}
