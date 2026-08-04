package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestEditRetryAtomicRollbackCompletionAndAudit(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")
	if _, created, err := store.PrepareRuntimeOperation(ctx, editRetryPrepare("operation-edit", "turn-original", "client-edit", 0)); err != nil || !created {
		t.Fatalf("prepare created=%v error=%v", created, err)
	}
	claimRuntimeOperation(t, store, "operation-edit", "worker-a")
	if _, changed, err := store.CaptureEditRetryPreEffectSnapshot(ctx, CaptureEditRetryPreEffectSnapshotInput{
		WorkspaceID: "ws-1", OperationID: "operation-edit", LeaseOwner: "worker-a",
		ProviderSessionID: "thread-1", ProviderTurnIDs: []string{"provider-original"}, NowUnixMS: 21,
	}); err != nil || !changed {
		t.Fatalf("capture pre-effect snapshot changed=%v error=%v", changed, err)
	}
	op, _, err := store.GetRuntimeOperation(ctx, "ws-1", "operation-edit")
	if err != nil {
		t.Fatal(err)
	}
	payload := decodeEditRetryPayloadTest(t, op)
	payload.Checkpoint = EditRetryCheckpointRollbackDispatched
	payload.BeforeProviderIDs = []string{"provider-original"}
	op, changed, err := store.MarkEditRetryRollbackDispatched(ctx, MarkEditRetryRollbackDispatchedInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
		Payload: payload, NowUnixMS: 22,
	})
	if err != nil || !changed {
		t.Fatalf("mark rollback dispatched changed=%v error=%v", changed, err)
	}
	// A repeated call only observes the durable checkpoint. It does not grant
	// another provider rollback dispatch.
	if _, changed, err := store.MarkEditRetryRollbackDispatched(ctx, MarkEditRetryRollbackDispatchedInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
		Payload: payload, NowUnixMS: 23,
	}); err != nil || changed {
		t.Fatalf("duplicate rollback checkpoint changed=%v error=%v", changed, err)
	}
	assertSessionHistory(t, store, "session-1", 0, SessionHistoryRecoveryRollbackPending)

	payload.Checkpoint = EditRetryCheckpointRollbackConfirmed
	op, changed, err = store.ConfirmEditRetryRollback(ctx, ConfirmEditRetryRollbackInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
		Payload: payload, ProviderTurnIDs: []string{}, NowUnixMS: 24,
	})
	if err != nil || !changed {
		t.Fatalf("confirm rollback changed=%v error=%v", changed, err)
	}
	assertSessionHistory(t, store, "session-1", 1, SessionHistoryRecoveryResendPending)
	assertTurnHistory(t, store, "session-1", "turn-original", TurnHistoryStateRetracted)
	if turns, err := store.ListEffectiveSessionTurns(ctx, "ws-1", "session-1"); err != nil || len(turns) != 0 {
		t.Fatalf("effective after rollback=%#v error=%v", turns, err)
	}

	seedEditRetryTurn(t, store, payload.ReplacementTurnID, "provider-replacement", 30, payload.ClientSubmitID)
	acceptEditRetrySubmitClaim(t, store, payload.ClientSubmitID, payload.ReplacementTurnID, 31)
	payload.Checkpoint = EditRetryCheckpointReplacementDispatched
	payloadMap, err := EncodeEditRetryOperationPayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	op, changed, err = store.CheckpointRuntimeOperation(ctx, CheckpointRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
		Payload: payloadMap, NowUnixMS: 33,
	})
	if err != nil || !changed {
		t.Fatalf("checkpoint replacement changed=%v error=%v", changed, err)
	}
	completion, changed, err := store.CompleteEditRetryRuntimeOperation(ctx, CompleteEditRetryRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
		ReplacementTurnID: payload.ReplacementTurnID,
		ProviderTurnID:    "provider-replacement", NowUnixMS: 34,
	})
	if err != nil || !changed || completion.Event.Kind != RuntimeOperationEventEditRetryCompleted {
		t.Fatalf("completion changed=%v value=%#v error=%v", changed, completion, err)
	}
	assertSessionHistory(t, store, "session-1", 2, SessionHistoryRecoveryReady)
	history, _, err := store.GetTurnHistory(ctx, "ws-1", "session-1", "turn-original")
	if err != nil || history.ReplacementTurnID != payload.ReplacementTurnID {
		t.Fatalf("linked history=%#v error=%v", history, err)
	}
	audit, found, err := store.GetTurn(ctx, "ws-1", "session-1", "turn-original")
	if err != nil || !found || len(audit.FileChanges) == 0 {
		t.Fatalf("audit turn=%#v found=%v error=%v", audit, found, err)
	}
}

func TestCaptureEditRetryPreEffectSnapshotIsRequiredBeforeRollbackIntent(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")
	if _, changed, err := store.PrepareEditRetry(ctx, editRetryPrepare("operation-snapshot", "turn-original", "client-snapshot", 0)); err != nil || !changed {
		t.Fatal(err)
	}
	claimRuntimeOperation(t, store, "operation-snapshot", "worker-a")
	if _, err := store.db.ExecContext(ctx, `
CREATE TRIGGER fail_edit_retry_snapshot BEFORE UPDATE ON workspace_agent_runtime_operations
WHEN NEW.operation_id='operation-snapshot' BEGIN SELECT RAISE(ABORT, 'snapshot write failed'); END;`); err != nil {
		t.Fatal(err)
	}
	input := CaptureEditRetryPreEffectSnapshotInput{WorkspaceID: "ws-1", OperationID: "operation-snapshot", LeaseOwner: "worker-a", ProviderSessionID: "thread-1", ProviderTurnIDs: []string{"provider-original"}, NowUnixMS: 22}
	if _, changed, err := store.CaptureEditRetryPreEffectSnapshot(ctx, input); err == nil || changed {
		t.Fatalf("capture changed=%v error=%v, want trigger failure", changed, err)
	}
	op, _, err := store.GetRuntimeOperation(ctx, "ws-1", "operation-snapshot")
	if err != nil {
		t.Fatal(err)
	}
	payload := decodeEditRetryPayloadTest(t, op)
	if len(payload.BeforeProviderIDs) != 0 || payload.ProviderSessionID != "" {
		t.Fatalf("failed snapshot payload=%#v", payload)
	}
	payload.Checkpoint, payload.BeforeProviderIDs, payload.ProviderSessionID = EditRetryCheckpointRollbackDispatched, []string{"provider-original"}, "thread-1"
	if _, changed, err := store.MarkEditRetryRollbackDispatched(ctx, MarkEditRetryRollbackDispatchedInput{WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a", Payload: payload, NowUnixMS: 23}); !errors.Is(err, ErrRuntimeOperationSubjectState) || changed {
		t.Fatalf("rollback intent without durable snapshot changed=%v error=%v, want subject-state rejection", changed, err)
	}
	if _, err := store.db.ExecContext(ctx, `DROP TRIGGER fail_edit_retry_snapshot`); err != nil {
		t.Fatal(err)
	}
	op, changed, err := store.CaptureEditRetryPreEffectSnapshot(ctx, input)
	if err != nil || !changed {
		t.Fatalf("retry capture op=%#v changed=%v error=%v", op, changed, err)
	}
	payload = decodeEditRetryPayloadTest(t, op)
	payload.Checkpoint = EditRetryCheckpointRollbackDispatched
	if _, changed, err := store.MarkEditRetryRollbackDispatched(ctx, MarkEditRetryRollbackDispatchedInput{WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a", Payload: payload, NowUnixMS: 24}); err != nil || !changed {
		t.Fatalf("rollback intent after snapshot changed=%v error=%v", changed, err)
	}
}

func TestEditRetryRetryReasonTransitionsAreDurable(t *testing.T) {
	ctx := context.Background()
	t.Run("defer records retry wait with a future eligibility boundary", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		seedEditRetryTurn(t, store, "turn-retry-wait", "provider-retry-wait", 20, "submit-retry-wait")
		if _, changed, err := store.PrepareEditRetry(ctx, editRetryPrepare("operation-retry-wait", "turn-retry-wait", "client-retry-wait", 0)); err != nil || !changed {
			t.Fatalf("PrepareEditRetry() changed=%v error=%v", changed, err)
		}
		claimRuntimeOperation(t, store, "operation-retry-wait", "worker-retry-wait")
		op, changed, err := store.DeferEditRetry(ctx, DeferEditRetryInput{
			WorkspaceID: "ws-1", OperationID: "operation-retry-wait", LeaseOwner: "worker-retry-wait",
			ReasonCode: EditRetryReasonRetryWait, NowUnixMS: 30, NextAttemptAtMS: 31,
		})
		if err != nil || !changed || op.Status != RuntimeOperationStatusPrepared || op.LastError != string(EditRetryReasonRetryWait) || op.NextAttemptAtMS != 31 {
			t.Fatalf("DeferEditRetry() operation=%#v changed=%v error=%v", op, changed, err)
		}
	})
	t.Run("budget block clears automatic retry eligibility", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		seedEditRetryTurn(t, store, "turn-budget", "provider-budget", 20, "submit-budget")
		if _, changed, err := store.PrepareEditRetry(ctx, editRetryPrepare("operation-budget", "turn-budget", "client-budget", 0)); err != nil || !changed {
			t.Fatalf("PrepareEditRetry() changed=%v error=%v", changed, err)
		}
		claimRuntimeOperation(t, store, "operation-budget", "worker-budget")
		op, changed, err := store.BlockEditRetry(ctx, BlockEditRetryInput{
			WorkspaceID: "ws-1", OperationID: "operation-budget", LeaseOwner: "worker-budget",
			ReasonCode: EditRetryReasonRetryBudgetExhausted, NowUnixMS: 30,
		})
		if err != nil || !changed || op.Status != RuntimeOperationStatusBlocked || op.LastError != string(EditRetryReasonRetryBudgetExhausted) || op.NextAttemptAtMS != 0 {
			t.Fatalf("BlockEditRetry() operation=%#v changed=%v error=%v", op, changed, err)
		}
	})
}

