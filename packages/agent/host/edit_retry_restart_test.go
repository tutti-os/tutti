package agenthost_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

var editRetryRestartRef = agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}

func TestEditRetryRealSQLiteColdRestartsDoNotMutateProviders(t *testing.T) {
	testCases := []struct {
		name                   string
		prepare                func(*testing.T, *agenthost.Host, *storesqlite.Store, *hostEditRetryRuntime) string
		wantStatus             string
		wantRollback, wantExec int
	}{
		{"deferred prepared operation remains parked before retry time", prepareFutureDeferredEditRetry, storesqlite.RuntimeOperationStatusPrepared, 0, 0},
		{"unknown rollback is never replayed", func(t *testing.T, host *agenthost.Host, _ *storesqlite.Store, runtime *hostEditRetryRuntime) string {
			runtime.mu.Lock()
			runtime.rollbackUnknown = true
			runtime.mu.Unlock()
			result, err := host.EditRetry(t.Context(), editRetryRestartRef, "turn-original", agenthost.EditRetryInput{EditedText: "edited", ClientOperationID: "restart-rollback", ExpectedHistoryRevision: 0})
			if !errors.Is(err, agenthost.ErrEditRetryInProgress) {
				t.Fatalf("EditRetry() error = %v", err)
			}
			return result.OperationID
		}, storesqlite.RuntimeOperationStatusPrepared, 1, 0},
		{"unknown replacement is never resent", func(t *testing.T, host *agenthost.Host, _ *storesqlite.Store, runtime *hostEditRetryRuntime) string {
			runtime.mu.Lock()
			runtime.execOutcomeUnknown = true
			runtime.mu.Unlock()
			result, err := host.EditRetry(t.Context(), editRetryRestartRef, "turn-original", agenthost.EditRetryInput{EditedText: "edited", ClientOperationID: "restart-replacement", ExpectedHistoryRevision: 0})
			if !errors.Is(err, agenthost.ErrEditRetryRecoveryRequired) {
				t.Fatalf("EditRetry() error = %v", err)
			}
			return result.OperationID
		}, storesqlite.RuntimeOperationStatusBlocked, 1, 1},
	}
	for _, test := range testCases {
		t.Run(test.name, func(t *testing.T) {
			dbPath := filepath.Join(t.TempDir(), "restart.db")
			runtime := &hostEditRetryRuntime{}
			host, store, db := openEditRetryRestartFixture(t, dbPath, runtime, true)
			operationID := test.prepare(t, host, store, runtime)
			assertEditRetryRestartSnapshot(t, store, operationID, test.wantStatus)
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			for restart := 0; restart < 3; restart++ {
				host, store, db = openEditRetryRestartFixture(t, dbPath, runtime, false)
				if err := host.RecoverCore(t.Context()); err != nil {
					t.Fatalf("restart %d RecoverCore() = %v", restart+1, err)
				}
				assertEditRetryRestartSnapshot(t, store, operationID, test.wantStatus)
				if err := db.Close(); err != nil {
					t.Fatal(err)
				}
			}
			runtime.mu.Lock()
			defer runtime.mu.Unlock()
			if runtime.rollbackCalls != test.wantRollback || runtime.execCalls != test.wantExec {
				t.Fatalf("provider calls rollback=%d exec=%d, want %d/%d", runtime.rollbackCalls, runtime.execCalls, test.wantRollback, test.wantExec)
			}
		})
	}
}

