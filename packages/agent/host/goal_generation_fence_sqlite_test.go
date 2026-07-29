package agenthost_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"sync"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

type goalFenceRuntime struct {
	mu         sync.Mutex
	controls   []agenthost.RuntimeGoalControlInput
	fences     []agenthost.RuntimeGoalGenerationFenceInput
	fenceError error
	onFence    func()
}

type offlineGoalFenceSessionRuntime struct {
	agenthost.RuntimeController
	mu          sync.Mutex
	session     agenthost.ProviderRuntimeSession
	live        bool
	resumeCalls int
}

type pendingCancelGoalFenceRuntime struct {
	agenthost.RuntimeController
	mu          sync.Mutex
	session     agenthost.ProviderRuntimeSession
	live        bool
	resumeCalls int
	cancelCalls int
}

func (r *pendingCancelGoalFenceRuntime) Session(workspaceID, agentSessionID string) (agenthost.ProviderRuntimeSession, bool) {
	return r.session, workspaceID == r.session.WorkspaceID && agentSessionID == r.session.ID
}

func (r *pendingCancelGoalFenceRuntime) RuntimeSessionLive(workspaceID, agentSessionID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.live && workspaceID == r.session.WorkspaceID && agentSessionID == r.session.ID
}

func (r *pendingCancelGoalFenceRuntime) Resume(
	_ context.Context,
	_ agenthost.RuntimeResumeInput,
) (agenthost.ProviderRuntimeSession, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.resumeCalls++
	r.live = true
	return r.session, nil
}

func (r *pendingCancelGoalFenceRuntime) Cancel(context.Context, agenthost.RuntimeCancelInput) (agenthost.RuntimeCancelResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cancelCalls++
	return agenthost.RuntimeCancelResult{}, agenthost.ErrRuntimeSessionDisconnected
}

func (r *pendingCancelGoalFenceRuntime) setLive(live bool) {
	r.mu.Lock()
	r.live = live
	r.mu.Unlock()
}

func (r *pendingCancelGoalFenceRuntime) counts() (int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.resumeCalls, r.cancelCalls
}

func (r *offlineGoalFenceSessionRuntime) Session(workspaceID, agentSessionID string) (agenthost.ProviderRuntimeSession, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.session, r.live && workspaceID == r.session.WorkspaceID && agentSessionID == r.session.ID
}

func (r *offlineGoalFenceSessionRuntime) RuntimeSessionLive(workspaceID, agentSessionID string) bool {
	_, live := r.Session(workspaceID, agentSessionID)
	return live
}

func (r *offlineGoalFenceSessionRuntime) Resume(_ context.Context, input agenthost.RuntimeResumeInput) (agenthost.ProviderRuntimeSession, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.resumeCalls++
	r.live = true
	r.session.ID = input.AgentSessionID
	r.session.WorkspaceID = input.WorkspaceID
	r.session.Provider = input.Provider
	r.session.ProviderSessionID = input.ProviderSessionID
	return r.session, nil
}

func (r *offlineGoalFenceSessionRuntime) resumeCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.resumeCalls
}

func (r *goalFenceRuntime) GoalControl(_ context.Context, input agenthost.RuntimeGoalControlInput) (agenthost.RuntimeGoalControlResult, error) {
	r.mu.Lock()
	r.controls = append(r.controls, input)
	r.mu.Unlock()
	goal := map[string]any{"objective": input.Objective, "status": "active"}
	if input.Action == "clear" {
		goal = nil
	}
	return agenthost.RuntimeGoalControlResult{
		AgentSessionID: input.AgentSessionID, Goal: goal,
		Evidence: map[string]any{"source": "test"}, ProviderPhase: storesqlite.GoalProviderPhaseApplied,
	}, nil
}

func (r *goalFenceRuntime) FenceGoalGeneration(_ context.Context, input agenthost.RuntimeGoalGenerationFenceInput) error {
	r.mu.Lock()
	r.fences = append(r.fences, input)
	onFence := r.onFence
	err := r.fenceError
	r.mu.Unlock()
	if onFence != nil {
		onFence()
	}
	return err
}