func TestBlockEditRetryProviderRejectionCommitsReceiptAndFenceAtomically(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	op, payload := prepareEditRetryReplacementPhase(t, store, "operation-provider-rejected")
	if _, _, err := store.PrepareSubmitClaim(ctx, SubmitClaimPrepare{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
		ClientSubmitID: payload.ClientSubmitID, CanonicalTurnID: payload.ReplacementTurnID, NowUnixMS: 29,
	}); err != nil {
		t.Fatal(err)
	}
	payload.ReplacementNotDispatched = true
	payload.RedispatchProofIDs = nil
	payload.RedispatchProofSID = ""
	payload.RedispatchProofAt = 0
	if _, err := store.db.ExecContext(ctx, `
CREATE TRIGGER fail_provider_rejection_event BEFORE INSERT ON workspace_agent_runtime_operation_events
WHEN NEW.operation_id='operation-provider-rejected'
BEGIN SELECT RAISE(ABORT, 'forced provider rejection event failure'); END;
`); err != nil {
		t.Fatal(err)
	}
	if _, changed, err := store.BlockEditRetry(ctx, BlockEditRetryInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
		ReasonCode: EditRetryReasonProviderRejected, Payload: &payload, NowUnixMS: 30,
	}); err == nil || changed || !strings.Contains(err.Error(), "forced provider rejection event failure") {
		t.Fatalf("failed provider rejection block changed=%v error=%v", changed, err)
	}
	current, found, err := store.GetRuntimeOperation(ctx, "ws-1", op.OperationID)
	if err != nil || !found || current.Status != RuntimeOperationStatusLeased || current.LeaseOwner != "worker-a" {
		t.Fatalf("operation after failed rejection block=%#v found=%v error=%v", current, found, err)
	}
	if rejectedPayload := decodeEditRetryPayloadTest(t, current); rejectedPayload.ReplacementNotDispatched {
		t.Fatalf("negative receipt was half committed: %#v", rejectedPayload)
	}
	claim, found, err := store.GetSubmitClaim(ctx, "ws-1", "session-1", payload.ClientSubmitID)
	if err != nil || !found || claim.Status != "prepared" {
		t.Fatalf("claim after failed rejection block=%#v found=%v error=%v, want prepared", claim, found, err)
	}
	assertSessionHistory(t, store, "session-1", 1, SessionHistoryRecoveryResendPending)
	if _, err := store.db.ExecContext(ctx, `DROP TRIGGER fail_provider_rejection_event`); err != nil {
		t.Fatal(err)
	}
	blocked, changed, err := store.BlockEditRetry(ctx, BlockEditRetryInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
		ReasonCode: EditRetryReasonProviderRejected, Payload: &payload, NowUnixMS: 31,
	})
	if err != nil || !changed || blocked.Status != RuntimeOperationStatusBlocked ||
		blocked.LastError != string(EditRetryReasonProviderRejected) || blocked.NextAttemptAtMS != 0 {
		t.Fatalf("provider rejection block=%#v changed=%v error=%v", blocked, changed, err)
	}
	storedPayload := decodeEditRetryPayloadTest(t, blocked)
	if !storedPayload.ReplacementNotDispatched || storedPayload.RedispatchProofAt != 0 {
		t.Fatalf("provider rejection payload=%#v, want durable negative receipt", storedPayload)
	}
	claim, found, err = store.GetSubmitClaim(ctx, "ws-1", "session-1", payload.ClientSubmitID)
	if err != nil || !found || claim.Status != "rejected" || claim.TurnID != payload.ReplacementTurnID {
		t.Fatalf("claim after provider rejection block=%#v found=%v error=%v, want rejected", claim, found, err)
	}
	assertSessionHistory(t, store, "session-1", 1, SessionHistoryRecoveryRequired)
}

func TestPrepareEditRetryAtomicallyFencesTheSession(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")
	prepare := editRetryPrepare("operation-prepared-fence", "turn-original", "client-prepared-fence", 0)
	if _, err := store.db.ExecContext(ctx, `
CREATE TRIGGER fail_edit_retry_prepare BEFORE INSERT ON workspace_agent_runtime_operations
WHEN NEW.operation_id = 'operation-prepared-fence'
BEGIN SELECT RAISE(ABORT, 'forced edit retry prepare failure'); END;
`); err != nil {
		t.Fatal(err)
	}
	if _, changed, err := store.PrepareEditRetry(ctx, prepare); err == nil || changed {
		t.Fatalf("PrepareEditRetry() changed=%v error=%v, want transaction failure", changed, err)
	}
	assertSessionHistory(t, store, "session-1", 0, SessionHistoryRecoveryReady)
	if _, found, err := store.GetRuntimeOperation(ctx, "ws-1", prepare.OperationID); err != nil || found {
		t.Fatalf("failed prepare operation found=%v error=%v", found, err)
	}
	if _, err := store.db.ExecContext(ctx, `DROP TRIGGER fail_edit_retry_prepare`); err != nil {
		t.Fatal(err)
	}
	op, changed, err := store.PrepareEditRetry(ctx, prepare)
	if err != nil || !changed || op.Status != RuntimeOperationStatusPrepared {
		t.Fatalf("PrepareEditRetry() operation=%#v changed=%v error=%v", op, changed, err)
	}
	assertSessionHistory(t, store, "session-1", 0, SessionHistoryRecoveryRollbackPending)
	second := editRetryPrepare("operation-prepared-fence-second", "turn-original", "client-prepared-fence-second", 0)
	if _, changed, err := store.PrepareEditRetry(ctx, second); !errors.Is(err, ErrRuntimeOperationSubjectState) || changed {
		t.Fatalf("second same-session prepare changed=%v error=%v, want fenced rejection", changed, err)
	}
}

