package storesqlite

import (
	"context"
	"errors"
	"testing"
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

func TestEditRetryReplacementRedispatchConsumesProofAtomically(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	op, payload := prepareEditRetryReplacementPhase(t, store, "operation-redispatch")
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: payload.ReplacementTurnID,
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeFailed, Origin: TurnOriginUserPrompt,
		ErrorMessage: "transport failed before receipt", OccurredAtUnixMS: 30,
	}); err != nil || !accepted {
		t.Fatalf("record failed replacement accepted=%v error=%v", accepted, err)
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

	payload.RedispatchAllowed = true
	payload.RedispatchProofAt = 35
	payload.RedispatchProofSID = payload.ProviderSessionID
	payload.RedispatchProofIDs = []string{}
	payloadMap, err := EncodeEditRetryOperationPayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	op, changed, err := store.CheckpointRuntimeOperation(ctx, CheckpointRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
		Payload: payloadMap, NowUnixMS: 35,
	})
	if err != nil || !changed {
		t.Fatalf("proof checkpoint changed=%v error=%v", changed, err)
	}
	op, changed, err = store.PrepareEditRetryReplacementRedispatch(ctx, PrepareEditRetryReplacementRedispatchInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
		ReplacementTurnID: payload.ReplacementTurnID, NowUnixMS: 36,
	})
	if err != nil || !changed {
		t.Fatalf("redispatch prepare changed=%v error=%v", changed, err)
	}
	if _, found, err := store.GetTurn(ctx, "ws-1", "session-1", payload.ReplacementTurnID); err != nil || found {
		t.Fatalf("failed placeholder found=%v error=%v", found, err)
	}
	if _, found, err := store.GetSubmitClaim(ctx, "ws-1", "session-1", payload.ClientSubmitID); err != nil || found {
		t.Fatalf("stale accepted claim found=%v error=%v", found, err)
	}
	stored := decodeEditRetryPayloadTest(t, op)
	if stored.RedispatchReadyAt != stored.RedispatchProofAt || stored.DispatchAttempt != 2 {
		t.Fatalf("redispatch checkpoint=%#v", stored)
	}
	if _, changed, err := store.PrepareEditRetryReplacementRedispatch(ctx, PrepareEditRetryReplacementRedispatchInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
		ReplacementTurnID: payload.ReplacementTurnID, NowUnixMS: 37,
	}); err != nil || changed {
		t.Fatalf("duplicate proof consumption changed=%v error=%v", changed, err)
	}
}

func TestEditRetryReplacementRedispatchReusesPreparedClaimWithoutLocalTurn(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	op, payload := prepareEditRetryReplacementPhase(t, store, "operation-not-dispatched")
	claim, created, err := store.PrepareSubmitClaim(ctx, SubmitClaimPrepare{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
		ClientSubmitID: payload.ClientSubmitID, CanonicalTurnID: payload.ReplacementTurnID,
		NowUnixMS: 30,
	})
	if err != nil || !created || claim.Status != "prepared" {
		t.Fatalf("prepare claim created=%v claim=%#v error=%v", created, claim, err)
	}

	payload.RedispatchAllowed = true
	payload.RedispatchProofAt = 35
	payload.RedispatchProofSID = payload.ProviderSessionID
	payload.RedispatchProofIDs = []string{}
	payloadMap, err := EncodeEditRetryOperationPayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	op, changed, err := store.CheckpointRuntimeOperation(ctx, CheckpointRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
		Payload: payloadMap, NowUnixMS: 35,
	})
	if err != nil || !changed {
		t.Fatalf("proof checkpoint changed=%v error=%v", changed, err)
	}
	op, changed, err = store.PrepareEditRetryReplacementRedispatch(
		ctx,
		PrepareEditRetryReplacementRedispatchInput{
			WorkspaceID: "ws-1", OperationID: op.OperationID, LeaseOwner: "worker-a",
			ReplacementTurnID: payload.ReplacementTurnID, NowUnixMS: 36,
		},
	)
	if err != nil || !changed {
		t.Fatalf("redispatch prepare changed=%v error=%v", changed, err)
	}
	claim, found, err := store.GetSubmitClaim(
		ctx, "ws-1", "session-1", payload.ClientSubmitID,
	)
	if err != nil || !found || claim.Status != "prepared" ||
		claim.CanonicalTurnID != payload.ReplacementTurnID {
		t.Fatalf("retained prepared claim=%#v found=%v error=%v", claim, found, err)
	}
	stored := decodeEditRetryPayloadTest(t, op)
	if stored.RedispatchReadyAt != stored.RedispatchProofAt || stored.DispatchAttempt != 2 {
		t.Fatalf("redispatch checkpoint=%#v", stored)
	}
}

func TestEditRetryAbortAndRecoveryFailureAreAtomic(t *testing.T) {
	t.Parallel()
	t.Run("abort proven rejection restores ready", func(t *testing.T) {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		ctx := context.Background()
		seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")
		if _, _, err := store.PrepareRuntimeOperation(ctx, editRetryPrepare("operation-abort", "turn-original", "client-abort", 0)); err != nil {
			t.Fatal(err)
		}
		claimRuntimeOperation(t, store, "operation-abort", "worker-a")
		op, _, _ := store.GetRuntimeOperation(ctx, "ws-1", "operation-abort")
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
		failed, changed, err := store.FailEditRetryRecovery(ctx, FailEditRetryRecoveryInput{
			WorkspaceID: "ws-1", OperationID: "operation-fail", LeaseOwner: "worker-a",
			ReasonCode: EditRetryReasonProviderOutcomeUnknown, NowUnixMS: 22,
		})
		if err != nil || !changed || failed.LastError != string(EditRetryReasonProviderOutcomeUnknown) {
			t.Fatalf("fail recovery changed=%v op=%#v error=%v", changed, failed, err)
		}
		assertSessionHistory(t, store, "session-1", 0, SessionHistoryRecoveryRequired)
	})
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

func prepareEditRetryReplacementPhase(t *testing.T, store *Store, operationID string) (RuntimeOperation, EditRetryOperationPayload) {
	t.Helper()
	ctx := context.Background()
	seedEditRetryTurn(t, store, "turn-original", "provider-original", 20, "submit-original")
	if _, created, err := store.PrepareRuntimeOperation(ctx, editRetryPrepare(operationID, "turn-original", "client-"+operationID, 0)); err != nil || !created {
		t.Fatalf("prepare created=%v error=%v", created, err)
	}
	claimRuntimeOperation(t, store, operationID, "worker-a")
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
