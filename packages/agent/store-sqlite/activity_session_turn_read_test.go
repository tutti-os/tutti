package storesqlite

import (
	"context"
	"testing"
)

func TestGetSessionAndTurnUsesOneCanonicalSnapshot(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-snapshot", "session-snapshot")

	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-snapshot", AgentSessionID: "session-snapshot", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 10,
	}); err != nil || !accepted {
		t.Fatalf("record running turn accepted=%v error=%v", accepted, err)
	}
	session, turn, found, err := store.GetSessionAndTurn(ctx, "ws-snapshot", "session-snapshot", "turn-1")
	if err != nil || !found {
		t.Fatalf("GetSessionAndTurn() found=%v error=%v", found, err)
	}
	if session.ActiveTurnID != turn.TurnID || turn.Phase != TurnPhaseRunning {
		t.Fatalf("live snapshot session=%#v turn=%#v", session, turn)
	}

	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-snapshot", AgentSessionID: "session-snapshot", TurnID: "turn-1",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 20,
	}); err != nil || !accepted {
		t.Fatalf("record settled turn accepted=%v error=%v", accepted, err)
	}
	session, turn, found, err = store.GetSessionAndTurn(ctx, "ws-snapshot", "session-snapshot", "turn-1")
	if err != nil || !found {
		t.Fatalf("GetSessionAndTurn() terminal found=%v error=%v", found, err)
	}
	if session.ActiveTurnID != "" || turn.Phase != TurnPhaseSettled || turn.Outcome != TurnOutcomeCompleted {
		t.Fatalf("terminal snapshot session=%#v turn=%#v", session, turn)
	}
}