// TestPrepareEditRetryCommitFailpointRollsBackTheCompoundTransition fails the
// final transaction participant after both the fence and operation writes have
// been staged. It is a deterministic SQLite commit-boundary regression test,
// not an in-memory mock of the transition.
func TestPrepareEditRetryCommitFailpointRollsBackTheCompoundTransition(t *testing.T) {
	participant := &failPreparedEditRetryCommitParticipant{}
	options := testOptions(&staticProjectPaths{})
	options.TransactionParticipant = participant
	store := openTestStore(t, options)
	ctx := context.Background()
	seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")
	prepare := editRetryPrepare("operation-prepare-commit-failure", "turn-original", "client-prepare-commit-failure", 0)

	if _, changed, err := store.PrepareEditRetry(ctx, prepare); err == nil || changed {
		t.Fatalf("PrepareEditRetry() changed=%v error=%v, want commit failpoint", changed, err)
	}
	assertSessionHistory(t, store, "session-1", 0, SessionHistoryRecoveryReady)
	if _, found, err := store.GetRuntimeOperation(ctx, "ws-1", prepare.OperationID); err != nil || found {
		t.Fatalf("failed prepare operation found=%v error=%v", found, err)
	}
	var events int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspace_agent_runtime_operation_events WHERE operation_id = ?`, prepare.OperationID).Scan(&events); err != nil || events != 0 {
		t.Fatalf("failed prepare outbox events=%d error=%v, want 0", events, err)
	}

	op, changed, err := store.PrepareEditRetry(ctx, prepare)
	if err != nil || !changed || op.Status != RuntimeOperationStatusPrepared {
		t.Fatalf("retry PrepareEditRetry() operation=%#v changed=%v error=%v", op, changed, err)
	}
	assertSessionHistory(t, store, "session-1", 0, SessionHistoryRecoveryRollbackPending)
	second := editRetryPrepare("operation-prepare-commit-failure-second", "turn-original", "client-prepare-commit-failure-second", 0)
	if _, changed, err := store.PrepareEditRetry(ctx, second); !errors.Is(err, ErrRuntimeOperationSubjectState) || changed {
		t.Fatalf("second owner changed=%v error=%v, want fenced rejection", changed, err)
	}
}

type failPreparedEditRetryCommitParticipant struct {
	failed bool
}

func (p *failPreparedEditRetryCommitParticipant) Participate(_ context.Context, _ TransactionWriter, delta TransactionDelta) error {
	if p.failed {
		return nil
	}
	for _, mutation := range delta.Mutations {
		if mutation.EntityKind == MutationEntityRuntimeOperation && mutation.Operation == "prepare" {
			p.failed = true
			return errors.New("injected prepared edit retry commit failure")
		}
	}
	return nil
}

func TestEditRetryCompletionRequiresReceiptAndAcceptedProvenance(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	op, payload := prepareEditRetryReplacementPhase(t, store, "operation-proof")
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: payload.ReplacementTurnID,
		Phase: TurnPhaseSubmitted, Origin: TurnOriginUserPrompt, OccurredAtUnixMS: 30,
	}); err != nil || !accepted {
		t.Fatalf("record replacement accepted=%v error=%v", accepted, err)
	}
	if _, _, err := store.RecordTurnSubmission(ctx, TurnSubmission{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: payload.ReplacementTurnID,
		ContentJSON: `[{"type":"text","text":"edited prompt"}]`, DisplayPrompt: "edited prompt",
		CapabilityRefsJSON: `[]`, TuttiModeSnapshotJSON: `null`,
		ClientSubmitID: payload.ClientSubmitID, CreatedAtUnixMS: 30, UpdatedAtUnixMS: 30,
	}); err != nil {
		t.Fatal(err)
	}
	acceptEditRetrySubmitClaim(t, store, payload.ClientSubmitID, payload.ReplacementTurnID, 31)
	if _, _, err := store.CompleteEditRetryRuntimeOperation(ctx, CompleteEditRetryRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
		ReplacementTurnID: payload.ReplacementTurnID, ProviderTurnID: "provider-replacement",
		NowUnixMS: 32,
	}); !errors.Is(err, ErrRuntimeOperationSubjectState) {
		t.Fatalf("completion without provider receipt error=%v", err)
	}
	assertSessionHistory(t, store, "session-1", 1, SessionHistoryRecoveryResendPending)
}

func TestAuthorizeEditRetryReplacementRetryEventInsertFailureRollsBack(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "authorize-event.db")
	open := func() (*sql.DB, *Store) {
		db, err := sql.Open("sqlite", path)
		if err != nil {
			t.Fatal(err)
		}
		store := New(db, testOptions(&staticProjectPaths{}))
		if err := store.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
		return db, store
	}
	db, store := open()
	op, payload := prepareEditRetryReplacementPhase(t, store, "operation-authorize-event")
	payload.ReplacementNotDispatched = true
	payloadMap, err := EncodeEditRetryOperationPayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	op, changed, err := store.CheckpointRuntimeOperation(ctx, CheckpointRuntimeOperationInput{WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a", Payload: payloadMap, NowUnixMS: 25})
	if err != nil || !changed {
		t.Fatalf("checkpoint changed=%v err=%v", changed, err)
	}
	if _, changed, err = store.ReleaseOrFailRuntimeOperation(ctx, ReleaseOrFailRuntimeOperationInput{WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a", NowUnixMS: 26, NextAttemptAtMS: 26}); err != nil || !changed {
		t.Fatalf("release changed=%v err=%v", changed, err)
	}
	if _, created, err := store.PrepareSubmitClaim(ctx, SubmitClaimPrepare{WorkspaceID: "ws-1", AgentSessionID: "session-1", ClientSubmitID: payload.ClientSubmitID, CanonicalTurnID: payload.ReplacementTurnID, NowUnixMS: 26}); err != nil || !created {
		t.Fatalf("claim created=%v err=%v", created, err)
	}
	op, _, _ = store.GetRuntimeOperation(ctx, "ws-1", op.OperationID)
	history, _, _ := store.GetSessionHistory(ctx, "ws-1", "session-1")
	beforePayload := op.Payload
	beforeVersion := op.Version
	input := AuthorizeEditRetryReplacementRetryInput{WorkspaceID: "ws-1", OperationID: op.OperationID, ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: int64(history.Revision), ClientActionID: "authorize-event", ActionIdentity: "retry_replacement:test", ReplacementTurnID: payload.ReplacementTurnID, ProviderSessionID: payload.ProviderSessionID, ProviderTurnIDs: []string{}, ProofAtUnixMS: 30, NowUnixMS: 30}
	if _, err := db.ExecContext(ctx, `CREATE TRIGGER fail_authorize_event BEFORE INSERT ON workspace_agent_runtime_operation_events WHEN NEW.operation_id = 'operation-authorize-event' BEGIN SELECT RAISE(ABORT, 'authorize event trigger hit'); END;`); err != nil {
		t.Fatal(err)
	}
	if _, changed, err := store.AuthorizeEditRetryReplacementRetry(ctx, input); err == nil || changed {
		t.Fatalf("authorize changed=%v err=%v", changed, err)
	}
	if _, err := db.ExecContext(ctx, `DROP TRIGGER fail_authorize_event`); err != nil {
		t.Fatal(err)
	}
	after, _, _ := store.GetRuntimeOperation(ctx, "ws-1", op.OperationID)
	if after.Version != beforeVersion || !reflect.DeepEqual(after.Payload, beforePayload) {
		t.Fatalf("operation half committed before=%#v after=%#v", op, after)
	}
	if h, _, _ := store.GetSessionHistory(ctx, "ws-1", "session-1"); h != history {
		t.Fatalf("history changed=%#v", h)
	}
	if _, found, err := store.GetRuntimeOperationRecoveryAction(ctx, "ws-1", op.OperationID, input.ClientActionID); err != nil || found {
		t.Fatalf("ledger found=%v err=%v", found, err)
	}
	if events, err := store.ListPendingRuntimeOperationEvents(ctx, "ws-1", 10); err != nil || len(events) != 2 {
		t.Fatalf("events=%#v err=%v", events, err)
	}
	_, changed, err = store.AuthorizeEditRetryReplacementRetry(ctx, input)
	if err != nil || !changed {
		t.Fatalf("retry changed=%v err=%v", changed, err)
	}
	events, err := store.ListPendingRuntimeOperationEvents(ctx, "ws-1", 10)
	if err != nil || len(events) != 3 {
		t.Fatalf("events=%#v err=%v", events, err)
	}
	eventID := events[2].ID
	if events[2].Kind != RuntimeOperationEventEditRetryReplacementAuthorized || events[2].Kind == RuntimeOperationEventEditRetryWake || events[2].OccurrenceKey != input.ActionIdentity {
		t.Fatalf("authorization event=%#v, want independent action occurrence", events[2])
	}
	if _, changed, err := store.AuthorizeEditRetryReplacementRetry(ctx, input); err != nil || changed {
		t.Fatalf("same action replay changed=%v error=%v", changed, err)
	}
	if replay, replayErr := store.ListPendingRuntimeOperationEvents(ctx, "ws-1", 10); replayErr != nil || len(replay) != 3 || replay[2].ID != eventID {
		t.Fatalf("same action replay events=%#v error=%v", replay, replayErr)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		db, store = open()
		events, err = store.ListPendingRuntimeOperationEvents(ctx, "ws-1", 10)
		if err != nil || len(events) != 3 || events[2].ID != eventID {
			t.Fatalf("reopen %d events=%#v err=%v", i, events, err)
		}
		if i == 0 {
			_ = db.Close()
		}
	}
}

func TestAbandonEditRetryEventInsertFailureRollsBack(t *testing.T) {
	for _, test := range []struct {
		name      string
		confirmed bool
	}{{"prepared", false}, {"rollback confirmed", true}} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			path := filepath.Join(t.TempDir(), "abandon-event.db")
			open := func() (*sql.DB, *Store) {
				db, err := sql.Open("sqlite", path)
				if err != nil {
					t.Fatal(err)
				}
				s := New(db, testOptions(&staticProjectPaths{}))
				if err := s.Migrate(ctx); err != nil {
					t.Fatal(err)
				}
				return db, s
			}
			db, s := open()
			op := prepareAbandonEventFixture(t, s, "operation-abandon-event", test.confirmed)
			h, _, _ := s.GetSessionHistory(ctx, "ws-1", "session-1")
			before := op
			beforeHistory := h
			baselineEvents, err := s.ListPendingRuntimeOperationEvents(ctx, "ws-1", 10)
			if err != nil {
				t.Fatal(err)
			}
			input := AbandonEditRetryInput{WorkspaceID: "ws-1", OperationID: op.OperationID, ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: int64(h.Revision), ClientActionID: "abandon-event", NowUnixMS: 40}
			if _, err := db.ExecContext(ctx, `CREATE TRIGGER fail_abandon_event BEFORE INSERT ON workspace_agent_runtime_operation_events WHEN NEW.operation_id='operation-abandon-event' BEGIN SELECT RAISE(ABORT,'abandon event trigger hit'); END;`); err != nil {
				t.Fatal(err)
			}
			if _, changed, err := s.AbandonEditRetry(ctx, input); err == nil || changed {
				t.Fatalf("abandon changed=%v err=%v", changed, err)
			}
			if _, err := db.ExecContext(ctx, `DROP TRIGGER fail_abandon_event`); err != nil {
				t.Fatal(err)
			}
			after, _, _ := s.GetRuntimeOperation(ctx, "ws-1", op.OperationID)
			ah, _, _ := s.GetSessionHistory(ctx, "ws-1", "session-1")
			if after.Status != before.Status || after.Result != before.Result || after.Version != before.Version || !reflect.DeepEqual(after.Payload, before.Payload) || ah != beforeHistory {
				t.Fatalf("half commit op=%#v history=%#v", after, ah)
			}
			if _, found, err := s.GetRuntimeOperationRecoveryAction(ctx, "ws-1", op.OperationID, input.ClientActionID); err != nil || found {
				t.Fatalf("ledger found=%v err=%v", found, err)
			}
			if events, err := s.ListPendingRuntimeOperationEvents(ctx, "ws-1", 10); err != nil || len(events) != len(baselineEvents) {
				t.Fatalf("events=%#v err=%v", events, err)
			}
			abandoned, changed, err := s.AbandonEditRetry(ctx, input)
			if err != nil || !changed || abandoned.Result != RuntimeOperationResultAbandoned {
				t.Fatalf("retry=%#v changed=%v err=%v", abandoned, changed, err)
			}
			events, err := s.ListPendingRuntimeOperationEvents(ctx, "ws-1", 10)
			if err != nil || len(events) != len(baselineEvents)+1 {
				t.Fatalf("events=%#v err=%v", events, err)
			}
			id := events[len(events)-1].ID
			if _, changed, err := s.AbandonEditRetry(ctx, input); err != nil || changed {
				t.Fatalf("replay changed=%v err=%v", changed, err)
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 2; i++ {
				db, s = open()
				events, err = s.ListPendingRuntimeOperationEvents(ctx, "ws-1", 10)
				if err != nil || len(events) != len(baselineEvents)+1 || events[len(events)-1].ID != id {
					t.Fatalf("reopen %d events=%#v err=%v", i, events, err)
				}
				if i == 0 {
					_ = db.Close()
				}
			}
		})
	}
}

func prepareAbandonEventFixture(t *testing.T, s *Store, id string, confirmed bool) RuntimeOperation {
	t.Helper()
	ctx := context.Background()
	seedEditRetryTurn(t, s, "turn-original", "provider-original", 20, "submit-original")
	if _, _, err := s.PrepareEditRetry(ctx, editRetryPrepare(id, "turn-original", "client-"+id, 0)); err != nil {
		t.Fatal(err)
	}
	op, _, _ := s.GetRuntimeOperation(ctx, "ws-1", id)
	if !confirmed {
		return op
	}
	now := int64(30)
	_, _, _ = s.ClaimRuntimeOperationLease(ctx, ClaimRuntimeOperationLeaseInput{WorkspaceID: "ws-1", OperationID: id, LeaseOwner: "seed", NowUnixMS: now, LeaseExpiresAtMS: now + 100})
	captureEditRetrySnapshotForTest(t, s, id, "seed", "provider-session-1", []string{"provider-original"}, now)
	op, _, _ = s.GetRuntimeOperation(ctx, "ws-1", id)
	p := decodeEditRetryPayloadTest(t, op)
	p.Checkpoint = EditRetryCheckpointRollbackDispatched
	p.BeforeProviderIDs = []string{"provider-original"}
	if _, _, err := s.MarkEditRetryRollbackDispatched(ctx, MarkEditRetryRollbackDispatchedInput{WorkspaceID: "ws-1", OperationID: id, LeaseOwner: "seed", Payload: p, NowUnixMS: now}); err != nil {
		t.Fatal(err)
	}
	p.Checkpoint = EditRetryCheckpointRollbackConfirmed
	if _, _, err := s.ConfirmEditRetryRollback(ctx, ConfirmEditRetryRollbackInput{WorkspaceID: "ws-1", OperationID: id, LeaseOwner: "seed", Payload: p, ProviderTurnIDs: nil, NowUnixMS: now + 1}); err != nil {
		t.Fatal(err)
	}
	_, _, _ = s.ReleaseOrFailRuntimeOperation(ctx, ReleaseOrFailRuntimeOperationInput{WorkspaceID: "ws-1", OperationID: id, LeaseOwner: "seed", NowUnixMS: now + 2, NextAttemptAtMS: now + 2})
	op, _, _ = s.GetRuntimeOperation(ctx, "ws-1", id)
	return op
}

func TestEditRetryAbortAndRecoveryFailureAreAtomic(t *testing.T) {
	t.Parallel()
	t.Run("pre-effect local failure restores the session fence", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		ctx := context.Background()
		seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")
		if _, _, err := store.PrepareRuntimeOperation(ctx, editRetryPrepare("operation-pre-effect", "turn-original", "client-pre-effect", 0)); err != nil {
			t.Fatal(err)
		}
		claimRuntimeOperation(t, store, "operation-pre-effect", "worker-pre-effect")
		failed, changed, err := store.AbortEditRetryRollback(ctx, AbortEditRetryRollbackInput{
			WorkspaceID: "ws-1", OperationID: "operation-pre-effect", LeaseOwner: "worker-pre-effect",
			ReasonCode: EditRetryReasonProviderUnsupported, NowUnixMS: 21,
		})
		if err != nil || !changed || failed.Status != RuntimeOperationStatusFailed {
			t.Fatalf("pre-effect abort changed=%v op=%#v error=%v", changed, failed, err)
		}
		payload, err := DecodeEditRetryOperationPayload(failed.Payload)
		if err != nil || payload.Checkpoint != EditRetryCheckpointRollbackAborted {
			t.Fatalf("pre-effect payload=%#v error=%v, want rollback_aborted", payload, err)
		}
		assertSessionHistory(t, store, "session-1", 0, SessionHistoryRecoveryReady)
		claimable, err := store.ListClaimableEditRetryOperations(ctx, ListClaimableRuntimeOperationsInput{NowUnixMS: 22})
		if err != nil {
			t.Fatal(err)
		}
		for _, operation := range claimable {
			if operation.OperationID == "operation-pre-effect" {
				t.Fatal("pre-effect failed operation remained claimable")
			}
		}
	})
	t.Run("abort proven rejection restores ready", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		ctx := context.Background()
		seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")
		if _, _, err := store.PrepareRuntimeOperation(ctx, editRetryPrepare("operation-abort", "turn-original", "client-abort", 0)); err != nil {
			t.Fatal(err)
		}
		claimRuntimeOperation(t, store, "operation-abort", "worker-a")
		op, _, _ := store.GetRuntimeOperation(ctx, "ws-1", "operation-abort")
		captureEditRetrySnapshotForTest(t, store, op.OperationID, "worker-a", "provider-session-1", []string{"provider-original"}, 21)
		op, _, _ = store.GetRuntimeOperation(ctx, "ws-1", op.OperationID)
		payload := decodeEditRetryPayloadTest(t, op)
		payload.Checkpoint = EditRetryCheckpointRollbackDispatched
		payload.BeforeProviderIDs = []string{"provider-original"}
		if _, _, err := store.MarkEditRetryRollbackDispatched(ctx, MarkEditRetryRollbackDispatchedInput{
			WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
			Payload: payload, NowUnixMS: 22,
		}); err != nil {
			t.Fatal(err)
		}
		aborted, changed, err := store.AbortEditRetryRollback(ctx, AbortEditRetryRollbackInput{
			WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
			ReasonCode:      EditRetryReasonProviderUnsupported,
			ProviderTurnIDs: []string{"provider-original"}, NowUnixMS: 23,
		})
		if err != nil || !changed || aborted.Status != RuntimeOperationStatusFailed {
			t.Fatalf("abort changed=%v op=%#v error=%v", changed, aborted, err)
		}
		assertSessionHistory(t, store, "session-1", 0, SessionHistoryRecoveryReady)
	})
	t.Run("uncertain outcome fences recovery", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		ctx := context.Background()
		seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")
		if _, _, err := store.PrepareRuntimeOperation(ctx, editRetryPrepare("operation-fail", "turn-original", "client-fail", 0)); err != nil {
			t.Fatal(err)
		}
		claimRuntimeOperation(t, store, "operation-fail", "worker-a")
		failed, changed, err := store.BlockEditRetry(ctx, BlockEditRetryInput{
			WorkspaceID: "ws-1", OperationID: "operation-fail", LeaseOwner: "worker-a",
			ReasonCode: EditRetryReasonProviderOutcomeUnknown, NowUnixMS: 22,
		})
		if err != nil || !changed || failed.LastError != string(EditRetryReasonProviderOutcomeUnknown) {
			t.Fatalf("fail recovery changed=%v op=%#v error=%v", changed, failed, err)
		}
		if failed.Status != RuntimeOperationStatusBlocked {
			t.Fatalf("fail recovery status=%q, want blocked", failed.Status)
		}
		assertSessionHistory(t, store, "session-1", 0, SessionHistoryRecoveryRequired)
	})
	t.Run("block rolls back the fence when its audit outbox cannot commit", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		ctx := context.Background()
		seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")
		if _, _, err := store.PrepareRuntimeOperation(ctx, editRetryPrepare("operation-block-rollback", "turn-original", "client-block-rollback", 0)); err != nil {
			t.Fatal(err)
		}
		claimRuntimeOperation(t, store, "operation-block-rollback", "worker-a")
		if _, err := store.db.ExecContext(ctx, `
CREATE TRIGGER fail_edit_retry_block_event BEFORE INSERT ON workspace_agent_runtime_operation_events
WHEN NEW.operation_id = 'operation-block-rollback'
BEGIN SELECT RAISE(ABORT, 'forced edit retry block event failure'); END;
`); err != nil {
			t.Fatal(err)
		}
		_, changed, err := store.BlockEditRetry(ctx, BlockEditRetryInput{
			WorkspaceID: "ws-1", OperationID: "operation-block-rollback", LeaseOwner: "worker-a",
			ReasonCode: EditRetryReasonProviderOutcomeUnknown, NowUnixMS: 22,
		})
		if err == nil || changed {
			t.Fatalf("BlockEditRetry() changed=%v error=%v, want rolled-back transaction", changed, err)
		}
		assertSessionHistory(t, store, "session-1", 0, SessionHistoryRecoveryRollbackPending)
		op, found, readErr := store.GetRuntimeOperation(ctx, "ws-1", "operation-block-rollback")
		if readErr != nil || !found || op.Status != RuntimeOperationStatusLeased || op.LeaseOwner != "worker-a" {
			t.Fatalf("operation after failed block = %#v found=%v error=%v, want original lease", op, found, readErr)
		}
	})
}

func TestBlockEditRetryNeverStealsAnotherOperationFence(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")

	// A is a historical, claimable edit-retry row that predates B's durable
	// fence. It must be contained locally rather than overwriting B when its
	// worker discovers an unknown provider outcome.
	if _, _, err := store.PrepareEditRetry(ctx, editRetryPrepare("operation-b", "turn-original", "client-b", 0)); err != nil {
		t.Fatal(err)
	}
	legacyA := editRetryPrepare("operation-a", "turn-original", "client-a", 0)
	payloadJSON, err := marshalJSONMap(legacyA.Payload)
	if err != nil {
		t.Fatal(err)
	}
	// Legacy/orphan rows can exist from before compound prepare. Seed that
	// precise historical shape without invoking the current safe transition.
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_runtime_operations (
 operation_id,workspace_id,agent_session_id,kind,status,turn_id,request_id,payload_json,next_attempt_at_unix_ms,created_at_unix_ms,updated_at_unix_ms
) VALUES (?,?,?,?, 'prepared',?,?,?,?,?,?)`, "operation-a", "ws-1", "session-1", RuntimeOperationKindEditRetry, "turn-original", "client-a", payloadJSON, int64(20), int64(20), int64(20)); err != nil {
		t.Fatal(err)
	}
	claimRuntimeOperation(t, store, "operation-a", "worker-a")
	claimRuntimeOperation(t, store, "operation-b", "worker-b")
	if _, changed, err := store.BlockEditRetry(ctx, BlockEditRetryInput{
		WorkspaceID: "ws-1", OperationID: "operation-b", LeaseOwner: "worker-b",
		ReasonCode: EditRetryReasonProviderOutcomeUnknown, NowUnixMS: 32,
	}); err != nil || !changed {
		t.Fatalf("block owner B changed=%v error=%v", changed, err)
	}

	blocked, changed, err := store.BlockEditRetry(ctx, BlockEditRetryInput{
		WorkspaceID: "ws-1", OperationID: "operation-a", LeaseOwner: "worker-a",
		ReasonCode: EditRetryReasonProviderOutcomeUnknown, NowUnixMS: 33,
	})
	if err != nil || !changed {
		t.Fatalf("block stale A changed=%v error=%v", changed, err)
	}
	if blocked.Status != RuntimeOperationStatusBlocked || blocked.LastError != string(EditRetryReasonRecoveryRequired) {
		t.Fatalf("stale operation=%#v, want locally blocked invariant", blocked)
	}
	var state, owner string
	if err := store.db.QueryRowContext(ctx, `SELECT recovery_state, operation_id FROM workspace_agent_session_history WHERE workspace_id='ws-1' AND agent_session_id='session-1'`).Scan(&state, &owner); err != nil {
		t.Fatal(err)
	}
	if state != SessionHistoryRecoveryRequired || owner != "operation-b" {
		t.Fatalf("history fence=(%q,%q), want B owner", state, owner)
	}
	ownerOp, found, err := store.GetRuntimeOperation(ctx, "ws-1", "operation-b")
	if err != nil || !found || ownerOp.Status != RuntimeOperationStatusBlocked {
		t.Fatalf("owner B=%#v found=%v error=%v", ownerOp, found, err)
	}
}

