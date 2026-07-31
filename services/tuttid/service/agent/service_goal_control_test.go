package agent

import (
	"context"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func TestServiceResumesPersistedSessionBeforeInput(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				ActiveTurnID:      "turn-1",
				Title:             "Persisted session",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	result, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{Content: TextPromptContent("hello")})
	if err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}
	session := result.Session
	if session.ID != "session-1" {
		t.Fatalf("session id = %q", session.ID)
	}
	if len(runtime.resumeCalls) != 1 {
		t.Fatalf("resume calls = %d, want 1", len(runtime.resumeCalls))
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
}

type recordingGoalStateStore struct {
	prepared     []agentactivitybiz.GoalControlOperationPrepare
	dispatched   []string
	acknowledged []agentactivitybiz.GoalControlOperationAcknowledge
	released     []agentactivitybiz.ReleaseGoalControlOperationInput
}

func (s *recordingGoalStateStore) PrepareGoalControlOperation(_ context.Context, input agentactivitybiz.GoalControlOperationPrepare) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error) {
	s.prepared = append(s.prepared, input)
	return agentactivitybiz.GoalControlOperation{
			OperationID: input.OperationID, WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
			GoalRevision: 1, Action: input.Action, Objective: input.Objective, ClientSubmitID: input.ClientSubmitID,
		}, agentactivitybiz.SessionGoalState{
			WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, Revision: 1,
			PendingOperationID: input.OperationID, SyncStatus: agentactivitybiz.GoalSyncStatusPending,
		}, true, nil
}

func (*recordingGoalStateStore) AdoptProviderGoalOperation(_ context.Context, input agentactivitybiz.ProviderGoalAdoption) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error) {
	objective, _ := input.Goal["objective"].(string)
	return agentactivitybiz.GoalControlOperation{
			OperationID: input.OperationID, WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
			GoalRevision: 1, Action: "set", Objective: objective,
			Status: agentactivitybiz.GoalOperationStatusCompleted, ProviderPhase: agentactivitybiz.GoalProviderPhaseApplied,
		}, agentactivitybiz.SessionGoalState{
			WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
			Desired: clonePayload(input.Goal), Observed: clonePayload(input.Goal), Revision: 1,
			SyncStatus: agentactivitybiz.GoalSyncStatusSynced,
		}, true, nil
}

func (s *recordingGoalStateStore) MarkGoalControlOperationDispatched(_ context.Context, _ string, operationID string, _ int64) (agentactivitybiz.GoalControlOperation, bool, error) {
	s.dispatched = append(s.dispatched, operationID)
	return agentactivitybiz.GoalControlOperation{OperationID: operationID, GoalRevision: 1}, true, nil
}

func (s *recordingGoalStateStore) AcknowledgeGoalControlOperation(_ context.Context, input agentactivitybiz.GoalControlOperationAcknowledge) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error) {
	s.acknowledged = append(s.acknowledged, input)
	return agentactivitybiz.GoalControlOperation{OperationID: input.OperationID, GoalRevision: 1}, agentactivitybiz.SessionGoalState{
		Revision: 1, PendingOperationID: input.OperationID, SyncStatus: agentactivitybiz.GoalSyncStatusApplying,
	}, true, nil
}

func (s *recordingGoalStateStore) GetGoalControlAudit(_ context.Context, workspaceID string, agentSessionID string, operationID string) (agentactivitybiz.Message, bool, error) {
	for index := len(s.prepared) - 1; index >= 0; index-- {
		prepared := s.prepared[index]
		if prepared.WorkspaceID != workspaceID || prepared.AgentSessionID != agentSessionID || prepared.OperationID != operationID {
			continue
		}
		content := "/goal " + prepared.Action
		if prepared.Action == "set" {
			content = "/goal " + prepared.Objective
		}
		return agentactivitybiz.Message{
			AgentSessionID: agentSessionID,
			MessageID:      "goal-control:" + operationID,
			Version:        1,
			Role:           "user",
			Kind:           "session_audit",
			Status:         "completed",
			Payload: map[string]any{
				"action":      prepared.Action,
				"goalControl": true,
				"operationId": operationID,
				"text":        content,
			},
			OccurredAtUnixMS: prepared.OccurredAtUnixMS,
		}, true, nil
	}
	return agentactivitybiz.Message{}, false, nil
}

