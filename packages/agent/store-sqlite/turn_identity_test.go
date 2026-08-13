package storesqlite

import (
	"context"
	"errors"
	"testing"
)

func TestBindTurnIdentityAnchorFlattensAndPreservesIdentity(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedTurnTestSession(t, store, "ws-1", "session-1")
	if _, err := store.db.Exec(`
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, identity_anchor_turn_id, phase,
  started_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES
  ('ws-1', 'session-1', 'root-turn', NULL, 'submitted', 1, 1, 1),
  ('ws-1', 'session-1', 'intermediate-turn', 'root-turn', 'submitted', 2, 2, 2),
  ('ws-1', 'session-1', 'child-turn', NULL, 'submitted', 3, 3, 3),
  ('ws-1', 'session-1', 'other-turn', NULL, 'submitted', 4, 4, 4)
`); err != nil {
		t.Fatal(err)
	}
	tx, err := store.db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	turn, changed, err := bindTurnIdentityAnchorTx(
		context.Background(), tx, "ws-1", "session-1", "child-turn", "intermediate-turn", 10,
	)
	if err != nil || !changed || turn.IdentityAnchorTurnID != "root-turn" {
		_ = tx.Rollback()
		t.Fatalf("bind flattened identity anchor: turn=%#v changed=%v error=%v", turn, changed, err)
	}
	turn, changed, err = bindTurnIdentityAnchorTx(
		context.Background(), tx, "ws-1", "session-1", "child-turn", "root-turn", 11,
	)
	if err != nil || changed || turn.IdentityAnchorTurnID != "root-turn" {
		_ = tx.Rollback()
		t.Fatalf("repeat identity anchor: turn=%#v changed=%v error=%v", turn, changed, err)
	}
	if _, _, err := bindTurnIdentityAnchorTx(
		context.Background(), tx, "ws-1", "session-1", "child-turn", "other-turn", 12,
	); !errors.Is(err, ErrTurnIdentityAnchorConflict) {
		_ = tx.Rollback()
		t.Fatalf("identity anchor rewrite error = %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func TestTurnIdentityAnchorMigrationBackfillsOnlyProvenContinuation(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedTurnTestSession(t, store, "ws-1", "session-1")
	if _, err := store.db.Exec(`
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase,
  started_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES
  ('ws-1', 'session-1', 'plan-turn', 'submitted', 1, 1, 1),
  ('ws-1', 'session-1', 'implementation-turn', 'submitted', 2, 2, 2),
  ('ws-1', 'session-1', 'unproven-turn', 'submitted', 3, 3, 3);

INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, turn_id, role, kind,
  status, payload_json, occurred_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (
  'ws-1', 'session-1', 'implementation-submit', 1, 'implementation-turn',
  'user', 'text', 'completed', '{"clientSubmitId":"plan-decision:operation-1"}', 4, 4, 4
);

INSERT INTO workspace_agent_runtime_operations (
  operation_id, workspace_id, agent_session_id, kind, status, result,
  turn_id, request_id, payload_json, attempt, version, last_error,
  created_at_unix_ms, updated_at_unix_ms, completed_at_unix_ms
) VALUES (
  'operation-1', 'ws-1', 'session-1', 'plan_decision', 'completed', 'applied',
  'plan-turn', 'plan-turn',
  '{"promptKind":"plan-implementation","action":"implement","idempotencyKey":"decision-1","step":"send_confirmed","clientSubmitId":"plan-decision:operation-1","confirmedTurnId":"implementation-turn"}',
  1, 1, '', 5, 6, 6
);

DELETE FROM agent_store_schema_migrations
WHERE id = 'workspace_agent_turn_identity_anchor_v1';
`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentTurnIdentityAnchorV1(context.Background()); err != nil {
		t.Fatal(err)
	}
	var implementationAnchor, unprovenAnchor string
	if err := store.db.QueryRow(`
SELECT COALESCE(identity_anchor_turn_id, '')
FROM workspace_agent_turns
WHERE workspace_id='ws-1' AND agent_session_id='session-1' AND turn_id='implementation-turn'
`).Scan(&implementationAnchor); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`
SELECT COALESCE(identity_anchor_turn_id, '')
FROM workspace_agent_turns
WHERE workspace_id='ws-1' AND agent_session_id='session-1' AND turn_id='unproven-turn'
`).Scan(&unprovenAnchor); err != nil {
		t.Fatal(err)
	}
	if implementationAnchor != "plan-turn" || unprovenAnchor != "" {
		t.Fatalf("migration anchors: implementation=%q unproven=%q", implementationAnchor, unprovenAnchor)
	}
}

func TestTurnIdentityAnchorMigrationTopologicallyFlattensContinuationChain(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedTurnTestSession(t, store, "ws-1", "session-1")
	if _, err := store.db.Exec(`
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase,
  started_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES
  ('ws-1', 'session-1', 'turn-a', 'submitted', 1, 1, 1),
  ('ws-1', 'session-1', 'turn-b', 'submitted', 2, 2, 2),
  ('ws-1', 'session-1', 'turn-c', 'submitted', 3, 3, 3);

INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, turn_id, role, kind,
  status, payload_json, occurred_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES
  ('ws-1', 'session-1', 'submit-b', 1, 'turn-b', 'user', 'text', 'completed',
   '{"clientSubmitId":"plan-decision:operation-z-parent"}', 4, 4, 4),
  ('ws-1', 'session-1', 'submit-c', 2, 'turn-c', 'user', 'text', 'completed',
   '{"clientSubmitId":"plan-decision:operation-a-descendant"}', 5, 5, 5);

INSERT INTO workspace_agent_runtime_operations (
  operation_id, workspace_id, agent_session_id, kind, status, result,
  turn_id, request_id, payload_json, attempt, version, last_error,
  created_at_unix_ms, updated_at_unix_ms, completed_at_unix_ms
) VALUES
  ('operation-z-parent', 'ws-1', 'session-1', 'plan_decision', 'completed', 'applied',
   'turn-a', 'turn-a',
   '{"promptKind":"plan-implementation","action":"implement","idempotencyKey":"decision-parent","step":"send_confirmed","clientSubmitId":"plan-decision:operation-z-parent","confirmedTurnId":"turn-b"}',
   1, 1, '', 6, 7, 10),
  ('operation-a-descendant', 'ws-1', 'session-1', 'plan_decision', 'completed', 'applied',
   'turn-b', 'turn-b',
   '{"promptKind":"plan-implementation","action":"implement","idempotencyKey":"decision-descendant","step":"send_confirmed","clientSubmitId":"plan-decision:operation-a-descendant","confirmedTurnId":"turn-c"}',
   1, 1, '', 8, 9, 10);

DELETE FROM agent_store_schema_migrations
WHERE id = 'workspace_agent_turn_identity_anchor_v1';
`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentTurnIdentityAnchorV1(context.Background()); err != nil {
		t.Fatal(err)
	}

	for _, expectation := range []struct {
		turnID     string
		wantAnchor string
	}{
		{turnID: "turn-b", wantAnchor: "turn-a"},
		{turnID: "turn-c", wantAnchor: "turn-a"},
	} {
		var anchor string
		if err := store.db.QueryRow(`
SELECT COALESCE(identity_anchor_turn_id, '')
FROM workspace_agent_turns
WHERE workspace_id='ws-1' AND agent_session_id='session-1' AND turn_id=?
`, expectation.turnID).Scan(&anchor); err != nil {
			t.Fatal(err)
		}
		if anchor != expectation.wantAnchor {
			t.Fatalf("turn %s identity anchor = %q, want %q", expectation.turnID, anchor, expectation.wantAnchor)
		}
	}
}

func TestOrderHistoricalTurnIdentityAnchorRepairsRejectsCycle(t *testing.T) {
	t.Parallel()
	_, err := orderHistoricalTurnIdentityAnchorRepairs([]historicalTurnIdentityAnchor{
		{workspaceID: "ws-1", agentSessionID: "session-1", turnID: "turn-a", anchorTurnID: "turn-b"},
		{workspaceID: "ws-1", agentSessionID: "session-1", turnID: "turn-b", anchorTurnID: "turn-a"},
	})
	if !errors.Is(err, ErrTurnIdentityAnchorConflict) {
		t.Fatalf("cycle error = %v, want %v", err, ErrTurnIdentityAnchorConflict)
	}
}