func TestBlockEditRetryFenceOwnerCASHandlesLegacyNullAndReadyOwner(t *testing.T) {
	for _, test := range []struct {
		name          string
		recoveryState string
		owner         any
		wantOwner     string
		wantReason    EditRetryReasonCode
	}{
		{name: "ready owner B", recoveryState: SessionHistoryRecoveryReady, owner: "operation-b", wantOwner: "operation-b", wantReason: EditRetryReasonRecoveryRequired},
		{name: "nonready owner B", recoveryState: SessionHistoryRecoveryRequired, owner: "operation-b", wantOwner: "operation-b", wantReason: EditRetryReasonRecoveryRequired},
		{name: "null owner", recoveryState: SessionHistoryRecoveryReady, owner: nil, wantOwner: "operation-a", wantReason: EditRetryReasonProviderOutcomeUnknown},
		{name: "empty owner", recoveryState: SessionHistoryRecoveryReady, owner: "", wantOwner: "operation-a", wantReason: EditRetryReasonProviderOutcomeUnknown},
		{name: "same owner", recoveryState: SessionHistoryRecoveryRollbackPending, owner: "operation-a", wantOwner: "operation-a", wantReason: EditRetryReasonProviderOutcomeUnknown},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := openTestStore(t, testOptions(&staticProjectPaths{}))
			ctx := t.Context()
			seedEditRetryTurn(t, store, "turn-owner-cas", "provider-owner-cas", 20, "submit-owner-cas")
			if _, _, err := store.PrepareEditRetry(ctx, editRetryPrepare("operation-a", "turn-owner-cas", "client-owner-a", 0)); err != nil {
				t.Fatal(err)
			}
			claimRuntimeOperation(t, store, "operation-a", "worker-a")
			if test.owner == nil {
				// Older local databases could carry a NULL owner even though the
				// current schema writes an empty string. Rebuild only this fixture
				// shape to exercise the read/CAS compatibility path.
				for _, statement := range []string{
					`ALTER TABLE workspace_agent_session_history RENAME TO workspace_agent_session_history_legacy_null`,
					`CREATE TABLE workspace_agent_session_history (workspace_id TEXT NOT NULL, agent_session_id TEXT NOT NULL, history_revision INTEGER NOT NULL DEFAULT 0, recovery_state TEXT NOT NULL DEFAULT 'ready', operation_id TEXT DEFAULT '', updated_at_unix_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(workspace_id,agent_session_id))`,
					`INSERT INTO workspace_agent_session_history SELECT workspace_id,agent_session_id,history_revision,recovery_state,operation_id,updated_at_unix_ms FROM workspace_agent_session_history_legacy_null`,
					`DROP TABLE workspace_agent_session_history_legacy_null`,
				} {
					if _, err := store.db.ExecContext(ctx, statement); err != nil {
						t.Fatal(err)
					}
				}
			}
			if _, err := store.db.ExecContext(ctx, `UPDATE workspace_agent_session_history SET recovery_state=?,operation_id=? WHERE workspace_id='ws-1' AND agent_session_id='session-1'`, test.recoveryState, test.owner); err != nil {
				t.Fatal(err)
			}
			blocked, changed, err := store.BlockEditRetry(ctx, BlockEditRetryInput{WorkspaceID: "ws-1", OperationID: "operation-a", LeaseOwner: "worker-a", ReasonCode: EditRetryReasonProviderOutcomeUnknown, NowUnixMS: 31})
			if err != nil || !changed || blocked.Status != RuntimeOperationStatusBlocked || blocked.LastError != string(test.wantReason) {
				t.Fatalf("blocked=%#v changed=%v error=%v", blocked, changed, err)
			}
			var state, owner string
			if err := store.db.QueryRowContext(ctx, `SELECT recovery_state,COALESCE(operation_id,'') FROM workspace_agent_session_history WHERE workspace_id='ws-1' AND agent_session_id='session-1'`).Scan(&state, &owner); err != nil {
				t.Fatal(err)
			}
			if owner != test.wantOwner {
				t.Fatalf("fence owner=%q state=%q, want owner %q", owner, state, test.wantOwner)
			}
			if test.wantOwner == "operation-a" && state != SessionHistoryRecoveryRequired {
				t.Fatalf("owning block state=%q, want recovery_required", state)
			}
		})
	}
}

