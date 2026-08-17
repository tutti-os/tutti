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

type liveGoalRuntime struct {
	agenthost.RuntimeController
	session agenthost.ProviderRuntimeSession
}

func (r liveGoalRuntime) Session(workspaceID, agentSessionID string) (agenthost.ProviderRuntimeSession, bool) {
	return r.session, workspaceID == r.session.WorkspaceID && agentSessionID == r.session.ID
}

func (r liveGoalRuntime) RuntimeSessionLive(workspaceID, agentSessionID string) bool {
	_, live := r.Session(workspaceID, agentSessionID)
	return live
}

type countingGoalRuntime struct {
	mu    sync.Mutex
	calls int
	err   error
}

type createGoalRestartRuntime struct {
	agenthost.RuntimeController
	mu      sync.Mutex
	session agenthost.ProviderRuntimeSession
	starts  int
}

func (r *createGoalRestartRuntime) Start(
	_ context.Context,
	input agenthost.RuntimeStartInput,
) (agenthost.RuntimeStartResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.starts++
	r.session = agenthost.ProviderRuntimeSession{
		ID: input.AgentSessionID, WorkspaceID: input.WorkspaceID,
		AgentTargetID: input.AgentTargetID, Provider: input.Provider,
		ProviderSessionID: "provider-" + input.AgentSessionID,
		Cwd:               input.Cwd, Status: "ready", Visible: true,
		CreatedAtUnixMS: 1, UpdatedAtUnixMS: 1,
	}
	return agenthost.RuntimeStartResult{Session: r.session, Created: true}, nil
}

func (r *createGoalRestartRuntime) Session(
	workspaceID,
	agentSessionID string,
) (agenthost.ProviderRuntimeSession, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	found := workspaceID == r.session.WorkspaceID && agentSessionID == r.session.ID
	return r.session, found
}

func (r *createGoalRestartRuntime) PublishSessionInitialization(
	_ context.Context,
	input agenthost.RuntimeSessionInitializationPublishInput,
) (agenthost.ProviderRuntimeSession, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if input.WorkspaceID != r.session.WorkspaceID || input.AgentSessionID != r.session.ID {
		return agenthost.ProviderRuntimeSession{}, agenthost.ErrSessionNotFound
	}
	return r.session, nil
}

func (r *createGoalRestartRuntime) startCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.starts
}

func (r *countingGoalRuntime) GoalControl(_ context.Context, input agenthost.RuntimeGoalControlInput) (agenthost.RuntimeGoalControlResult, error) {
	r.mu.Lock()
	r.calls++
	err := r.err
	r.mu.Unlock()
	if err != nil {
		return agenthost.RuntimeGoalControlResult{}, err
	}
	return agenthost.RuntimeGoalControlResult{
		Goal: map[string]any{"objective": input.Objective, "status": "active"},
	}, nil
}

func TestCreateWithInitialGoalPreservesAcceptedPendingIntent(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "agent-host-create-goal-pending.db"))
	if err != nil {
		t.Fatalf("open SQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatalf("migrate SQLite: %v", err)
	}
	hostRuntime := &createGoalRestartRuntime{}
	goalRuntime := &countingGoalRuntime{err: context.DeadlineExceeded}
	host := agenthost.New(agenthost.Config{
		CanonicalStore: &agenthost.SQLiteWorkspaceStore{
			StoreForWorkspace: func(string) *storesqlite.Store { return store },
			CurrentUserID:     func() string { return "user-1" },
		},
		Runtime: hostRuntime, GoalStore: store, GoalRuntime: goalRuntime,
	})
	input := agenthost.CreateSessionInput{
		AgentSessionID: "session-1", AgentTargetID: "target-1", Provider: "codex",
		ClientSubmitID: "create-goal-pending-1",
		InitialGoalControl: &agenthost.TypedGoalControl{
			Action: "set", Objective: "ship after retry",
		},
	}
	first, err := host.CreateSession(t.Context(), "workspace-1", input)
	if !errors.Is(err, context.DeadlineExceeded) || first.GoalControl == nil ||
		!first.GoalControl.IntentAccepted || !goalControlResultIsPending(first.GoalControl) ||
		first.InitialGoalStatus != agenthost.CreateSessionInitialGoalStatusUnknown {
		t.Fatalf("first pending create=%#v error=%v", first, err)
	}
	second, err := host.CreateSession(t.Context(), "workspace-1", input)
	if !errors.Is(err, agenthost.ErrRuntimeOperationInProgress) || second.GoalControl == nil ||
		!second.GoalControl.IntentAccepted || !goalControlResultIsPending(second.GoalControl) ||
		second.GoalControl.OperationID != first.GoalControl.OperationID {
		t.Fatalf("replayed pending create=%#v error=%v", second, err)
	}
	if hostRuntime.startCount() != 1 || goalRuntime.callCount() != 1 {
		t.Fatalf("pending create calls start=%d goal=%d", hostRuntime.startCount(), goalRuntime.callCount())
	}
}