func (r *goalFenceRuntime) snapshot() ([]agenthost.RuntimeGoalControlInput, []agenthost.RuntimeGoalGenerationFenceInput) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]agenthost.RuntimeGoalControlInput(nil), r.controls...),
		append([]agenthost.RuntimeGoalGenerationFenceInput(nil), r.fences...)
}

func openGoalFenceHostStore(t *testing.T) *storesqlite.Store {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "agent-host-goal-fence.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: "workspace", AgentSessionID: "session", Provider: "claude-code", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	return store
}

func newGoalFenceHost(store *storesqlite.Store, goalRuntime *goalFenceRuntime) *agenthost.Host {
	runtimeSession := agenthost.ProviderRuntimeSession{
		ID: "session", WorkspaceID: "workspace", Provider: "claude-code",
	}
	return agenthost.New(agenthost.Config{
		CanonicalStore: sqliteCanonicalStore{Store: store},
		Runtime:        liveGoalRuntime{session: runtimeSession},
		GoalStore:      store,
		GoalFences:     store,
		GoalRuntime:    goalRuntime,
	})
}

func TestFenceGoalGenerationDurablyClearsOnlyCurrentGeneration(t *testing.T) {
	store := openGoalFenceHostStore(t)
	runtime := &goalFenceRuntime{}
	host := newGoalFenceHost(store, runtime)
	target, err := host.GoalControl(t.Context(), agenthost.GoalControlInput{
		WorkspaceID: "workspace", AgentSessionID: "session", Action: "set",
		Objective: "shared work", ClientSubmitID: "shared-goal-submit",
	})
	if err != nil {
		t.Fatal(err)
	}
	resolved, found, err := host.FindGoalControlOperationByClientSubmitID(t.Context(), agenthost.SessionRef{
		WorkspaceID: "workspace", AgentSessionID: "session",
	}, "shared-goal-submit")
	if err != nil || !found || resolved.OperationID != target.OperationID {
		t.Fatalf("resolved=%#v found=%v error=%v", resolved, found, err)
	}

	result, err := host.FenceGoalGeneration(t.Context(), agenthost.FenceGoalGenerationInput{
		WorkspaceID: "workspace", AgentSessionID: "session",
		TargetOperationID: target.OperationID, ClientSubmitID: "binding-revoke-1",
		Reason: "binding_revoked",
	})
	if err != nil || !result.IntentAccepted || !result.Settled {
		t.Fatalf("fence result=%#v error=%v", result, err)
	}
	state, found, err := store.GetSessionGoalState(t.Context(), "workspace", "session")
	if err != nil || !found || !state.Tombstoned || state.Revision != 2 {
		t.Fatalf("goal state=%#v found=%v error=%v", state, found, err)
	}
	controls, fences := runtime.snapshot()
	if len(fences) == 0 || fences[0].TargetOperationID != target.OperationID ||
		fences[0].TargetRevision != 1 {
		t.Fatalf("runtime fences=%#v", fences)
	}
	if len(controls) != 2 || controls[0].Action != "set" || controls[1].Action != "clear" {
		t.Fatalf("runtime controls=%#v", controls)
	}

	restartedRuntime := &goalFenceRuntime{}
	restarted := newGoalFenceHost(store, restartedRuntime)
	if _, err := restarted.EnsureRuntimeSession(t.Context(), agenthost.SessionRef{
		WorkspaceID: "workspace", AgentSessionID: "session",
	}); err != nil {
		t.Fatal(err)
	}
	_, restoredFences := restartedRuntime.snapshot()
	if len(restoredFences) != 1 || restoredFences[0].TargetOperationID != target.OperationID {
		t.Fatalf("restored fences=%#v", restoredFences)
	}
	if _, err := restarted.EnsureRuntimeSession(t.Context(), agenthost.SessionRef{
		WorkspaceID: "workspace", AgentSessionID: "session",
	}); err != nil {
		t.Fatal(err)
	}
	_, restoredFences = restartedRuntime.snapshot()
	if len(restoredFences) != 1 {
		t.Fatalf("live EnsureRuntimeSession rescanned durable fences: %#v", restoredFences)
	}
}

