package storesqlite

import (
	"context"
	"errors"
	"testing"
)

func TestPlanDecisionPrepareRequiresSettledDurablePlanEvidence(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedTurnTestSession(t, store, "ws-1", "session-1")
	if _, err := store.db.Exec(`
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase, outcome,
  started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-1', 'session-1', 'turn-1', 'settled', 'completed', 2, 3, 2, 3)
`); err != nil {
		t.Fatal(err)
	}
	_, _, err := store.PrepareRuntimeOperation(context.Background(), planDecisionPrepare("operation-1", "turn-1", "turn-1", "decision-1"))
	if !errors.Is(err, ErrRuntimeOperationSubjectState) {
		t.Fatalf("prepare without plan evidence error = %v", err)
	}
	seedPlanMessage(t, store, "turn-1", "plan-message", map[string]any{"messageKind": "plan"})
	if _, created, err := store.PrepareRuntimeOperation(context.Background(), planDecisionPrepare("operation-1", "turn-1", "turn-1", "decision-1")); err != nil || !created {
		t.Fatalf("prepare with plan evidence created=%v err=%v", created, err)
	}
}

func TestPlanDecisionIdentityRejectsCrossScopeAndPayloadMismatch(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedPlanDecisionSubject(t, store, "session-1", "turn-1")
	input := planDecisionPrepare("operation-1", "turn-1", "turn-1", "decision-1")
	if _, _, err := store.PrepareRuntimeOperation(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	input.OperationID = "operation-retry"
	input.Payload["clientSubmitId"] = "plan-decision:operation-retry"
	input.Payload["idempotencyKey"] = "decision-other"
	if _, _, err := store.PrepareRuntimeOperation(context.Background(), input); !errors.Is(err, ErrRuntimeOperationConflict) {
		t.Fatalf("same turn different key error = %v", err)
	}
	input.RequestID = "request-other"
	if _, _, err := store.PrepareRuntimeOperation(context.Background(), input); err == nil {
		t.Fatal("request mismatch error = nil")
	}
	input.RequestID = "turn-1"
	input.Payload["action"] = "deny"
	if _, _, err := store.PrepareRuntimeOperation(context.Background(), input); err == nil {
		t.Fatal("invalid action error = nil")
	}
}

func TestPlanDecisionCompletionRequiresCheckpointAndCommitsOutbox(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedPlanDecisionSubject(t, store, "session-1", "turn-1")
	if _, _, err := store.PrepareRuntimeOperation(context.Background(), planDecisionPrepare("operation-1", "turn-1", "turn-1", "decision-1")); err != nil {
		t.Fatal(err)
	}
	claimRuntimeOperation(t, store, "operation-1", "worker-a")
	if _, _, err := store.CompletePlanDecisionRuntimeOperation(context.Background(), CompletePlanDecisionRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-a", NowUnixMS: 30,
	}); !errors.Is(err, ErrRuntimeOperationSubjectState) {
		t.Fatalf("incomplete operation completion error = %v", err)
	}
	op, _, _ := store.GetRuntimeOperation(context.Background(), "ws-1", "operation-1")
	payload := cloneJSONMap(op.Payload)
	for index, step := range []string{"settings_applied", "send_dispatched", "send_confirmed"} {
		payload["step"] = step
		if step == "send_confirmed" {
			payload["confirmedTurnId"] = "implementation-turn"
		}
		if _, changed, err := store.CheckpointRuntimeOperation(context.Background(), CheckpointRuntimeOperationInput{
			WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-a", Payload: payload, NowUnixMS: int64(28 + index),
		}); err != nil || !changed {
			t.Fatalf("checkpoint %s changed=%v err=%v", step, changed, err)
		}
	}
	var noticeStatus, noticePayload string
	if err := store.db.QueryRow(`
SELECT status, payload_json FROM workspace_agent_messages
WHERE workspace_id = 'ws-1' AND agent_session_id = 'session-1' AND message_id = ?
`, planDecisionNoticeMessageID("operation-1")).Scan(&noticeStatus, &noticePayload); err != nil || noticeStatus != "running" {
		t.Fatalf("pending notice status=%q payload=%s err=%v", noticeStatus, noticePayload, err)
	}
	assertPlanDecisionNoticePayload(t, mustJSONMap(t, noticePayload), "plan_implementation_pending_confirmation", "warning", "")
	pendingEvents, err := store.ListPendingRuntimeOperationEvents(context.Background(), "ws-1", 10)
	if err != nil || len(pendingEvents) != 1 || pendingEvents[0].Kind != RuntimeOperationEventPlanDecisionPending ||
		payloadString(pendingEvents[0].Payload, "noticeMessageId") != planDecisionNoticeMessageID("operation-1") {
		t.Fatalf("pending events=%#v err=%v", pendingEvents, err)
	}
	if _, _, err := store.CompletePlanDecisionRuntimeOperation(context.Background(), CompletePlanDecisionRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-a", NowUnixMS: 31,
	}); !errors.Is(err, ErrRuntimeOperationSubjectState) {
		t.Fatalf("forged confirmation completion error = %v", err)
	}
	seedImplementationConfirmation(t, store, "implementation-turn", "other-submit")
	if _, _, err := store.CompletePlanDecisionRuntimeOperation(context.Background(), CompletePlanDecisionRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-a", NowUnixMS: 31,
	}); !errors.Is(err, ErrRuntimeOperationSubjectState) {
		t.Fatalf("client submit mismatch completion error = %v", err)
	}
	seedPlanMessage(t, store, "implementation-turn", "confirmed-message", map[string]any{"clientSubmitId": "plan-decision:operation-1"})
	completion, changed, err := store.CompletePlanDecisionRuntimeOperation(context.Background(), CompletePlanDecisionRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-a", NowUnixMS: 31,
	})
	if err != nil || !changed || completion.Operation.Result != RuntimeOperationResultApplied || completion.Event.Kind != RuntimeOperationEventPlanDecisionCompleted {
		t.Fatalf("completion=%#v changed=%v err=%v", completion, changed, err)
	}
	if err := store.db.QueryRow(`
SELECT status, payload_json FROM workspace_agent_messages
WHERE workspace_id = 'ws-1' AND agent_session_id = 'session-1' AND message_id = ?
`, planDecisionNoticeMessageID("operation-1")).Scan(&noticeStatus, &noticePayload); err != nil || noticeStatus != "completed" {
		t.Fatalf("completed notice status=%q payload=%s err=%v", noticeStatus, noticePayload, err)
	}
	assertPlanDecisionNoticePayload(t, mustJSONMap(t, noticePayload), "plan_implementation_completed", "info", "implementation-turn")
	completionEvents, err := store.ListPendingRuntimeOperationEvents(context.Background(), "ws-1", 10)
	if err != nil || len(completionEvents) != 2 || completionEvents[1].Kind != RuntimeOperationEventPlanDecisionCompleted {
		t.Fatalf("completion events=%#v err=%v", completionEvents, err)
	}
}

