package agenthost_test

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// TestEditRetryRetryBudgetFaultMatrix keeps retry eligibility fully durable:
// every row starts from a real SQLite file and advances time through Host's
// Clock instead of changing next_attempt_at in the database.
func TestEditRetryRetryBudgetFaultMatrix(t *testing.T) {
	t.Run("unknown provider backoff is bounded stable and not claimable early", func(t *testing.T) {
		f := newRetryBudgetFixture(t, "retry-backoff")
		op := f.startUnknown(t)
		if op.NextAttemptAtMS <= f.clock.Now().UnixMilli() {
			t.Fatalf("next retry=%d now=%d", op.NextAttemptAtMS, f.clock.Now().UnixMilli())
		}
		delay := op.NextAttemptAtMS - f.clock.Now().UnixMilli()
		if delay < time.Second.Milliseconds() || delay > (time.Second+time.Second/4).Milliseconds() {
			t.Fatalf("attempt-one retry delay=%dms, want exponential base plus bounded jitter", delay)
		}
		// The jitter is derived from the durable operation identity, rather than
		// process entropy: a second real SQLite fixture with the same identity
		// and Clock computes the same delay.
		stable := newRetryBudgetFixture(t, "retry-backoff")
		stable.clock.Set(f.clock.Now())
		stableOp := stable.startUnknown(t)
		if got := stableOp.NextAttemptAtMS - stable.clock.Now().UnixMilli(); got != delay {
			t.Fatalf("jitter delay=%d, want stable %d", got, delay)
		}
		rollback, exec := f.providerCounts()
		for i := 0; i < 3; i++ {
			f.clock.Set(time.UnixMilli(op.NextAttemptAtMS - 1))
			if err := f.host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
				t.Fatal(err)
			}
			if claimable, err := f.store.ListClaimableRuntimeOperations(t.Context(), storesqlite.ListClaimableRuntimeOperationsInput{WorkspaceID: editRetryRestartRef.WorkspaceID, NowUnixMS: f.clock.Now().UnixMilli(), Limit: 10}); err != nil || len(claimable) != 0 {
				t.Fatalf("early claimable=%#v error=%v", claimable, err)
			}
			if gotRollback, gotExec := f.providerCounts(); gotRollback != rollback || gotExec != exec {
				t.Fatalf("provider changed before retry: rollback=%d/%d exec=%d/%d", gotRollback, rollback, gotExec, exec)
			}
		}
		f.clock.Set(time.UnixMilli(op.NextAttemptAtMS))
		if err := f.host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
			t.Fatal(err)
		}
		after := f.operation(t)
		if after.Attempt != 2 || after.NextAttemptAtMS <= f.clock.Now().UnixMilli() {
			t.Fatalf("due retry=%#v", after)
		}
		if gotRollback, gotExec := f.providerCounts(); gotRollback != rollback || gotExec != exec {
			t.Fatalf("due reconcile mutated provider rollback=%d exec=%d", gotRollback, gotExec)
		}
		f.reopenTwice(t)
		assertBatchOperationStatus(t, f.store, f.healthyID, storesqlite.RuntimeOperationStatusCompleted)
	})

	t.Run("attempt and age budgets block before another provider mutation", func(t *testing.T) {
		for _, test := range []struct {
			name string
			age  bool
		}{
			{name: "attempt eight"},
			{name: "max age", age: true},
		} {
			t.Run(test.name, func(t *testing.T) {
				f := newRetryBudgetFixture(t, "budget-"+strings.ReplaceAll(test.name, " ", "-"))
				if test.age {
					op := f.operation(t)
					f.clock.Set(time.UnixMilli(op.CreatedAtUnixMS).Add(24*time.Hour + time.Millisecond))
				} else {
					f.startUnknown(t)
					f.driveToAttempt(t, 7)
					op := f.operation(t)
					f.clock.Set(time.UnixMilli(op.NextAttemptAtMS))
				}
				rollback, exec := f.providerCounts()
				if err := f.host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
					t.Fatal(err)
				}
				f.assertBlocked(t)
				if gotRollback, gotExec := f.providerCounts(); gotRollback != rollback || gotExec != exec {
					t.Fatalf("budget boundary mutated provider rollback=%d/%d exec=%d/%d", gotRollback, rollback, gotExec, exec)
				}
				f.reopenTwice(t)
				f.assertBlocked(t)
			})
		}
	})

	t.Run("block event failure rolls back then safely retries", func(t *testing.T) {
		f := newRetryBudgetFixture(t, "budget-block-rollback")
		f.startUnknown(t)
		f.driveToAttempt(t, 7)
		op := f.operation(t)
		f.clock.Set(time.UnixMilli(op.NextAttemptAtMS))
		leased, claimed, err := f.store.ClaimRuntimeOperationLease(t.Context(), f.claimInput("block-owner", f.clock.Now().UnixMilli()))
		if err != nil || !claimed || leased.Attempt != 8 {
			t.Fatalf("budget lease=%#v claimed=%v error=%v", leased, claimed, err)
		}
		db := f.db.(*sql.DB)
		if _, err := db.ExecContext(t.Context(), `
CREATE TRIGGER fail_edit_retry_budget_block_event
BEFORE INSERT ON workspace_agent_runtime_operation_events
WHEN NEW.operation_id = 'budget-block-rollback'
BEGIN SELECT RAISE(ABORT, 'injected edit retry budget block event failure'); END;
`); err != nil {
			t.Fatal(err)
		}
		before := f.operation(t)
		rollback, exec := f.providerCounts()
		_, changed, err := f.store.BlockEditRetry(t.Context(), storesqlite.BlockEditRetryInput{
			WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: f.operationID, LeaseOwner: "block-owner",
			ReasonCode: storesqlite.EditRetryReasonRetryBudgetExhausted, NowUnixMS: f.clock.Now().UnixMilli(),
		})
		if err == nil || changed || !strings.Contains(err.Error(), "injected edit retry budget block event failure") {
			t.Fatalf("BlockEditRetry changed=%v error=%v", changed, err)
		}
		after := f.operation(t)
		assertLeaseUnchanged(t, before, after)
		if gotRollback, gotExec := f.providerCounts(); gotRollback != rollback || gotExec != exec {
			t.Fatalf("failed block mutated provider rollback=%d/%d exec=%d/%d", gotRollback, rollback, gotExec, exec)
		}
		if _, err := db.ExecContext(t.Context(), `DROP TRIGGER fail_edit_retry_budget_block_event`); err != nil {
			t.Fatal(err)
		}
		if _, changed, err = f.store.BlockEditRetry(t.Context(), storesqlite.BlockEditRetryInput{
			WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: f.operationID, LeaseOwner: "block-owner",
			ReasonCode: storesqlite.EditRetryReasonRetryBudgetExhausted, NowUnixMS: f.clock.Now().UnixMilli(),
		}); err != nil || !changed {
			t.Fatalf("retry BlockEditRetry changed=%v error=%v", changed, err)
		}
		f.assertBlocked(t)
		f.reopenTwice(t)
		f.assertBlocked(t)
	})

	t.Run("two Hosts have one budget transition winner", func(t *testing.T) {
		f := newRetryBudgetFixture(t, "budget-concurrent")
		f.startUnknown(t)
		f.driveToAttempt(t, 7)
		op := f.operation(t)
		f.clock.Set(time.UnixMilli(op.NextAttemptAtMS))
		stores := []*recordingClaimStore{{RuntimeOperationStore: f.store}, {RuntimeOperationStore: f.store}}
		rollback, exec := f.providerCounts()
		hosts := []*agenthost.Host{
			newRetryBudgetHost(f.store, f.runtime, stores[0], f.clock),
			newRetryBudgetHost(f.store, f.runtime, stores[1], f.clock),
		}
		start := make(chan struct{})
		var group sync.WaitGroup
		for _, host := range hosts {
			group.Add(1)
			go func(host *agenthost.Host) {
				defer group.Done()
				<-start
				_ = host.StepRuntimeOperationWorker(t.Context(), false)
			}(host)
		}
		close(start)
		group.Wait()
		winners := 0
		for _, store := range stores {
			for _, result := range store.resultsSnapshot() {
				if result.operationID == f.operationID && result.claimed {
					winners++
				}
			}
		}
		if winners != 1 {
			t.Fatalf("budget claim winners=%d", winners)
		}
		f.assertBlocked(t)
		if gotRollback, gotExec := f.providerCounts(); gotRollback != rollback || gotExec != exec {
			t.Fatalf("concurrent budget boundary mutated provider rollback=%d/%d exec=%d/%d", gotRollback, rollback, gotExec, exec)
		}
		f.reopenTwice(t)
	})

	t.Run("blocked admission isolates only the fenced session", func(t *testing.T) {
		f := newRetryBudgetFixture(t, "budget-admission")
		f.startUnknown(t)
		f.driveToAttempt(t, 7)
		op := f.operation(t)
		f.clock.Set(time.UnixMilli(op.NextAttemptAtMS))
		if err := f.host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
			t.Fatal(err)
		}
		f.assertBlocked(t)
		if _, err := f.host.SendInput(t.Context(), editRetryRestartRef, agenthost.SendInput{Content: []agenthost.PromptContentBlock{{Type: "text", Text: "blocked send"}}}); !errors.Is(err, agenthost.ErrEditRetryRecoveryRequired) {
			t.Fatalf("SendInput(blocked)=%v", err)
		}
		if _, err := f.host.EditRetry(t.Context(), editRetryRestartRef, "turn-original", agenthost.EditRetryInput{EditedText: "blocked retry", ClientOperationID: "blocked-action", ExpectedHistoryRevision: 0}); !errors.Is(err, agenthost.ErrEditRetryRecoveryRequired) {
			t.Fatalf("EditRetry(blocked)=%v", err)
		}
		if _, found, err := f.store.GetSession(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID); err != nil || !found {
			t.Fatalf("blocked session read found=%v error=%v", found, err)
		}
		if _, found, err := f.store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID); err != nil || !found {
			t.Fatalf("blocked diagnostics found=%v error=%v", found, err)
		}
		assertBatchOperationStatus(t, f.store, f.healthyID, storesqlite.RuntimeOperationStatusCompleted)
		f.reopenTwice(t)
	})

	t.Run("blocked reconcile is provider-read-only and preserves the fence", func(t *testing.T) {
		f := newRetryBudgetFixture(t, "budget-read-only-reconcile")
		f.startUnknown(t)
		f.driveToAttempt(t, 7)
		op := f.operation(t)
		f.clock.Set(time.UnixMilli(op.NextAttemptAtMS))
		if err := f.host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
			t.Fatal(err)
		}
		f.assertBlocked(t)
		availability, err := f.host.GetEditRetryAvailability(t.Context(), editRetryRestartRef)
		if err != nil {
			t.Fatal(err)
		}
		f.runtime.mu.Lock()
		rollbackBefore, execBefore, readsBefore := f.runtime.rollbackCalls, f.runtime.execCalls, f.runtime.historyReads
		f.runtime.mu.Unlock()
		result, err := f.host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, agenthost.RecoverEditRetryInput{
			Action: agenthost.EditRetryRecoveryActionReconcile, ClientActionID: "blocked-read-only-reconcile",
			ExpectedOperationVersion: availability.OperationVersion, ExpectedHistoryRevision: availability.HistoryRevision,
		})
		if err != nil || result.State != agenthost.EditRetryStateRecoveryRequired {
			t.Fatalf("blocked reconcile result=%#v error=%v", result, err)
		}
		f.runtime.mu.Lock()
		rollbackAfter, execAfter, readsAfter := f.runtime.rollbackCalls, f.runtime.execCalls, f.runtime.historyReads
		f.runtime.mu.Unlock()
		if rollbackAfter != rollbackBefore || execAfter != execBefore || readsAfter != readsBefore+1 {
			t.Fatalf("blocked reconcile provider calls rollback=%d/%d exec=%d/%d reads=%d/%d", rollbackAfter, rollbackBefore, execAfter, execBefore, readsAfter, readsBefore+1)
		}
		f.assertBlocked(t)
	})

	t.Run("concurrent identical blocked reconcile reads provider once", func(t *testing.T) {
		f := newRetryBudgetFixture(t, "budget-reconcile-idempotent")
		f.startUnknown(t)
		f.driveToAttempt(t, 7)
		op := f.operation(t)
		f.clock.Set(time.UnixMilli(op.NextAttemptAtMS))
		if err := f.host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
			t.Fatal(err)
		}
		availability, err := f.host.GetEditRetryAvailability(t.Context(), editRetryRestartRef)
		if err != nil {
			t.Fatal(err)
		}
		input := agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionReconcile, ClientActionID: "same-reconcile", ExpectedOperationVersion: availability.OperationVersion, ExpectedHistoryRevision: availability.HistoryRevision}
		f.runtime.mu.Lock()
		readsBefore := f.runtime.historyReads
		f.runtime.mu.Unlock()
		start := make(chan struct{})
		var wait sync.WaitGroup
		errs := make([]error, 2)
		for index := range errs {
			wait.Add(1)
			go func(index int) {
				defer wait.Done()
				<-start
				_, errs[index] = f.host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, input)
			}(index)
		}
		close(start)
		wait.Wait()
		for _, err := range errs {
			if err != nil {
				t.Fatalf("same identity reconcile error=%v", err)
			}
		}
		f.runtime.mu.Lock()
		reads := f.runtime.historyReads
		f.runtime.mu.Unlock()
		if reads != readsBefore+1 {
			t.Fatalf("provider history reads=%d, want %d for one actor-linearized command", reads, readsBefore+1)
		}
		if _, found, err := f.store.GetRuntimeOperationRecoveryAction(t.Context(), editRetryRestartRef.WorkspaceID, f.operationID, input.ClientActionID); err != nil || !found {
			t.Fatalf("durable reconcile ledger found=%v error=%v", found, err)
		}
	})

	t.Run("actor queued conflicting commands are rejected before a second provider read", func(t *testing.T) {
		for _, testCase := range []struct {
			name   string
			second agenthost.RecoverEditRetryInput
			want   error
		}{
			{name: "same client action different identity", second: agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionRetryReplacement, ClientActionID: "shared"}, want: storesqlite.ErrRuntimeOperationActionConflict},
			{name: "different client action stale CAS", second: agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionReconcile, ClientActionID: "other"}, want: agenthost.ErrEditRetryHistoryConflict},
		} {
			t.Run(testCase.name, func(t *testing.T) {
				f := newRetryBudgetFixture(t, "budget-queued-"+strings.ReplaceAll(testCase.name, " ", "-"))
				f.startUnknown(t)
				f.driveToAttempt(t, 7)
				op := f.operation(t)
				f.clock.Set(time.UnixMilli(op.NextAttemptAtMS))
				if err := f.host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
					t.Fatal(err)
				}
				availability, err := f.host.GetEditRetryAvailability(t.Context(), editRetryRestartRef)
				if err != nil {
					t.Fatal(err)
				}
				first := agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionReconcile, ClientActionID: "shared", ExpectedOperationVersion: availability.OperationVersion, ExpectedHistoryRevision: availability.HistoryRevision}
				testCase.second.ExpectedOperationVersion, testCase.second.ExpectedHistoryRevision = availability.OperationVersion, availability.HistoryRevision
				started, release := make(chan struct{}, 1), make(chan struct{})
				f.runtime.mu.Lock()
				readsBefore := f.runtime.historyReads
				f.runtime.historyReadStarted, f.runtime.historyReadRelease = started, release
				f.runtime.mu.Unlock()
				firstDone := make(chan error, 1)
				go func() {
					_, err := f.host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, first)
					firstDone <- err
				}()
				<-started
				secondDone := make(chan error, 1)
				go func() {
					_, err := f.host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, testCase.second)
					secondDone <- err
				}()
				close(release)
				if err := <-firstDone; err != nil {
					t.Fatalf("first command=%v", err)
				}
				if err := <-secondDone; !errors.Is(err, testCase.want) {
					t.Fatalf("second command=%v want %v", err, testCase.want)
				}
				f.runtime.mu.Lock()
				reads := f.runtime.historyReads
				f.runtime.historyReadStarted, f.runtime.historyReadRelease = nil, nil
				f.runtime.mu.Unlock()
				if reads != readsBefore+1 {
					t.Fatalf("provider reads=%d want %d", reads, readsBefore+1)
				}
			})
		}
	})

	t.Run("blocked reconcile caller loss reopens from durable action ledger", func(t *testing.T) {
		f := newRetryBudgetFixture(t, "budget-reconcile-caller-loss")
		f.startUnknown(t)
		f.driveToAttempt(t, 7)
		op := f.operation(t)
		f.clock.Set(time.UnixMilli(op.NextAttemptAtMS))
		if err := f.host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
			t.Fatal(err)
		}
		availability, err := f.host.GetEditRetryAvailability(t.Context(), editRetryRestartRef)
		if err != nil {
			t.Fatal(err)
		}
		input := agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionReconcile, ClientActionID: "reconcile-after", ExpectedOperationVersion: availability.OperationVersion, ExpectedHistoryRevision: availability.HistoryRevision}
		faults := &postCommitEditRetryFaultStore{EffectiveHistoryStore: f.store, point: "blocked_reconcile"}
		f.host = newRollbackFaultHost(f.store, f.runtime, faults, f.store)
		if _, err := f.host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, input); !errors.Is(err, errInjectedPostCommit) || !faults.fired {
			t.Fatalf("caller loss error=%v fired=%v", err, faults.fired)
		}
		f.runtime.mu.Lock()
		readsBefore := f.runtime.historyReads
		f.runtime.mu.Unlock()
		f.reopenTwice(t)
		if _, err := f.host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, input); err != nil {
			t.Fatalf("same identity reopen replay=%v", err)
		}
		if _, err := f.host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionRetryReplacement, ClientActionID: input.ClientActionID, ExpectedOperationVersion: input.ExpectedOperationVersion, ExpectedHistoryRevision: input.ExpectedHistoryRevision}); !errors.Is(err, storesqlite.ErrRuntimeOperationActionConflict) {
			t.Fatalf("different identity=%v", err)
		}
		f.runtime.mu.Lock()
		reads := f.runtime.historyReads
		f.runtime.mu.Unlock()
		if reads != readsBefore {
			t.Fatalf("reopen replay provider reads=%d want %d", reads, readsBefore)
		}
	})
}

