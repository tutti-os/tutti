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

type workspaceStoreProjectPaths []string

func (paths workspaceStoreProjectPaths) ProjectPaths(context.Context, storesqlite.Querier) ([]string, error) {
	return append([]string(nil), paths...), nil
}

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

type workspaceStoreForkRuntime struct{}

func (workspaceStoreForkRuntime) ResolveSessionFork(
	_ context.Context,
	_ agenthost.ProviderRuntimeSession,
) (agenthost.SessionForkDriverDescriptor, error) {
	return agenthost.SessionForkDriverDescriptor{
		Kind:             "codex",
		Version:          "1",
		ThroughTurn:      true,
		StateBindingMode: agenthost.SessionForkStateBindingProviderOwned,
	}, nil
}

func (workspaceStoreForkRuntime) CanForkProviderTurn(
	context.Context,
	agenthost.RuntimeProviderTurnForkabilityInput,
) (bool, error) {
	return true, nil
}

func (workspaceStoreForkRuntime) ForkSession(
	_ context.Context,
	_ agenthost.RuntimeSessionForkInput,
) (agenthost.RuntimeSessionForkResult, error) {
	return agenthost.RuntimeSessionForkResult{}, errors.New("unexpected fork dispatch")
}

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
	canonical := storesqlite.New(db, storesqlite.Options{
		ProjectPaths: workspaceStoreProjectPaths{"/workspace/app"},
	})
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
			SectionKey:  "project:/workspace/app",
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
	wantRailKey := storesqlite.RailSectionKeyForProject("/workspace/app")
	if persisted.RailSectionKey != wantRailKey {
		t.Fatalf("persisted rail section key = %q, want %q", persisted.RailSectionKey, wantRailKey)
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

func TestSQLiteWorkspaceStoreResolvesRuntimeRailPlacementFromPreparedCWD(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "agent-host-rail-resolution.db"))
	if err != nil {
		t.Fatalf("open SQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	canonical := storesqlite.New(db, storesqlite.Options{
		ProjectPaths: workspaceStoreProjectPaths{"/workspace/app"},
	})
	if err := canonical.Migrate(t.Context()); err != nil {
		t.Fatalf("migrate SQLite: %v", err)
	}
	store := &agenthost.SQLiteWorkspaceStore{
		StoreForWorkspace: func(workspaceID string) *storesqlite.Store {
			if workspaceID != "workspace-1" {
				return nil
			}
			return canonical
		},
	}

	placement, err := store.ResolveRuntimeSessionRailPlacement(t.Context(), agenthost.ResolveRuntimeSessionRailPlacementInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Cwd:            "/workspace/app/pkg",
	})
	if err != nil {
		t.Fatalf("ResolveRuntimeSessionRailPlacement() error = %v", err)
	}
	wantKey := storesqlite.RailSectionKeyForProject("/workspace/app")
	if placement.Version != 1 || placement.Kind != agenthost.RailPlacementKindProject ||
		placement.ProjectPath != storesqlite.NormalizeProjectPath("/workspace/app") ||
		placement.SectionKey != wantKey {
		t.Fatalf("resolved placement = %#v, want project %q", placement, wantKey)
	}

	_, err = store.ResolveRuntimeSessionRailPlacement(t.Context(), agenthost.ResolveRuntimeSessionRailPlacementInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-stale-project",
		Cwd:            "/workspace/deleted-project",
		RailPlacement: &agenthost.RailPlacement{
			Version: 1, Kind: agenthost.RailPlacementKindProject,
			ProjectPath: "/workspace/deleted-project",
		},
	})
	if !errors.Is(err, agenthost.ErrRailPlacementConflict) {
		t.Fatalf("stale explicit project error = %v, want %v", err, agenthost.ErrRailPlacementConflict)
	}

	authoritative, err := store.ResolveRuntimeSessionRailPlacement(t.Context(), agenthost.ResolveRuntimeSessionRailPlacementInput{
		WorkspaceID:                "workspace-1",
		AgentSessionID:             "session-authoritative-project",
		Cwd:                        "/workspace/caller-project",
		RailPlacementAuthoritative: true,
		RailPlacement: &agenthost.RailPlacement{
			Version: 1, Kind: agenthost.RailPlacementKindProject,
			ProjectPath: "/workspace/caller-project",
		},
	})
	if err != nil {
		t.Fatalf("ResolveRuntimeSessionRailPlacement(authoritative) error = %v", err)
	}
	wantAuthoritativeKey := storesqlite.RailSectionKeyForProject("/workspace/caller-project")
	if authoritative.Kind != agenthost.RailPlacementKindProject ||
		authoritative.ProjectPath != storesqlite.NormalizeProjectPath("/workspace/caller-project") ||
		authoritative.SectionKey != wantAuthoritativeKey {
		t.Fatalf("authoritative placement = %#v, want project %q", authoritative, wantAuthoritativeKey)
	}
}