func assertPlanDecisionNoticePayload(t *testing.T, payload map[string]any, noticeKind, severity, confirmedTurnID string) {
	t.Helper()
	if payloadString(payload, "kind") != "agent_system_notice" || payloadString(payload, "noticeKind") != noticeKind ||
		payloadString(payload, "severity") != severity || payload["retryable"] != false ||
		payloadString(payload, "operationId") != "operation-1" || payloadString(payload, "planTurnId") != "turn-1" ||
		payloadString(payload, "confirmedTurnId") != confirmedTurnID {
		t.Fatalf("notice payload=%#v", payload)
	}
}

func TestFindTurnByClientSubmitIDUsesDurableMessageScope(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedPlanDecisionSubject(t, store, "session-1", "turn-1")
	seedPlanMessage(t, store, "implementation-turn", "user-message", map[string]any{"clientSubmitId": "submit-1"})
	turnID, found, err := store.FindTurnByClientSubmitID(context.Background(), "ws-1", "session-1", "submit-1")
	if err != nil || !found || turnID != "implementation-turn" {
		t.Fatalf("turn=%q found=%v err=%v", turnID, found, err)
	}
	if _, found, err := store.FindTurnByClientSubmitID(context.Background(), "ws-1", "other-session", "submit-1"); err != nil || found {
		t.Fatalf("cross-session found=%v err=%v", found, err)
	}
}

