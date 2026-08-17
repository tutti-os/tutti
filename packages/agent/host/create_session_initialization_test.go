package agenthost

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type initializationBarrierTestStore struct {
	CanonicalStore
	cancelParent context.CancelFunc
	existing     storesqlite.Session
	exists       bool
	rollback     bool
	rollbackCtx  contextObservation
}

type canonicalStoreWithoutRuntimeRailPlacement struct {
	CanonicalStore
}

func (s *initializationBarrierTestStore) GetSession(
	_ context.Context,
	_, _ string,
) (storesqlite.Session, bool, error) {
	return s.existing, s.exists, nil
}

func (s *initializationBarrierTestStore) ResolveRuntimeSessionRailPlacement(
	_ context.Context,
	input ResolveRuntimeSessionRailPlacementInput,
) (*RailPlacement, error) {
	if input.RailPlacement != nil {
		placement := *input.RailPlacement
		return &placement, nil
	}
	if s.exists && strings.TrimSpace(s.existing.RailSectionKey) != "" {
		return railPlacementFromSession(s.existing)
	}
	return &RailPlacement{
		Version: RailPlacementVersion, Kind: RailPlacementKindConversations,
		SectionKey: storesqlite.RailSectionKeyConversations,
	}, nil
}

func (s *initializationBarrierTestStore) InitializeRuntimeSession(
	_ context.Context,
	input RuntimeSessionInitialization,
) (storesqlite.Session, error) {
	if s.cancelParent != nil {
		s.cancelParent()
	}
	railKind := storesqlite.RailSectionKindConversations
	railKey := storesqlite.RailSectionKeyConversations
	railProjectPath := ""
	if input.RailPlacement != nil {
		railKind = string(input.RailPlacement.Kind)
		railKey = input.RailPlacement.SectionKey
		railProjectPath = input.RailPlacement.ProjectPath
	}
	return storesqlite.Session{
		ID: input.Session.ID, WorkspaceID: input.Session.WorkspaceID,
		Provider: input.Session.Provider, ProviderSessionID: input.Session.ProviderSessionID,
		RailSectionKind: railKind, RailProjectPath: railProjectPath, RailSectionKey: railKey,
		Metadata: storesqlite.SessionMetadata{Visible: true},
	}, nil
}

func (s *initializationBarrierTestStore) RollbackRuntimeSessionInitialization(
	ctx context.Context,
	_, _ string,
) (bool, error) {
	s.rollbackCtx = observeContext(ctx)
	s.rollback = true
	return true, nil
}

type initializationBarrierTestRuntime struct {
	RuntimeController
	locker        *initializationBarrierTestLocker
	session       ProviderRuntimeSession
	reuseExisting bool
	publishErr    error
	publishCtx    contextObservation
	closeCtx      contextObservation
	closeCalls    int
	startCalls    int
	publishCalls  int
}

func (r *initializationBarrierTestRuntime) Start(
	_ context.Context,
	input RuntimeStartInput,
) (RuntimeStartResult, error) {
	r.startCalls++
	r.session = ProviderRuntimeSession{
		ID: input.AgentSessionID, WorkspaceID: input.WorkspaceID,
		AgentTargetID: input.AgentTargetID, Provider: input.Provider,
		ProviderSessionID: "provider-" + input.AgentSessionID,
		Cwd:               input.Cwd, Status: "ready", Visible: true,
		CreatedAtUnixMS: 1, UpdatedAtUnixMS: 1,
	}
	return RuntimeStartResult{Session: r.session, Created: !r.reuseExisting}, nil
}

func (r *initializationBarrierTestRuntime) PublishSessionInitialization(
	ctx context.Context,
	_ RuntimeSessionInitializationPublishInput,
) (ProviderRuntimeSession, error) {
	r.publishCalls++
	r.publishCtx = observeContext(ctx)
	if r.publishErr != nil {
		return ProviderRuntimeSession{}, r.publishErr
	}
	return r.session, nil
}

func (r *initializationBarrierTestRuntime) Close(
	ctx context.Context,
	_ RuntimeCloseInput,
) error {
	r.closeCalls++
	r.closeCtx = observeContext(ctx)
	if r.locker != nil && !r.locker.isHeld() {
		return errors.New("runtime close ran without the session lifecycle lock")
	}
	return context.DeadlineExceeded
}