func TestRuntimeOperationHealthBlockedEditRetrySurvivesSQLiteReopenWithoutProviderCalls(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "blocked-health.db")
	runtime := &hostEditRetryRuntime{rollbackUnknown: true}
	host, store, db := openEditRetryRestartFixture(t, dbPath, runtime, true)
	result, err := host.EditRetry(t.Context(), editRetryRestartRef, "turn-original", agenthost.EditRetryInput{EditedText: "edited", ClientOperationID: "blocked-health", ExpectedHistoryRevision: 0})
	if !errors.Is(err, agenthost.ErrEditRetryInProgress) || result.OperationID == "" {
		t.Fatalf("EditRetry result=%#v error=%v", result, err)
	}
	op, found, err := store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, result.OperationID)
	if err != nil || !found {
		t.Fatalf("operation found=%v error=%v", found, err)
	}
	now := time.Now().UnixMilli()
	_, claimed, err := store.ClaimRuntimeOperationLease(t.Context(), storesqlite.ClaimRuntimeOperationLeaseInput{WorkspaceID: op.WorkspaceID, OperationID: op.OperationID, LeaseOwner: "health-block", NowUnixMS: op.NextAttemptAtMS, LeaseExpiresAtMS: op.NextAttemptAtMS + 60_000})
	if err != nil || !claimed {
		t.Fatalf("claim unknown operation claimed=%v error=%v", claimed, err)
	}
	if _, changed, err := store.BlockEditRetry(t.Context(), storesqlite.BlockEditRetryInput{WorkspaceID: op.WorkspaceID, OperationID: op.OperationID, LeaseOwner: "health-block", ReasonCode: storesqlite.EditRetryReasonProviderOutcomeUnknown, NowUnixMS: max(now, op.NextAttemptAtMS+1)}); err != nil || !changed {
		t.Fatalf("block changed=%v error=%v", changed, err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	reopenedHost, _, reopenedDB := openEditRetryRestartFixture(t, dbPath, runtime, false)
	defer reopenedDB.Close()
	runtime.mu.Lock()
	reads, rollbacks, execs := runtime.historyReads, runtime.rollbackCalls, runtime.execCalls
	runtime.mu.Unlock()
	assertBlockedHealth := func() {
		health := reopenedHost.RuntimeOperationHealth(t.Context())
		if !health.ActiveStateAvailable || health.ActiveDegradationCount != 1 || len(health.ActiveEditRetryDegradations) != 1 {
			t.Fatalf("health=%#v", health)
		}
		item := health.ActiveEditRetryDegradations[0]
		if item.WorkspaceID != editRetryRestartRef.WorkspaceID || item.AgentSessionID != editRetryRestartRef.AgentSessionID || item.OperationID != result.OperationID || item.State != agenthost.EditRetryStateRecoveryRequired || item.ReasonCode != agenthost.EditRetryReasonCodeProviderOutcomeUnknown || len(item.AvailableActions) != 1 || item.AvailableActions[0] != agenthost.EditRetryRecoveryActionReconcile {
			t.Fatalf("active=%#v", item)
		}
	}
	assertBlockedHealth()
	if err := reopenedHost.RecoverCore(t.Context()); err != nil {
		t.Fatal(err)
	}
	assertBlockedHealth()
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.historyReads != reads || runtime.rollbackCalls != rollbacks || runtime.execCalls != execs {
		t.Fatalf("health/recover provider reads=%d rollback=%d exec=%d", runtime.historyReads-reads, runtime.rollbackCalls-rollbacks, runtime.execCalls-execs)
	}
}

func TestRuntimeOperationHealthOrphanFenceSurvivesSQLiteReopenWithoutProviderCalls(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "orphan-fence-health.db")
	runtime := &hostEditRetryRuntime{}
	_, store, db := openEditRetryRestartFixture(t, dbPath, runtime, true)
	operationID := prepareFutureDeferredEditRetry(t, nil, store, runtime)
	if _, err := db.ExecContext(t.Context(), `DELETE FROM workspace_agent_runtime_operations WHERE workspace_id = ? AND operation_id = ?`, editRetryRestartRef.WorkspaceID, operationID); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	host, _, reopenedDB := openEditRetryRestartFixture(t, dbPath, runtime, false)
	defer reopenedDB.Close()
	runtime.mu.Lock()
	reads, rollbacks, execs := runtime.historyReads, runtime.rollbackCalls, runtime.execCalls
	runtime.mu.Unlock()
	health := host.RuntimeOperationHealth(t.Context())
	if !health.ActiveStateAvailable || health.ActiveDegradationCount != 1 || len(health.ActiveEditRetryDegradations) != 1 {
		t.Fatalf("orphan health=%#v", health)
	}
	item := health.ActiveEditRetryDegradations[0]
	if item.WorkspaceID != editRetryRestartRef.WorkspaceID || item.AgentSessionID != editRetryRestartRef.AgentSessionID || item.OperationID != operationID || item.State != agenthost.EditRetryStateRecoveryRequired || item.ReasonCode != agenthost.EditRetryReasonCodeRecoveryRequired || len(item.AvailableActions) != 0 {
		t.Fatalf("orphan active=%#v", item)
	}
	if err := host.RecoverCore(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := host.RuntimeOperationHealth(t.Context()); got.ActiveDegradationCount != 1 {
		t.Fatalf("RecoverCore hid orphan=%#v", got)
	}
	runtime.mu.Lock()
	if runtime.historyReads != reads || runtime.rollbackCalls != rollbacks || runtime.execCalls != execs {
		runtime.mu.Unlock()
		t.Fatalf("health/recover called provider reads=%d rollback=%d exec=%d", runtime.historyReads-reads, runtime.rollbackCalls-rollbacks, runtime.execCalls-execs)
	}
	runtime.mu.Unlock()
	if _, err := reopenedDB.ExecContext(t.Context(), `UPDATE workspace_agent_session_history SET recovery_state = 'ready', operation_id = '' WHERE workspace_id = ? AND agent_session_id = ?`, editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID); err != nil {
		t.Fatal(err)
	}
	if got := host.RuntimeOperationHealth(t.Context()); got.ActiveDegradationCount != 0 || len(got.ActiveEditRetryDegradations) != 0 {
		t.Fatalf("cleared orphan remains active=%#v", got)
	}
}

func max(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func TestRuntimeOperationHealthDeferredEditRetrySurvivesSQLiteReopenWithoutProviderCalls(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "deferred-health.db")
	runtime := &hostEditRetryRuntime{}
	_, store, db := openEditRetryRestartFixture(t, dbPath, runtime, true)
	operationID := prepareFutureDeferredEditRetry(t, nil, store, runtime)
	operation, found, err := store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, operationID)
	if err != nil || !found || operation.NextAttemptAtMS <= time.Now().UnixMilli() {
		t.Fatalf("deferred operation=%#v found=%v error=%v", operation, found, err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	host, _, reopenedDB := openEditRetryRestartFixture(t, dbPath, runtime, false)
	defer reopenedDB.Close()
	runtime.mu.Lock()
	reads, rollbacks, execs := runtime.historyReads, runtime.rollbackCalls, runtime.execCalls
	runtime.mu.Unlock()
	health := host.RuntimeOperationHealth(t.Context())
	if !health.ActiveStateAvailable || health.ActiveDegradationCount != 1 || len(health.ActiveEditRetryDegradations) != 1 {
		t.Fatalf("health=%#v", health)
	}
	item := health.ActiveEditRetryDegradations[0]
	if item.OperationID != operationID || item.State != agenthost.EditRetryStateRollingBack || item.NextAttemptAtMS <= time.Now().UnixMilli() {
		t.Fatalf("deferred active=%#v", item)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.historyReads != reads || runtime.rollbackCalls != rollbacks || runtime.execCalls != execs {
		t.Fatalf("health called provider reads=%d rollback=%d exec=%d", runtime.historyReads-reads, runtime.rollbackCalls-rollbacks, runtime.execCalls-execs)
	}
}

func TestRuntimeOperationHealthTerminalEditRetryDisappearsAfterSQLiteReopen(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "terminal-health.db")
	runtime := &hostEditRetryRuntime{}
	host, _, db := openEditRetryRestartFixture(t, dbPath, runtime, true)
	result, err := host.EditRetry(t.Context(), editRetryRestartRef, "turn-original", agenthost.EditRetryInput{EditedText: "edited", ClientOperationID: "terminal-health", ExpectedHistoryRevision: 0})
	if err != nil || result.State != agenthost.EditRetryStateCompleted {
		t.Fatalf("EditRetry result=%#v error=%v", result, err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	reopenedHost, _, reopenedDB := openEditRetryRestartFixture(t, dbPath, runtime, false)
	defer reopenedDB.Close()
	health := reopenedHost.RuntimeOperationHealth(t.Context())
	if !health.ActiveStateAvailable || health.ActiveDegradationCount != 0 || len(health.ActiveEditRetryDegradations) != 0 {
		t.Fatalf("terminal health=%#v", health)
	}
}

func TestRuntimeOperationHealthFailsClosedForDurableFenceInvariants(t *testing.T) {
	for _, test := range []struct {
		name       string
		wantActive int64
		mutate     func(*testing.T, *sql.DB, string)
	}{
		{"missing_history", 1, func(t *testing.T, db *sql.DB, _ string) {
			if _, err := db.ExecContext(t.Context(), `DELETE FROM workspace_agent_session_history WHERE workspace_id = ? AND agent_session_id = ?`, editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID); err != nil {
				t.Fatal(err)
			}
		}},
		{"ready_nonterminal", 1, func(t *testing.T, db *sql.DB, _ string) {
			if _, err := db.ExecContext(t.Context(), `UPDATE workspace_agent_session_history SET recovery_state = 'ready', operation_id = '' WHERE workspace_id = ? AND agent_session_id = ?`, editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID); err != nil {
				t.Fatal(err)
			}
		}},
		{"other_operation_owner", 2, func(t *testing.T, db *sql.DB, _ string) {
			if _, err := db.ExecContext(t.Context(), `UPDATE workspace_agent_session_history SET recovery_state = 'recovery_required', operation_id = 'other-operation' WHERE workspace_id = ? AND agent_session_id = ?`, editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID); err != nil {
				t.Fatal(err)
			}
		}},
		{"terminal_owner", 1, func(t *testing.T, db *sql.DB, operationID string) {
			if _, err := db.ExecContext(t.Context(), `UPDATE workspace_agent_runtime_operations SET status='completed', result='abandoned', lease_owner=NULL, lease_expires_at_unix_ms=NULL, next_attempt_at_unix_ms=NULL, completed_at_unix_ms=99 WHERE workspace_id=? AND operation_id=?`, editRetryRestartRef.WorkspaceID, operationID); err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(t.Context(), `UPDATE workspace_agent_session_history SET recovery_state='recovery_required', operation_id=? WHERE workspace_id=? AND agent_session_id=?`, operationID, editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			runtime := &hostEditRetryRuntime{}
			host, store, db := openEditRetryRestartFixture(t, filepath.Join(t.TempDir(), "invariant-health.db"), runtime, true)
			operationID := prepareFutureDeferredEditRetry(t, nil, store, runtime)
			const raw = "sensitive sqlite/provider diagnostic"
			if _, err := db.ExecContext(t.Context(), `UPDATE workspace_agent_runtime_operations SET last_error = ? WHERE workspace_id = ? AND operation_id = ?`, raw, editRetryRestartRef.WorkspaceID, operationID); err != nil {
				t.Fatal(err)
			}
			test.mutate(t, db, operationID)
			runtime.mu.Lock()
			reads, rollbacks, execs := runtime.historyReads, runtime.rollbackCalls, runtime.execCalls
			runtime.mu.Unlock()
			health := host.RuntimeOperationHealth(t.Context())
			if !health.ActiveStateAvailable || health.ActiveDegradationCount != test.wantActive || len(health.ActiveEditRetryDegradations) != int(test.wantActive) {
				t.Fatalf("health=%#v", health)
			}
			for _, item := range health.ActiveEditRetryDegradations {
				if item.State != agenthost.EditRetryStateRecoveryRequired || item.ReasonCode != agenthost.EditRetryReasonCodeRecoveryRequired || string(item.ReasonCode) == raw || len(item.AvailableActions) != 0 {
					op, _, _ := store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, operationID)
					history, _, _ := store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID)
					t.Fatalf("invariant active=%#v operation=%#v history=%#v", item, op, history)
				}
			}
			runtime.mu.Lock()
			defer runtime.mu.Unlock()
			if runtime.historyReads != reads || runtime.rollbackCalls != rollbacks || runtime.execCalls != execs {
				t.Fatalf("health called provider reads=%d rollback=%d exec=%d", runtime.historyReads-reads, runtime.rollbackCalls-rollbacks, runtime.execCalls-execs)
			}
		})
	}
}

func TestEditRetryAvailabilityFailsClosedWhenFenceOwnerDoesNotExactlyMatch(t *testing.T) {
	runtime := &hostEditRetryRuntime{}
	host, store, db := openEditRetryRestartFixture(t, filepath.Join(t.TempDir(), "availability-owner.db"), runtime, true)
	defer db.Close()
	_ = prepareFutureDeferredEditRetry(t, nil, store, runtime)
	if _, err := db.ExecContext(t.Context(), `
UPDATE workspace_agent_session_history
SET recovery_state='recovery_required', operation_id='other-session-operation'
WHERE workspace_id=? AND agent_session_id=?`, editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID); err != nil {
		t.Fatal(err)
	}
	availability, err := host.GetEditRetryAvailability(t.Context(), editRetryRestartRef)
	if err != nil {
		t.Fatal(err)
	}
	if availability.RecoveryState != agenthost.EditRetryStateRecoveryRequired || availability.ReasonCode != agenthost.EditRetryReasonCodeRecoveryRequired || len(availability.AvailableActions) != 0 {
		t.Fatalf("availability=%#v, want no actions for mismatched fence owner", availability)
	}
}

func TestEditRetryPrepareCommitFailureDoesNotCallProviderAndAllowsSingleOwnerRetry(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "prepare-commit-failure.db")
	runtime := &hostEditRetryRuntime{}
	participant := &failEditRetryPrepareCommitParticipant{}
	host, store, db := openEditRetryRestartFixtureWithOptions(t, dbPath, runtime, true, storesqlite.Options{TransactionParticipant: participant})
	defer db.Close()

	input := agenthost.EditRetryInput{EditedText: "edited", ClientOperationID: "prepare-commit-failure", ExpectedHistoryRevision: 0}
	if _, err := host.EditRetry(t.Context(), editRetryRestartRef, "turn-original", input); err == nil {
		t.Fatal("EditRetry() error = nil, want injected prepare commit failure")
	}
	assertNoEditRetryProviderWork(t, runtime)
	var preparedCount int
	if err := db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM workspace_agent_runtime_operations WHERE workspace_id = ? AND agent_session_id = ?`, editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID).Scan(&preparedCount); err != nil || preparedCount != 0 {
		t.Fatalf("failed prepare operation count=%d error=%v, want 0", preparedCount, err)
	}
	history, found, err := store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID)
	if err != nil || !found || history.RecoveryState != storesqlite.SessionHistoryRecoveryReady || history.OperationID != "" {
		t.Fatalf("failed prepare history=%#v found=%v error=%v", history, found, err)
	}

	result, err := host.EditRetry(t.Context(), editRetryRestartRef, "turn-original", input)
	if err != nil {
		t.Fatalf("retry EditRetry() result=%#v error=%v", result, err)
	}
	assertEditRetryProviderCalls(t, runtime, 1, 1)
	var owners int
	if err := db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM workspace_agent_runtime_operations WHERE workspace_id = ? AND agent_session_id = ?`, editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID).Scan(&owners); err != nil || owners != 1 {
		t.Fatalf("runtime operation owners=%d error=%v, want 1", owners, err)
	}
}

func TestEditRetryPreEffectSnapshotCrashBoundariesKeepProviderMutationAtZero(t *testing.T) {
	t.Run("prepare commit before provider read", func(t *testing.T) {
		// The dedicated Prepare transaction failure regression is the pre-read
		// boundary: it asserts zero history reads and zero mutations.
		TestEditRetryPrepareCommitFailureDoesNotCallProviderAndAllowsSingleOwnerRetry(t)
	})
	t.Run("prepared fence is durable while provider read is in flight", func(t *testing.T) {
		dbPath := filepath.Join(t.TempDir(), "prepared-before-read.db")
		release := make(chan struct{})
		runtime := &hostEditRetryRuntime{historyReadStarted: make(chan struct{}, 1), historyReadRelease: release}
		host, store, db := openEditRetryRestartFixture(t, dbPath, runtime, true)
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan error, 1)
		go func() {
			_, err := host.EditRetry(ctx, editRetryRestartRef, "turn-original", agenthost.EditRetryInput{EditedText: "edited", ClientOperationID: "prepared-before-read", ExpectedHistoryRevision: 0})
			done <- err
		}()
		select {
		case <-runtime.historyReadStarted:
		case <-time.After(2 * time.Second):
			t.Fatal("provider history read did not begin")
		}
		operationID := editRetryOperationIDForRequest(t, db, "prepared-before-read")
		op, found, err := store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, operationID)
		if err != nil || !found || op.Status != storesqlite.RuntimeOperationStatusLeased {
			t.Fatalf("in-flight prepared operation=%#v found=%v error=%v", op, found, err)
		}
		payload, err := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
		if err != nil || payload.Checkpoint != storesqlite.EditRetryCheckpointPrepared || len(payload.BeforeProviderIDs) != 0 {
			t.Fatalf("in-flight prepared payload=%#v error=%v", payload, err)
		}
		assertFaultHarnessFence(t, store)
		cancel()
		if err := <-done; err == nil {
			t.Fatal("EditRetry() error=nil after cancelled provider read")
		}
		close(release)
		deferred, found, err := store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, operationID)
		if err != nil || !found || deferred.Status != storesqlite.RuntimeOperationStatusPrepared || deferred.LeaseOwner != "" || deferred.NextAttemptAtMS <= deferred.UpdatedAtUnixMS {
			t.Fatalf("cancelled operation=%#v found=%v error=%v, want unleased future retry", deferred, found, err)
		}
		assertNoEditRetryProviderMutation(t, runtime)
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
		_, reopened, reopenedDB := openEditRetryRestartFixture(t, dbPath, runtime, false)
		defer reopenedDB.Close()
		if err := agenthost.New(agenthost.Config{CanonicalStore: sqliteCanonicalStore{Store: reopened}, TurnSubmissions: reopened, EffectiveHistory: reopened, RuntimeOperations: reopened, Runtime: runtime, HistoryRuntime: runtime, GoalRuntime: runtime, OperationOwner: "restart-worker"}).RecoverCore(t.Context()); err != nil {
			t.Fatalf("RecoverCore()=%v", err)
		}
		assertNoEditRetryProviderMutation(t, runtime)
	})
	t.Run("snapshot commit before commit", func(t *testing.T) {
		dbPath := filepath.Join(t.TempDir(), "snapshot-before-commit.db")
		runtime := &hostEditRetryRuntime{}
		participant := &failEditRetrySnapshotCommitParticipant{}
		host, store, db := openEditRetryRestartFixtureWithOptions(t, dbPath, runtime, true, storesqlite.Options{TransactionParticipant: participant})
		if _, err := host.EditRetry(t.Context(), editRetryRestartRef, "turn-original", agenthost.EditRetryInput{EditedText: "edited", ClientOperationID: "snapshot-before-commit", ExpectedHistoryRevision: 0}); err == nil {
			t.Fatal("EditRetry() error=nil, want snapshot commit failure")
		}
		if !participant.failed {
			t.Fatal("snapshot participant did not fire")
		}
		assertEditRetryProviderReadsAndMutations(t, runtime, 1, 0, 0)
		operationID := editRetryOperationIDForRequest(t, db, "snapshot-before-commit")
		assertPreparedWithoutPreEffectSnapshot(t, store, operationID)
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
		host, store, db = openEditRetryRestartFixture(t, dbPath, runtime, false)
		defer db.Close()
		if err := host.RecoverCore(t.Context()); err != nil {
			t.Fatalf("RecoverCore()=%v", err)
		}
		assertPreparedWithoutPreEffectSnapshot(t, store, operationID)
		assertEditRetryProviderReadsAndMutations(t, runtime, 1, 0, 0)
	})
	t.Run("snapshot commit after commit before rollback", func(t *testing.T) {
		dbPath := filepath.Join(t.TempDir(), "snapshot-after-commit.db")
		runtime := &hostEditRetryRuntime{}
		_, store, db := openEditRetryRestartFixture(t, dbPath, runtime, true)
		faults := &postCommitEditRetryFaultStore{EffectiveHistoryStore: store, point: "pre_effect_snapshot"}
		host := newEditRetryFaultHarnessHost(store, runtime, faults)
		if _, err := host.EditRetry(t.Context(), editRetryRestartRef, "turn-original", agenthost.EditRetryInput{EditedText: "edited", ClientOperationID: "snapshot-after-commit", ExpectedHistoryRevision: 0}); !errors.Is(err, errInjectedPostCommit) {
			t.Fatalf("EditRetry() error=%v, want post-commit interruption", err)
		}
		if !faults.fired {
			t.Fatal("post-commit snapshot wrapper did not fire")
		}
		assertEditRetryProviderReadsAndMutations(t, runtime, 1, 0, 0)
		operationID := editRetryOperationIDForRequest(t, db, "snapshot-after-commit")
		assertPreparedWithPreEffectSnapshot(t, store, operationID)
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
		host, store, db = openEditRetryRestartFixture(t, dbPath, runtime, false)
		defer db.Close()
		if err := host.RecoverCore(t.Context()); err != nil {
			t.Fatalf("RecoverCore()=%v", err)
		}
		assertPreparedWithPreEffectSnapshot(t, store, operationID)
		assertEditRetryProviderReadsAndMutations(t, runtime, 1, 0, 0)
	})
}