type recordingGoalAuditPublisher struct {
	audits []agentactivitybiz.Message
}

func (p *recordingGoalAuditPublisher) ObserveCommitted(_ context.Context, delta agenthost.CommittedDelta) error {
	if delta.GoalOperation != nil && delta.GoalOperation.Audit != nil {
		p.audits = append(p.audits, *delta.GoalOperation.Audit)
	}
	return nil
}

func (*recordingGoalStateStore) CompleteGoalControlOperation(context.Context, agentactivitybiz.GoalControlOperationComplete) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error) {
	return agentactivitybiz.GoalControlOperation{}, agentactivitybiz.SessionGoalState{}, false, nil
}

func (s *recordingGoalStateStore) GetSessionGoalState(_ context.Context, workspaceID, agentSessionID string) (agentactivitybiz.SessionGoalState, bool, error) {
	if len(s.prepared) == 0 {
		return agentactivitybiz.SessionGoalState{}, false, nil
	}
	return agentactivitybiz.SessionGoalState{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID, Revision: 1,
		PendingOperationID: s.prepared[len(s.prepared)-1].OperationID,
		SyncStatus:         agentactivitybiz.GoalSyncStatusApplying,
	}, true, nil
}

func (*recordingGoalStateStore) ReconcileSessionGoalObservation(context.Context, agentactivitybiz.GoalObservationReconcile) (agentactivitybiz.SessionGoalState, error) {
	return agentactivitybiz.SessionGoalState{}, nil
}

func (*recordingGoalStateStore) MarkGoalRevisionTerminalIncident(_ context.Context, input agentactivitybiz.GoalTerminalIncidentInput) (agentactivitybiz.SessionGoalState, error) {
	return agentactivitybiz.SessionGoalState{WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, Revision: input.Revision, SyncStatus: agentactivitybiz.GoalSyncStatusUnknown, LastError: input.LastError}, nil
}

func (*recordingGoalStateStore) GetGoalControlOperation(context.Context, string, string) (agentactivitybiz.GoalControlOperation, bool, error) {
	return agentactivitybiz.GoalControlOperation{}, false, nil
}

func (*recordingGoalStateStore) ListClaimableGoalControlOperations(context.Context, agentactivitybiz.ListClaimableGoalControlOperationsInput) ([]agentactivitybiz.GoalControlOperation, error) {
	return nil, nil
}

func (*recordingGoalStateStore) ClaimGoalControlOperation(_ context.Context, input agentactivitybiz.ClaimGoalControlOperationInput) (agentactivitybiz.GoalControlOperation, bool, error) {
	return agentactivitybiz.GoalControlOperation{OperationID: input.OperationID, GoalRevision: 1, LeaseOwner: input.LeaseOwner}, true, nil
}

func (s *recordingGoalStateStore) ReleaseGoalControlOperation(_ context.Context, input agentactivitybiz.ReleaseGoalControlOperationInput) (agentactivitybiz.GoalControlOperation, bool, error) {
	s.released = append(s.released, input)
	return agentactivitybiz.GoalControlOperation{}, true, nil
}

func (*recordingGoalStateStore) RecordGoalControlOperationEvidence(context.Context, agentactivitybiz.GoalControlOperationEvidence) (agentactivitybiz.GoalControlOperation, bool, error) {
	return agentactivitybiz.GoalControlOperation{}, true, nil
}

func (*recordingGoalStateStore) WakeGoalControlOperation(context.Context, agentactivitybiz.WakeGoalControlOperationInput) (agentactivitybiz.GoalControlOperation, bool, error) {
	return agentactivitybiz.GoalControlOperation{}, true, nil
}

func (*recordingGoalStateStore) EnsureGoalRepairOperation(context.Context, agentactivitybiz.EnsureGoalRepairOperationInput) (agentactivitybiz.GoalControlOperation, bool, error) {
	return agentactivitybiz.GoalControlOperation{}, true, nil
}

func (*recordingGoalStateStore) EnsureOrWakeGoalRepairOperation(context.Context, agentactivitybiz.EnsureGoalRepairOperationInput) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error) {
	return agentactivitybiz.GoalControlOperation{}, agentactivitybiz.SessionGoalState{WorkspaceID: "ws-typed", AgentSessionID: "session-typed", Revision: 1}, true, nil
}