type initializationBarrierTestPreparation struct {
	cleanupCalls int
	cleanupCtx   contextObservation
}

func (*initializationBarrierTestPreparation) Prepare(
	_ context.Context,
	input RuntimePreparationInput,
) (PreparedRuntime, error) {
	return PreparedRuntime{Cwd: input.Cwd}, nil
}

func (p *initializationBarrierTestPreparation) Cleanup(
	ctx context.Context,
	_ RuntimeCleanupInput,
) error {
	p.cleanupCalls++
	p.cleanupCtx = observeContext(ctx)
	return nil
}

type initializationBarrierTestLocker struct {
	mu       sync.Mutex
	held     bool
	acquires int
	releases int
}

func (l *initializationBarrierTestLocker) Acquire(ctx context.Context, _ SessionRef) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.held {
		return nil, errors.New("session lifecycle lock acquired twice")
	}
	l.held = true
	l.acquires++
	return func() {
		l.mu.Lock()
		l.held = false
		l.releases++
		l.mu.Unlock()
	}, nil
}

func (l *initializationBarrierTestLocker) isHeld() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.held
}

type initializationBarrierGoalRuntime struct {
	calls int
}

func (r *initializationBarrierGoalRuntime) GoalControl(
	context.Context,
	RuntimeGoalControlInput,
) (RuntimeGoalControlResult, error) {
	r.calls++
	return RuntimeGoalControlResult{}, nil
}

type contextObservation struct {
	err         error
	hasDeadline bool
	remaining   time.Duration
}

func observeContext(ctx context.Context) contextObservation {
	deadline, hasDeadline := ctx.Deadline()
	remaining := time.Duration(0)
	if hasDeadline {
		remaining = time.Until(deadline)
	}
	return contextObservation{
		err: ctx.Err(), hasDeadline: hasDeadline, remaining: remaining,
	}
}

func TestCreateSessionPublishFailureCleansWithIndependentDeadlinesUnderLifecycleLock(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	store := &initializationBarrierTestStore{cancelParent: cancel}
	locker := &initializationBarrierTestLocker{}
	publishErr := errors.New("publish initialization")
	runtime := &initializationBarrierTestRuntime{locker: locker, publishErr: publishErr}
	preparation := &initializationBarrierTestPreparation{}
	goalRuntime := &initializationBarrierGoalRuntime{}
	host := New(Config{
		CanonicalStore: store, Runtime: runtime, RuntimePreparation: preparation,
		SessionLocker: locker, GoalRuntime: goalRuntime,
	})

	result, err := host.CreateSession(ctx, "workspace-1", CreateSessionInput{
		AgentSessionID: "session-1", AgentTargetID: "target-1", Provider: "codex",
		InitialGoalControl: &TypedGoalControl{Action: "set", Objective: "must not execute"},
		RailPlacement: &RailPlacement{
			Version: 1, Kind: RailPlacementKindProject, ProjectPath: "/workspace/project",
		},
	})
	if !errors.Is(err, publishErr) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("CreateSession() result=%#v error=%v, want publish and close errors", result, err)
	}
	if result.SessionStatus != CreateSessionStatusNotCreated {
		t.Fatalf("CreateSession() status=%q, want %q", result.SessionStatus, CreateSessionStatusNotCreated)
	}
	if runtime.publishCalls != 1 || runtime.closeCalls != 1 || !store.rollback ||
		preparation.cleanupCalls != 1 || goalRuntime.calls != 0 {
		t.Fatalf(
			"cleanup calls publish=%d close=%d rollback=%v preparation=%d goal=%d",
			runtime.publishCalls,
			runtime.closeCalls,
			store.rollback,
			preparation.cleanupCalls,
			goalRuntime.calls,
		)
	}
	if locker.isHeld() || locker.acquires != 1 || locker.releases != 1 {
		t.Fatalf("lifecycle lock held=%v acquires=%d releases=%d", locker.isHeld(), locker.acquires, locker.releases)
	}
	assertDetachedDeadline(t, "publish", runtime.publishCtx, runtimeSessionPublishTimeout)
	assertDetachedDeadline(t, "runtime close", runtime.closeCtx, failedCreateRuntimeCloseTimeout)
	assertDetachedDeadline(t, "canonical rollback", store.rollbackCtx, failedCreateRollbackTimeout)
	assertDetachedDeadline(t, "preparation cleanup", preparation.cleanupCtx, failedCreatePreparationTimeout)
}

