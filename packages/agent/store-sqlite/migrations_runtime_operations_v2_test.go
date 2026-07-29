package storesqlite

import (
	"context"
	"testing"
)

func TestRuntimeOperationsV2UpgradesV1DataAndConstraints(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.db.Exec(`
DROP TABLE workspace_agent_runtime_operation_events;
DROP TABLE workspace_agent_runtime_operations;
DELETE FROM agent_store_schema_migrations
WHERE id IN ('workspace_agent_runtime_operations_v1', 'workspace_agent_runtime_operations_v2', 'workspace_agent_runtime_operations_v3', 'workspace_agent_runtime_operations_v4');
`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentRuntimeOperationsV1(ctx); err != nil {
		t.Fatal(err)
	}
	seedRuntimeInteractiveSubject(t, store, "session-1", "turn-1", "request-1")
	if _, err := store.db.Exec(`
INSERT INTO workspace_agent_runtime_operations (
  operation_id, workspace_id, agent_session_id, kind, status, subject_id, turn_id,
  request_id, payload_json, next_attempt_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES
  ('interactive-1', 'ws-1', 'session-1', 'interactive_response', 'prepared', 'request-1', 'turn-1',
   'request-1', '{"answer":"yes"}', 10, 10, 10),
  ('cancel-1', 'ws-1', 'session-1', 'cancel_turn', 'prepared', 'turn-1', 'turn-1',
   NULL, '{"rootAgentSessionId":"session-1","targets":[{"agentSessionId":"session-1","turnId":"turn-1"}]}', 10, 10, 10)
`); err != nil {
		t.Fatalf("seed v1 operations: %v", err)
	}
	if _, err := store.db.Exec(`
INSERT INTO workspace_agent_runtime_operation_events (
  operation_id, workspace_id, agent_session_id, kind, payload_json, created_at_unix_ms
) VALUES
  ('interactive-1', 'ws-1', 'session-1', 'interactive_completed', '{}', 11),
  ('cancel-1', 'ws-1', 'session-1', 'turn_canceled', '{}', 12)
`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentRuntimeOperationsV2(ctx); err != nil {
		t.Fatal(err)
	}
	op, found, err := store.GetRuntimeOperation(ctx, "ws-1", "interactive-1")
	if err != nil || !found || op.Kind != RuntimeOperationKindInteractiveResponse || op.RequestID != "request-1" {
		t.Fatalf("operation=%#v found=%v err=%v", op, found, err)
	}
	cancelOperation, found, err := store.GetRuntimeOperation(ctx, "ws-1", "cancel-1")
	if err != nil || !found || cancelOperation.Kind != RuntimeOperationKindCancelTurn || cancelOperation.TurnID != "turn-1" {
		t.Fatalf("cancel operation=%#v found=%v err=%v", cancelOperation, found, err)
	}
	events, err := store.ListPendingRuntimeOperationEvents(ctx, "ws-1", 10)
	if err != nil || len(events) != 2 || events[0].OperationID != "interactive-1" || events[1].OperationID != "cancel-1" {
		t.Fatalf("events=%#v err=%v", events, err)
	}
	var migrationCount int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM agent_store_schema_migrations WHERE id = ?`, schemaMigrationWorkspaceAgentRuntimeOperationsV2).Scan(&migrationCount); err != nil || migrationCount != 1 {
		t.Fatalf("migration count=%d err=%v", migrationCount, err)
	}
	var indexCount int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_workspace_agent_runtime_operations_claimable'`).Scan(&indexCount); err != nil || indexCount != 1 {
		t.Fatalf("claimable index count=%d err=%v", indexCount, err)
	}
	seedPlanDecisionSubject(t, store, "session-2", "plan-turn")
	if _, err := store.db.Exec(`
INSERT INTO workspace_agent_runtime_operations (
 operation_id, workspace_id, agent_session_id, kind, status, subject_id, turn_id,
 request_id, payload_json, next_attempt_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES ('plan-op', 'ws-1', 'session-2', 'plan_decision', 'prepared', 'plan-turn',
 'plan-turn', 'plan-turn', '{"promptKind":"plan-implementation","action":"implement","idempotencyKey":"decision-1","clientSubmitId":"plan-decision:plan-op","step":"prepared"}', 20, 20, 20)
`); err != nil {
		t.Fatalf("seed valid v2 plan operation: %v", err)
	}
	if _, err := store.db.Exec(`
INSERT INTO workspace_agent_runtime_operations (
 operation_id, workspace_id, agent_session_id, kind, status, subject_id, turn_id,
 request_id, payload_json, next_attempt_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES ('invalid-plan', 'ws-1', 'session-2', 'plan_decision', 'prepared', 'plan-turn',
 'plan-turn', 'plan-turn', '{"promptKind":"plan-implementation","action":"deny","idempotencyKey":"x","clientSubmitId":"plan-decision:invalid-plan","step":"prepared"}', 20, 20, 20)
`); err == nil {
		t.Fatal("invalid plan payload bypassed v2 CHECK")
	}
	var foreignKeyCount int
	rows, err := store.db.Query(`PRAGMA foreign_key_list(workspace_agent_runtime_operations)`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		foreignKeyCount++
	}
	_ = rows.Close()
	if foreignKeyCount < 2 {
		t.Fatalf("foreign keys=%d, want session and turn", foreignKeyCount)
	}
	if err := store.applyWorkspaceAgentRuntimeOperationsV3(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`
INSERT INTO workspace_agent_runtime_operation_events (
  operation_id, workspace_id, agent_session_id, kind, payload_json, created_at_unix_ms
) VALUES
  ('plan-op', 'ws-1', 'session-2', 'plan_decision_pending_confirmation', '{}', 21),
  ('plan-op', 'ws-1', 'session-2', 'plan_decision_completed', '{}', 22)
`); err != nil {
		t.Fatalf("v3 two-stage plan events: %v", err)
	}
	var v3Count int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM agent_store_schema_migrations WHERE id = ?`, schemaMigrationWorkspaceAgentRuntimeOperationsV3).Scan(&v3Count); err != nil || v3Count != 1 {
		t.Fatalf("v3 migration count=%d err=%v", v3Count, err)
	}
	if _, err := store.db.Exec(`UPDATE workspace_agent_runtime_operations SET attempt = 3, version = 4, last_error = 'retry me', updated_at_unix_ms = 25 WHERE operation_id = 'interactive-1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE workspace_agent_runtime_operation_events SET published_at_unix_ms = 23 WHERE operation_id = 'interactive-1'`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentRuntimeOperationsV4(ctx); err != nil {
		t.Fatal(err)
	}
	var subjectColumnCount int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('workspace_agent_runtime_operations') WHERE name = 'subject_id'`).Scan(&subjectColumnCount); err != nil || subjectColumnCount != 0 {
		t.Fatalf("subject_id column count=%d err=%v", subjectColumnCount, err)
	}
	var operationCount, eventCount int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM workspace_agent_runtime_operations`).Scan(&operationCount); err != nil || operationCount != 3 {
		t.Fatalf("operation count=%d err=%v", operationCount, err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM workspace_agent_runtime_operation_events`).Scan(&eventCount); err != nil || eventCount != 4 {
		t.Fatalf("event count=%d err=%v", eventCount, err)
	}
	var attempt, version int
	var lastError string
	var updatedAt int64
	if err := store.db.QueryRow(`SELECT attempt, version, last_error, updated_at_unix_ms FROM workspace_agent_runtime_operations WHERE operation_id = 'interactive-1'`).Scan(&attempt, &version, &lastError, &updatedAt); err != nil || attempt != 3 || version != 4 || lastError != "retry me" || updatedAt != 25 {
		t.Fatalf("preserved operation fields attempt=%d version=%d lastError=%q updatedAt=%d err=%v", attempt, version, lastError, updatedAt, err)
	}
	var publishedAt int64
	if err := store.db.QueryRow(`SELECT published_at_unix_ms FROM workspace_agent_runtime_operation_events WHERE operation_id = 'interactive-1'`).Scan(&publishedAt); err != nil || publishedAt != 23 {
		t.Fatalf("preserved event publishedAt=%d err=%v", publishedAt, err)
	}
}
