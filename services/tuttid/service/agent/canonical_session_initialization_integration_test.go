package agent

import (
	"context"
	"database/sql"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	hostadapter "github.com/tutti-os/tutti/packages/agent/daemon/hostadapter"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

type canonicalInitializationIntegrationStore struct {
	*agenthost.SQLiteWorkspaceStore
	initializeEntered chan struct{}
	releaseInitialize chan struct{}
	enterOnce         sync.Once
}

type canonicalInitializationProjectPaths []string

func (paths canonicalInitializationProjectPaths) ProjectPaths(context.Context, storesqlite.Querier) ([]string, error) {
	return append([]string(nil), paths...), nil
}

func (s *canonicalInitializationIntegrationStore) InitializeRuntimeSession(
	ctx context.Context,
	input agenthost.RuntimeSessionInitialization,
) (storesqlite.Session, error) {
	s.enterOnce.Do(func() { close(s.initializeEntered) })
	select {
	case <-s.releaseInitialize:
	case <-ctx.Done():
		return storesqlite.Session{}, ctx.Err()
	}
	return s.SQLiteWorkspaceStore.InitializeRuntimeSession(ctx, input)
}

type canonicalInitializationIntegrationReporter struct {
	projection *ActivityProjection
	reports    atomic.Int32
	mu         sync.Mutex
	lastReport agentsessionstore.ReportActivityInput
}

func (*canonicalInitializationIntegrationReporter) AsyncActivityReporter() {}

func (r *canonicalInitializationIntegrationReporter) Report(
	ctx context.Context,
	input agentsessionstore.ReportActivityInput,
) error {
	r.reports.Add(1)
	r.mu.Lock()
	r.lastReport = input
	r.mu.Unlock()
	return r.projection.Report(ctx, input)
}

func (r *canonicalInitializationIntegrationReporter) ReportSubmitProvenance(
	ctx context.Context,
	input agentsessionstore.ReportActivityInput,
) error {
	return r.projection.ReportSubmitProvenance(ctx, input)
}

func (r *canonicalInitializationIntegrationReporter) snapshot() agentsessionstore.ReportActivityInput {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lastReport
}

type canonicalInitializationIntegrationObserver struct {
	calls atomic.Int32
}

func (o *canonicalInitializationIntegrationObserver) ObserveRuntimeStreamEvents(
	context.Context,
	string,
	string,
	[]agentruntime.StreamEvent,
) error {
	o.calls.Add(1)
	return nil
}

type canonicalInitializationIntegrationAdapter struct {
	sinkMu     sync.Mutex
	sink       agentruntime.SessionEventSink
	startCalls atomic.Int32
	goalCalls  atomic.Int32
}

func (*canonicalInitializationIntegrationAdapter) Provider() string {
	return agentruntime.ProviderCodex
}

func (a *canonicalInitializationIntegrationAdapter) Start(
	_ context.Context,
	session agentruntime.Session,
) ([]activityshared.Event, error) {
	a.startCalls.Add(1)
	return []activityshared.Event{activityshared.NewSessionStarted(activityshared.EventContext{
		EventID:           "canonical-init-session-started",
		Provider:          activityshared.Provider(session.Provider),
		ProviderSessionID: "provider-session-1",
		AgentSessionID:    session.AgentSessionID,
		CWD:               session.CWD,
		Title:             session.Title,
	})}, nil
}

func (*canonicalInitializationIntegrationAdapter) Resume(context.Context, agentruntime.Session) error {
	return nil
}

func (*canonicalInitializationIntegrationAdapter) Close(context.Context, agentruntime.Session) error {
	return nil
}

func (*canonicalInitializationIntegrationAdapter) Exec(
	context.Context,
	agentruntime.Session,
	[]agentruntime.PromptContentBlock,
	string,
	string,
	agentruntime.EventSink,
	agentruntime.CommandSnapshotSink,
) ([]activityshared.Event, error) {
	return nil, nil
}

func (*canonicalInitializationIntegrationAdapter) Cancel(
	context.Context,
	agentruntime.Session,
	string,
) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *canonicalInitializationIntegrationAdapter) SetSessionEventSink(
	sink agentruntime.SessionEventSink,
) {
	a.sinkMu.Lock()
	a.sink = sink
	a.sinkMu.Unlock()
}

