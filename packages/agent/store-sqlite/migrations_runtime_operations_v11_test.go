package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// TestRuntimeOperationsV11RetiresOnlyProvenPreEffectLegacyEditRetries exercises
// V11 against a real SQLite database that has already run the earlier schema
// migrations. The rows below model pre-V2 payloads added after an older binary
// had recorded its migration ledger; deleting only V11's ledger entry models a
// real upgrade without rebuilding state in memory.
func TestRuntimeOperationsV11RetiresOnlyProvenPreEffectLegacyEditRetries(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	type legacyCase struct {
		name           string
		payloadJSON    string
		initialStatus  string
		wantStatus     string
		wantReadyFence bool
	}
	cases := []legacyCase{
		{name: "missing version prepared", payloadJSON: legacyV11Payload(t, EditRetryCheckpointPrepared), wantStatus: RuntimeOperationStatusCompleted, wantReadyFence: true},
		{name: "zero version prepared", payloadJSON: legacyV11PayloadWithSaga(t, float64(0), EditRetryCheckpointPrepared), wantStatus: RuntimeOperationStatusCompleted, wantReadyFence: true},
		// rollback_aborted is durable evidence that rollback was never
		// dispatched, so the prior source turn remains authoritative.
		{name: "one version rollback aborted", payloadJSON: legacyV11PayloadWithSaga(t, float64(1), EditRetryCheckpointRollbackAborted), wantStatus: RuntimeOperationStatusCompleted, wantReadyFence: true},
		{name: "rollback dispatched", payloadJSON: legacyV11Payload(t, EditRetryCheckpointRollbackDispatched), wantStatus: RuntimeOperationStatusBlocked},
		{name: "rollback confirmed", payloadJSON: legacyV11Payload(t, EditRetryCheckpointRollbackConfirmed), wantStatus: RuntimeOperationStatusBlocked},
		{name: "replacement dispatched", payloadJSON: legacyV11Payload(t, EditRetryCheckpointReplacementDispatched), wantStatus: RuntimeOperationStatusBlocked},
		{name: "unknown checkpoint", payloadJSON: legacyV11Payload(t, EditRetryCheckpoint("unknown")), wantStatus: RuntimeOperationStatusBlocked},
		{name: "missing checkpoint", payloadJSON: `{"clientOperationId":"legacy","editedText":"replacement"}`, wantStatus: RuntimeOperationStatusBlocked},
		{name: "future version", payloadJSON: legacyV11PayloadWithSaga(t, float64(3), EditRetryCheckpointPrepared), wantStatus: RuntimeOperationStatusBlocked},
		{name: "null version", payloadJSON: legacyV11PayloadWithSaga(t, nil, EditRetryCheckpointPrepared), wantStatus: RuntimeOperationStatusBlocked},
		{name: "string version", payloadJSON: legacyV11PayloadWithSaga(t, "1", EditRetryCheckpointPrepared), wantStatus: RuntimeOperationStatusBlocked},
		{name: "fractional version", payloadJSON: legacyV11PayloadWithSaga(t, 1.5, EditRetryCheckpointPrepared), wantStatus: RuntimeOperationStatusBlocked},
		{name: "legacy already blocked", payloadJSON: legacyV11Payload(t, EditRetryCheckpointPrepared), initialStatus: RuntimeOperationStatusBlocked, wantStatus: RuntimeOperationStatusBlocked},
		{name: "failed legacy fence owner", payloadJSON: legacyV11Payload(t, EditRetryCheckpointRollbackDispatched), initialStatus: RuntimeOperationStatusFailed, wantStatus: RuntimeOperationStatusBlocked},
		{name: "completed legacy fence owner", payloadJSON: legacyV11Payload(t, EditRetryCheckpointReplacementDispatched), initialStatus: RuntimeOperationStatusCompleted, wantStatus: RuntimeOperationStatusBlocked},
		{name: "malformed payload", payloadJSON: `{not-json`, wantStatus: RuntimeOperationStatusBlocked},
	}

	operationIDs := make(map[string]string, len(cases))
	for index, testCase := range cases {
		workspaceID := fmt.Sprintf("ws-v11-%d", index)
		sessionID := fmt.Sprintf("session-v11-%d", index)
		suffix := fmt.Sprintf("v11-%d", index)
		seedClaimableEditRetry(t, store, workspaceID, sessionID, "provider-v11", suffix, 10)
		operationID := "edit-retry-" + suffix
		operationIDs[testCase.name] = operationID
		if testCase.name == "malformed payload" {
			// The production schema has long enforced json_valid. Simulate a
			// damaged legacy file deliberately so V11 proves one malformed row
			// cannot poison startup or receive the unsafe prepared default.
			if _, err := store.db.ExecContext(ctx, `PRAGMA ignore_check_constraints=ON`); err != nil {
				t.Fatal(err)
			}
		}
		initialStatus := testCase.initialStatus
		if initialStatus == "" {
			initialStatus = RuntimeOperationStatusPrepared
		}
		initialResult := any(nil)
		initialNextAttempt := any(int64(0))
		initialCompletedAt := any(nil)
		switch initialStatus {
		case RuntimeOperationStatusFailed:
			initialResult = RuntimeOperationResultFailed
			initialNextAttempt = nil
		case RuntimeOperationStatusCompleted:
			initialResult = RuntimeOperationResultApplied
			initialNextAttempt = nil
			initialCompletedAt = int64(9)
		case RuntimeOperationStatusBlocked:
			initialNextAttempt = nil
		}
		if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET payload_json=?, status=?, result=?, lease_owner=NULL,
    lease_expires_at_unix_ms=NULL, next_attempt_at_unix_ms=?, completed_at_unix_ms=?, last_error=''
WHERE workspace_id=? AND operation_id=?`, testCase.payloadJSON, initialStatus, initialResult, initialNextAttempt, initialCompletedAt, workspaceID, operationID); err != nil {
			t.Fatalf("seed %s legacy payload: %v", testCase.name, err)
		}
		if testCase.initialStatus == RuntimeOperationStatusBlocked {
			if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET status='blocked', next_attempt_at_unix_ms=NULL, last_error='legacy blocked state'
WHERE workspace_id=? AND operation_id=?`, workspaceID, operationID); err != nil {
				t.Fatalf("seed %s blocked legacy operation: %v", testCase.name, err)
			}
		}
		if testCase.name == "malformed payload" {
			if _, err := store.db.ExecContext(ctx, `PRAGMA ignore_check_constraints=OFF`); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_session_history
SET recovery_state='recovery_required', operation_id=?
WHERE workspace_id=? AND agent_session_id=?`, operationID, workspaceID, sessionID); err != nil {
			t.Fatalf("seed %s fence: %v", testCase.name, err)
		}
	}

	// An operation ID is globally unique, but session history is not a foreign
	// key. This cross-workspace stale pointer proves V11 clears fences by the
	// exact workspace/session/operation tuple, not merely operation_id.
	seedTurnTestSession(t, store, "ws-v11-other", "session-v11-other")
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_session_history
SET recovery_state='recovery_required', operation_id=?
WHERE workspace_id='ws-v11-other' AND agent_session_id='session-v11-other'`, operationIDs["missing version prepared"]); err != nil {
		t.Fatal(err)
	}

	// Deleted rows are the one deletion-only cleanup path. The live fence with
	// the same non-ready state must remain an incident.
	seedTurnTestSession(t, store, "ws-v11-deleted", "session-v11-deleted")
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions SET deleted_at_unix_ms=99
WHERE workspace_id='ws-v11-deleted' AND agent_session_id='session-v11-deleted';
UPDATE workspace_agent_session_history
SET recovery_state='recovery_required', operation_id='deleted-legacy-owner'
WHERE workspace_id='ws-v11-deleted' AND agent_session_id='session-v11-deleted';
DELETE FROM agent_store_schema_migrations WHERE id=?`, schemaMigrationWorkspaceAgentRuntimeOperationsV11); err != nil {
		t.Fatal(err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("upgrade through V11: %v", err)
	}

	for index, testCase := range cases {
		workspaceID := fmt.Sprintf("ws-v11-%d", index)
		sessionID := fmt.Sprintf("session-v11-%d", index)
		var status, leaseOwner, lastError string
		var leaseExpiry, nextAttempt int64
		if err := store.db.QueryRowContext(ctx, `