// TestBlockedReconcileOutboxFaultsPreserveDurableProjection binds the generic
// publisher retry contract to the non-terminal replacement-absence reconcile
// transition. Provider reads happen only while creating that transition, never
// while replaying its stable event ID.
func TestBlockedReconcileOutboxFaultsPreserveDurableProjection(t *testing.T) {
	for _, testCase := range []struct {
		name string
		mark bool
	}{{"publish failure", false}, {"mark failure", true}} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newRetryBudgetFixture(t, "blocked-reconcile-outbox-"+strings.ReplaceAll(testCase.name, " ", "-"))
			f.startUnknown(t)
			f.driveToAttempt(t, 7)
			op := f.operation(t)
			f.clock.Set(time.UnixMilli(op.NextAttemptAtMS))
			if err := f.host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
				t.Fatal(err)
			}
			availability, err := f.host.GetEditRetryAvailability(t.Context(), editRetryRestartRef)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionReconcile, ClientActionID: "reconcile-outbox", ExpectedOperationVersion: availability.OperationVersion, ExpectedHistoryRevision: availability.HistoryRevision}); err != nil {
				t.Fatal(err)
			}
			before, _, _ := f.store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, f.operationID)
			history, _, _ := f.store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID)
			pending, err := f.store.ListPendingRuntimeOperationEvents(t.Context(), editRetryRestartRef.WorkspaceID, 20)
			if err != nil {
				t.Fatal(err)
			}
			var eventID int64
			for _, event := range pending {
				if event.OperationID == f.operationID && (event.Kind == storesqlite.RuntimeOperationEventEditRetryRecovery || event.Kind == storesqlite.RuntimeOperationEventEditRetryWake) {
					eventID = event.ID
				}
			}
			if eventID == 0 {
				t.Fatalf("missing blocked reconcile event: %#v", pending)
			}
			publisher := &recordingRuntimeOperationPublisher{fail: !testCase.mark}
			if testCase.mark {
				if _, err := f.db.(*sql.DB).ExecContext(t.Context(), `CREATE TRIGGER fail_blocked_reconcile_mark BEFORE UPDATE OF published_at_unix_ms ON workspace_agent_runtime_operation_events WHEN NEW.id=`+fmt.Sprint(eventID)+` BEGIN SELECT RAISE(ABORT, 'blocked reconcile mark failure'); END;`); err != nil {
					t.Fatal(err)
				}
			}
			host := newBatchRuntimeOperationHost(f.store, f.runtime, f.store, publisher, true, f.clock)
			if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
				t.Fatal(err)
			}
			after, _, _ := f.store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, f.operationID)
			currentHistory, _, _ := f.store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID)
			if after.Status != before.Status || after.Version != before.Version || currentHistory != history {
				t.Fatalf("outbox reversed canonical op=%#v/%#v history=%#v/%#v", after, before, currentHistory, history)
			}
			if host.RuntimeOperationWorkerSummary().OutboxFailures == 0 {
				t.Fatal("outbox health was not degraded")
			}
			f.runtime.mu.Lock()
			readsBefore, rollbacks, execs := f.runtime.historyReads, f.runtime.rollbackCalls, f.runtime.execCalls
			f.runtime.mu.Unlock()
			if testCase.mark {
				if _, err := f.db.(*sql.DB).ExecContext(t.Context(), `DROP TRIGGER fail_blocked_reconcile_mark`); err != nil {
					t.Fatal(err)
				}
			} else {
				publisher.fail = false
			}
			// A failed publish remains visible as pending diagnostics but is not
			// scheduler-ready until its durable backoff expires. Advance the
			// fixture clock from the persisted event rather than relying on wall
			// time across the close/reopen boundary.
			pending, err = f.store.ListPendingRuntimeOperationEvents(t.Context(), editRetryRestartRef.WorkspaceID, 20)
			if err != nil {
				t.Fatal(err)
			}
			for _, event := range pending {
				if event.ID == eventID {
					if event.NextAttemptAtMS <= f.clock.Now().UnixMilli() {
						t.Fatalf("deferred event next attempt=%d now=%d", event.NextAttemptAtMS, f.clock.Now().UnixMilli())
					}
					f.clock.Set(time.UnixMilli(event.NextAttemptAtMS))
					break
				}
			}
			if err := f.db.Close(); err != nil {
				t.Fatal(err)
			}
			_, reopened, db := openEditRetryRestartFixture(t, f.dbPath, f.runtime, false)
			defer db.Close()
			host = newBatchRuntimeOperationHost(reopened, f.runtime, reopened, publisher, true, f.clock)
			if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
				t.Fatal(err)
			}
			publisher.mu.Lock()
			seenStable := false
			for _, event := range publisher.deliveries {
				if event.ID == eventID {
					seenStable = true
				}
			}
			publisher.mu.Unlock()
			if !seenStable {
				t.Fatalf("blocked reconcile event %d was not replayed", eventID)
			}
			f.runtime.mu.Lock()
			reads, rb, ex := f.runtime.historyReads, f.runtime.rollbackCalls, f.runtime.execCalls
			f.runtime.mu.Unlock()
			if reads != readsBefore || rb != rollbacks || ex != execs {
				t.Fatalf("outbox replay provider reads=%d/%d rollback=%d/%d exec=%d/%d", reads, readsBefore, rb, rollbacks, ex, execs)
			}
		})
	}
}