type failEditRetrySnapshotCommitParticipant struct{ failed bool }

func (p *failEditRetrySnapshotCommitParticipant) Participate(_ context.Context, _ storesqlite.TransactionWriter, delta storesqlite.TransactionDelta) error {
	if p.failed {
		return nil
	}
	for _, mutation := range delta.Mutations {
		if mutation.EntityKind == storesqlite.MutationEntityRuntimeOperation && mutation.Operation == "pre_effect_snapshot" {
			p.failed = true
			return errors.New("injected pre-effect snapshot transaction failure")
		}
	}
	return nil
}

func assertPreparedWithoutPreEffectSnapshot(t *testing.T, store *storesqlite.Store, operationID string) {
	t.Helper()
	op, found, err := store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, operationID)
	if err != nil || !found {
		t.Fatalf("operation=%#v found=%v error=%v", op, found, err)
	}
	payload, err := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
	if err != nil || payload.Checkpoint != storesqlite.EditRetryCheckpointPrepared || len(payload.BeforeProviderIDs) != 0 || payload.ProviderSessionID != "" {
		t.Fatalf("operation payload=%#v error=%v", payload, err)
	}
	assertFaultHarnessFence(t, store)
}

func assertPreparedWithPreEffectSnapshot(t *testing.T, store *storesqlite.Store, operationID string) {
	t.Helper()
	op, found, err := store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, operationID)
	if err != nil || !found {
		t.Fatalf("operation=%#v found=%v error=%v", op, found, err)
	}
	payload, err := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
	if err != nil || payload.Checkpoint != storesqlite.EditRetryCheckpointPrepared || payload.ProviderSessionID != "thread-1" || len(payload.BeforeProviderIDs) != 1 || payload.BeforeProviderIDs[0] != "provider-original" {
		t.Fatalf("operation payload=%#v error=%v", payload, err)
	}
	assertFaultHarnessFence(t, store)
}