func (a *canonicalInitializationIntegrationAdapter) emitTitleUpdate(agentSessionID, title string) {
	a.sinkMu.Lock()
	sink := a.sink
	a.sinkMu.Unlock()
	if sink == nil {
		return
	}
	sink(agentSessionID, []activityshared.Event{
		activityshared.NewSessionTitleUpdated(activityshared.EventContext{
			EventID:           "canonical-init-title-updated",
			Provider:          activityshared.Provider(agentruntime.ProviderCodex),
			ProviderSessionID: "provider-session-1",
			AgentSessionID:    agentSessionID,
			Title:             title,
		}),
	})
}

func (*canonicalInitializationIntegrationAdapter) GoalCapabilities() agentruntime.GoalAdapterCapabilities {
	return agentruntime.GoalAdapterCapabilities{}
}

func (a *canonicalInitializationIntegrationAdapter) ApplyGoal(
	_ context.Context,
	_ agentruntime.Session,
	input agentruntime.GoalApplyInput,
) (agentruntime.GoalAdapterResult, error) {
	a.goalCalls.Add(1)
	return agentruntime.GoalAdapterResult{
		Observation: map[string]any{
			"objective": input.Objective,
			"status":    "active",
		},
		Evidence: map[string]any{"phase": "applied"},
	}, nil
}

func (*canonicalInitializationIntegrationAdapter) ReconcileGoal(
	context.Context,
	agentruntime.Session,
) (agentruntime.GoalAdapterResult, error) {
	return agentruntime.GoalAdapterResult{}, nil
}

func (*canonicalInitializationIntegrationAdapter) NormalizeGoalObservation(raw map[string]any) map[string]any {
	return raw
}

func (*canonicalInitializationIntegrationAdapter) ExecGoalControl(
	context.Context,
	agentruntime.Session,
	[]agentruntime.PromptContentBlock,
	string,
) ([]activityshared.Event, bool, error) {
	return nil, false, nil
}