type retryBudgetClock struct {
	mu sync.RWMutex
	at time.Time
}

func (c *retryBudgetClock) Now() time.Time   { c.mu.RLock(); defer c.mu.RUnlock(); return c.at }
func (c *retryBudgetClock) Set(at time.Time) { c.mu.Lock(); c.at = at; c.mu.Unlock() }

type retryBudgetFixture struct {
	*leaseFaultFixture
	clock *retryBudgetClock
}

func newRetryBudgetFixture(t *testing.T, operationID string) *retryBudgetFixture {
	t.Helper()
	base := newLeaseFaultFixture(t, operationID)
	// PrepareEditRetry records its own durable current timestamp. Start the
	// controllable Host clock at that exact eligibility boundary rather than
	// assuming wall-clock fixture construction stayed in one millisecond.
	prepared := base.operation(t)
	clock := &retryBudgetClock{at: time.UnixMilli(prepared.NextAttemptAtMS + time.Second.Milliseconds())}
	base.host = newRetryBudgetHost(base.store, base.runtime, base.store, clock)
	return &retryBudgetFixture{leaseFaultFixture: base, clock: clock}
}

func newRetryBudgetHost(store *storesqlite.Store, runtime *hostEditRetryRuntime, operations agenthost.RuntimeOperationStore, clock agenthost.Clock) *agenthost.Host {
	return agenthost.New(agenthost.Config{
		CanonicalStore: sqliteCanonicalStore{Store: store}, TurnSubmissions: store, EffectiveHistory: store,
		RuntimeOperations: operations, Runtime: runtime, HistoryRuntime: runtime, GoalRuntime: runtime,
		OperationOwner: "retry-budget", Clock: clock,
	})
}