func assertEditRetryProviderReadsAndMutations(t *testing.T, runtime *hostEditRetryRuntime, wantReads, wantRollback, wantExec int) {
	t.Helper()
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.historyReads != wantReads || runtime.rollbackCalls != wantRollback || runtime.execCalls != wantExec {
		t.Fatalf("provider reads=%d rollback=%d exec=%d, want %d/%d/%d", runtime.historyReads, runtime.rollbackCalls, runtime.execCalls, wantReads, wantRollback, wantExec)
	}
}

func assertNoEditRetryProviderMutation(t *testing.T, runtime *hostEditRetryRuntime) {
	t.Helper()
	assertEditRetryProviderReadsAndMutations(t, runtime, 1, 0, 0)
}

func editRetryOperationIDForRequest(t *testing.T, db *sql.DB, requestID string) string {
	t.Helper()
	var operationID string
	if err := db.QueryRowContext(t.Context(), `SELECT operation_id FROM workspace_agent_runtime_operations WHERE workspace_id=? AND request_id=?`, editRetryRestartRef.WorkspaceID, requestID).Scan(&operationID); err != nil {
		t.Fatalf("find operation for request %q: %v", requestID, err)
	}
	return operationID
}

func TestEditRetryPostProviderCommitWriteLockFailsClosedAcrossReopen(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "post-provider-commit-lock.db")
	runtime := &hostEditRetryRuntime{}
	host, store, db := openEditRetryRestartFixture(t, dbPath, runtime, true)
	if _, err := db.ExecContext(t.Context(), `PRAGMA busy_timeout = 25`); err != nil {
		t.Fatal(err)
	}
	var releaseLock func()
	runtime.mu.Lock()
	runtime.afterExec = func() error {
		releaseLock = acquireEditRetrySQLiteWriteLock(t, dbPath)
		return nil
	}
	runtime.mu.Unlock()
	t.Cleanup(func() {
		if releaseLock != nil {
			releaseLock()
		}
	})

	operationID := "operation-post-provider-commit-lock"
	payloadMap, err := storesqlite.EncodeEditRetryOperationPayload(storesqlite.EditRetryOperationPayload{
		ClientOperationID: "post-provider-commit-lock", EditedText: "edited",
		ReplacementTurnID: "turn-replacement-lock", ClientSubmitID: "edit-retry:" + operationID,
		ExpectedRevision: 0, Checkpoint: storesqlite.EditRetryCheckpointPrepared,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, changed, err := store.PrepareEditRetry(t.Context(), storesqlite.RuntimeOperationPrepare{
		WorkspaceID: editRetryRestartRef.WorkspaceID, AgentSessionID: editRetryRestartRef.AgentSessionID,
		OperationID: operationID, Kind: storesqlite.RuntimeOperationKindEditRetry,
		TurnID: "turn-original", RequestID: "post-provider-commit-lock", Payload: payloadMap, OccurredAtMS: time.Now().UnixMilli(),
	}); err != nil || !changed {
		t.Fatalf("PrepareEditRetry() changed=%v error=%v", changed, err)
	}
	// StepRuntimeOperationWorker isolates this item error and returns normally,
	// which proves a recovery worker does not exit when post-provider persistence
	// cannot acquire the canonical SQLite writer.
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatalf("locked StepRuntimeOperationWorker() = %v", err)
	}
	if releaseLock == nil {
		t.Fatal("provider callback did not acquire external SQLite write lock")
	}
	assertEditRetryProviderCalls(t, runtime, 1, 1)
	op, found, getErr := store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, operationID)
	if getErr != nil || !found || op.Status != storesqlite.RuntimeOperationStatusLeased {
		t.Fatalf("locked operation=%#v found=%v error=%v, want leased fence owner", op, found, getErr)
	}
	payload, decodeErr := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
	if decodeErr != nil || payload.Checkpoint != storesqlite.EditRetryCheckpointReplacementDispatched {
		t.Fatalf("locked operation checkpoint=%#v error=%v, want replacement_dispatched", payload, decodeErr)
	}
	history, found, historyErr := store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID)
	if historyErr != nil || !found || history.OperationID != operationID || history.RecoveryState != storesqlite.SessionHistoryRecoveryResendPending {
		t.Fatalf("locked history=%#v found=%v error=%v, want retained resend fence", history, found, historyErr)
	}

	releaseLock()
	releaseLock = nil
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	host, store, db = openEditRetryRestartFixture(t, dbPath, runtime, false)
	defer db.Close()
	if err := host.RecoverCore(t.Context()); err != nil {
		t.Fatalf("RecoverCore() = %v", err)
	}
	op, found, getErr = store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, operationID)
	if getErr != nil || !found || op.Status != storesqlite.RuntimeOperationStatusPrepared {
		t.Fatalf("reopened operation=%#v found=%v error=%v, want reconcile-only prepared operation", op, found, getErr)
	}
	payload, decodeErr = storesqlite.DecodeEditRetryOperationPayload(op.Payload)
	if decodeErr != nil || payload.Checkpoint != storesqlite.EditRetryCheckpointReplacementDispatched {
		t.Fatalf("reopened checkpoint=%#v error=%v, want replacement_dispatched", payload, decodeErr)
	}
	assertEditRetryProviderCalls(t, runtime, 1, 1)

	if err := host.StepRuntimeOperationWorker(t.Context(), true); err != nil {
		t.Fatalf("StepRuntimeOperationWorker() = %v", err)
	}
	op, found, getErr = store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, operationID)
	if getErr != nil || !found || op.Status != storesqlite.RuntimeOperationStatusCompleted {
		t.Fatalf("reconciled operation=%#v found=%v error=%v, want completed", op, found, getErr)
	}
	assertEditRetryProviderCalls(t, runtime, 1, 1)
}

