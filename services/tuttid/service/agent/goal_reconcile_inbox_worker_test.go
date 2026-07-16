package agent

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

type goalReconcileInboxWorkerStore struct {
	item    agentactivitybiz.GoalReconcileInboxItem
	items   []agentactivitybiz.GoalReconcileInboxItem
	claims  []agentactivitybiz.ClaimGoalReconcileInboxInput
	release agentactivitybiz.ReleaseGoalReconcileInboxInput
}

func (s *goalReconcileInboxWorkerStore) ListClaimableGoalReconcileInbox(context.Context, int64, int) ([]agentactivitybiz.GoalReconcileInboxItem, error) {
	if s.items != nil {
		return append([]agentactivitybiz.GoalReconcileInboxItem(nil), s.items...), nil
	}
	return []agentactivitybiz.GoalReconcileInboxItem{s.item}, nil
}
func (s *goalReconcileInboxWorkerStore) ClaimGoalReconcileInbox(_ context.Context, input agentactivitybiz.ClaimGoalReconcileInboxInput) (agentactivitybiz.GoalReconcileInboxItem, bool, error) {
	s.claims = append(s.claims, input)
	if s.items != nil {
		for _, item := range s.items {
			if item.RequestID == input.RequestID {
				item.Attempt++
				item.LeaseOwner = input.LeaseOwner
				return item, true, nil
			}
		}
	}
	s.item.Attempt++
	s.item.LeaseOwner = input.LeaseOwner
	return s.item, true, nil
}