func (*recordingGoalStateStore) RequeueLeasedGoalControlOperationsOnStartup(context.Context, int64) (int64, error) {
	return 0, nil
}

func TestServiceTypedGoalUsesDurableSagaBeforeTurnSubmit(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-typed:session-typed"] = ProviderRuntimeSession{
		ID: "session-typed", Provider: "claude-code", ProviderSessionID: "provider-typed", Status: "ready",
	}
	store := &recordingGoalStateStore{}
	publisher := &recordingGoalAuditPublisher{}
	runtime.goalControlHook = func(_ context.Context, input RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
		if len(publisher.audits) != 1 {
			t.Fatalf("goal audit count before provider dispatch = %d, want 1", len(publisher.audits))
		}
		return RuntimeGoalControlResult{
			Goal:          map[string]any{"objective": input.Objective, "status": "active"},
			ProviderPhase: "accepted",
			Evidence:      map[string]any{"phase": "accepted"},
		}, nil
	}
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.CommitObserver = publisher

	result, err := service.SendInput(context.Background(), "ws-typed", "session-typed", SendInput{
		Content:  TextPromptContent("/goal ship it"),
		Metadata: map[string]any{"clientSubmitId": "submit-goal-1"},
	})
	if err != nil {
		t.Fatalf("typed goal: %v", err)
	}
	if result.Kind != "goalControl" || result.TurnID != "" || result.GoalControl == nil {
		t.Fatalf("typed goal result=%#v", result)
	}
	if len(runtime.execCalls) != 0 {
		t.Fatalf("typed goal entered Turn Exec: %#v", runtime.execCalls)
	}
	if len(store.prepared) != 1 || store.prepared[0].Action != "set" || store.prepared[0].Objective != "ship it" {
		t.Fatalf("prepared operations=%#v", store.prepared)
	}
	if len(runtime.goalControlCalls) != 1 || runtime.goalControlCalls[0].OperationID == "" || runtime.goalControlCalls[0].GoalRevision != 1 {
		t.Fatalf("runtime goal calls=%#v", runtime.goalControlCalls)
	}
	if runtime.goalControlCalls[0].SubmissionMetadata["clientSubmitId"] != "submit-goal-1" {
		t.Fatalf("runtime goal submission metadata=%#v", runtime.goalControlCalls[0].SubmissionMetadata)
	}
	if len(store.acknowledged) != 1 || store.acknowledged[0].OperationID != runtime.goalControlCalls[0].OperationID {
		t.Fatalf("acknowledgements=%#v", store.acknowledged)
	}
	if len(publisher.audits) != 1 || publisher.audits[0].MessageID != "goal-control:"+runtime.goalControlCalls[0].OperationID {
		t.Fatalf("published goal audits=%#v", publisher.audits)
	}
}

func TestServiceCreateWithTypedGoalCreatesNoInitialTurn(t *testing.T) {
	runtime := newFakeRuntime()
	store := &recordingGoalStateStore{}
	service := newTestService(runtime)
	service.GoalStateStore = store

	session, err := service.Create(context.Background(), "ws-typed", CreateSessionInput{
		AgentSessionID: "session-new-goal",
		AgentTargetID:  agenttargetbiz.IDLocalClaudeCode,
		InitialContent: TextPromptContent("/goal ship it"),
		Metadata:       map[string]any{"clientSubmitId": "submit-new-goal"},
	})
	if err != nil {
		t.Fatalf("Create typed goal: %v", err)
	}
	if session.ID != "session-new-goal" {
		t.Fatalf("session=%#v", session)
	}
	if len(runtime.execCalls) != 0 {
		t.Fatalf("typed Goal create entered Turn Exec: %#v", runtime.execCalls)
	}
	if len(runtime.goalControlCalls) != 1 || runtime.goalControlCalls[0].OperationID == "" {
		t.Fatalf("goal control calls=%#v", runtime.goalControlCalls)
	}
	if runtime.goalControlCalls[0].SubmissionMetadata["clientSubmitId"] != "submit-new-goal" {
		t.Fatalf("goal control submission metadata=%#v", runtime.goalControlCalls[0].SubmissionMetadata)
	}
	if len(store.prepared) != 1 || store.prepared[0].AgentSessionID != "session-new-goal" {
		t.Fatalf("prepared operations=%#v", store.prepared)
	}
}