func TestPlanDecisionCompletionPreservesDatabaseFailure(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedPlanDecisionSubject(t, store, "session-1", "turn-1")
	if _, _, err := store.PrepareRuntimeOperation(context.Background(), planDecisionPrepare("operation-1", "turn-1", "turn-1", "decision-1")); err != nil {
		t.Fatal(err)
	}
	claimRuntimeOperation(t, store, "operation-1", "worker-a")
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}
	_, _, err := store.CompletePlanDecisionRuntimeOperation(context.Background(), CompletePlanDecisionRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-a", NowUnixMS: 30,
	})
	if err == nil || errors.Is(err, ErrRuntimeOperationSubjectState) {
		t.Fatalf("database failure error=%v", err)
	}
}

func planDecisionPrepare(operationID, turnID, requestID, idempotencyKey string) RuntimeOperationPrepare {
	return RuntimeOperationPrepare{
		OperationID: operationID, WorkspaceID: "ws-1", AgentSessionID: "session-1",
		Kind: RuntimeOperationKindPlanDecision, TurnID: turnID, RequestID: requestID, OccurredAtMS: 10,
		Payload: map[string]any{
			"promptKind": "plan-implementation", "action": "implement",
			"idempotencyKey": idempotencyKey, "step": "prepared",
			"clientSubmitId": "plan-decision:" + operationID,
		},
	}
}

func seedPlanDecisionSubject(t *testing.T, store *Store, sessionID, turnID string) {
	t.Helper()
	seedTurnTestSession(t, store, "ws-1", sessionID)
	if _, err := store.db.Exec(`
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase, outcome,
  started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-1', ?, ?, 'settled', 'completed', 2, 3, 2, 3)
`, sessionID, turnID); err != nil {
		t.Fatal(err)
	}
	seedPlanMessageForSession(t, store, sessionID, turnID, "plan-message", map[string]any{"messageKind": "plan"})
}

func seedPlanMessage(t *testing.T, store *Store, turnID, messageID string, payload map[string]any) {
	t.Helper()
	seedPlanMessageForSession(t, store, "session-1", turnID, messageID, payload)
}

func seedPlanMessageForSession(t *testing.T, store *Store, sessionID, turnID, messageID string, payload map[string]any) {
	t.Helper()
	var exists int
	if err := store.db.QueryRow(`SELECT 1 FROM workspace_agent_turns WHERE workspace_id = 'ws-1' AND agent_session_id = ? AND turn_id = ?`, sessionID, turnID).Scan(&exists); err != nil {
		if _, insertErr := store.db.Exec(`
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase,
  started_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-1', ?, ?, 'submitted', 3, 3, 3)
`, sessionID, turnID); insertErr != nil {
			t.Fatal(insertErr)
		}
	}
	encoded, err := marshalJSONMap(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`
INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, turn_id, role, kind,
  status, payload_json, occurred_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-1', ?, ?, 1, ?, 'assistant', 'plan', 'completed', ?, 4, 4, 4)
`, sessionID, messageID, turnID, encoded); err != nil {
		t.Fatal(err)
	}
}

func seedImplementationConfirmation(t *testing.T, store *Store, turnID, clientSubmitID string) {
	t.Helper()
	if _, err := store.db.Exec(`
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase,
  started_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-1', 'session-1', ?, 'submitted', 5, 5, 5)
`, turnID); err != nil {
		t.Fatal(err)
	}
	seedPlanMessage(t, store, turnID, "implementation-message", map[string]any{"clientSubmitId": clientSubmitID})
}

func mustJSONMap(t *testing.T, value string) map[string]any {
	t.Helper()
	result, err := unmarshalJSONMap(value)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