func goalControlResultIsPending(result *agenthost.GoalControlResult) bool {
	return result != nil && result.GoalState != nil && result.OperationID != "" &&
		result.GoalState.PendingOperationID == result.OperationID &&
		(result.GoalState.SyncStatus == storesqlite.GoalSyncStatusPending ||
			result.GoalState.SyncStatus == storesqlite.GoalSyncStatusApplying)
}

func (r *countingGoalRuntime) callCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

func TestGoalControlRetryAfterHostRestartDoesNotReplayProviderMutation(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "agent-host-goal-restart.db"))
	if err != nil {
		t.Fatalf("open SQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatalf("migrate SQLite: %v", err)
	}
	if _, err := store.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", Provider: "codex", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	runtimeSession := agenthost.ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex",
	}
	runtime := liveGoalRuntime{session: runtimeSession}
	goalRuntime := &countingGoalRuntime{}
	newHost := func() *agenthost.Host {
		return agenthost.New(agenthost.Config{
			CanonicalStore: sqliteCanonicalStore{Store: store}, Runtime: runtime,
			GoalStore: store, GoalRuntime: goalRuntime,
		})
	}
	input := agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", Action: "set",
		Objective: "ship exactly once", ClientSubmitID: "stable-submit-1",
	}
	first, err := newHost().GoalControl(t.Context(), input)
	if err != nil {
		t.Fatalf("first GoalControl(): %v", err)
	}
	second, err := newHost().GoalControl(t.Context(), input)
	if err != nil {
		t.Fatalf("GoalControl() after restart: %v", err)
	}
	if goalRuntime.callCount() != 1 {
		t.Fatalf("provider GoalControl calls = %d, want 1", goalRuntime.callCount())
	}
	if first.OperationID == "" || second.OperationID != first.OperationID || second.GoalState == nil || second.GoalState.Revision != 1 {
		t.Fatalf("first=%#v second=%#v", first, second)
	}
}

func TestCreateWithInitialGoalRetryAfterHostRestartDoesNotStartProviderSession(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "agent-host-create-goal-restart.db"))
	if err != nil {
		t.Fatalf("open SQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatalf("migrate SQLite: %v", err)
	}
	canonicalStore := &agenthost.SQLiteWorkspaceStore{
		StoreForWorkspace: func(string) *storesqlite.Store { return store },
		CurrentUserID:     func() string { return "user-1" },
	}
	goalRuntime := &countingGoalRuntime{}
	firstRuntime := &createGoalRestartRuntime{}
	newHost := func(runtime *createGoalRestartRuntime) *agenthost.Host {
		return agenthost.New(agenthost.Config{
			CanonicalStore: canonicalStore,
			Runtime:        runtime,
			GoalStore:      store,
			GoalRuntime:    goalRuntime,
		})
	}
	input := agenthost.CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  "target-1",
		Provider:       "codex",
		ClientSubmitID: "create-goal-submit-1",
		InitialGoalControl: &agenthost.TypedGoalControl{
			Action:    "set",
			Objective: "ship exactly once",
		},
	}
	first, err := newHost(firstRuntime).CreateSession(t.Context(), "workspace-1", input)
	if err != nil {
		t.Fatalf("first CreateSession(): %v", err)
	}

	restartedRuntime := &createGoalRestartRuntime{}
	second, err := newHost(restartedRuntime).CreateSession(t.Context(), "workspace-1", input)
	if err != nil {
		t.Fatalf("CreateSession() after restart: %v", err)
	}
	if firstRuntime.startCount() != 1 || restartedRuntime.startCount() != 0 {
		t.Fatalf(
			"provider Start calls before=%d after=%d, want 1 and 0",
			firstRuntime.startCount(),
			restartedRuntime.startCount(),
		)
	}
	if goalRuntime.callCount() != 1 {
		t.Fatalf("provider GoalControl calls = %d, want 1", goalRuntime.callCount())
	}
	if first.GoalControl == nil || second.GoalControl == nil ||
		first.GoalControl.OperationID == "" ||
		second.GoalControl.OperationID != first.GoalControl.OperationID ||
		second.Session.ID != input.AgentSessionID ||
		second.TurnID != "" {
		t.Fatalf("first=%#v second=%#v", first, second)
	}
}