func TestStaleSettlementPreservesEditRetryReplacement(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")
	prepare := editRetryPrepare("operation-stale", "turn-original", "client-stale", 0)
	if _, created, err := store.PrepareRuntimeOperation(ctx, prepare); err != nil || !created {
		t.Fatalf("prepare created=%v error=%v", created, err)
	}
	payload, err := DecodeEditRetryOperationPayload(prepare.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: payload.ReplacementTurnID,
		Phase: TurnPhaseSubmitted, Origin: TurnOriginUserPrompt, OccurredAtUnixMS: 30,
	}); err != nil || !accepted {
		t.Fatalf("record replacement accepted=%v error=%v", accepted, err)
	}
	if _, err := store.SettleStaleTurns(ctx); err != nil {
		t.Fatal(err)
	}
	replacement, found, err := store.GetTurn(ctx, "ws-1", "session-1", payload.ReplacementTurnID)
	if err != nil || !found || replacement.Phase == TurnPhaseSettled {
		t.Fatalf("replacement=%#v found=%v error=%v", replacement, found, err)
	}
}

func TestWakeDeferredEditRetryUsesRealClockAndFenceOwnership(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")
	if _, _, err := store.PrepareRuntimeOperation(ctx, editRetryPrepare("operation-wake", "turn-original", "client-wake", 0)); err != nil {
		t.Fatal(err)
	}
	claimRuntimeOperation(t, store, "operation-wake", "worker-a")
	op, _, _ := store.GetRuntimeOperation(ctx, "ws-1", "operation-wake")
	captureEditRetrySnapshotForTest(t, store, op.OperationID, "worker-a", "provider-session-1", []string{"provider-original"}, 19)
	op, _, _ = store.GetRuntimeOperation(ctx, "ws-1", op.OperationID)
	payload := decodeEditRetryPayloadTest(t, op)
	payload.Checkpoint = EditRetryCheckpointRollbackDispatched
	payload.BeforeProviderIDs = []string{"provider-original"}
	if _, _, err := store.MarkEditRetryRollbackDispatched(ctx, MarkEditRetryRollbackDispatchedInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a", Payload: payload, NowUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, changed, err := store.ReleaseOrFailRuntimeOperation(ctx, ReleaseOrFailRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a", LastError: "deferred",
		NowUnixMS: 21, NextAttemptAtMS: 100,
	}); err != nil || !changed {
		t.Fatalf("defer changed=%v error=%v", changed, err)
	}
	op, _, _ = store.GetRuntimeOperation(ctx, "ws-1", "operation-wake")
	if _, err := store.db.ExecContext(ctx, `CREATE TRIGGER fail_wake_action BEFORE INSERT ON workspace_agent_runtime_operation_recovery_actions WHEN NEW.operation_id = 'operation-wake' BEGIN SELECT RAISE(ABORT, 'forced wake action failure'); END;`); err != nil {
		t.Fatal(err)
	}
	if _, changed, err := store.WakeDeferredEditRetry(ctx, WakeDeferredEditRetryInput{WorkspaceID: "ws-1", OperationID: op.OperationID, ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: 0, ClientActionID: "wake-rollback", NowUnixMS: 30}); err == nil || changed {
		t.Fatalf("wake action transaction changed=%v error=%v, want rollback", changed, err)
	}
	if _, err := store.db.ExecContext(ctx, `DROP TRIGGER fail_wake_action`); err != nil {
		t.Fatal(err)
	}
	op, _, _ = store.GetRuntimeOperation(ctx, "ws-1", "operation-wake")
	if op.NextAttemptAtMS != 100 {
		t.Fatalf("wake rollback next attempt=%d, want 100", op.NextAttemptAtMS)
	}
	if claimable, err := store.ListClaimableEditRetryOperations(ctx, ListClaimableRuntimeOperationsInput{NowUnixMS: 99}); err != nil || len(claimable) != 0 {
		t.Fatalf("claimable before wake=%#v error=%v", claimable, err)
	}
	op, _, _ = store.GetRuntimeOperation(ctx, "ws-1", "operation-wake")
	woken, changed, err := store.WakeDeferredEditRetry(ctx, WakeDeferredEditRetryInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, ExpectedOperationVersion: op.Version,
		ExpectedHistoryRevision: 0, ClientActionID: "wake-operation-wake", NowUnixMS: 30,
	})
	if err != nil || !changed || woken.NextAttemptAtMS != 30 || woken.Status != RuntimeOperationStatusPrepared {
		t.Fatalf("wake=%#v changed=%v error=%v", woken, changed, err)
	}
	if claimable, err := store.ListClaimableEditRetryOperations(ctx, ListClaimableRuntimeOperationsInput{NowUnixMS: 30}); err != nil || len(claimable) != 1 {
		t.Fatalf("claimable after wake=%#v error=%v", claimable, err)
	}
	if replay, changed, err := store.WakeDeferredEditRetry(ctx, WakeDeferredEditRetryInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, ExpectedOperationVersion: op.Version,
		ExpectedHistoryRevision: 0, ClientActionID: "wake-operation-wake", NowUnixMS: 31,
	}); err != nil || changed || replay.OperationID != op.OperationID {
		t.Fatalf("same action wake replay=%#v changed=%v error=%v", replay, changed, err)
	}
	if _, changed, err := store.WakeDeferredEditRetry(ctx, WakeDeferredEditRetryInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, ExpectedOperationVersion: woken.Version,
		ExpectedHistoryRevision: 0, ClientActionID: "wake-operation-wake", NowUnixMS: 31,
	}); !errors.Is(err, ErrRuntimeOperationActionConflict) || changed {
		t.Fatalf("conflicting wake identity changed=%v error=%v", changed, err)
	}
	var actionKind, actionIdentity string
	if err := store.db.QueryRowContext(ctx, `SELECT action_kind, action_identity FROM workspace_agent_runtime_operation_recovery_actions WHERE workspace_id = 'ws-1' AND operation_id = 'operation-wake' AND client_action_id = 'wake-operation-wake'`).Scan(&actionKind, &actionIdentity); err != nil || actionKind != "wake" || actionIdentity == "" {
		t.Fatalf("wake action ledger kind=%q identity=%q error=%v", actionKind, actionIdentity, err)
	}
	// A later legal wake is a new durable occurrence, even though the first
	// wake was already published. The client-action ledger still makes replay
	// of either occurrence exactly one row.
	if _, claimed, err := store.ClaimRuntimeOperationLease(ctx, ClaimRuntimeOperationLeaseInput{WorkspaceID: "ws-1", OperationID: "operation-wake", LeaseOwner: "worker-b", NowUnixMS: 40, LeaseExpiresAtMS: 80}); err != nil || !claimed {
		t.Fatalf("claim second wake occurrence claimed=%v error=%v", claimed, err)
	}
	op, _, _ = store.GetRuntimeOperation(ctx, "ws-1", "operation-wake")
	if _, changed, err := store.DeferEditRetry(ctx, DeferEditRetryInput{WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-b", ReasonCode: EditRetryReasonProviderOutcomeUnknown, NowUnixMS: 40, NextAttemptAtMS: 100}); err != nil || !changed {
		t.Fatalf("defer second wake occurrence changed=%v error=%v", changed, err)
	}
	op, _, _ = store.GetRuntimeOperation(ctx, "ws-1", "operation-wake")
	if _, changed, err := store.WakeDeferredEditRetry(ctx, WakeDeferredEditRetryInput{WorkspaceID: "ws-1", OperationID: op.OperationID, ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: 0, ClientActionID: "wake-operation-wake-2", NowUnixMS: 50}); err != nil || !changed {
		t.Fatalf("second wake changed=%v error=%v", changed, err)
	}
	rows, err := store.db.QueryContext(ctx, `SELECT occurrence_key FROM workspace_agent_runtime_operation_events WHERE operation_id='operation-wake' AND kind='edit_retry_wake' ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	occurrences := make([]string, 0, 2)
	for rows.Next() {
		var occurrence string
		if err := rows.Scan(&occurrence); err != nil {
			t.Fatal(err)
		}
		occurrences = append(occurrences, occurrence)
	}
	if err := rows.Err(); err != nil || len(occurrences) != 2 || occurrences[0] == occurrences[1] {
		t.Fatalf("wake occurrences=%#v error=%v", occurrences, err)
	}
}

func TestSafeAbandonEditRetryEvidenceMatrix(t *testing.T) {
	t.Parallel()
	t.Run("prepared means rollback never dispatched", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		ctx := context.Background()
		seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")
		if _, _, err := store.PrepareRuntimeOperation(ctx, editRetryPrepare("operation-abandon-prepared", "turn-original", "client-abandon-prepared", 0)); err != nil {
			t.Fatal(err)
		}
		claimRuntimeOperation(t, store, "operation-abandon-prepared", "worker-a")
		op, _, _ := store.GetRuntimeOperation(ctx, "ws-1", "operation-abandon-prepared")
		abandoned, changed, err := store.AbandonEditRetry(ctx, AbandonEditRetryInput{WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a", ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: 0, ClientActionID: "abandon-prepared", NowUnixMS: 22})
		if err != nil || !changed || abandoned.Status != RuntimeOperationStatusCompleted || abandoned.Result != RuntimeOperationResultAbandoned {
			t.Fatalf("prepared abandon=%#v changed=%v error=%v", abandoned, changed, err)
		}
		assertSessionHistory(t, store, "session-1", 0, SessionHistoryRecoveryReady)
	})
	t.Run("confirmed rollback abandons without restoring the retracted turn", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		ctx := context.Background()
		seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")
		if _, _, err := store.PrepareRuntimeOperation(ctx, editRetryPrepare("operation-abandon-confirmed", "turn-original", "client-abandon-confirmed", 0)); err != nil {
			t.Fatal(err)
		}
		claimRuntimeOperation(t, store, "operation-abandon-confirmed", "worker-a")
		op, _, _ := store.GetRuntimeOperation(ctx, "ws-1", "operation-abandon-confirmed")
		captureEditRetrySnapshotForTest(t, store, op.OperationID, "worker-a", "provider-session-1", []string{"provider-original"}, 21)
		op, _, _ = store.GetRuntimeOperation(ctx, "ws-1", op.OperationID)
		payload := decodeEditRetryPayloadTest(t, op)
		payload.Checkpoint, payload.BeforeProviderIDs, payload.ProviderSessionID = EditRetryCheckpointRollbackDispatched, []string{"provider-original"}, "provider-session-1"
		if _, _, err := store.MarkEditRetryRollbackDispatched(ctx, MarkEditRetryRollbackDispatchedInput{WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a", Payload: payload, NowUnixMS: 22}); err != nil {
			t.Fatal(err)
		}
		payload.Checkpoint = EditRetryCheckpointRollbackConfirmed
		if _, _, err := store.ConfirmEditRetryRollback(ctx, ConfirmEditRetryRollbackInput{WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a", Payload: payload, ProviderTurnIDs: []string{}, NowUnixMS: 23}); err != nil {
			t.Fatal(err)
		}
		op, _, _ = store.GetRuntimeOperation(ctx, "ws-1", op.OperationID)
		abandoned, changed, err := store.AbandonEditRetry(ctx, AbandonEditRetryInput{WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a", ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: 1, ClientActionID: "abandon-confirmed", NowUnixMS: 24})
		if err != nil || !changed || abandoned.Result != RuntimeOperationResultAbandoned {
			t.Fatalf("confirmed abandon=%#v changed=%v error=%v", abandoned, changed, err)
		}
		assertSessionHistory(t, store, "session-1", 1, SessionHistoryRecoveryReady)
		assertTurnHistory(t, store, "session-1", "turn-original", TurnHistoryStateRetracted)
	})
	t.Run("unknown replacement dispatch cannot abandon", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		ctx := context.Background()
		op, _ := prepareEditRetryReplacementPhase(t, store, "operation-abandon-unknown")
		_, changed, err := store.AbandonEditRetry(ctx, AbandonEditRetryInput{WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a", ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: 1, ClientActionID: "abandon-unknown", NowUnixMS: 25})
		if !errors.Is(err, ErrRuntimeOperationSubjectState) || changed {
			t.Fatalf("unknown replacement abandon changed=%v error=%v, want rejection", changed, err)
		}
		assertSessionHistory(t, store, "session-1", 1, SessionHistoryRecoveryResendPending)
	})
	t.Run("confirmed rollback plus authoritative replacement non-dispatch can abandon", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		ctx := context.Background()
		op, payload := prepareEditRetryReplacementPhase(t, store, "operation-abandon-not-dispatched")
		payload.ReplacementNotDispatched = true
		payloadMap, err := EncodeEditRetryOperationPayload(payload)
		if err != nil {
			t.Fatal(err)
		}
		op, changed, err := store.CheckpointRuntimeOperation(ctx, CheckpointRuntimeOperationInput{
			WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a", Payload: payloadMap, NowUnixMS: 25,
		})
		if err != nil || !changed {
			t.Fatalf("checkpoint authoritative non-dispatch changed=%v error=%v", changed, err)
		}
		abandoned, changed, err := store.AbandonEditRetry(ctx, AbandonEditRetryInput{
			WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a", ExpectedOperationVersion: op.Version,
			ExpectedHistoryRevision: 1, ClientActionID: "abandon-not-dispatched", NowUnixMS: 26,
		})
		if err != nil || !changed || abandoned.Result != RuntimeOperationResultAbandoned {
			t.Fatalf("authoritative non-dispatch abandon=%#v changed=%v error=%v", abandoned, changed, err)
		}
		assertSessionHistory(t, store, "session-1", 1, SessionHistoryRecoveryReady)
		assertTurnHistory(t, store, "session-1", "turn-original", TurnHistoryStateRetracted)
	})
}

func TestEditRetryTypedPayloadCodecAndReasonValidation(t *testing.T) {
	t.Parallel()
	payload := EditRetryOperationPayload{
		ClientOperationID: "client-1", EditedText: " \n edited \t",
		ReplacementTurnID: "turn-replacement", ClientSubmitID: "edit-retry:operation-1",
		ExpectedRevision: 2, Checkpoint: EditRetryCheckpointPrepared,
	}
	encoded, err := EncodeEditRetryOperationPayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeEditRetryOperationPayload(encoded)
	if err != nil || decoded.EditedText != payload.EditedText {
		t.Fatalf("decoded=%#v error=%v", decoded, err)
	}
	if err := decoded.Validate("operation-1"); err != nil {
		t.Fatal(err)
	}
	encoded["unknown"] = true
	if _, err := DecodeEditRetryOperationPayload(encoded); err == nil {
		t.Fatal("unknown durable payload field was accepted")
	}
	if err := EditRetryReasonReplacementNotProvenAbsent.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := EditRetryReasonCode("ad_hoc_text").Validate(); err == nil {
		t.Fatal("unknown reason code was accepted")
	}
}

func TestReconcileBlockedEditRetryValidatesCanonicalCheckpointCombinations(t *testing.T) {
	ctx := context.Background()
	t.Run("source present never restores a retracted source", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		op, _ := prepareEditRetryReplacementPhase(t, store, "operation-source-present")
		blocked, changed, err := store.BlockEditRetry(ctx, BlockEditRetryInput{
			WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
			ReasonCode: EditRetryReasonProviderOutcomeUnknown, NowUnixMS: 30,
		})
		if err != nil || !changed {
			t.Fatalf("block=%#v changed=%v error=%v", blocked, changed, err)
		}
		_, changed, err = store.ReconcileBlockedEditRetry(ctx, ReconcileBlockedEditRetryInput{
			WorkspaceID: "ws-1", OperationID: blocked.OperationID, ExpectedOperationVersion: blocked.Version,
			ExpectedHistoryRevision: 1, ClientActionID: "source-present", ActionIdentity: "reconcile:source-present",
			Disposition: BlockedEditRetryReconcileSourcePresent, ProviderSessionID: "provider-session-1",
			ProviderTurnIDs: []string{"provider-original"}, NowUnixMS: 31,
		})
		if !errors.Is(err, ErrRuntimeOperationSubjectState) || changed {
			t.Fatalf("source-present reconciliation changed=%v error=%v, want fail closed", changed, err)
		}
		current, found, err := store.GetRuntimeOperation(ctx, "ws-1", blocked.OperationID)
		if err != nil || !found || current.Version != blocked.Version || current.Status != RuntimeOperationStatusBlocked {
			t.Fatalf("operation after rejected source-present=%#v found=%v error=%v", current, found, err)
		}
		assertSessionHistory(t, store, "session-1", 1, SessionHistoryRecoveryRequired)
		assertTurnHistory(t, store, "session-1", "turn-original", TurnHistoryStateRetracted)
	})
	t.Run("replacement absence advances the exact authorization checkpoint", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		op, payload := prepareEditRetryReplacementPhase(t, store, "operation-replacement-absent")
		payload.RedispatchProofIDs = []string{"stale-provider-replacement"}
		payload.RedispatchProofSID = "provider-session-1"
		payload.RedispatchProofAt = 29
		payloadMap, err := EncodeEditRetryOperationPayload(payload)
		if err != nil {
			t.Fatal(err)
		}
		if _, changed, err := store.CheckpointRuntimeOperation(ctx, CheckpointRuntimeOperationInput{
			WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
			Payload: payloadMap, NowUnixMS: 29,
		}); err != nil || !changed {
			t.Fatalf("seed stale redispatch proof changed=%v error=%v", changed, err)
		}
		blocked, changed, err := store.BlockEditRetry(ctx, BlockEditRetryInput{
			WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
			ReasonCode: EditRetryReasonProviderOutcomeUnknown, NowUnixMS: 30,
		})
		if err != nil || !changed {
			t.Fatalf("block=%#v changed=%v error=%v", blocked, changed, err)
		}
		reconciled, changed, err := store.ReconcileBlockedEditRetry(ctx, ReconcileBlockedEditRetryInput{
			WorkspaceID: "ws-1", OperationID: blocked.OperationID, ExpectedOperationVersion: blocked.Version,
			ExpectedHistoryRevision: 1, ClientActionID: "replacement-absent", ActionIdentity: "reconcile:replacement-absent",
			Disposition: BlockedEditRetryReconcileReplacementAbsent, ProviderSessionID: "provider-session-1",
			ProviderTurnIDs: []string{}, NowUnixMS: 31,
		})
		if err != nil || !changed || reconciled.Status != RuntimeOperationStatusBlocked {
			t.Fatalf("reconcile=%#v changed=%v error=%v", reconciled, changed, err)
		}
		payload = decodeEditRetryPayloadTest(t, reconciled)
		if payload.Checkpoint != EditRetryCheckpointReplacementDispatched || !payload.ReplacementNotDispatched || payload.RedispatchProofAt != 0 || len(payload.RedispatchProofIDs) != 0 || payload.RedispatchProofSID != "" {
			t.Fatalf("absence payload=%#v, want durable replacement-dispatched absence", payload)
		}
		assertSessionHistory(t, store, "session-1", 1, SessionHistoryRecoveryResendPending)
		assertTurnHistory(t, store, "session-1", "turn-original", TurnHistoryStateRetracted)
		_, duplicate, err := store.ReconcileBlockedEditRetry(ctx, ReconcileBlockedEditRetryInput{
			WorkspaceID: "ws-1", OperationID: blocked.OperationID, ExpectedOperationVersion: blocked.Version,
			ExpectedHistoryRevision: 1, ClientActionID: "replacement-absent", ActionIdentity: "reconcile:replacement-absent",
			Disposition: BlockedEditRetryReconcileReplacementAbsent, ProviderSessionID: "provider-session-1",
			ProviderTurnIDs: []string{}, NowUnixMS: 32,
		})
		if err != nil || duplicate {
			t.Fatalf("duplicate absence reconciliation changed=%v error=%v", duplicate, err)
		}
		if _, _, err := store.ReconcileBlockedEditRetry(ctx, ReconcileBlockedEditRetryInput{
			WorkspaceID: "ws-1", OperationID: blocked.OperationID, ExpectedOperationVersion: reconciled.Version,
			ExpectedHistoryRevision: 1, ClientActionID: "replacement-absent", ActionIdentity: "reconcile:other",
			Disposition: BlockedEditRetryReconcileUnknown, NowUnixMS: 32,
		}); !errors.Is(err, ErrRuntimeOperationActionConflict) {
			t.Fatalf("same action id different identity error=%v, want conflict", err)
		}
	})
	t.Run("replacement present completes only a correlated canonical receipt", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		op, payload := prepareEditRetryReplacementPhase(t, store, "operation-replacement-present")
		seedEditRetryTurn(t, store, payload.ReplacementTurnID, "provider-replacement", 30, payload.ClientSubmitID)
		if _, err := store.db.ExecContext(ctx, `DELETE FROM workspace_agent_turn_submissions WHERE workspace_id='ws-1' AND agent_session_id='session-1' AND turn_id=?`, payload.ReplacementTurnID); err != nil {
			t.Fatal(err)
		}
		if _, created, err := store.PrepareSubmitClaim(ctx, SubmitClaimPrepare{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", ClientSubmitID: payload.ClientSubmitID,
			CanonicalTurnID: payload.ReplacementTurnID, NowUnixMS: 31,
		}); err != nil || !created {
			t.Fatalf("prepare replacement submit claim created=%v error=%v", created, err)
		}
		blocked, changed, err := store.BlockEditRetry(ctx, BlockEditRetryInput{
			WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
			ReasonCode: EditRetryReasonProviderOutcomeUnknown, NowUnixMS: 32,
		})
		if err != nil || !changed {
			t.Fatalf("block=%#v changed=%v error=%v", blocked, changed, err)
		}
		completed, changed, err := store.ReconcileBlockedEditRetry(ctx, ReconcileBlockedEditRetryInput{
			WorkspaceID: "ws-1", OperationID: blocked.OperationID, ExpectedOperationVersion: blocked.Version,
			ExpectedHistoryRevision: 1, ClientActionID: "replacement-present", ActionIdentity: "reconcile:replacement-present",
			Disposition: BlockedEditRetryReconcileReplacementPresent, ProviderSessionID: "provider-session-1",
			ProviderTurnIDs: []string{"provider-replacement"}, ProviderTurnID: "provider-replacement",
			ReplacementSubmission: &TurnSubmission{
				WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: payload.ReplacementTurnID,
				ContentJSON: `[ {"type":"text","text":"edited prompt"} ]`, DisplayPrompt: "edited prompt",
				CapabilityRefsJSON: `[]`, TuttiModeSnapshotJSON: `null`, ClientSubmitID: payload.ClientSubmitID,
			}, NowUnixMS: 33,
		})
		if err != nil || !changed || completed.Status != RuntimeOperationStatusCompleted || completed.Result != RuntimeOperationResultApplied {
			t.Fatalf("complete=%#v changed=%v error=%v", completed, changed, err)
		}
		claim, found, err := store.GetSubmitClaim(ctx, "ws-1", "session-1", payload.ClientSubmitID)
		if err != nil || !found || claim.Status != "accepted" || claim.TurnID != payload.ReplacementTurnID {
			t.Fatalf("replacement submit claim=%#v found=%v error=%v", claim, found, err)
		}
		submission, found, err := store.GetTurnSubmission(ctx, "ws-1", "session-1", payload.ReplacementTurnID)
		if err != nil || !found || submission.ClientSubmitID != payload.ClientSubmitID || submission.DisplayPrompt != "edited prompt" {
			t.Fatalf("repaired replacement submission=%#v found=%v error=%v", submission, found, err)
		}
		assertSessionHistory(t, store, "session-1", 2, SessionHistoryRecoveryReady)
		turnHistory, found, err := store.GetTurnHistory(ctx, "ws-1", "session-1", "turn-original")
		if err != nil || !found || turnHistory.ReplacementTurnID != payload.ReplacementTurnID {
			t.Fatalf("source history=%#v found=%v error=%v", turnHistory, found, err)
		}
	})
	t.Run("replacement present rejects a retracted replacement canonical turn", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		op, payload := prepareEditRetryReplacementPhase(t, store, "operation-replacement-history-mismatch")
		seedEditRetryTurn(t, store, payload.ReplacementTurnID, "provider-replacement", 30, payload.ClientSubmitID)
		acceptEditRetrySubmitClaim(t, store, payload.ClientSubmitID, payload.ReplacementTurnID, 31)
		if _, err := store.db.ExecContext(ctx, `UPDATE workspace_agent_turn_history SET history_state='retracted',retracted_by_operation_id='other-operation' WHERE workspace_id='ws-1' AND agent_session_id='session-1' AND turn_id=?`, payload.ReplacementTurnID); err != nil {
			t.Fatal(err)
		}
		blocked, changed, err := store.BlockEditRetry(ctx, BlockEditRetryInput{WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a", ReasonCode: EditRetryReasonProviderOutcomeUnknown, NowUnixMS: 32})
		if err != nil || !changed {
			t.Fatalf("block=%#v changed=%v error=%v", blocked, changed, err)
		}
		_, changed, err = store.ReconcileBlockedEditRetry(ctx, ReconcileBlockedEditRetryInput{WorkspaceID: "ws-1", OperationID: blocked.OperationID, ExpectedOperationVersion: blocked.Version, ExpectedHistoryRevision: 1, ClientActionID: "replacement-history-mismatch", ActionIdentity: "reconcile:replacement-present", Disposition: BlockedEditRetryReconcileReplacementPresent, ProviderSessionID: "provider-session-1", ProviderTurnIDs: []string{"provider-replacement"}, ProviderTurnID: "provider-replacement", NowUnixMS: 33})
		if !errors.Is(err, ErrRuntimeOperationSubjectState) || changed {
			t.Fatalf("mismatched replacement history changed=%v error=%v, want fail closed", changed, err)
		}
		assertSessionHistory(t, store, "session-1", 1, SessionHistoryRecoveryRequired)
	})
	t.Run("replacement present rejects an already linked replacement turn", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		op, payload := prepareEditRetryReplacementPhase(t, store, "operation-replacement-linked")
		seedEditRetryTurn(t, store, payload.ReplacementTurnID, "provider-replacement", 30, payload.ClientSubmitID)
		acceptEditRetrySubmitClaim(t, store, payload.ClientSubmitID, payload.ReplacementTurnID, 31)
		if _, err := store.db.ExecContext(ctx, `UPDATE workspace_agent_turn_history SET replacement_turn_id='other-replacement' WHERE workspace_id='ws-1' AND agent_session_id='session-1' AND turn_id=?`, payload.ReplacementTurnID); err != nil {
			t.Fatal(err)
		}
		blocked, changed, err := store.BlockEditRetry(ctx, BlockEditRetryInput{WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a", ReasonCode: EditRetryReasonProviderOutcomeUnknown, NowUnixMS: 32})
		if err != nil || !changed {
			t.Fatalf("block=%#v changed=%v error=%v", blocked, changed, err)
		}
		_, changed, err = store.ReconcileBlockedEditRetry(ctx, ReconcileBlockedEditRetryInput{WorkspaceID: "ws-1", OperationID: blocked.OperationID, ExpectedOperationVersion: blocked.Version, ExpectedHistoryRevision: 1, ClientActionID: "replacement-linked", ActionIdentity: "reconcile:replacement-present", Disposition: BlockedEditRetryReconcileReplacementPresent, ProviderSessionID: "provider-session-1", ProviderTurnIDs: []string{"provider-replacement"}, ProviderTurnID: "provider-replacement", NowUnixMS: 33})
		if !errors.Is(err, ErrRuntimeOperationSubjectState) || changed {
			t.Fatalf("linked replacement changed=%v error=%v, want fail closed", changed, err)
		}
		assertSessionHistory(t, store, "session-1", 1, SessionHistoryRecoveryRequired)
	})
}

func TestInsertRuntimeOperationEventIsIdempotent(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	op, _ := prepareEditRetryReplacementPhase(t, store, "operation-event-idempotent")
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	first, err := insertRuntimeOperationEventTx(ctx, tx, op, RuntimeOperationEventEditRetryRecovery, map[string]any{
		"turnId": op.TurnID, "reasonCode": string(EditRetryReasonProviderOutcomeUnknown), "historyRevision": 1,
	}, 30)
	if err != nil {
		_ = tx.Rollback()
		t.Fatalf("first event insert: %v", err)
	}
	second, err := insertRuntimeOperationEventTx(ctx, tx, op, RuntimeOperationEventEditRetryRecovery, map[string]any{
		"turnId": op.TurnID, "reasonCode": string(EditRetryReasonProviderOutcomeUnknown), "historyRevision": 1,
	}, 31)
	if err != nil {
		_ = tx.Rollback()
		t.Fatalf("duplicate event insert: %v", err)
	}
	if first.ID != second.ID || first.CreatedAtUnixMS != second.CreatedAtUnixMS {
		_ = tx.Rollback()
		t.Fatalf("duplicate event=%#v, first=%#v; expected the original event", second, first)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspace_agent_runtime_operation_events WHERE operation_id=? AND kind=?`, op.OperationID, RuntimeOperationEventEditRetryRecovery).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("event count=%d, want 1", count)
	}
}