type failEditRetryPrepareCommitParticipant struct {
	failed bool
}

func (p *failEditRetryPrepareCommitParticipant) Participate(_ context.Context, _ storesqlite.TransactionWriter, delta storesqlite.TransactionDelta) error {
	if p.failed {
		return nil
	}
	for _, mutation := range delta.Mutations {
		if mutation.EntityKind == storesqlite.MutationEntityRuntimeOperation && mutation.Operation == "prepare" {
			p.failed = true
			return errors.New("injected edit retry prepare commit failure")
		}
	}
	return nil
}

func acquireEditRetrySQLiteWriteLock(t *testing.T, path string) func() {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := db.Conn(t.Context())
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if _, err := connection.ExecContext(t.Context(), `PRAGMA busy_timeout = 25`); err != nil {
		_ = connection.Close()
		_ = db.Close()
		t.Fatal(err)
	}
	if _, err := connection.ExecContext(t.Context(), `BEGIN IMMEDIATE`); err != nil {
		_ = connection.Close()
		_ = db.Close()
		t.Fatal(err)
	}
	return func() {
		_, _ = connection.ExecContext(context.Background(), `ROLLBACK`)
		_ = connection.Close()
		_ = db.Close()
	}
}

func assertEditRetryProviderCalls(t *testing.T, runtime *hostEditRetryRuntime, wantRollback, wantExec int) {
	t.Helper()
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.rollbackCalls != wantRollback || runtime.execCalls != wantExec {
		t.Fatalf("provider calls rollback=%d exec=%d, want %d/%d", runtime.rollbackCalls, runtime.execCalls, wantRollback, wantExec)
	}
}

