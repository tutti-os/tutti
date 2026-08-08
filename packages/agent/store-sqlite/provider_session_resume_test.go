package storesqlite

import (
	"context"
	"testing"
)

func TestGetProviderSessionResumeEvidenceRequiresProviderRootTurn(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")

	evidence, err := store.GetProviderSessionResumeEvidence(ctx, "ws-1", "session-1")
	if err != nil {
		t.Fatalf("empty session evidence: %v", err)
	}
	if evidence.HasTurns || evidence.Established {
		t.Fatalf("empty session evidence = %#v", evidence)
	}

	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase, outcome,
  started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms,
  turn_origin
) VALUES ('ws-1', 'session-1', 'turn-canceled', 'settled', 'canceled', 1, 2, 1, 2, 'user_prompt')
`); err != nil {
		t.Fatalf("insert unestablished turn: %v", err)
	}
	evidence, err = store.GetProviderSessionResumeEvidence(ctx, "ws-1", "session-1")
	if err != nil {
		t.Fatalf("unestablished evidence: %v", err)
	}
	if !evidence.HasTurns || !evidence.HasSettledTurn || evidence.Established {
		t.Fatalf("unestablished evidence = %#v", evidence)
	}

	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET root_provider_turn_id = 'provider-turn-1',
    root_provider_turn_phase = 'completed',
    root_provider_turn_outcome = 'canceled',
    root_provider_turn_updated_at_unix_ms = 2
WHERE workspace_id = 'ws-1' AND agent_session_id = 'session-1' AND turn_id = 'turn-canceled'
`); err != nil {
		t.Fatalf("establish provider turn: %v", err)
	}
	evidence, err = store.GetProviderSessionResumeEvidence(ctx, "ws-1", "session-1")
	if err != nil {
		t.Fatalf("established evidence: %v", err)
	}
	if !evidence.HasTurns || !evidence.HasSettledTurn || !evidence.Established {
		t.Fatalf("established evidence = %#v", evidence)
	}
}

func TestGetProviderSessionResumeEvidenceRetainsHistoricalAcceptedGoal(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-goal", "session-goal")

	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-set", WorkspaceID: "ws-goal", AgentSessionID: "session-goal",
		Action: "set", Objective: "ship", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatalf("prepare Goal: %v", err)
	}
	if _, _, _, err := store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-goal", OperationID: "goal-set", Succeeded: true,
		Observed: map[string]any{"objective": "ship", "status": "active"},
		Evidence: map[string]any{"confidence": "authoritative"}, OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatalf("complete Goal: %v", err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-local-stop", WorkspaceID: "ws-goal", AgentSessionID: "session-goal",
		Action: "clear", OccurredAtUnixMS: 30,
	}); err != nil {
		t.Fatalf("prepare local stop: %v", err)
	}
	if _, _, _, err := store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-goal", OperationID: "goal-local-stop",
		Mode: GoalControlCompletionModeLocalStop, Succeeded: true, OccurredAtUnixMS: 40,
	}); err != nil {
		t.Fatalf("complete local stop: %v", err)
	}

	evidence, err := store.GetProviderSessionResumeEvidence(ctx, "ws-goal", "session-goal")
	if err != nil {
		t.Fatalf("Goal resume evidence: %v", err)
	}
	if evidence.HasTurns || evidence.HasSettledTurn || !evidence.Established {
		t.Fatalf("historical Goal evidence=%#v", evidence)
	}
}