func (f *retryBudgetFixture) startUnknown(t *testing.T) storesqlite.RuntimeOperation {
	t.Helper()
	prepared := f.operation(t)
	if f.clock.Now().UnixMilli() < prepared.NextAttemptAtMS {
		f.clock.Set(time.UnixMilli(prepared.NextAttemptAtMS))
	}
	f.runtime.mu.Lock()
	f.runtime.rollbackUnknown = true
	f.runtime.mu.Unlock()
	if claimable, err := f.store.ListClaimableRuntimeOperations(t.Context(), storesqlite.ListClaimableRuntimeOperationsInput{WorkspaceID: editRetryRestartRef.WorkspaceID, NowUnixMS: f.clock.Now().UnixMilli(), Limit: 10}); err != nil || len(claimable) == 0 {
		t.Fatalf("initial claimable=%#v error=%v now=%d", claimable, err, f.clock.Now().UnixMilli())
	}
	if err := f.host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	op := f.operation(t)
	if op.Status != storesqlite.RuntimeOperationStatusPrepared || op.Attempt != 1 || op.NextAttemptAtMS <= f.clock.Now().UnixMilli() {
		t.Fatalf("unknown retry operation=%#v", op)
	}
	assertBatchOperationStatus(t, f.store, f.healthyID, storesqlite.RuntimeOperationStatusCompleted)
	return op
}