func assertNoEditRetryProviderWork(t *testing.T, runtime *hostEditRetryRuntime) {
	t.Helper()
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.rollbackCalls != 0 || runtime.execCalls != 0 || runtime.historyReads != 0 || runtime.reconcileAcceptanceCalls != 0 {
		t.Fatalf("provider calls rollback=%d exec=%d historyReads=%d reconcileAcceptance=%d, want all 0", runtime.rollbackCalls, runtime.execCalls, runtime.historyReads, runtime.reconcileAcceptanceCalls)
	}
}

func prepareFutureDeferredEditRetry(t *testing.T, _ *agenthost.Host, store *storesqlite.Store, _ *hostEditRetryRuntime) string {
	t.Helper()
	operationID := "restart-deferred"
	payload, err := storesqlite.EncodeEditRetryOperationPayload(storesqlite.EditRetryOperationPayload{ClientOperationID: "restart-deferred-client", EditedText: "edited", ReplacementTurnID: "turn-replacement", ClientSubmitID: "edit-retry:" + operationID, ExpectedRevision: 0, Checkpoint: storesqlite.EditRetryCheckpointPrepared})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.PrepareRuntimeOperation(t.Context(), storesqlite.RuntimeOperationPrepare{WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: operationID, AgentSessionID: editRetryRestartRef.AgentSessionID, Kind: storesqlite.RuntimeOperationKindEditRetry, TurnID: "turn-original", RequestID: "restart-deferred-client", Payload: payload, OccurredAtMS: 10}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	op, claimed, err := store.ClaimRuntimeOperationLease(t.Context(), storesqlite.ClaimRuntimeOperationLeaseInput{WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: operationID, LeaseOwner: "restart-preparer", NowUnixMS: now, LeaseExpiresAtMS: now + 60_000})
	if err != nil || !claimed {
		t.Fatalf("claim=%v err=%v", claimed, err)
	}
	if _, changed, err := store.DeferEditRetry(t.Context(), storesqlite.DeferEditRetryInput{WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: operationID, LeaseOwner: "restart-preparer", ReasonCode: storesqlite.EditRetryReasonProviderOutcomeUnknown, NowUnixMS: now, NextAttemptAtMS: now + 3_600_000}); err != nil || !changed {
		t.Fatalf("defer=%v err=%v", changed, err)
	}
	if op.OperationID != operationID {
		t.Fatalf("claimed=%#v", op)
	}
	return operationID
}

func assertEditRetryRestartSnapshot(t *testing.T, store *storesqlite.Store, operationID string, wantStatus string) {
	t.Helper()
	op, found, err := store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, operationID)
	if err != nil || !found || op.Status != wantStatus {
		t.Fatalf("operation=%#v found=%v err=%v, want status %q", op, found, err, wantStatus)
	}
	history, found, err := store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID)
	if err != nil || !found || history.OperationID != operationID || history.RecoveryState == storesqlite.SessionHistoryRecoveryReady {
		t.Fatalf("history=%#v found=%v err=%v", history, found, err)
	}
}

