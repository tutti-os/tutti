package agent

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

type goalEvidenceFenceStore struct {
	*recordingGoalStateStore
	state           agentactivitybiz.SessionGoalState
	operations      map[string]agentactivitybiz.GoalControlOperation
	repairInputs    []agentactivitybiz.EnsureGoalRepairOperationInput
	evidenceInputs  []agentactivitybiz.GoalControlOperationEvidence
	reconcileInputs []agentactivitybiz.GoalObservationReconcile
	stateErr        error
	operationErr    error
}

func (s *goalEvidenceFenceStore) GetSessionGoalState(context.Context, string, string) (agentactivitybiz.SessionGoalState, bool, error) {
	if s.stateErr != nil {
		return agentactivitybiz.SessionGoalState{}, false, s.stateErr
	}
	return s.state, true, nil
}

func (s *goalEvidenceFenceStore) GetGoalControlOperation(_ context.Context, _ string, operationID string) (agentactivitybiz.GoalControlOperation, bool, error) {
	if s.operationErr != nil {
		return agentactivitybiz.GoalControlOperation{}, false, s.operationErr
	}
	operation, found := s.operations[operationID]
	return operation, found, nil
}

func TestGoalReconcileEvidencePropagatesFenceReadFailure(t *testing.T) {
	want := errors.New("transient store failure")
	store := &goalEvidenceFenceStore{recordingGoalStateStore: &recordingGoalStateStore{}, stateErr: want}
	service := newIsolatedAgentService(newFakeRuntime())
	service.GoalStateStore = store
	err := service.ReconcileGoalFromEvidence(context.Background(), GoalReconcileRequiredInput{
		WorkspaceID: "ws", AgentSessionID: "session", RequestID: "request", ProviderTurnID: "turn",
		FenceMode: "operation", ExpectedOperationID: "operation", ExpectedRevision: 1, QuiesceSucceeded: true,
	})
	if !errors.Is(err, want) {
		t.Fatalf("ReconcileGoalFromEvidence error = %v", err)
	}
}

func (s *goalEvidenceFenceStore) RecordGoalControlOperationEvidence(_ context.Context, input agentactivitybiz.GoalControlOperationEvidence) (agentactivitybiz.GoalControlOperation, bool, error) {
	s.evidenceInputs = append(s.evidenceInputs, input)
	operation, found := s.operations[input.OperationID]
	return operation, found, nil
}

func (s *goalEvidenceFenceStore) EnsureOrWakeGoalRepairOperation(_ context.Context, input agentactivitybiz.EnsureGoalRepairOperationInput) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error) {
	s.repairInputs = append(s.repairInputs, input)
	return agentactivitybiz.GoalControlOperation{OperationID: "repair-op", GoalRevision: input.CurrentRevision}, s.state, true, nil
}

func (s *goalEvidenceFenceStore) ReconcileSessionGoalObservation(_ context.Context, input agentactivitybiz.GoalObservationReconcile) (agentactivitybiz.SessionGoalState, error) {
	s.reconcileInputs = append(s.reconcileInputs, input)
	state := s.state
	state.SyncStatus = agentactivitybiz.GoalSyncStatusUnknown
	return state, nil
}