func TestReconcileBlockedEditRetryEventInsertFailureRollsBack(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	op, _ := prepareEditRetryReplacementPhase(t, store, "operation-reconcile-event")
	blocked, changed, err := store.BlockEditRetry(ctx, BlockEditRetryInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
		ReasonCode: EditRetryReasonProviderOutcomeUnknown, NowUnixMS: 30,
	})
	if err != nil || !changed {
		t.Fatalf("block=%#v changed=%v error=%v", blocked, changed, err)
	}
	if _, err := store.db.ExecContext(ctx, `CREATE TRIGGER fail_blocked_reconcile_event BEFORE INSERT ON workspace_agent_runtime_operation_events WHEN NEW.operation_id='operation-reconcile-event' BEGIN SELECT RAISE(ABORT, 'forced blocked reconcile event failure'); END;`); err != nil {
		t.Fatal(err)
	}
	input := ReconcileBlockedEditRetryInput{
		WorkspaceID: "ws-1", OperationID: blocked.OperationID, ExpectedOperationVersion: blocked.Version,
		ExpectedHistoryRevision: 1, ClientActionID: "reconcile-event", ActionIdentity: "reconcile:replacement-absent",
		Disposition: BlockedEditRetryReconcileReplacementAbsent, ProviderSessionID: "provider-session-1", NowUnixMS: 31,
	}
	if _, changed, err := store.ReconcileBlockedEditRetry(ctx, input); err == nil || changed || !strings.Contains(err.Error(), "forced blocked reconcile event failure") {
		t.Fatalf("failed reconcile changed=%v error=%v", changed, err)
	}
	current, found, err := store.GetRuntimeOperation(ctx, "ws-1", blocked.OperationID)
	if err != nil || !found || current.Version != blocked.Version {
		t.Fatalf("operation after event failure=%#v found=%v error=%v", current, found, err)
	}
	payload := decodeEditRetryPayloadTest(t, current)
	if payload.ReplacementNotDispatched {
		t.Fatalf("absence proof was half committed: %#v", payload)
	}
	assertSessionHistory(t, store, "session-1", 1, SessionHistoryRecoveryRequired)
	assertTurnHistory(t, store, "session-1", "turn-original", TurnHistoryStateRetracted)
	var actions, events int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspace_agent_runtime_operation_recovery_actions WHERE operation_id=?`, blocked.OperationID).Scan(&actions); err != nil || actions != 0 {
		t.Fatalf("action ledger=%d error=%v", actions, err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspace_agent_runtime_operation_events WHERE operation_id=? AND kind='edit_retry_wake'`, blocked.OperationID).Scan(&events); err != nil || events != 0 {
		t.Fatalf("events=%d error=%v", events, err)
	}
	if _, err := store.db.ExecContext(ctx, `DROP TRIGGER fail_blocked_reconcile_event`); err != nil {
		t.Fatal(err)
	}
	if _, changed, err := store.ReconcileBlockedEditRetry(ctx, input); err != nil || !changed {
		t.Fatalf("retry after event failure changed=%v error=%v", changed, err)
	}
}

