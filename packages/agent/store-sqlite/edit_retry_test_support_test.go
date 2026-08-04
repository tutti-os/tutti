package storesqlite

import "testing"

func seedClaimableEditRetry(t *testing.T, store *Store, workspaceID, sessionID, provider, suffix string, occurredAtMS int64) {
	t.Helper()
	ctx := t.Context()
	turnID := "source-" + suffix
	providerTurnID := "provider-" + suffix
	providerSessionID := "thread-" + suffix
	if _, err := store.ReportSessionState(ctx, SessionStateReport{WorkspaceID: workspaceID, AgentSessionID: sessionID, Kind: SessionKindRoot, Provider: provider, ProviderSessionID: providerSessionID, OccurredAtUnixMS: occurredAtMS}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(ctx, ActivityStateReport{Session: SessionStateReport{WorkspaceID: workspaceID, AgentSessionID: sessionID, Kind: SessionKindRoot, Provider: provider, ProviderSessionID: providerSessionID, OccurredAtUnixMS: occurredAtMS}, Turn: &TurnTransition{WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID, Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, Origin: TurnOriginUserPrompt, StartedAtUnixMS: occurredAtMS, SettledAtUnixMS: occurredAtMS, OccurredAtUnixMS: occurredAtMS}, RootProviderTurn: &RootProviderTurnTransition{WorkspaceID: workspaceID, RootAgentSessionID: sessionID, RootTurnID: turnID, ProviderTurnID: providerTurnID, Phase: RootProviderTurnPhaseCompleted, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: occurredAtMS}}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RecordTurnSubmission(ctx, TurnSubmission{WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID, ContentJSON: `[{"type":"text","text":"source"}]`, DisplayPrompt: "source", CapabilityRefsJSON: `[]`, TuttiModeSnapshotJSON: `null`, ClientSubmitID: "submit-" + suffix, CreatedAtUnixMS: occurredAtMS, UpdatedAtUnixMS: occurredAtMS}); err != nil {
		t.Fatal(err)
	}
	history, found, err := store.GetSessionHistory(ctx, workspaceID, sessionID)
	if err != nil || !found {
		t.Fatalf("history found=%v error=%v", found, err)
	}
	operationID := "edit-retry-" + suffix
	payload, err := EncodeEditRetryOperationPayload(EditRetryOperationPayload{ClientOperationID: "client-" + suffix, EditedText: "replacement", ReplacementTurnID: "replacement-" + suffix, ClientSubmitID: "edit-retry:" + operationID, ExpectedRevision: int64(history.Revision), Checkpoint: EditRetryCheckpointPrepared, DispatchAttempt: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, created, err := store.PrepareEditRetry(ctx, RuntimeOperationPrepare{OperationID: operationID, WorkspaceID: workspaceID, AgentSessionID: sessionID, Kind: RuntimeOperationKindEditRetry, TurnID: turnID, RequestID: "client-" + suffix, Payload: payload, OccurredAtMS: occurredAtMS}); err != nil || !created {
		t.Fatalf("prepare edit retry created=%v error=%v", created, err)
	}
}