func TestCreateSessionCanonicalInitializationBarrierWithRealControllerAndSQLite(t *testing.T) {
	ctx := t.Context()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "canonical-initialization.db"))
	if err != nil {
		t.Fatalf("open SQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	cwd := "/workspace/selected-project"
	canonical := storesqlite.New(db, storesqlite.Options{
		ProjectPaths: canonicalInitializationProjectPaths{cwd},
	})
	if err := canonical.Migrate(ctx); err != nil {
		t.Fatalf("migrate SQLite: %v", err)
	}

	workspaceID := "workspace-canonical-initialization"
	agentSessionID := "session-canonical-initialization"
	baseStore := &agenthost.SQLiteWorkspaceStore{
		StoreForWorkspace: func(candidate string) *storesqlite.Store {
			if candidate == workspaceID {
				return canonical
			}
			return nil
		},
		CurrentUserID: func() string { return "user-1" },
	}
	store := &canonicalInitializationIntegrationStore{
		SQLiteWorkspaceStore: baseStore,
		initializeEntered:    make(chan struct{}),
		releaseInitialize:    make(chan struct{}),
	}
	projection := NewActivityProjection(canonical)
	reporter := &canonicalInitializationIntegrationReporter{projection: projection}
	adapter := &canonicalInitializationIntegrationAdapter{}
	controller := agentruntime.NewController([]agentruntime.Adapter{adapter}, reporter)
	observer := &canonicalInitializationIntegrationObserver{}
	controller.SetStreamEventObserver(observer)
	bridge := &hostadapter.RuntimeController{Backend: controller}
	applicationHost := agenthost.New(agenthost.Config{
		CanonicalStore: store,
		Runtime:        bridge,
		GoalStore:      canonical,
		GoalRuntime:    bridge,
	})

	input := agenthost.CreateSessionInput{
		AgentSessionID:       agentSessionID,
		AgentTargetID:        "local:codex",
		Provider:             agentruntime.ProviderCodex,
		Cwd:                  &cwd,
		ClientSubmitID:       "canonical-initialization-goal-1",
		InitialDisplayPrompt: "/goal ship from the selected project",
		InitialGoalControl: &agenthost.TypedGoalControl{
			Action:    "set",
			Objective: "ship from the selected project",
		},
		RailPlacement: &agenthost.RailPlacement{
			Version:     1,
			Kind:        agenthost.RailPlacementKindProject,
			ProjectPath: cwd,
		},
	}
	type createResult struct {
		result agenthost.CreateSessionResult
		err    error
	}
	created := make(chan createResult, 1)
	go func() {
		result, createErr := applicationHost.CreateSession(ctx, workspaceID, input)
		created <- createResult{result: result, err: createErr}
	}()

	select {
	case <-store.initializeEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("Host did not reach canonical initialization")
	}
	adapter.emitTitleUpdate(agentSessionID, "provider title during initialization")
	if got := reporter.reports.Load(); got != 0 {
		t.Fatalf("runtime reports before canonical initialization = %d, want 0", got)
	}
	if got := observer.calls.Load(); got != 0 {
		t.Fatalf("stream publications before canonical initialization = %d, want 0", got)
	}
	if sessions := controller.Sessions(workspaceID); len(sessions) != 0 {
		t.Fatalf("visible runtime sessions before canonical initialization = %#v", sessions)
	}
	if _, found, readErr := canonical.GetSession(ctx, workspaceID, agentSessionID); readErr != nil || found {
		t.Fatalf("canonical session before initialization found=%v error=%v", found, readErr)
	}

	close(store.releaseInitialize)
	var create createResult
	select {
	case create = <-created:
	case <-time.After(2 * time.Second):
		t.Fatal("CreateSession did not finish after canonical initialization release")
	}
	if create.err != nil {
		t.Fatalf("CreateSession error = %v", create.err)
	}
	if create.result.SessionStatus != agenthost.CreateSessionStatusCreated ||
		create.result.InitialGoalStatus != agenthost.CreateSessionInitialGoalStatusSucceeded ||
		create.result.TurnID != "" {
		t.Fatalf("CreateSession result = %#v", create.result)
	}
	persisted, found, err := canonical.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil || !found {
		t.Fatalf("canonical session after create found=%v error=%v", found, err)
	}
	wantRailKey := storesqlite.RailSectionKeyForProject(cwd)
	wantProjectPath := storesqlite.NormalizeProjectPath(cwd)
	if persisted.RailSectionKind != string(agenthost.RailPlacementKindProject) ||
		persisted.RailProjectPath != wantProjectPath || persisted.RailSectionKey != wantRailKey {
		t.Fatalf(
			"canonical rail = %q/%q/%q, want project/%q/%q",
			persisted.RailSectionKind,
			persisted.RailProjectPath,
			persisted.RailSectionKey,
			wantProjectPath,
			wantRailKey,
		)
	}
	report := reporter.snapshot()
	bufferedTitleFound := false
	for _, patch := range report.StatePatches {
		if patch.Title == "provider title during initialization" {
			bufferedTitleFound = true
			break
		}
	}
	if !bufferedTitleFound {
		t.Fatalf("released runtime report lost buffered title update: %#v", report.StatePatches)
	}
	if reporter.reports.Load() != 1 || observer.calls.Load() != 1 ||
		adapter.startCalls.Load() != 1 || adapter.goalCalls.Load() != 1 {
		t.Fatalf(
			"calls reports=%d streams=%d starts=%d goals=%d, want 1/1/1/1",
			reporter.reports.Load(),
			observer.calls.Load(),
			adapter.startCalls.Load(),
			adapter.goalCalls.Load(),
		)
	}

	replayed, err := applicationHost.CreateSession(ctx, workspaceID, input)
	if err != nil {
		t.Fatalf("replayed CreateSession error = %v", err)
	}
	if replayed.Session.ID != agentSessionID || replayed.TurnID != "" ||
		replayed.InitialGoalStatus != agenthost.CreateSessionInitialGoalStatusSucceeded {
		t.Fatalf("replayed CreateSession result = %#v", replayed)
	}
	if reporter.reports.Load() != 1 || adapter.startCalls.Load() != 1 || adapter.goalCalls.Load() != 1 {
		t.Fatalf(
			"replay calls reports=%d starts=%d goals=%d, want 1/1/1",
			reporter.reports.Load(),
			adapter.startCalls.Load(),
			adapter.goalCalls.Load(),
		)
	}
}