func prepareEditRetryReplacementPhase(t *testing.T, store *Store, operationID string) (RuntimeOperation, EditRetryOperationPayload) {
	t.Helper()
	ctx := context.Background()
	seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")
	if _, created, err := store.PrepareRuntimeOperation(ctx, editRetryPrepare(operationID, "turn-original", "client-"+operationID, 0)); err != nil || !created {
		t.Fatalf("prepare created=%v error=%v", created, err)
	}
	claimRuntimeOperation(t, store, operationID, "worker-a")
	captureEditRetrySnapshotForTest(t, store, operationID, "worker-a", "provider-session-1", []string{"provider-original"}, 21)
	op, _, err := store.GetRuntimeOperation(ctx, "ws-1", operationID)
	if err != nil {
		t.Fatal(err)
	}
	payload := decodeEditRetryPayloadTest(t, op)
	payload.Checkpoint = EditRetryCheckpointRollbackDispatched
	payload.BeforeProviderIDs = []string{"provider-original"}
	payload.ProviderSessionID = "provider-session-1"
	_, _, err = store.MarkEditRetryRollbackDispatched(ctx, MarkEditRetryRollbackDispatchedInput{
		WorkspaceID: "ws-1", OperationID: operationID, LeaseOwner: "worker-a",
		Payload: payload, NowUnixMS: 22,
	})
	if err != nil {
		t.Fatal(err)
	}
	payload.Checkpoint = EditRetryCheckpointRollbackConfirmed
	_, _, err = store.ConfirmEditRetryRollback(ctx, ConfirmEditRetryRollbackInput{
		WorkspaceID: "ws-1", OperationID: operationID, LeaseOwner: "worker-a",
		Payload: payload, ProviderTurnIDs: []string{}, NowUnixMS: 23,
	})
	if err != nil {
		t.Fatal(err)
	}
	payload.Checkpoint = EditRetryCheckpointReplacementDispatched
	payloadMap, err := EncodeEditRetryOperationPayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	op, _, err = store.CheckpointRuntimeOperation(ctx, CheckpointRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: operationID, LeaseOwner: "worker-a",
		Payload: payloadMap, NowUnixMS: 24,
	})
	if err != nil {
		t.Fatal(err)
	}
	return op, payload
}