SELECT status, COALESCE(lease_owner,''), COALESCE(lease_expires_at_unix_ms,0),
       COALESCE(next_attempt_at_unix_ms,0), last_error
FROM workspace_agent_runtime_operations WHERE workspace_id=? AND operation_id=?`, workspaceID, operationIDs[testCase.name]).Scan(&status, &leaseOwner, &leaseExpiry, &nextAttempt, &lastError); err != nil || status != testCase.wantStatus {
			t.Fatalf("%s status=%q error=%v, want status=%s", testCase.name, status, err, testCase.wantStatus)
		}
		if status == RuntimeOperationStatusBlocked && (leaseOwner != "" || leaseExpiry != 0 || nextAttempt != 0 || lastError != string(EditRetryReasonRecoveryRequired)) {
			t.Fatalf("%s blocked operation retained execution state: lease=%q expiry=%d retry=%d reason=%q", testCase.name, leaseOwner, leaseExpiry, nextAttempt, lastError)
		}
		history, found, err := store.GetSessionHistory(ctx, workspaceID, sessionID)
		if err != nil || !found {
			t.Fatalf("%s history found=%v error=%v", testCase.name, found, err)
		}
		if gotReady := history.RecoveryState == SessionHistoryRecoveryReady && history.OperationID == ""; gotReady != testCase.wantReadyFence {
			t.Fatalf("%s fence=%#v ready=%v, want %v", testCase.name, history, gotReady, testCase.wantReadyFence)
		}
		if status == RuntimeOperationStatusBlocked && (history.RecoveryState != SessionHistoryRecoveryRequired || history.OperationID != operationIDs[testCase.name]) {
			t.Fatalf("%s blocked history=%#v, want exact recovery_required owner", testCase.name, history)
		}
	}
	other, found, err := store.GetSessionHistory(ctx, "ws-v11-other", "session-v11-other")
	if err != nil || !found || other.RecoveryState == SessionHistoryRecoveryReady {
		t.Fatalf("cross-workspace history=%#v found=%v error=%v, want retained fence", other, found, err)
	}
	deleted, found, err := store.GetSessionHistory(ctx, "ws-v11-deleted", "session-v11-deleted")
	if err != nil || !found || deleted.RecoveryState != SessionHistoryRecoveryReady || deleted.OperationID != "" {
		t.Fatalf("deleted history=%#v found=%v error=%v, want cleared fence", deleted, found, err)
	}

	// No zero-version legacy row may ever re-enter scheduler eligibility. This
	// is a database assertion, so it also proves the migration does not rely on
	// a Host/provider call to quarantine the incident.
	claimable, err := store.ListClaimableRuntimeOperations(ctx, ListClaimableRuntimeOperationsInput{NowUnixMS: 100, Limit: 100})
	if err != nil {
		t.Fatalf("list claimable after V11: %v", err)
	}
	for _, operation := range claimable {
		if operation.Kind == RuntimeOperationKindEditRetry {
			t.Fatalf("legacy edit retry returned from claim query: %#v", operation)
		}
	}
	items, count, _, err := store.ListActiveEditRetryDegradations(ctx, 100)
	if err != nil || count != 14 {
		t.Fatalf("active incidents=%#v count=%d error=%v, want thirteen blocked legacy rows plus one orphan fence", items, count, err)
	}
	var orphanFound, deletedFound bool
	for _, item := range items {
		if item.Operation.WorkspaceID == "ws-v11-other" && item.Operation.AgentSessionID == "session-v11-other" {
			orphanFound = item.Invariant && item.OrphanFence
		}
		if item.Operation.WorkspaceID == "ws-v11-deleted" {
			deletedFound = true
		}
	}
	if !orphanFound || deletedFound {
		t.Fatalf("orphan=%v deleted=%v active incidents=%#v", orphanFound, deletedFound, items)
	}
	// The query is a second execution guard in addition to V11. Even a
	// hand-carried zero-version prepared row added after upgrade is never
	// scheduler eligible (and a future saga constant is bound as a query
	// argument rather than copied as a SQL literal).
	seedClaimableEditRetry(t, store, "ws-v11-query", "session-v11-query", "provider-v11", "v11-query", 20)
	seedClaimableEditRetry(t, store, "ws-v11-future-query", "session-v11-future-query", "provider-v11", "v11-future-query", 20)
	seedClaimableEditRetry(t, store, "ws-v11-malformed-query", "session-v11-malformed-query", "provider-v11", "v11-malformed-query", 20)
	seedClaimableEditRetry(t, store, "ws-v11-current", "session-v11-current", "provider-v11", "v11-current", 20)
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET payload_json=?, status='prepared', next_attempt_at_unix_ms=1
WHERE workspace_id='ws-v11-query' AND operation_id='edit-retry-v11-query'`, legacyV11Payload(t, EditRetryCheckpointPrepared)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET payload_json=?, status='prepared', next_attempt_at_unix_ms=1
WHERE workspace_id='ws-v11-future-query' AND operation_id='edit-retry-v11-future-query'`, legacyV11PayloadWithSaga(t, float64(3), EditRetryCheckpointPrepared)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `PRAGMA ignore_check_constraints=ON`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET payload_json='{not-json', status='prepared', next_attempt_at_unix_ms=1
WHERE workspace_id='ws-v11-malformed-query' AND operation_id='edit-retry-v11-malformed-query'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `PRAGMA ignore_check_constraints=OFF`); err != nil {
		t.Fatal(err)
	}
	claimable, err = store.ListClaimableEditRetryOperations(ctx, ListClaimableRuntimeOperationsInput{NowUnixMS: 100, Limit: 100})
	if err != nil {
		t.Fatalf("list claimable zero-version row: %v", err)
	}
	var currentClaimed bool
	for _, operation := range claimable {
		if operation.OperationID == "edit-retry-v11-query" ||
			operation.OperationID == "edit-retry-v11-future-query" ||
			operation.OperationID == "edit-retry-v11-malformed-query" {
			t.Fatalf("non-V2 edit retry returned from claim query: %#v", operation)
		}
		if operation.OperationID == "edit-retry-v11-current" {
			payload, decodeErr := DecodeEditRetryOperationPayload(operation.Payload)
			currentClaimed = decodeErr == nil && payload.SagaVersion == EditRetrySagaVersionCurrent
		}
	}
	if !currentClaimed {
		t.Fatalf("current V%d edit retry was not returned from edit-retry claim query: %#v", EditRetrySagaVersionCurrent, claimable)
	}

	// V11 remains an idempotent recorded migration on every restart/reopen.
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("replay V11 migration: %v", err)
	}
}

func legacyV11Payload(t *testing.T, checkpoint EditRetryCheckpoint) string {
	t.Helper()
	return legacyV11PayloadWithOptionalSaga(t, nil, false, checkpoint)
}

func legacyV11PayloadWithSaga(t *testing.T, sagaVersion any, checkpoint EditRetryCheckpoint) string {
	t.Helper()
	return legacyV11PayloadWithOptionalSaga(t, sagaVersion, true, checkpoint)
}

func legacyV11PayloadWithOptionalSaga(t *testing.T, sagaVersion any, includeSaga bool, checkpoint EditRetryCheckpoint) string {
	t.Helper()
	payload := map[string]any{
		"clientOperationId": "legacy-client",
		"editedText":        "legacy replacement",
		"replacementTurnId": "legacy-replacement",
		"clientSubmitId":    "edit-retry:legacy",
		"step":              checkpoint,
	}
	if includeSaga {
		payload["sagaVersion"] = sagaVersion
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestRuntimeOperationsV11LeavesV2RowsBitForBitUntouchedAndClaimable(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := t.Context()
	seedClaimableEditRetry(t, store, "ws-v11-v2", "session-v11-v2", "provider-v2", "v2", 10)
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET result='abandoned', last_error='edit_retry_protocol_retired'
WHERE workspace_id='ws-v11-v2' AND operation_id='edit-retry-v2';
UPDATE workspace_agent_session_history
SET recovery_state='recovery_required', operation_id='edit-retry-v2'
WHERE workspace_id='ws-v11-v2' AND agent_session_id='session-v11-v2'`); err != nil {
		t.Fatal(err)
	}
	before := snapshotV11Operation(t, store, "ws-v11-v2", "edit-retry-v2")
	beforeHistory := snapshotV11History(t, store, "ws-v11-v2", "session-v11-v2")
	armV11Migration(t, store)
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("upgrade V2 row through V11: %v", err)
	}
	if after := snapshotV11Operation(t, store, "ws-v11-v2", "edit-retry-v2"); after != before {
		t.Fatalf("V2 operation changed by V11:\n got %#v\nwant %#v", after, before)
	}
	if after := snapshotV11History(t, store, "ws-v11-v2", "session-v11-v2"); after != beforeHistory {
		t.Fatalf("V2 history changed by V11:\n got %#v\nwant %#v", after, beforeHistory)
	}
	claimable, err := store.ListClaimableEditRetryOperations(ctx, ListClaimableRuntimeOperationsInput{NowUnixMS: 100, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	for _, operation := range claimable {
		if operation.OperationID == "edit-retry-v2" {
			return
		}
	}
	t.Fatalf("V2 operation absent from edit-retry claim query: %#v", claimable)
}

func TestRuntimeOperationsV11RollsBackOnFailure(t *testing.T) {
	for _, failure := range []struct {
		name, triggerSQL, needle string
	}{
		{"operation update", `CREATE TRIGGER v11_fail_operation_update BEFORE UPDATE ON workspace_agent_runtime_operations WHEN OLD.operation_id = 'edit-retry-failure' BEGIN SELECT RAISE(ABORT, 'v11 operation update failure'); END;`, "v11 operation update failure"},
		{"migration ledger", `CREATE TRIGGER v11_fail_migration_ledger BEFORE INSERT ON agent_store_schema_migrations WHEN NEW.id = 'workspace_agent_runtime_operations_v11_edit_retry_protocol_v2' BEGIN SELECT RAISE(ABORT, 'v11 migration ledger failure'); END;`, "v11 migration ledger failure"},
	} {
		t.Run(failure.name, func(t *testing.T) {
			store := openTestStore(t, testOptions(&staticProjectPaths{}))
			ctx := t.Context()
			seedV11LegacyOperation(t, store, "failure", legacyV11Payload(t, EditRetryCheckpointPrepared), RuntimeOperationStatusPrepared)
			armV11Migration(t, store)
			beforeOperation := snapshotV11Operation(t, store, "ws-v11-failure", "edit-retry-failure")
			beforeHistory := snapshotV11History(t, store, "ws-v11-failure", "session-v11-failure")
			if _, err := store.db.ExecContext(ctx, failure.triggerSQL); err != nil {
				t.Fatal(err)
			}
			if err := store.Migrate(ctx); err == nil || !strings.Contains(err.Error(), failure.needle) {
				t.Fatalf("Migrate() error=%v, want trigger %q", err, failure.needle)
			}
			if after := snapshotV11Operation(t, store, "ws-v11-failure", "edit-retry-failure"); after != beforeOperation {
				t.Fatalf("operation partially committed after %s", failure.name)
			}
			if after := snapshotV11History(t, store, "ws-v11-failure", "session-v11-failure"); after != beforeHistory {
				t.Fatalf("fence partially committed after %s", failure.name)
			}
			if v11MigrationRecorded(t, store) {
				t.Fatalf("V11 ledger recorded after %s rollback", failure.name)
			}
			if _, err := store.db.ExecContext(ctx, `DROP TRIGGER `+triggerNameForV11Failure(failure.name)); err != nil {
				t.Fatal(err)
			}
			if err := store.Migrate(ctx); err != nil {
				t.Fatalf("retry V11 after %s: %v", failure.name, err)
			}
			if operation := snapshotV11Operation(t, store, "ws-v11-failure", "edit-retry-failure"); operation.Status != RuntimeOperationStatusCompleted || operation.Result != RuntimeOperationResultAbandoned {
				t.Fatalf("retry did not terminalize proven pre-effect row: %#v", operation)
			}
		})
	}
}

func TestRuntimeOperationsV11IsStableAcrossFileReopen(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedV11LegacyOperation(t, store, "reopen", legacyV11Payload(t, EditRetryCheckpointRollbackDispatched), RuntimeOperationStatusPrepared)
	armV11Migration(t, store)
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	wantOperation := snapshotV11Operation(t, store, "ws-v11-reopen", "edit-retry-reopen")
	wantHistory := snapshotV11History(t, store, "ws-v11-reopen", "session-v11-reopen")
	for reopen := 0; reopen < 2; reopen++ {
		store = reopenV11Store(t, store)
		if operation := snapshotV11Operation(t, store, "ws-v11-reopen", "edit-retry-reopen"); operation != wantOperation {
			t.Fatalf("reopen %d operation=%#v, want %#v", reopen+1, operation, wantOperation)
		}
		if history := snapshotV11History(t, store, "ws-v11-reopen", "session-v11-reopen"); history != wantHistory {
			t.Fatalf("reopen %d history=%#v, want %#v", reopen+1, history, wantHistory)
		}
	}
}

type v11OperationSnapshot struct {
	Status, Result, Payload, LeaseOwner, LastError string
	LeaseExpiry, NextAttempt, Version, CompletedAt int64
	Attempt                                        int
}

func snapshotV11Operation(t *testing.T, store *Store, workspaceID, operationID string) v11OperationSnapshot {
	t.Helper()
	var snapshot v11OperationSnapshot
	if err := store.db.QueryRowContext(t.Context(), `
SELECT status, COALESCE(result,''), payload_json, COALESCE(lease_owner,''), COALESCE(lease_expires_at_unix_ms,0), COALESCE(next_attempt_at_unix_ms,0), attempt, version, last_error, COALESCE(completed_at_unix_ms,0)
FROM workspace_agent_runtime_operations WHERE workspace_id=? AND operation_id=?`, workspaceID, operationID).Scan(&snapshot.Status, &snapshot.Result, &snapshot.Payload, &snapshot.LeaseOwner, &snapshot.LeaseExpiry, &snapshot.NextAttempt, &snapshot.Attempt, &snapshot.Version, &snapshot.LastError, &snapshot.CompletedAt); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

type v11HistorySnapshot struct {
	RecoveryState, OperationID string
	Revision, UpdatedAt        int64
}

func snapshotV11History(t *testing.T, store *Store, workspaceID, sessionID string) v11HistorySnapshot {
	t.Helper()
	var snapshot v11HistorySnapshot
	if err := store.db.QueryRowContext(t.Context(), `SELECT recovery_state, operation_id, history_revision, updated_at_unix_ms FROM workspace_agent_session_history WHERE workspace_id=? AND agent_session_id=?`, workspaceID, sessionID).Scan(&snapshot.RecoveryState, &snapshot.OperationID, &snapshot.Revision, &snapshot.UpdatedAt); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func seedV11LegacyOperation(t *testing.T, store *Store, suffix, payloadJSON, status string) {
	t.Helper()
	workspaceID, sessionID := "ws-v11-"+suffix, "session-v11-"+suffix
	seedClaimableEditRetry(t, store, workspaceID, sessionID, "provider-v11", suffix, 10)
	nextAttempt := any(int64(0))
	if status == RuntimeOperationStatusBlocked {
		nextAttempt = nil
	}
	if _, err := store.db.ExecContext(t.Context(), `UPDATE workspace_agent_runtime_operations SET payload_json=?, status=?, result=NULL, lease_owner=NULL, lease_expires_at_unix_ms=NULL, next_attempt_at_unix_ms=?, last_error='' WHERE workspace_id=? AND operation_id=?`, payloadJSON, status, nextAttempt, workspaceID, "edit-retry-"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(t.Context(), `UPDATE workspace_agent_session_history SET recovery_state='recovery_required', operation_id=? WHERE workspace_id=? AND agent_session_id=?`, "edit-retry-"+suffix, workspaceID, sessionID); err != nil {
		t.Fatal(err)
	}
}

func armV11Migration(t *testing.T, store *Store) {
	t.Helper()
	if _, err := store.db.ExecContext(t.Context(), `DELETE FROM agent_store_schema_migrations WHERE id=?`, schemaMigrationWorkspaceAgentRuntimeOperationsV11); err != nil {
		t.Fatal(err)
	}
}

func v11MigrationRecorded(t *testing.T, store *Store) bool {
	t.Helper()
	var count int
	if err := store.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM agent_store_schema_migrations WHERE id=?`, schemaMigrationWorkspaceAgentRuntimeOperationsV11).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count != 0
}

func triggerNameForV11Failure(name string) string {
	if name == "operation update" {
		return "v11_fail_operation_update"
	}
	return "v11_fail_migration_ledger"
}

func reopenV11Store(t *testing.T, store *Store) *Store {
	t.Helper()
	path := sqliteTestDatabasePath(t, store.db)
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	for _, pragma := range []string{"PRAGMA busy_timeout = 5000", "PRAGMA foreign_keys = ON", "PRAGMA journal_mode = WAL"} {
		if _, err := db.ExecContext(t.Context(), pragma); err != nil {
			t.Fatal(err)
		}
	}
	reopened := New(db, testOptions(&staticProjectPaths{}))
	if err := reopened.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	return reopened
}
