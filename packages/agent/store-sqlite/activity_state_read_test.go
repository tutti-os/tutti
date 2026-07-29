package storesqlite

import (
	"context"
	"testing"
)

func TestGetAgentStateComposesCanonicalSessionsWithLatestTurns(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	for _, report := range []ActivityStateReport{
		{
			Session: SessionStateReport{
				WorkspaceID: "ws-state", AgentSessionID: "session-with-turn", Kind: SessionKindRoot,
				Origin: "runtime", Provider: "codex", Status: "working", OccurredAtUnixMS: 20,
			},
			Turn: &TurnTransition{
				WorkspaceID: "ws-state", AgentSessionID: "session-with-turn", TurnID: "turn-latest",
				Phase: TurnPhaseRunning, StartedAtUnixMS: 20, OccurredAtUnixMS: 20,
			},
		},
		{
			Session: SessionStateReport{
				WorkspaceID: "ws-state", AgentSessionID: "session-without-turn", Kind: SessionKindRoot,
				Origin: "runtime", Provider: "claude-code", Status: "idle", OccurredAtUnixMS: 10,
			},
		},
	} {
		if _, err := store.ReportActivityState(ctx, report); err != nil {
			t.Fatalf("ReportActivityState(%s) error = %v", report.Session.AgentSessionID, err)
		}
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase, outcome,
  started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-state', 'session-with-turn', 'turn-older', 'settled', 'completed', 1, 1, 1, 1)
`); err != nil {
		t.Fatalf("insert older turn: %v", err)
	}

	state, ok, err := store.GetAgentState(ctx, "  ws-state  ")
	if err != nil || !ok {
		t.Fatalf("GetAgentState() ok=%v error=%v", ok, err)
	}
	if state.WorkspaceID != "ws-state" || len(state.Sessions) != 2 {
		t.Fatalf("GetAgentState() = %#v", state)
	}
	bySessionID := make(map[string]AgentSessionState, len(state.Sessions))
	for _, sessionState := range state.Sessions {
		bySessionID[sessionState.Session.ID] = sessionState
	}
	withTurn := bySessionID["session-with-turn"]
	if withTurn.LatestTurn == nil || withTurn.LatestTurn.TurnID != "turn-latest" {
		t.Fatalf("session-with-turn state = %#v", withTurn)
	}
	withoutTurn := bySessionID["session-without-turn"]
	if withoutTurn.LatestTurn != nil {
		t.Fatalf("session-without-turn state = %#v", withoutTurn)
	}
}

func TestGetAgentStateRejectsBlankWorkspace(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	state, ok, err := store.GetAgentState(context.Background(), "  ")
	if err != nil || ok || len(state.Sessions) != 0 {
		t.Fatalf("GetAgentState(blank) state=%#v ok=%v error=%v", state, ok, err)
	}
}
