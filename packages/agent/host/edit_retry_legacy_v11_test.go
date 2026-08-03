package agenthost_test

import (
	"encoding/json"
	"path/filepath"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// TestLegacyTerminalFenceIsMigratedToBlockedLocalReconcile proves that an old
// terminal status never leaves the owning session behind a terminal fence.
// V11 keeps the fence local, changes only the legacy operation to a blocked
// incident, and exposes the read-only reconcile action without probing a
// provider from either the migration or availability read.
func TestLegacyTerminalFenceIsMigratedToBlockedLocalReconcile(t *testing.T) {
	runtime := &hostEditRetryRuntime{}
	host, store, db := openEditRetryRestartFixture(t, filepath.Join(t.TempDir(), "legacy-terminal-fence.db"), runtime, true)
	defer db.Close()
	operationID := prepareFutureDeferredEditRetry(t, nil, store, runtime)
	op, found, err := store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, operationID)
	if err != nil || !found {
		t.Fatalf("operation found=%v error=%v", found, err)
	}
	payload, err := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
	if err != nil {
		t.Fatal(err)
	}
	payload.SagaVersion = 0
	payload.Checkpoint = storesqlite.EditRetryCheckpointRollbackDispatched
	payload.BeforeProviderIDs = []string{"provider-original"}
	payload.ProviderSessionID = "thread-original"
	payloadMap, err := storesqlite.EncodeEditRetryOperationPayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	// Encode intentionally stamps all new payloads as V2. This fixture models
	// the durable JSON written by the pre-V2 implementation instead.
	payloadMap["sagaVersion"] = float64(0)
	payloadJSON, err := json.Marshal(payloadMap)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(t.Context(), `
UPDATE workspace_agent_runtime_operations
SET payload_json=?, status='failed', result='failed', lease_owner=NULL,
    lease_expires_at_unix_ms=NULL, next_attempt_at_unix_ms=NULL,
    completed_at_unix_ms=NULL, last_error='legacy failure'
WHERE workspace_id=? AND operation_id=?;
UPDATE workspace_agent_session_history
SET recovery_state='rollback_pending', operation_id=?
WHERE workspace_id=? AND agent_session_id=?;
DELETE FROM agent_store_schema_migrations
WHERE id='workspace_agent_runtime_operations_v11_edit_retry_protocol_v2'`,
		string(payloadJSON), editRetryRestartRef.WorkspaceID, operationID,
		operationID, editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID,
	); err != nil {
		t.Fatal(err)
	}
	runtime.mu.Lock()
	reads, rollbacks, execs := runtime.historyReads, runtime.rollbackCalls, runtime.execCalls
	runtime.mu.Unlock()
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	migrated, found, err := store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, operationID)
	if err != nil || !found || migrated.Status != storesqlite.RuntimeOperationStatusBlocked || migrated.Result != "" || migrated.LastError != string(storesqlite.EditRetryReasonRecoveryRequired) {
		t.Fatalf("migrated operation=%#v found=%v error=%v", migrated, found, err)
	}
	history, found, err := store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID)
	if err != nil || !found || history.RecoveryState != storesqlite.SessionHistoryRecoveryRequired || history.OperationID != operationID {
		t.Fatalf("migrated history=%#v found=%v error=%v", history, found, err)
	}
	availability, err := host.GetEditRetryAvailability(t.Context(), editRetryRestartRef)
	if err != nil || availability.RecoveryState != agenthost.EditRetryStateRecoveryRequired || availability.ReasonCode != agenthost.EditRetryReasonCodeRecoveryRequired || len(availability.AvailableActions) != 1 || availability.AvailableActions[0] != agenthost.EditRetryRecoveryActionReconcile {
		t.Fatalf("availability=%#v error=%v", availability, err)
	}
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.historyReads != reads || runtime.rollbackCalls != rollbacks || runtime.execCalls != execs {
		t.Fatalf("migration/availability/worker touched provider reads=%d rollback=%d exec=%d", runtime.historyReads-reads, runtime.rollbackCalls-rollbacks, runtime.execCalls-execs)
	}
}
