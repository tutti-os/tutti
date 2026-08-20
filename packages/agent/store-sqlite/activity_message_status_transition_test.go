package storesqlite

import (
	"context"
	"testing"
)

func TestReportSessionMessagesReportsStatusTransitionOnlyOnce(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-tool", AgentSessionID: "session-tool", Origin: "runtime",
		Provider: "codex", ProviderSessionID: "provider-tool", Status: "running", OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatal(err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-tool", AgentSessionID: "session-tool", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 101,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition() accepted=%v error=%v", accepted, err)
	}

	report := func(status string, payload map[string]any, occurredAt int64) MessageReportResult {
		t.Helper()
		result, err := store.ReportSessionMessages(ctx, SessionMessageReport{
			WorkspaceID: "ws-tool", AgentSessionID: "session-tool", Origin: "runtime", Provider: "codex",
			Messages: []MessageUpdate{{
				MessageID: "toolcall:1", TurnID: "turn-1", Role: "assistant", Kind: "tool_call",
				Status: status, Payload: payload, OccurredAtUnixMS: occurredAt,
			}},
		})
		if err != nil {
			t.Fatalf("ReportSessionMessages(%s) error = %v", status, err)
		}
		return result
	}

	running := report("running", map[string]any{"toolName": "Bash"}, 110)
	if len(running.StatusTransitionedMessageIDs) != 1 || running.StatusTransitionedMessageIDs[0] != "toolcall:1" {
		t.Fatalf("first report transitions = %#v, want the created message", running.StatusTransitionedMessageIDs)
	}

	failed := report("failed", map[string]any{
		"toolName": "Bash", "error": map[string]any{"text": "Exit code 137"},
	}, 120)
	if len(failed.StatusTransitionedMessageIDs) != 1 || failed.StatusTransitionedMessageIDs[0] != "toolcall:1" {
		t.Fatalf("failed report transitions = %#v, want the first move into failed", failed.StatusTransitionedMessageIDs)
	}

	replayed := report("failed", map[string]any{
		"toolName": "Bash", "error": map[string]any{"text": "Exit code 137"},
	}, 130)
	if replayed.AcceptedCount != 1 {
		t.Fatalf("replayed report = %#v, want the already-applied snapshot accepted", replayed)
	}
	if len(replayed.StatusTransitionedMessageIDs) != 0 {
		t.Fatalf("replayed report transitions = %#v, want none", replayed.StatusTransitionedMessageIDs)
	}

	enriched := report("failed", map[string]any{
		"toolName": "Bash", "error": map[string]any{"text": "Exit code 137", "stderr": "no such file"},
	}, 140)
	if enriched.AcceptedCount != 1 {
		t.Fatalf("enriched report = %#v, want the payload update accepted", enriched)
	}
	if len(enriched.StatusTransitionedMessageIDs) != 0 {
		t.Fatalf("enriched report transitions = %#v, want none for a payload-only update", enriched.StatusTransitionedMessageIDs)
	}
}
