package agenthost_test

import (
	"context"
	"database/sql"
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

type countingGoalRuntime struct {
	mu    sync.Mutex
	calls int
}

func (r *countingGoalRuntime) GoalControl(_ context.Context, input agenthost.RuntimeGoalControlInput) (agenthost.RuntimeGoalControlResult, error) {
	r.mu.Lock()
	r.calls++
	r.mu.Unlock()
	return agenthost.RuntimeGoalControlResult{
		Goal: map[string]any{"objective": input.Objective, "status": "active"},
	}, nil
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