func (f *retryBudgetFixture) driveToAttempt(t *testing.T, target int) {
	t.Helper()
	for {
		op := f.operation(t)
		if op.Attempt >= target {
			return
		}
		if op.Status != storesqlite.RuntimeOperationStatusPrepared || op.NextAttemptAtMS <= 0 {
			t.Fatalf("cannot advance retry budget operation=%#v", op)
		}
		f.clock.Set(time.UnixMilli(op.NextAttemptAtMS))
		if err := f.host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
			t.Fatal(err)
		}
	}
}

func (f *retryBudgetFixture) providerCounts() (int, int) {
	f.runtime.mu.Lock()
	defer f.runtime.mu.Unlock()
	return f.runtime.rollbackCalls, f.runtime.execCalls
}

func (f *retryBudgetFixture) assertBlocked(t *testing.T) {
	t.Helper()
	op := f.operation(t)
	if op.Status != storesqlite.RuntimeOperationStatusBlocked ||
		(op.LastError != string(storesqlite.EditRetryReasonRetryBudgetExhausted) && op.LastError != string(storesqlite.EditRetryReasonProviderOutcomeUnknown)) ||
		op.NextAttemptAtMS != 0 || op.LeaseOwner != "" {
		t.Fatalf("blocked operation=%#v", op)
	}
	history, found, err := f.store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID)
	if err != nil || !found || history.OperationID != f.operationID || history.RecoveryState != storesqlite.SessionHistoryRecoveryRequired {
		t.Fatalf("blocked history=%#v found=%v error=%v", history, found, err)
	}
	availability, err := f.host.GetEditRetryAvailability(t.Context(), editRetryRestartRef)
	if err != nil || (availability.ReasonCode != agenthost.EditRetryReasonCodeRetryBudgetExhausted && availability.ReasonCode != agenthost.EditRetryReasonCodeProviderOutcomeUnknown) || len(availability.AvailableActions) != 1 || availability.AvailableActions[0] != agenthost.EditRetryRecoveryActionReconcile {
		t.Fatalf("blocked availability=%#v error=%v", availability, err)
	}
	claimable, err := f.store.ListClaimableRuntimeOperations(t.Context(), storesqlite.ListClaimableRuntimeOperationsInput{WorkspaceID: editRetryRestartRef.WorkspaceID, NowUnixMS: f.clock.Now().Add(365 * 24 * time.Hour).UnixMilli(), Limit: 10})
	if err != nil || len(claimable) != 0 {
		t.Fatalf("blocked claimable=%#v error=%v", claimable, err)
	}
}
