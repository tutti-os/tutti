package storesqlite

import (
	"context"
	"testing"
)

func TestRollbackRuntimeSessionInitializationRemovesOnlyOwnedProvisionalShapes(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seed := func(sessionID string) {
		t.Helper()
		if _, err := store.ReportSessionState(ctx, SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: sessionID,
			Origin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME", Provider: "codex", OccurredAtUnixMS: 1,
		}); err != nil {
			t.Fatalf("seed %s: %v", sessionID, err)
		}
	}

	seed("empty")
	removed, err := store.RollbackRuntimeSessionInitialization(ctx, "ws-1", "empty")
	if err != nil || !removed {
		t.Fatalf("rollback empty shell removed=%v error=%v", removed, err)
	}
	if _, ok, err := store.GetSession(ctx, "ws-1", "empty"); err != nil || ok {
		t.Fatalf("empty shell still exists ok=%v error=%v", ok, err)
	}

	seed("with-turn")
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "with-turn", TurnID: "turn-1",
		Phase: TurnPhaseSubmitted, OccurredAtUnixMS: 2,
	}); err != nil || !accepted {
		t.Fatalf("seed turn accepted=%v error=%v", accepted, err)
	}
	removed, err = store.RollbackRuntimeSessionInitialization(ctx, "ws-1", "with-turn")
	if err != nil || removed {
		t.Fatalf("rollback session with turn removed=%v error=%v", removed, err)
	}

	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "provisional-with-turn",
		Origin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME", Provider: "claude-sdk",
		RuntimeContext: map[string]any{"visible": false, "provisional": true}, OccurredAtUnixMS: 3,
	}); err != nil {
		t.Fatalf("seed provisional session: %v", err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "provisional-with-turn", TurnID: "turn-provisional",
		Phase: TurnPhaseSubmitted, OccurredAtUnixMS: 4,
	}); err != nil || !accepted {
		t.Fatalf("seed provisional turn accepted=%v error=%v", accepted, err)
	}
	removed, err = store.RollbackRuntimeSessionInitialization(ctx, "ws-1", "provisional-with-turn")
	if err != nil || !removed {
		t.Fatalf("rollback provisional session with submitted turn removed=%v error=%v", removed, err)
	}
	if _, ok, err := store.GetSession(ctx, "ws-1", "provisional-with-turn"); err != nil || ok {
		t.Fatalf("provisional session still exists ok=%v error=%v", ok, err)
	}

	seed("provisional-failed-turn")
	if result, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "provisional-failed-turn",
		Origin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME", Provider: "claude-sdk",
		RuntimeContext: map[string]any{"visible": false, "provisional": true}, OccurredAtUnixMS: 5,
	}); err != nil || !result.Accepted {
		t.Fatalf("seed failed provisional session accepted=%v error=%v", result.Accepted, err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "provisional-failed-turn", TurnID: "turn-failed",
		Phase: TurnPhaseSubmitted, OccurredAtUnixMS: 6,
	}); err != nil || !accepted {
		t.Fatalf("seed failed provisional submitted accepted=%v error=%v", accepted, err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "provisional-failed-turn", TurnID: "turn-failed",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeFailed, OccurredAtUnixMS: 7,
	}); err != nil || !accepted {
		t.Fatalf("seed failed provisional settled accepted=%v error=%v", accepted, err)
	}
	removed, err = store.RollbackRuntimeSessionInitialization(ctx, "ws-1", "provisional-failed-turn")
	if err != nil || !removed {
		t.Fatalf("rollback provisional failed turn removed=%v error=%v", removed, err)
	}
}