func openEditRetryRestartFixture(t *testing.T, path string, runtime *hostEditRetryRuntime, seed bool) (*agenthost.Host, *storesqlite.Store, *sql.DB) {
	return openEditRetryRestartFixtureWithOptions(t, path, runtime, seed, storesqlite.Options{})
}

func openEditRetryRestartFixtureWithOptions(t *testing.T, path string, runtime *hostEditRetryRuntime, seed bool, options storesqlite.Options) (*agenthost.Host, *storesqlite.Store, *sql.DB) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	store := storesqlite.New(db, options)
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if seed {
		seedEditRetryRestartFixture(t, store)
	}
	runtime.mu.Lock()
	runtime.store = store
	if runtime.providerTurns == nil {
		runtime.providerTurns = []agenthost.RuntimeHistoryTurn{{ID: "provider-original"}}
	}
	runtime.mu.Unlock()
	host := agenthost.New(agenthost.Config{CanonicalStore: sqliteCanonicalStore{Store: store}, TurnSubmissions: store, EffectiveHistory: store, RuntimeOperations: store, RuntimeOperationHealth: store, Runtime: runtime, HistoryRuntime: runtime, GoalRuntime: runtime, OperationOwner: "restart-worker"})
	return host, store, db
}

func seedEditRetryRestartFixture(t *testing.T, store *storesqlite.Store) {
	t.Helper()
	if _, err := store.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		Kind: storesqlite.SessionKindRoot, Provider: "codex",
		ProviderSessionID: "thread-1", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(t.Context(), storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			Kind: storesqlite.SessionKindRoot, Provider: "codex",
			ProviderSessionID: "thread-1", OccurredAtUnixMS: 2,
		},
		Turn: &storesqlite.TurnTransition{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			TurnID: "turn-original", Phase: storesqlite.TurnPhaseRunning,
			Origin: storesqlite.TurnOriginUserPrompt, StartedAtUnixMS: 2, OccurredAtUnixMS: 2,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID: "workspace-1", RootAgentSessionID: "session-1",
			RootTurnID: "turn-original", ProviderTurnID: "provider-original",
			Phase: storesqlite.RootProviderTurnPhaseRunning, OccurredAtUnixMS: 2,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(t.Context(), storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			Kind: storesqlite.SessionKindRoot, Provider: "codex",
			ProviderSessionID: "thread-1", OccurredAtUnixMS: 3,
		},
		Turn: &storesqlite.TurnTransition{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			TurnID: "turn-original", Phase: storesqlite.TurnPhaseSettled,
			Outcome: storesqlite.TurnOutcomeCompleted, Origin: storesqlite.TurnOriginUserPrompt,
			FileChanges:     map[string]any{"files": []any{"changed.txt"}},
			SettledAtUnixMS: 3, OccurredAtUnixMS: 3,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID: "workspace-1", RootAgentSessionID: "session-1",
			RootTurnID: "turn-original", ProviderTurnID: "provider-original",
			Phase:   storesqlite.RootProviderTurnPhaseCompleted,
			Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 3,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RecordTurnSubmission(t.Context(), storesqlite.TurnSubmission{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-original",
		ContentJSON:   `[{"type":"text","text":"original"},{"type":"image","mimeType":"image/png","attachmentId":"attachment-1"},{"type":"mention","name":"README","path":"README.md"}]`,
		DisplayPrompt: "original", CapabilityRefsJSON: `[]`,
		TuttiModeSnapshotJSON: `null`, ClientSubmitID: "submit-original",
		CreatedAtUnixMS: 3, UpdatedAtUnixMS: 3,
	}); err != nil {
		t.Fatal(err)
	}
}
