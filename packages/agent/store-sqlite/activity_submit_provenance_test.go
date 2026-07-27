package storesqlite

import (
	"context"
	"strings"
	"testing"
)

func TestReportActivityStateTreatsJSONEquivalentExistingMessageAsSubmitProvenanceReplay(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime",
		Provider: "codex", ProviderSessionID: "provider-1", Status: "active", CurrentPhase: "working", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseRunning, Origin: TurnOriginUserPrompt, OccurredAtUnixMS: 2,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition() accepted=%v error=%v", accepted, err)
	}

	message := MessageUpdate{
		MessageID: "client-submit:user:submit-1", TurnID: "turn-1",
		Role: "user", Kind: "text", Status: "completed", OccurredAtUnixMS: 3,
		Payload: map[string]any{
			"clientSubmitId": "submit-1",
			"content": []map[string]any{{
				"type": "text",
				"text": "hello",
			}},
			"contentMode": "snapshot",
			"sequence":    int64(1),
			"source":      "runtime",
			"text":        "hello",
		},
	}
	ordinary, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime",
		Provider: "codex",
		Messages: []MessageUpdate{message},
	})
	if err != nil || ordinary.AcceptedCount != 1 || ordinary.LatestVersion != 1 {
		t.Fatalf("ordinary report result=%#v error=%v", ordinary, err)
	}

	provenance, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime",
			Provider: "codex", ProviderSessionID: "provider-1", Status: "active", CurrentPhase: "working", OccurredAtUnixMS: 4,
		},
		Messages: []MessageUpdate{message},
	})
	if err != nil {
		t.Fatalf("submit provenance replay error=%v", err)
	}
	if provenance.Messages.AcceptedCount != 1 || provenance.Messages.LatestVersion != 1 ||
		len(provenance.Messages.Messages) != 1 || provenance.Messages.Messages[0].Version != 1 {
		t.Fatalf("submit provenance replay result=%#v, want existing message version 1", provenance.Messages)
	}
	content, ok := provenance.Messages.Messages[0].Payload["content"].([]any)
	if !ok || len(content) != 1 {
		t.Fatalf("canonical content=%#v, want one-element []any", provenance.Messages.Messages[0].Payload["content"])
	}
	if block, ok := content[0].(map[string]any); !ok || block["type"] != "text" || block["text"] != "hello" {
		t.Fatalf("canonical content block=%#v", content[0])
	}
	if sequence, ok := provenance.Messages.Messages[0].Payload["sequence"].(float64); !ok || sequence != 1 {
		t.Fatalf("canonical sequence=%#v, want float64(1)", provenance.Messages.Messages[0].Payload["sequence"])
	}

	conflicting := message
	conflicting.Payload = map[string]any{
		"clientSubmitId": "submit-1",
		"content":        []map[string]any{{"type": "text", "text": "changed"}},
		"contentMode":    "snapshot",
		"sequence":       int64(1),
		"source":         "runtime",
		"text":           "changed",
	}
	_, err = store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime",
			Provider: "codex", ProviderSessionID: "provider-1", Status: "active", CurrentPhase: "working", OccurredAtUnixMS: 5,
		},
		Messages: []MessageUpdate{conflicting},
	})
	if err == nil || !strings.Contains(err.Error(), "conflicts with durable submit provenance") {
		t.Fatalf("conflicting submit provenance error=%v", err)
	}
	session, ok, err := store.GetSession(ctx, "ws-1", "session-1")
	if err != nil || !ok || session.MessageVersion != 1 {
		t.Fatalf("session after conflict=%#v found=%v error=%v", session, ok, err)
	}
}
