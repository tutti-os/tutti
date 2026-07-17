package storesqlite

import (
	"context"
	"testing"
)

func TestRollbackRuntimeSessionInitializationOnlyRemovesEmptyRuntimeShell(t *testing.T) {
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
}