func TestCreateSessionConflictDoesNotStartOrCloseExistingRuntime(t *testing.T) {
	store := &initializationBarrierTestStore{
		exists: true,
		existing: storesqlite.Session{
			ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex",
			RailSectionKind: storesqlite.RailSectionKindConversations,
			RailSectionKey:  storesqlite.RailSectionKeyConversations,
		},
	}
	runtime := &initializationBarrierTestRuntime{reuseExisting: true}
	host := New(Config{CanonicalStore: store, Runtime: runtime})

	_, err := host.CreateSession(t.Context(), "workspace-1", CreateSessionInput{
		AgentSessionID: "session-1", AgentTargetID: "target-1", Provider: "codex",
		RailPlacement: &RailPlacement{
			Version: 1, Kind: RailPlacementKindProject,
			ProjectPath: "/workspace/project", SectionKey: "project:/workspace/project",
		},
	})
	if !errors.Is(err, ErrRailPlacementConflict) {
		t.Fatalf("CreateSession() error = %v, want rail conflict", err)
	}
	if runtime.startCalls != 0 || runtime.closeCalls != 0 || store.rollback {
		t.Fatalf("conflicting retry mutated existing state: start=%d close=%d rollback=%v", runtime.startCalls, runtime.closeCalls, store.rollback)
	}
}

func TestCreateSessionFailsClosedWithoutRuntimeRailPlacementResolver(t *testing.T) {
	store := &initializationBarrierTestStore{}
	runtime := &initializationBarrierTestRuntime{}
	host := New(Config{
		CanonicalStore: canonicalStoreWithoutRuntimeRailPlacement{CanonicalStore: store},
		Runtime:        runtime,
	})

	_, err := host.CreateSession(t.Context(), "workspace-1", CreateSessionInput{
		AgentSessionID: "session-1", AgentTargetID: "target-1", Provider: "codex",
	})
	if !errors.Is(err, ErrRuntimeRailPlacementUnavailable) {
		t.Fatalf("CreateSession() error = %v, want %v", err, ErrRuntimeRailPlacementUnavailable)
	}
	if runtime.startCalls != 0 {
		t.Fatalf("runtime start calls = %d, want 0", runtime.startCalls)
	}
}

func TestCreateSessionPublishFailurePreservesReusedRuntimeAndCanonicalSession(t *testing.T) {
	canonical := storesqlite.Session{
		ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex",
		RailSectionKind: storesqlite.RailSectionKindProject,
		RailProjectPath: "/workspace/project",
		RailSectionKey:  "project:/workspace/project",
	}
	store := &initializationBarrierTestStore{exists: true, existing: canonical}
	runtime := &initializationBarrierTestRuntime{
		reuseExisting: true,
		publishErr:    errors.New("publish initialization"),
	}
	host := New(Config{CanonicalStore: store, Runtime: runtime})

	_, err := host.CreateSession(t.Context(), "workspace-1", CreateSessionInput{
		AgentSessionID: "session-1", AgentTargetID: "target-1", Provider: "codex",
		RailPlacement: &RailPlacement{
			Version: 1, Kind: RailPlacementKindProject,
			ProjectPath: "/workspace/project", SectionKey: "project:/workspace/project",
		},
	})
	if err == nil || !strings.Contains(err.Error(), "publish initialization") {
		t.Fatalf("CreateSession() error = %v, want publish failure", err)
	}
	if runtime.startCalls != 1 || runtime.closeCalls != 0 || store.rollback {
		t.Fatalf("failed retry compensated existing state: start=%d close=%d rollback=%v", runtime.startCalls, runtime.closeCalls, store.rollback)
	}
}

func assertDetachedDeadline(
	t *testing.T,
	name string,
	observation contextObservation,
	wantMaximum time.Duration,
) {
	t.Helper()
	if observation.err != nil || !observation.hasDeadline || observation.remaining <= 0 ||
		observation.remaining > wantMaximum {
		t.Fatalf(
			"%s context=%#v, want active detached deadline within %s",
			name,
			observation,
			wantMaximum,
		)
	}
}