func TestFenceGoalGenerationDoesNotClearNewerOwnerGoal(t *testing.T) {
	store := openGoalFenceHostStore(t)
	runtime := &goalFenceRuntime{}
	host := newGoalFenceHost(store, runtime)
	shared, err := host.GoalControl(t.Context(), agenthost.GoalControlInput{
		WorkspaceID: "workspace", AgentSessionID: "session", Action: "set",
		Objective: "shared work", ClientSubmitID: "shared",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := host.GoalControl(t.Context(), agenthost.GoalControlInput{
		WorkspaceID: "workspace", AgentSessionID: "session", Action: "set",
		Objective: "owner work", ClientSubmitID: "owner",
	}); err != nil {
		t.Fatal(err)
	}
	result, err := host.FenceGoalGeneration(t.Context(), agenthost.FenceGoalGenerationInput{
		WorkspaceID: "workspace", AgentSessionID: "session",
		TargetOperationID: shared.OperationID, ClientSubmitID: "revoke-shared",
	})
	if err != nil || !result.Settled {
		t.Fatalf("fence result=%#v error=%v", result, err)
	}
	state, found, err := store.GetSessionGoalState(t.Context(), "workspace", "session")
	if err != nil || !found || state.Revision != 2 || state.Tombstoned ||
		state.Desired["objective"] != "owner work" {
		t.Fatalf("owner goal state=%#v found=%v error=%v", state, found, err)
	}
	controls, _ := runtime.snapshot()
	if len(controls) != 2 {
		t.Fatalf("fence issued a session-wide clear: %#v", controls)
	}
}

func TestFenceGoalGenerationAcceptanceSurvivesRuntimeFailure(t *testing.T) {
	store := openGoalFenceHostStore(t)
	runtime := &goalFenceRuntime{}
	host := newGoalFenceHost(store, runtime)
	target, err := host.GoalControl(t.Context(), agenthost.GoalControlInput{
		WorkspaceID: "workspace", AgentSessionID: "session", Action: "set",
		Objective: "shared", ClientSubmitID: "shared",
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime.fenceError = errors.New("runtime unavailable")
	result, err := host.FenceGoalGeneration(t.Context(), agenthost.FenceGoalGenerationInput{
		WorkspaceID: "workspace", AgentSessionID: "session",
		TargetOperationID: target.OperationID, ClientSubmitID: "revoke",
	})
	if err == nil || !result.IntentAccepted || result.Settled {
		t.Fatalf("fence result=%#v error=%v", result, err)
	}
	runtime.fenceError = nil
	restarted := newGoalFenceHost(store, runtime)
	if err := restarted.RecoverGoalOperations(t.Context()); err != nil {
		t.Fatal(err)
	}
	persisted, found, err := store.GetGoalGenerationFence(t.Context(), "workspace", result.Fence.FenceID)
	if err != nil || !found || persisted.Status != storesqlite.GoalGenerationFenceStatusCompleted {
		t.Fatalf("persisted=%#v found=%v error=%v", persisted, found, err)
	}
}

func TestGoalRecoveryProcessesFenceBeforePendingTargetOperation(t *testing.T) {
	store := openGoalFenceHostStore(t)
	target, state, created, err := store.PrepareGoalControlOperation(t.Context(), storesqlite.GoalControlOperationPrepare{
		OperationID: "shared-goal-op", WorkspaceID: "workspace", AgentSessionID: "session",
		Action: "set", Objective: "must never replay", ClientSubmitID: "shared-submit",
		OccurredAtUnixMS: 10,
	})
	if err != nil || !created || state.Revision != 1 {
		t.Fatalf("target=%#v state=%#v created=%v error=%v", target, state, created, err)
	}
	if _, created, err := store.PrepareGoalGenerationFence(t.Context(), storesqlite.GoalGenerationFencePrepare{
		FenceID: "binding-revoke", WorkspaceID: "workspace", AgentSessionID: "session",
		TargetOperationID: target.OperationID, ClientSubmitID: "binding-revoke",
		Reason: "binding_revoked", OccurredAtUnixMS: 20,
	}); err != nil || !created {
		t.Fatalf("prepare fence created=%v error=%v", created, err)
	}

	runtime := &goalFenceRuntime{}
	host := newGoalFenceHost(store, runtime)
	if err := host.RecoverGoalOperations(t.Context()); err != nil {
		t.Fatal(err)
	}
	controls, fences := runtime.snapshot()
	if len(fences) == 0 || fences[0].TargetOperationID != target.OperationID {
		t.Fatalf("runtime fences=%#v", fences)
	}
	if len(controls) != 1 || controls[0].Action != "clear" {
		t.Fatalf("pending fenced target reached provider before its fence: %#v", controls)
	}
	persistedTarget, found, err := store.GetGoalControlOperation(t.Context(), "workspace", target.OperationID)
	if err != nil || !found || persistedTarget.Status != storesqlite.GoalOperationStatusSuperseded {
		t.Fatalf("target=%#v found=%v error=%v", persistedTarget, found, err)
	}
}

func TestGoalFenceRecoveryDoesNotResumeOfflineSession(t *testing.T) {
	store := openGoalFenceHostStore(t)
	if _, err := store.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: "workspace", AgentSessionID: "session", Provider: "claude-code",
		ProviderSessionID: "provider-session", OccurredAtUnixMS: 2,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(t.Context(), storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: "workspace", AgentSessionID: "session", Provider: "claude-code",
			ProviderSessionID: "provider-session", OccurredAtUnixMS: 3,
		},
		Turn: &storesqlite.TurnTransition{
			WorkspaceID: "workspace", AgentSessionID: "session", TurnID: "settled-turn",
			Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeCompleted,
			Origin: storesqlite.TurnOriginUserPrompt, OccurredAtUnixMS: 3,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID: "workspace", RootAgentSessionID: "session", RootTurnID: "settled-turn",
			ProviderTurnID: "provider-turn", Phase: storesqlite.RootProviderTurnPhaseCompleted,
			Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 3,
		},
	}); err != nil {
		t.Fatal(err)
	}
	target, _, _, err := store.PrepareGoalControlOperation(t.Context(), storesqlite.GoalControlOperationPrepare{
		OperationID: "shared-offline-goal", WorkspaceID: "workspace", AgentSessionID: "session",
		Action: "set", Objective: "revoked work", ClientSubmitID: "shared-offline-submit",
		OccurredAtUnixMS: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	sessionRuntime := &offlineGoalFenceSessionRuntime{}
	goalRuntime := &goalFenceRuntime{fenceError: agenthost.ErrRuntimeSessionDisconnected}
	host := agenthost.New(agenthost.Config{
		CanonicalStore: sqliteCanonicalStore{Store: store}, Runtime: sessionRuntime,
		GoalStore: store, GoalFences: store, GoalRuntime: goalRuntime,
	})
	result, err := host.FenceGoalGeneration(t.Context(), agenthost.FenceGoalGenerationInput{
		WorkspaceID: "workspace", AgentSessionID: "session",
		TargetOperationID: target.OperationID, ClientSubmitID: "revoke-offline",
		Reason: "binding_revoked",
	})
	if err != nil || !result.IntentAccepted || result.Settled {
		t.Fatalf("fence result=%#v error=%v", result, err)
	}
	if err := host.RecoverGoalOperations(t.Context()); err != nil {
		t.Fatal(err)
	}
	if sessionRuntime.resumeCount() != 0 {
		t.Fatalf("background fence recovery resumed provider %d times", sessionRuntime.resumeCount())
	}
	controls, fences := goalRuntime.snapshot()
	if len(controls) != 0 || len(fences) == 0 {
		t.Fatalf("offline recovery controls=%#v fence registry calls=%#v", controls, fences)
	}
	for _, fence := range fences {
		if !fence.RequireLive {
			t.Fatalf("offline fence call may reconnect provider: %#v", fence)
		}
	}
	state, found, err := store.GetSessionGoalState(t.Context(), "workspace", "session")
	if err != nil || !found || !state.Tombstoned || state.Revision != 2 {
		t.Fatalf("local conditional clear state=%#v found=%v error=%v", state, found, err)
	}
	persistedTarget, found, err := store.GetGoalControlOperation(t.Context(), "workspace", target.OperationID)
	if err != nil || !found || persistedTarget.Status != storesqlite.GoalOperationStatusSuperseded {
		t.Fatalf("target=%#v found=%v error=%v", persistedTarget, found, err)
	}

	fencesBeforeEnsure := len(fences)
	goalRuntime.mu.Lock()
	goalRuntime.fenceError = nil
	goalRuntime.mu.Unlock()
	if _, err := host.EnsureRuntimeSession(t.Context(), agenthost.SessionRef{
		WorkspaceID: "workspace", AgentSessionID: "session",
	}); err != nil {
		t.Fatal(err)
	}
	if sessionRuntime.resumeCount() != 1 {
		t.Fatalf("user-triggered Ensure resumed provider %d times", sessionRuntime.resumeCount())
	}
	_, fences = goalRuntime.snapshot()
	if len(fences) != fencesBeforeEnsure+1 ||
		fences[len(fences)-1].TargetOperationID != target.OperationID ||
		fences[len(fences)-1].RequireLive {
		t.Fatalf("Ensure returned before restoring exact fence: %#v", fences)
	}
}

func TestGoalFenceWaitsForAuthoritativeTurnTerminalAfterCancelDeliveryFailure(t *testing.T) {
	store := openGoalFenceHostStore(t)
	target, _, _, err := store.PrepareGoalControlOperation(t.Context(), storesqlite.GoalControlOperationPrepare{
		OperationID: "shared-running-goal", WorkspaceID: "workspace", AgentSessionID: "session",
		Action: "set", Objective: "running shared work", ClientSubmitID: "shared-running-submit",
		OccurredAtUnixMS: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(t.Context(), storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: "workspace", AgentSessionID: "session", Provider: "claude-code",
			ProviderSessionID: "provider-session", Status: "running",
			OccurredAtUnixMS: 20,
		},
		Turn: &storesqlite.TurnTransition{
			WorkspaceID: "workspace", AgentSessionID: "session", TurnID: "goal-turn",
			Phase: storesqlite.TurnPhaseRunning, Origin: storesqlite.TurnOriginGoalContinuation,
			SourceGoalOperationID: target.OperationID, SourceGoalRevision: target.GoalRevision,
			SourceGoalRepairEpoch: target.RepairEpoch, OccurredAtUnixMS: 20,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID: "workspace", RootAgentSessionID: "session", RootTurnID: "goal-turn",
			ProviderTurnID: "provider-goal-turn", Phase: storesqlite.RootProviderTurnPhaseRunning,
			OccurredAtUnixMS: 20,
		},
	}); err != nil {
		t.Fatal(err)
	}
	sessionRuntime := &pendingCancelGoalFenceRuntime{live: true, session: agenthost.ProviderRuntimeSession{
		ID: "session", WorkspaceID: "workspace", Provider: "claude-code",
		ProviderSessionID: "provider-session",
	}}
	goalRuntime := &goalFenceRuntime{}
	host := agenthost.New(agenthost.Config{
		CanonicalStore: sqliteCanonicalStore{Store: store}, Runtime: sessionRuntime,
		RuntimeOperations: store, GoalStore: store, GoalFences: store, GoalRuntime: goalRuntime,
	})
	result, err := host.FenceGoalGeneration(t.Context(), agenthost.FenceGoalGenerationInput{
		WorkspaceID: "workspace", AgentSessionID: "session",
		TargetOperationID: target.OperationID, ClientSubmitID: "revoke-running",
		Reason: "binding_revoked",
	})
	if err != nil || !result.IntentAccepted || result.Settled {
		t.Fatalf("fence result=%#v error=%v", result, err)
	}
	_, cancelCalls := sessionRuntime.counts()
	if cancelCalls != 1 {
		t.Fatalf("cancel calls=%d", cancelCalls)
	}
	persistedFence, found, err := store.GetGoalGenerationFence(t.Context(), "workspace", result.Fence.FenceID)
	if err != nil || !found || persistedFence.Status != storesqlite.GoalGenerationFenceStatusPending {
		t.Fatalf("fence=%#v found=%v error=%v", persistedFence, found, err)
	}
	turn, found, err := store.GetTurn(t.Context(), "workspace", "session", "goal-turn")
	if err != nil || !found || turn.Phase != storesqlite.TurnPhaseRunning {
		t.Fatalf("turn=%#v found=%v error=%v", turn, found, err)
	}
}

func TestGoalFenceDoesNotReconnectWhenConnectionDropsBeforeCancel(t *testing.T) {
	store := openGoalFenceHostStore(t)
	target, _, _, err := store.PrepareGoalControlOperation(t.Context(), storesqlite.GoalControlOperationPrepare{
		OperationID: "shared-disconnected-goal", WorkspaceID: "workspace", AgentSessionID: "session",
		Action: "set", Objective: "running shared work", ClientSubmitID: "shared-disconnected-submit",
		OccurredAtUnixMS: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(t.Context(), storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: "workspace", AgentSessionID: "session", Provider: "claude-code",
			ProviderSessionID: "provider-session", Status: "running", OccurredAtUnixMS: 20,
		},
		Turn: &storesqlite.TurnTransition{
			WorkspaceID: "workspace", AgentSessionID: "session", TurnID: "goal-turn",
			Phase: storesqlite.TurnPhaseRunning, Origin: storesqlite.TurnOriginGoalContinuation,
			SourceGoalOperationID: target.OperationID, SourceGoalRevision: target.GoalRevision,
			SourceGoalRepairEpoch: target.RepairEpoch, OccurredAtUnixMS: 20,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID: "workspace", RootAgentSessionID: "session", RootTurnID: "goal-turn",
			ProviderTurnID: "provider-goal-turn", Phase: storesqlite.RootProviderTurnPhaseRunning,
			OccurredAtUnixMS: 20,
		},
	}); err != nil {
		t.Fatal(err)
	}
	sessionRuntime := &pendingCancelGoalFenceRuntime{live: true, session: agenthost.ProviderRuntimeSession{
		ID: "session", WorkspaceID: "workspace", Provider: "claude-code",
		ProviderSessionID: "provider-session",
	}}
	goalRuntime := &goalFenceRuntime{onFence: func() {
		sessionRuntime.setLive(false)
	}}
	host := agenthost.New(agenthost.Config{
		CanonicalStore: sqliteCanonicalStore{Store: store}, Runtime: sessionRuntime,
		RuntimeOperations: store, GoalStore: store, GoalFences: store, GoalRuntime: goalRuntime,
	})
	result, err := host.FenceGoalGeneration(t.Context(), agenthost.FenceGoalGenerationInput{
		WorkspaceID: "workspace", AgentSessionID: "session",
		TargetOperationID: target.OperationID, ClientSubmitID: "revoke-disconnected",
		Reason: "binding_revoked",
	})
	if err != nil || !result.IntentAccepted || result.Settled {
		t.Fatalf("fence result=%#v error=%v", result, err)
	}
	resumeCalls, cancelCalls := sessionRuntime.counts()
	if resumeCalls != 0 || cancelCalls != 0 {
		t.Fatalf("offline cancel resumed or reached provider: resume=%d cancel=%d", resumeCalls, cancelCalls)
	}
	persistedFence, found, err := store.GetGoalGenerationFence(t.Context(), "workspace", result.Fence.FenceID)
	if err != nil || !found || persistedFence.Status != storesqlite.GoalGenerationFenceStatusPending {
		t.Fatalf("fence=%#v found=%v error=%v", persistedFence, found, err)
	}
	turn, found, err := store.GetTurn(t.Context(), "workspace", "session", "goal-turn")
	if err != nil || !found || turn.Phase != storesqlite.TurnPhaseRunning {
		t.Fatalf("turn=%#v found=%v error=%v", turn, found, err)
	}
}