func TestSQLiteWorkspaceStoreProjectsForkTurnIdentitiesThroughProductionPort(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "agent-host-fork-store.db"))
	if err != nil {
		t.Fatalf("open SQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	canonical := storesqlite.New(db, storesqlite.Options{})
	if err := canonical.Migrate(t.Context()); err != nil {
		t.Fatalf("migrate SQLite: %v", err)
	}
	if _, err := canonical.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: "workspace-1", AgentSessionID: "source", Kind: storesqlite.SessionKindRoot,
		Origin: "runtime", Provider: "codex", ProviderSessionID: "provider-source",
		Cwd: "/workspace", Status: "ready", CurrentPhase: "idle", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatalf("seed source session: %v", err)
	}
	if _, err := canonical.ReportActivityState(t.Context(), storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: "workspace-1", AgentSessionID: "source", Kind: storesqlite.SessionKindRoot,
			Origin: "runtime", Provider: "codex", ProviderSessionID: "provider-source",
			Cwd: "/workspace", Status: "active", CurrentPhase: "working", OccurredAtUnixMS: 10,
		},
		Turn: &storesqlite.TurnTransition{
			WorkspaceID: "workspace-1", AgentSessionID: "source", TurnID: "turn-1",
			Phase: storesqlite.TurnPhaseRunning, OccurredAtUnixMS: 10,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID: "workspace-1", RootAgentSessionID: "source", RootTurnID: "turn-1",
			ProviderTurnID: "provider-turn-1", Phase: storesqlite.RootProviderTurnPhaseRunning,
			OccurredAtUnixMS: 10,
		},
	}); err != nil {
		t.Fatalf("seed running source turn: %v", err)
	}
	if _, err := canonical.ReportActivityState(t.Context(), storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: "workspace-1", AgentSessionID: "source", OccurredAtUnixMS: 12,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID: "workspace-1", RootAgentSessionID: "source", RootTurnID: "turn-1",
			ProviderTurnID: "provider-turn-1", Phase: storesqlite.RootProviderTurnPhaseCompleted,
			Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 12,
		},
	}); err != nil {
		t.Fatalf("settle source turn: %v", err)
	}
	store := &agenthost.SQLiteWorkspaceStore{
		StoreForWorkspace: func(workspaceID string) *storesqlite.Store {
			if workspaceID == "workspace-1" {
				return canonical
			}
			return nil
		},
	}
	host := agenthost.New(agenthost.Config{
		SessionForks:       store,
		SessionForkRuntime: workspaceStoreForkRuntime{},
	})
	capabilities, err := host.GetSessionForkCapabilities(
		t.Context(),
		agenthost.SessionForkCapabilityInput{
			WorkspaceID:          "workspace-1",
			SourceAgentSessionID: "source",
		},
	)
	if err != nil {
		t.Fatalf("GetSessionForkCapabilities() error = %v", err)
	}
	if !capabilities.ThroughTurn {
		t.Fatalf("GetSessionForkCapabilities() = %#v, want through-turn enabled", capabilities)
	}
}

func TestSQLiteWorkspaceStoreRejectsUnknownWorkspace(t *testing.T) {
	store := &agenthost.SQLiteWorkspaceStore{StoreForWorkspace: func(string) *storesqlite.Store { return nil }}
	if _, _, err := store.GetSession(t.Context(), "workspace-1", "session-1"); err == nil {
		t.Fatal("GetSession succeeded without a workspace store")
	}
}

func TestSQLiteWorkspaceStoreReadsSessionAndTurnFromOneSnapshot(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "agent-host-snapshot-store.db"))
	if err != nil {
		t.Fatalf("open SQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	canonical := storesqlite.New(db, storesqlite.Options{})
	if err := canonical.Migrate(t.Context()); err != nil {
		t.Fatalf("migrate SQLite: %v", err)
	}
	if _, err := canonical.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", Kind: storesqlite.SessionKindRoot,
		Origin: "runtime", Provider: "codex", CurrentPhase: "idle", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	if _, accepted, err := canonical.RecordTurnTransition(t.Context(), storesqlite.TurnTransition{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: storesqlite.TurnPhaseRunning, OccurredAtUnixMS: 2,
	}); err != nil || !accepted {
		t.Fatalf("seed turn: accepted=%v err=%v", accepted, err)
	}
	store := &agenthost.SQLiteWorkspaceStore{
		StoreForWorkspace: func(workspaceID string) *storesqlite.Store {
			if workspaceID == "workspace-1" {
				return canonical
			}
			return nil
		},
	}
	session, turn, found, err := store.GetSessionAndTurn(t.Context(), "workspace-1", "session-1", "turn-1")
	if err != nil || !found {
		t.Fatalf("GetSessionAndTurn() found=%v err=%v", found, err)
	}
	if session.ActiveTurnID != turn.TurnID || turn.Phase != storesqlite.TurnPhaseRunning {
		t.Fatalf("snapshot = session active %q, turn %#v; want active turn-1", session.ActiveTurnID, turn)
	}
}