func editRetryPrepare(operationID, turnID, clientOperationID string, revision int64) RuntimeOperationPrepare {
	payload := EditRetryOperationPayload{
		ClientOperationID: clientOperationID, EditedText: "edited prompt",
		ReplacementTurnID: "turn-replacement", ClientSubmitID: "edit-retry:" + operationID,
		ExpectedRevision: revision, Checkpoint: EditRetryCheckpointPrepared,
		DispatchAttempt: 1,
	}
	payloadMap, err := EncodeEditRetryOperationPayload(payload)
	if err != nil {
		panic(err)
	}
	return RuntimeOperationPrepare{
		OperationID: operationID, WorkspaceID: "ws-1", AgentSessionID: "session-1",
		Kind: RuntimeOperationKindEditRetry, TurnID: turnID, RequestID: clientOperationID,
		Payload: payloadMap, OccurredAtMS: 10,
	}
}

func seedEditRetryTurn(t *testing.T, store *Store, turnID, providerTurnID string, occurredAt int64, clientSubmitID string) {
	t.Helper()
	ctx := context.Background()
	if _, found, err := store.GetSession(ctx, "ws-1", "session-1"); err != nil {
		t.Fatal(err)
	} else if !found {
		seedTurnTestSession(t, store, "ws-1", "session-1")
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: turnID,
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, Origin: TurnOriginUserPrompt,
		FileChanges:     map[string]any{"files": []any{turnID + ".txt"}},
		StartedAtUnixMS: occurredAt, SettledAtUnixMS: occurredAt + 1, OccurredAtUnixMS: occurredAt + 1,
	}); err != nil || !accepted {
		t.Fatalf("seed turn accepted=%v error=%v", accepted, err)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET root_provider_turn_id = ?, root_provider_turn_phase = 'completed',
    root_provider_turn_outcome = 'completed', root_provider_turn_updated_at_unix_ms = ?
WHERE workspace_id = 'ws-1' AND agent_session_id = 'session-1' AND turn_id = ?
`, providerTurnID, occurredAt+1, turnID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RecordTurnSubmission(ctx, TurnSubmission{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: turnID,
		ContentJSON: `[{"type":"text","text":"original"}]`, DisplayPrompt: "original",
		CapabilityRefsJSON: `[]`, TuttiModeSnapshotJSON: `null`,
		ClientSubmitID: clientSubmitID, CreatedAtUnixMS: occurredAt + 1, UpdatedAtUnixMS: occurredAt + 1,
	}); err != nil {
		t.Fatal(err)
	}
}

func acceptEditRetrySubmitClaim(t *testing.T, store *Store, clientSubmitID, turnID string, now int64) {
	t.Helper()
	ctx := context.Background()
	if _, _, err := store.PrepareSubmitClaim(ctx, SubmitClaimPrepare{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
		ClientSubmitID: clientSubmitID, CanonicalTurnID: turnID, NowUnixMS: now,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.AcceptSubmitClaim(ctx, "ws-1", "session-1", clientSubmitID, turnID, now+1); err != nil {
		t.Fatal(err)
	}
}

func decodeEditRetryPayloadTest(t *testing.T, op RuntimeOperation) EditRetryOperationPayload {
	t.Helper()
	payload, err := DecodeEditRetryOperationPayload(op.Payload)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func captureEditRetrySnapshotForTest(t *testing.T, store *Store, operationID, owner, providerSessionID string, providerTurnIDs []string, now int64) {
	t.Helper()
	if _, changed, err := store.CaptureEditRetryPreEffectSnapshot(context.Background(), CaptureEditRetryPreEffectSnapshotInput{
		WorkspaceID: "ws-1", OperationID: operationID, LeaseOwner: owner,
		ProviderSessionID: providerSessionID, ProviderTurnIDs: providerTurnIDs, NowUnixMS: now,
	}); err != nil || !changed {
		t.Fatalf("capture pre-effect snapshot changed=%v error=%v", changed, err)
	}
}