func TestGoalReconcileInboxWorkerRefreshesClockAndLeaseCoversHandlerTimeout(t *testing.T) {
	store := &goalReconcileInboxWorkerStore{items: []agentactivitybiz.GoalReconcileInboxItem{{RequestID: "one", WorkspaceID: "ws", AgentSessionID: "session", PayloadError: "bad"}, {RequestID: "two", WorkspaceID: "ws", AgentSessionID: "session", PayloadError: "bad"}}}
	service := newIsolatedAgentService(newFakeRuntime())
	service.GoalReconcileInboxStore = store
	service.GoalStateStore = &goalEvidenceFenceStore{recordingGoalStateStore: &recordingGoalStateStore{}, state: agentactivitybiz.SessionGoalState{WorkspaceID: "ws", AgentSessionID: "session", Revision: 1}, operations: map[string]agentactivitybiz.GoalControlOperation{}}
	now := time.UnixMilli(1_000)
	service.GoalOperationClock = func() time.Time { current := now; now = now.Add(10 * time.Minute); return current }
	if err := service.StepGoalReconcileInboxWorker(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(store.claims) != 2 {
		t.Fatalf("claims=%#v", store.claims)
	}
	for _, claim := range store.claims {
		if claim.LeaseExpiresAtMS-claim.NowUnixMS != goalReconcileInboxLease.Milliseconds() {
			t.Fatalf("lease=%#v", claim)
		}
	}
	if store.claims[1].NowUnixMS <= store.claims[0].NowUnixMS {
		t.Fatalf("stale claim clocks=%#v", store.claims)
	}
}
func (*goalReconcileInboxWorkerStore) CompleteGoalReconcileInbox(context.Context, string, string, int64) (bool, error) {
	return true, nil
}
func (s *goalReconcileInboxWorkerStore) ReleaseGoalReconcileInbox(_ context.Context, input agentactivitybiz.ReleaseGoalReconcileInboxInput) (bool, error) {
	s.release = input
	return true, nil
}
func (*goalReconcileInboxWorkerStore) RequeueLeasedGoalReconcileInboxOnStartup(context.Context, int64) (int64, error) {
	return 1, nil
}

func TestGoalReconcileInboxWorkerExhaustionBecomesDurableTerminal(t *testing.T) {
	store := &goalReconcileInboxWorkerStore{item: agentactivitybiz.GoalReconcileInboxItem{
		RequestID: "request", WorkspaceID: "ws", AgentSessionID: "session", Attempt: goalReconcileInboxMaxAttempts - 1,
		PayloadError: "corrupt durable payload",
	}}
	service := newIsolatedAgentService(newFakeRuntime())
	service.GoalReconcileInboxStore = store
	service.GoalStateStore = &goalEvidenceFenceStore{recordingGoalStateStore: &recordingGoalStateStore{}, state: agentactivitybiz.SessionGoalState{WorkspaceID: "ws", AgentSessionID: "session", Revision: 1}, operations: map[string]agentactivitybiz.GoalControlOperation{}}
	if err := service.StepGoalReconcileInboxWorker(context.Background()); err != nil {
		t.Fatalf("worker: %v", err)
	}
	if !store.release.Fail || store.release.RequestID != "request" || store.release.LastError == "" {
		t.Fatalf("terminal release=%#v", store.release)
	}
}

func TestGoalReconcileInboxWorkerExhaustionPersistsRevisionTerminalFence(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "goal-inbox-terminal.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	goalStore := storesqlite.New(db, storesqlite.Options{})
	ctx := context.Background()
	if err := goalStore.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := goalStore.ReportSessionState(ctx, storesqlite.SessionStateReport{WorkspaceID: "ws", AgentSessionID: "session", Provider: "codex", OccurredAtUnixMS: 1}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := goalStore.PrepareGoalControlOperation(ctx, storesqlite.GoalControlOperationPrepare{OperationID: "goal-1", WorkspaceID: "ws", AgentSessionID: "session", Action: "set", Objective: "ship", OccurredAtUnixMS: 2}); err != nil {
		t.Fatal(err)
	}
	if _, err := goalStore.ReconcileSessionGoalObservation(ctx, storesqlite.GoalObservationReconcile{WorkspaceID: "ws", AgentSessionID: "session", Observed: map[string]any{"objective": "ship"}, Evidence: map[string]any{"confidence": "authoritative"}, OccurredAtUnixMS: 3}); err != nil {
		t.Fatal(err)
	}
	inbox := &goalReconcileInboxWorkerStore{item: agentactivitybiz.GoalReconcileInboxItem{RequestID: "request-exhausted", WorkspaceID: "ws", AgentSessionID: "session", Attempt: goalReconcileInboxMaxAttempts - 1, PayloadError: "corrupt durable payload"}}
	service := newIsolatedAgentService(newFakeRuntime())
	service.GoalStateStore = goalStore
	service.GoalReconcileInboxStore = inbox
	if err := service.StepGoalReconcileInboxWorker(ctx); err != nil {
		t.Fatal(err)
	}
	if !inbox.release.Fail {
		t.Fatalf("inbox was failed before durable terminal escalation: %#v", inbox.release)
	}
	state, err := goalStore.ReconcileSessionGoalObservation(ctx, storesqlite.GoalObservationReconcile{WorkspaceID: "ws", AgentSessionID: "session", Observed: map[string]any{"objective": "ship"}, Evidence: map[string]any{"confidence": "authoritative"}, OccurredAtUnixMS: 10})
	if err != nil || state.SyncStatus != storesqlite.GoalSyncStatusUnknown || state.LastError == "" {
		t.Fatalf("authoritative reconcile unlocked exhausted inbox state=%#v err=%v", state, err)
	}
}

func TestGoalReconcileInboxWorkerExhaustionTerminatesRevisionZeroState(t *testing.T) {
	store := &goalReconcileInboxWorkerStore{item: agentactivitybiz.GoalReconcileInboxItem{
		RequestID: "request-zero", WorkspaceID: "ws", AgentSessionID: "session", Attempt: goalReconcileInboxMaxAttempts - 1,
		PayloadError: "corrupt durable payload",
	}}
	goalStore := &goalEvidenceFenceStore{
		recordingGoalStateStore: &recordingGoalStateStore{},
		state:                   agentactivitybiz.SessionGoalState{WorkspaceID: "ws", AgentSessionID: "session", Revision: 0},
		operations:              map[string]agentactivitybiz.GoalControlOperation{},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.GoalReconcileInboxStore = store
	service.GoalStateStore = goalStore
	if err := service.StepGoalReconcileInboxWorker(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !store.release.Fail || len(goalStore.reconcileInputs) != 1 || !goalStore.reconcileInputs[0].ForceSyncUnknown || goalStore.reconcileInputs[0].LastError == "" {
		t.Fatalf("release=%#v reconcile=%#v", store.release, goalStore.reconcileInputs)
	}
}
