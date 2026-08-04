package storesqlite

import (
	"fmt"
	"testing"
)

func TestEditRetryClaimFrontierIsFairAndFailsClosed(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	for index := 0; index < 100; index++ {
		seedClaimableEditRetryForClaimTest(t, store, "ws-busy", fmt.Sprintf("busy-%03d", index), "provider-busy", fmt.Sprintf("busy-%03d", index))
	}
	seedClaimableEditRetryForClaimTest(t, store, "ws-busy", "healthy-provider", "provider-healthy", "healthy-provider")
	seedClaimableEditRetryForClaimTest(t, store, "ws-other", "healthy-workspace", "provider-other", "healthy-workspace")
	seedClaimableEditRetryForClaimTest(t, store, "ws-legacy", "unknown", "", "unknown")
	operations, err := store.ListClaimableEditRetryOperations(t.Context(), ListClaimableRuntimeOperationsInput{NowUnixMS: 30, Limit: 16})
	if err != nil {
		t.Fatal(err)
	}
	got := make(map[string]RuntimeOperation, len(operations))
	for _, operation := range operations {
		got[operation.OperationID] = operation
	}
	for _, operationID := range []string{"edit-retry-healthy-provider", "edit-retry-healthy-workspace", "edit-retry-unknown"} {
		if _, found := got[operationID]; !found {
			t.Fatalf("fair claim frontier omitted %q from %#v", operationID, operations)
		}
	}
	if got["edit-retry-unknown"].ProviderKey != "unknown:ws-legacy:unknown" {
		t.Fatalf("unknown provider key=%q", got["edit-retry-unknown"].ProviderKey)
	}
	for index, payload := range []map[string]any{
		{"step": EditRetryCheckpointPrepared},
		{"sagaVersion": EditRetrySagaVersionCurrent + 1, "step": EditRetryCheckpointPrepared},
	} {
		encoded, err := marshalJSONMap(payload)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.db.ExecContext(t.Context(), `
INSERT INTO workspace_agent_runtime_operations (
  operation_id, workspace_id, agent_session_id, kind, status, turn_id, request_id,
  payload_json, next_attempt_at_unix_ms, attempt, version, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, 'ws-busy', 'busy-000', 'edit_retry', 'prepared', 'source-busy-000', ?, ?, 20, 0, 1, 20, 20)`,
			"unsafe-"+fmt.Sprint(index+1), "unsafe-request-"+fmt.Sprint(index+1), encoded); err != nil {
			t.Fatal(err)
		}
	}
	operations, err = store.ListClaimableEditRetryOperations(t.Context(), ListClaimableRuntimeOperationsInput{NowUnixMS: 30, Limit: 1000})
	if err != nil {
		t.Fatal(err)
	}
	for _, operation := range operations {
		if operation.OperationID == "unsafe-1" || operation.OperationID == "unsafe-2" {
			t.Fatalf("legacy/future payload was claimable: %#v", operation)
		}
	}
}

func TestOrdinaryRuntimeOperationClaimOrderAndLimitIgnoreEditRetryRows(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedRuntimeInteractiveSubject(t, store, "ordinary-a", "turn-a", "request-a")
	seedRuntimeInteractiveSubject(t, store, "ordinary-b", "turn-b", "request-b")
	prepareRuntimeInteractive(t, store, "ordinary-operation-a", "ordinary-a", "turn-a", "request-a")
	prepareRuntimeInteractive(t, store, "ordinary-operation-b", "ordinary-b", "turn-b", "request-b")
	baseline, err := store.ListClaimableRuntimeOperations(t.Context(), ListClaimableRuntimeOperationsInput{NowUnixMS: 30, Limit: 1})
	if err != nil || len(baseline) != 1 {
		t.Fatalf("baseline ordinary claims=%#v error=%v", baseline, err)
	}
	for index := 0; index < 100; index++ {
		seedClaimableEditRetryForClaimTest(t, store, "ws-edits", fmt.Sprintf("edit-%03d", index), "provider-busy", fmt.Sprintf("edit-%03d", index))
	}
	after, err := store.ListClaimableRuntimeOperations(t.Context(), ListClaimableRuntimeOperationsInput{NowUnixMS: 30, Limit: 1})
	if err != nil || len(after) != 1 {
		t.Fatalf("ordinary claims after edit retries=%#v error=%v", after, err)
	}
	if after[0].OperationID != baseline[0].OperationID || after[0].Kind != baseline[0].Kind {
		t.Fatalf("edit retries changed ordinary claim result: before=%#v after=%#v", baseline[0], after[0])
	}
	for _, operation := range after {
		if operation.Kind == RuntimeOperationKindEditRetry {
			t.Fatalf("ordinary claim query returned edit retry: %#v", operation)
		}
	}
}

func seedClaimableEditRetryForClaimTest(t *testing.T, store *Store, workspaceID, sessionID, provider, suffix string) {
	t.Helper()
	ctx := t.Context()
	turnID := "source-" + suffix
	if _, err := store.ReportSessionState(ctx, SessionStateReport{WorkspaceID: workspaceID, AgentSessionID: sessionID, Kind: SessionKindRoot, Provider: provider, ProviderSessionID: "thread-" + suffix, OccurredAtUnixMS: 10}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session:          SessionStateReport{WorkspaceID: workspaceID, AgentSessionID: sessionID, Kind: SessionKindRoot, Provider: provider, ProviderSessionID: "thread-" + suffix, OccurredAtUnixMS: 10},
		Turn:             &TurnTransition{WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID, Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, Origin: TurnOriginUserPrompt, StartedAtUnixMS: 10, SettledAtUnixMS: 10, OccurredAtUnixMS: 10},
		RootProviderTurn: &RootProviderTurnTransition{WorkspaceID: workspaceID, RootAgentSessionID: sessionID, RootTurnID: turnID, ProviderTurnID: "provider-" + suffix, Phase: RootProviderTurnPhaseCompleted, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 10},
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RecordTurnSubmission(ctx, TurnSubmission{WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID, ContentJSON: `[{"type":"text","text":"source"}]`, DisplayPrompt: "source", CapabilityRefsJSON: "[]", TuttiModeSnapshotJSON: "null", ClientSubmitID: "submit-" + suffix, CreatedAtUnixMS: 10, UpdatedAtUnixMS: 10}); err != nil {
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
	if _, created, err := store.PrepareEditRetry(ctx, RuntimeOperationPrepare{WorkspaceID: workspaceID, AgentSessionID: sessionID, OperationID: operationID, Kind: RuntimeOperationKindEditRetry, TurnID: turnID, RequestID: "client-" + suffix, Payload: payload, OccurredAtMS: 10}); err != nil || !created {
		t.Fatalf("prepare edit retry created=%v error=%v", created, err)
	}
}