func TestGoalReconcileEvidenceRejectsOldOperationAfterSameRevisionRepair(t *testing.T) {
	store := &goalEvidenceFenceStore{
		recordingGoalStateStore: &recordingGoalStateStore{},
		state: agentactivitybiz.SessionGoalState{
			WorkspaceID: "ws", AgentSessionID: "session", Revision: 2, PendingOperationID: "repair-op",
		},
		operations: map[string]agentactivitybiz.GoalControlOperation{
			"old-op": {
				OperationID: "old-op", WorkspaceID: "ws", AgentSessionID: "session", GoalRevision: 2,
				Status: agentactivitybiz.GoalOperationStatusCompleted,
			},
			"repair-op": {
				OperationID: "repair-op", WorkspaceID: "ws", AgentSessionID: "session", GoalRevision: 2,
				Status: agentactivitybiz.GoalOperationStatusPrepared, RepairRequired: true, RepairEpoch: 1,
			},
		},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.GoalStateStore = store
	matches, err := service.goalReconcileEvidenceFenceMatches(context.Background(), GoalReconcileRequiredInput{
		WorkspaceID: "ws", AgentSessionID: "session", FenceMode: "operation",
		ExpectedOperationID: "old-op", ExpectedRevision: 2, ExpectedRepairEpoch: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if matches {
		t.Fatal("old same-revision operation evidence passed after repair operation became current")
	}
}

func TestGoalReconcileEvidenceFailedQuiesceAttachesRepairWithoutReconciling(t *testing.T) {
	store := &goalEvidenceFenceStore{
		recordingGoalStateStore: &recordingGoalStateStore{},
		state: agentactivitybiz.SessionGoalState{
			WorkspaceID: "ws", AgentSessionID: "session", Revision: 3, PendingOperationID: "goal-op-3",
		},
		operations: map[string]agentactivitybiz.GoalControlOperation{
			"goal-op-3": {
				OperationID: "goal-op-3", WorkspaceID: "ws", AgentSessionID: "session", GoalRevision: 3,
				Status: agentactivitybiz.GoalOperationStatusPrepared, RepairEpoch: 2,
			},
		},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.GoalStateStore = store
	err := service.ReconcileGoalFromEvidence(context.Background(), GoalReconcileRequiredInput{
		WorkspaceID: "ws", AgentSessionID: "session", RequestID: "request-1", ProviderTurnID: "provider-old",
		FenceMode: "operation", ExpectedOperationID: "goal-op-3", ExpectedRevision: 3, ExpectedRepairEpoch: 2,
		QuiesceSucceeded: false, QuiesceError: "interrupt rejected",
	})
	if err != nil {
		t.Fatalf("ReconcileGoalFromEvidence: %v", err)
	}
	if len(store.repairInputs) != 1 {
		t.Fatalf("repair inputs = %#v, want one", store.repairInputs)
	}
	if repair := store.repairInputs[0]; repair.SourceOperationID != "goal-provenance-incident:request-1:provider-old" || repair.SourceRevision != 3 || repair.CurrentRevision != 3 {
		t.Fatalf("repair input = %#v", repair)
	}
	if len(store.evidenceInputs) != 1 || store.evidenceInputs[0].ProviderPhase != agentactivitybiz.GoalProviderPhaseUnknown {
		t.Fatalf("quiesce failure evidence = %#v", store.evidenceInputs)
	}
}

func TestGoalReconcileEvidenceFailedQuiesceRepairsRevisionAdvancedBeforeReport(t *testing.T) {
	store := &goalEvidenceFenceStore{
		recordingGoalStateStore: &recordingGoalStateStore{},
		state: agentactivitybiz.SessionGoalState{
			WorkspaceID: "ws", AgentSessionID: "session", Revision: 4,
			Desired: map[string]any{"objective": "new desired"},
		},
		operations: map[string]agentactivitybiz.GoalControlOperation{
			"old-op": {
				OperationID: "old-op", WorkspaceID: "ws", AgentSessionID: "session", GoalRevision: 3,
				Status: agentactivitybiz.GoalOperationStatusCompleted, RepairEpoch: 1,
			},
		},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.GoalStateStore = store
	if err := service.ReconcileGoalFromEvidence(context.Background(), GoalReconcileRequiredInput{
		WorkspaceID: "ws", AgentSessionID: "session", RequestID: "late-failure", ProviderTurnID: "old-turn",
		FenceMode: "operation", ExpectedOperationID: "old-op", ExpectedRevision: 3, ExpectedRepairEpoch: 1,
		QuiesceSucceeded: false, QuiesceError: "still running",
	}); err != nil {
		t.Fatalf("ReconcileGoalFromEvidence: %v", err)
	}
	if len(store.repairInputs) != 1 || store.repairInputs[0].CurrentRevision != 4 || store.repairInputs[0].SourceRevision != 4 {
		t.Fatalf("repair inputs = %#v", store.repairInputs)
	}
}

func TestGoalReconcileEvidenceRestartedSyncedGoalUsesLastEvidenceForRepair(t *testing.T) {
	store := &goalEvidenceFenceStore{
		recordingGoalStateStore: &recordingGoalStateStore{},
		state: agentactivitybiz.SessionGoalState{
			WorkspaceID: "ws", AgentSessionID: "session", Revision: 4,
			SyncStatus: agentactivitybiz.GoalSyncStatusSynced,
			LastEvidence: map[string]any{
				"operationId": "goal-op-4", "revision": float64(4), "repairEpoch": float64(2),
			},
		},
		operations: map[string]agentactivitybiz.GoalControlOperation{
			"goal-op-4": {
				OperationID: "goal-op-4", WorkspaceID: "ws", AgentSessionID: "session", GoalRevision: 4,
				Status: agentactivitybiz.GoalOperationStatusCompleted, RepairEpoch: 2,
			},
		},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.GoalStateStore = store
	err := service.ReconcileGoalFromEvidence(context.Background(), GoalReconcileRequiredInput{
		WorkspaceID: "ws", AgentSessionID: "session", RequestID: "request-restart",
		ProviderTurnID: "provider-unproven", FenceMode: "current_durable",
		QuiesceSucceeded: false, QuiesceError: "interrupt rejected",
	})
	if err != nil {
		t.Fatalf("ReconcileGoalFromEvidence: %v", err)
	}
	if len(store.repairInputs) != 1 {
		t.Fatalf("repair inputs = %#v, want one", store.repairInputs)
	}
	if repair := store.repairInputs[0]; repair.SourceOperationID != "goal-provenance-incident:request-restart:provider-unproven" || repair.SourceRevision != 4 || repair.CurrentRevision != 4 {
		t.Fatalf("repair input = %#v", repair)
	}
	if len(store.reconcileInputs) != 0 {
		t.Fatalf("unexpected unknown fallback = %#v", store.reconcileInputs)
	}
}

func TestGoalReconcileEvidenceRestartedGoalWithoutSourceCreatesRequestRepair(t *testing.T) {
	store := &goalEvidenceFenceStore{
		recordingGoalStateStore: &recordingGoalStateStore{},
		state: agentactivitybiz.SessionGoalState{
			WorkspaceID: "ws", AgentSessionID: "session", Revision: 4,
			SyncStatus: agentactivitybiz.GoalSyncStatusSynced, ObservedAtUnixMS: 100,
			Desired:  map[string]any{"objective": "ship it"},
			Observed: map[string]any{"objective": "ship it"},
		},
		operations: map[string]agentactivitybiz.GoalControlOperation{},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.GoalStateStore = store
	err := service.ReconcileGoalFromEvidence(context.Background(), GoalReconcileRequiredInput{
		WorkspaceID: "ws", AgentSessionID: "session", RequestID: "request-restart",
		ProviderTurnID: "provider-unproven", FenceMode: "current_durable",
		QuiesceSucceeded: false, QuiesceError: "interrupt rejected",
	})
	if err != nil {
		t.Fatalf("ReconcileGoalFromEvidence: %v", err)
	}
	if len(store.repairInputs) != 1 {
		t.Fatalf("repair inputs = %#v, want one", store.repairInputs)
	}
	repair := store.repairInputs[0]
	if repair.SourceOperationID != "goal-provenance-incident:request-restart:provider-unproven" ||
		repair.SourceRevision != 4 || repair.CurrentRevision != 4 || repair.Evidence["missingSource"] != true {
		t.Fatalf("repair input = %#v", repair)
	}
	if len(store.reconcileInputs) != 0 {
		t.Fatalf("unexpected unknown fallback = %#v", store.reconcileInputs)
	}
}

func TestGoalReconcileEvidenceMissingRequestIdentityMarksUnknown(t *testing.T) {
	store := &goalEvidenceFenceStore{
		recordingGoalStateStore: &recordingGoalStateStore{},
		state: agentactivitybiz.SessionGoalState{
			WorkspaceID: "ws", AgentSessionID: "session", Revision: 4,
			SyncStatus: agentactivitybiz.GoalSyncStatusSynced, ObservedAtUnixMS: 100,
			Desired:  map[string]any{"objective": "ship it"},
			Observed: map[string]any{"objective": "ship it"},
		},
		operations: map[string]agentactivitybiz.GoalControlOperation{},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.GoalStateStore = store
	if err := service.attachGoalProvenanceQuiesceRepair(context.Background(), GoalReconcileRequiredInput{
		WorkspaceID: "ws", AgentSessionID: "session", QuiesceError: "interrupt rejected",
	}); err != nil {
		t.Fatalf("attachGoalProvenanceQuiesceRepair: %v", err)
	}
	if len(store.repairInputs) != 0 || len(store.reconcileInputs) != 1 || !store.reconcileInputs[0].ForceSyncUnknown {
		t.Fatalf("repair=%#v unknown=%#v", store.repairInputs, store.reconcileInputs)
	}
}

func TestGoalReconcileEvidenceDistinctProviderTurnsConsumePersistentIncidentBudget(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "goal.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := storesqlite.New(db, storesqlite.Options{})
	ctx := context.Background()
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, storesqlite.SessionStateReport{WorkspaceID: "ws", AgentSessionID: "session", Provider: "codex", OccurredAtUnixMS: 1}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, storesqlite.GoalControlOperationPrepare{OperationID: "goal-origin", WorkspaceID: "ws", AgentSessionID: "session", Action: "set", Objective: "ship", OccurredAtUnixMS: 2}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReconcileSessionGoalObservation(ctx, storesqlite.GoalObservationReconcile{WorkspaceID: "ws", AgentSessionID: "session", Observed: map[string]any{"objective": "ship"}, Evidence: map[string]any{"confidence": "authoritative"}, OccurredAtUnixMS: 3}); err != nil {
		t.Fatal(err)
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.GoalStateStore = store
	for i := 1; i <= 9; i++ {
		if err := service.ReconcileGoalFromEvidence(ctx, GoalReconcileRequiredInput{WorkspaceID: "ws", AgentSessionID: "session", RequestID: fmt.Sprintf("request-%d", i), ProviderTurnID: fmt.Sprintf("turn-%d", i), FenceMode: "operation", ExpectedOperationID: "goal-origin", ExpectedRevision: 1, QuiesceSucceeded: false, QuiesceError: "still running"}); err != nil {
			t.Fatalf("incident %d: %v", i, err)
		}
	}
	state, found, err := store.GetSessionGoalState(ctx, "ws", "session")
	if err != nil || !found || state.SyncStatus != storesqlite.GoalSyncStatusUnknown || state.PendingOperationID != "" {
		t.Fatalf("budget state=%#v found=%v err=%v", state, found, err)
	}
}
