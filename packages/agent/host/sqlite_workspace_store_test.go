package agenthost_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

type workspaceStoreClock struct{ value time.Time }

func (c workspaceStoreClock) Now() time.Time { return c.value }

type workspaceStoreObserver struct{ deltas []agenthost.CommittedDelta }

func (o *workspaceStoreObserver) ObserveCommitted(_ context.Context, delta agenthost.CommittedDelta) error {
	o.deltas = append(o.deltas, delta)
	return nil
}

type runtimeSessionInitializationObserver struct {
	runtime   agenthost.ProviderRuntimeSession
	persisted storesqlite.Session
}

type runtimeSessionInitializationPolicy struct{ calls int }

func (p *runtimeSessionInitializationPolicy) NormalizeRuntimeSessionInitialization(
	_ context.Context,
	session agenthost.ProviderRuntimeSession,
) (agenthost.ProviderRuntimeSession, error) {
	p.calls++
	session.AgentTargetID = "canonical-target"
	return session, nil
}

func (o *runtimeSessionInitializationObserver) ObserveRuntimeSessionInitialized(
	_ context.Context,
	runtime agenthost.ProviderRuntimeSession,
	persisted storesqlite.Session,
) {
	o.runtime = runtime
	o.persisted = persisted
}

func TestSQLiteWorkspaceStoreInitializesCanonicalRuntimeSession(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "agent-host-store.db"))
	if err != nil {
		t.Fatalf("open SQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	canonical := storesqlite.New(db, storesqlite.Options{})
	if err := canonical.Migrate(t.Context()); err != nil {
		t.Fatalf("migrate SQLite: %v", err)
	}
	observer := &workspaceStoreObserver{}
	initializationObserver := &runtimeSessionInitializationObserver{}
	initializationPolicy := &runtimeSessionInitializationPolicy{}
	store := &agenthost.SQLiteWorkspaceStore{
		StoreForWorkspace: func(workspaceID string) *storesqlite.Store {
			if workspaceID != "workspace-1" {
				return nil
			}
			return canonical
		},
		CurrentUserID:          func() string { return " user-1 " },
		Clock:                  workspaceStoreClock{value: time.UnixMilli(1234)},
		Observer:               observer,
		InitializationPolicy:   initializationPolicy,
		InitializationObserver: initializationObserver,
	}

	persisted, err := store.InitializeRuntimeSession(t.Context(), agenthost.RuntimeSessionInitialization{
		Session: agenthost.ProviderRuntimeSession{
			ID: "session-1", WorkspaceID: "workspace-1", AgentTargetID: "target-1", Provider: "codex",
			Visible: true, Provisional: true, RuntimeContext: map[string]any{"source": "create"},
			Settings: &agenthost.ComposerSettings{Model: "gpt-5.6", ReasoningEffort: "ultra", Speed: "standard"},
		},
		RailPlacement: &agenthost.RailPlacement{
			Version:     1,
			Kind:        agenthost.RailPlacementKindProject,
			ProjectPath: "/workspace/app",
			SectionKey:  "project:workspace-1:/workspace/app",
		},
	})
	if err != nil {
		t.Fatalf("InitializeRuntimeSession() error = %v", err)
	}
	if persisted.ID != "session-1" || persisted.UserID != "user-1" || persisted.Provider != "codex" || persisted.AgentTargetID != "canonical-target" {
		t.Fatalf("persisted session = %#v", persisted)
	}
	if persisted.LastEventUnixMS != 1234 || persisted.Settings["reasoningEffort"] != "ultra" || persisted.Settings["speed"] != "standard" {
		t.Fatalf("persisted canonical fields = %#v", persisted)
	}
	if persisted.RailSectionKey != "project:workspace-1:/workspace/app" {
		t.Fatalf("persisted rail section key = %q", persisted.RailSectionKey)
	}
	if persisted.Metadata.Visible {
		t.Fatalf("provisional session visibility = true, want false")
	}
	if len(observer.deltas) != 1 || len(observer.deltas[0].ProjectionDirty) == 0 || len(observer.deltas[0].ViewsInvalidated) != 1 {
		t.Fatalf("commit deltas = %#v", observer.deltas)
	}
	if initializationObserver.runtime.ID != "session-1" || initializationObserver.persisted.ID != "session-1" {
		t.Fatalf("initialization projection = %#v", initializationObserver)
	}
	if initializationPolicy.calls != 1 {
		t.Fatalf("initialization policy calls = %d, want 1", initializationPolicy.calls)
	}

	_, err = store.InitializeRuntimeSession(t.Context(), agenthost.RuntimeSessionInitialization{
		Session: agenthost.ProviderRuntimeSession{
			ID: "session-1", WorkspaceID: "workspace-1", AgentTargetID: "target-1", Provider: "codex",
		},
		RailPlacement: &agenthost.RailPlacement{
			Version: 1, Kind: agenthost.RailPlacementKindConversations, SectionKey: "conversations",
		},
	})
	if !errors.Is(err, agenthost.ErrRailPlacementConflict) {
		t.Fatalf("conflicting rail placement error = %v", err)
	}
}

func TestSQLiteWorkspaceStoreRejectsUnknownWorkspace(t *testing.T) {
	store := &agenthost.SQLiteWorkspaceStore{StoreForWorkspace: func(string) *storesqlite.Store { return nil }}
	if _, _, err := store.GetSession(t.Context(), "workspace-1", "session-1"); err == nil {
		t.Fatal("GetSession succeeded without a workspace store")
	}
}
