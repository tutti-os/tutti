package agenthost

import (
	"context"
	"errors"
	"reflect"
	"runtime"
	"testing"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type liveResumeCanonicalStore struct {
	CanonicalStore
	session  storesqlite.Session
	evidence storesqlite.ProviderSessionResumeEvidence
}

type runtimeContextCASStore struct {
	liveResumeCanonicalStore
	casCalls int
}

func (s *runtimeContextCASStore) CompareAndSwapSessionRuntimeContext(
	_ context.Context,
	_, _ string,
	expected map[string]any,
	replacement map[string]any,
) (storesqlite.Session, bool, error) {
	s.casCalls++
	if !reflect.DeepEqual(s.session.InternalRuntimeContext, expected) {
		return storesqlite.Session{}, false, nil
	}
	s.session.InternalRuntimeContext = cloneMap(replacement)
	return s.session, true, nil
}

func (s liveResumeCanonicalStore) GetSession(context.Context, string, string) (storesqlite.Session, bool, error) {
	return s.session, true, nil
}

func (liveResumeCanonicalStore) SessionDeleted(context.Context, string, string) (bool, error) {
	return false, nil
}

func (s liveResumeCanonicalStore) GetProviderSessionResumeEvidence(
	context.Context,
	string,
	string,
) (storesqlite.ProviderSessionResumeEvidence, error) {
	return s.evidence, nil
}

type liveResumeRuntime struct {
	RuntimeController
	session ProviderRuntimeSession
}

type failingResumeRuntime struct {
	RuntimeController
	err         error
	resumeCalls int
	closeCalls  int
}

func (*failingResumeRuntime) Session(string, string) (ProviderRuntimeSession, bool) {
	return ProviderRuntimeSession{}, false
}

func (r *failingResumeRuntime) Resume(context.Context, RuntimeResumeInput) (ProviderRuntimeSession, error) {
	r.resumeCalls++
	return ProviderRuntimeSession{}, r.err
}

func (r *failingResumeRuntime) Close(context.Context, RuntimeCloseInput) error {
	r.closeCalls++
	return nil
}

type trackingResumePreparation struct {
	cleanupCalls int
	cleanupInput RuntimeCleanupInput
	prepareInput RuntimePreparationInput
	prepared     PreparedRuntime
}

func (p *trackingResumePreparation) Prepare(_ context.Context, input RuntimePreparationInput) (PreparedRuntime, error) {
	p.prepareInput = input
	if len(p.prepared.MCPServers) > 0 {
		return p.prepared, nil
	}
	return PreparedRuntime{MCPServers: []MCPServerBinding{{Name: "connector", Type: "http"}}}, nil
}

type reprepareRuntime struct {
	RuntimeController
	session        ProviderRuntimeSession
	reprepareCalls int
	reprepareInput RuntimeResumeInput
	reprepareErr   error
	closeCalls     int
	closeEntered   chan struct{}
	releaseClose   chan struct{}
}

func (r *reprepareRuntime) Close(context.Context, RuntimeCloseInput) error {
	r.closeCalls++
	if r.closeEntered != nil {
		close(r.closeEntered)
	}
	if r.releaseClose != nil {
		<-r.releaseClose
	}
	return nil
}

type disconnectedReprepareRuntime struct {
	RuntimeController
	resumeCalls int
	resumeInput RuntimeResumeInput
}

func (*disconnectedReprepareRuntime) Session(string, string) (ProviderRuntimeSession, bool) {
	return ProviderRuntimeSession{}, false
}

func (r *disconnectedReprepareRuntime) Resume(_ context.Context, input RuntimeResumeInput) (ProviderRuntimeSession, error) {
	r.resumeCalls++
	r.resumeInput = input
	return ProviderRuntimeSession{ID: input.AgentSessionID, WorkspaceID: input.WorkspaceID, ProviderSessionID: input.ProviderSessionID}, nil
}

func (r *reprepareRuntime) Session(workspaceID, sessionID string) (ProviderRuntimeSession, bool) {
	return r.session, workspaceID == r.session.WorkspaceID && sessionID == r.session.ID
}

func (r *reprepareRuntime) Reprepare(_ context.Context, input RuntimeResumeInput) (ProviderRuntimeSession, error) {
	r.reprepareCalls++
	r.reprepareInput = input
	if r.reprepareErr != nil {
		return ProviderRuntimeSession{}, r.reprepareErr
	}
	r.session.MCPServers = cloneHostMCPServerBindings(input.MCPServers)
	return r.session, nil
}

func (p *trackingResumePreparation) Cleanup(_ context.Context, input RuntimeCleanupInput) error {
	p.cleanupCalls++
	p.cleanupInput = input
	return nil
}

func (r liveResumeRuntime) Session(workspaceID, sessionID string) (ProviderRuntimeSession, bool) {
	return r.session, workspaceID == r.session.WorkspaceID && sessionID == r.session.ID
}

func TestEnsureRuntimeSessionPreservesLiveResumableObservation(t *testing.T) {
	store := liveResumeCanonicalStore{session: storesqlite.Session{
		ID: "session-1", WorkspaceID: "workspace-1", Kind: storesqlite.SessionKindRoot,
		Provider: "codex", ProviderSessionID: "provider-session-1",
	}}
	runtime := liveResumeRuntime{session: ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex",
		ProviderSessionID: "provider-session-1", Resumable: true,
	}}
	host := New(Config{CanonicalStore: store, Runtime: runtime})

	session, err := host.EnsureRuntimeSession(t.Context(), SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatalf("EnsureRuntimeSession() error = %v", err)
	}
	if !session.Resumable {
		t.Fatal("EnsureRuntimeSession() discarded live resumable observation")
	}
}

func TestEnsureRuntimeSessionCleansPreparedResourcesAndPreservesRecoverableStateWhenResumeFails(t *testing.T) {
	resumeErr := errors.New("resume failed")
	store := liveResumeCanonicalStore{
		session: storesqlite.Session{
			ID: "session-1", WorkspaceID: "workspace-1", Kind: storesqlite.SessionKindRoot,
			Provider: "codex", ProviderSessionID: "provider-session-1",
		},
		evidence: storesqlite.ProviderSessionResumeEvidence{Established: true},
	}
	runtime := &failingResumeRuntime{err: resumeErr}
	preparation := &trackingResumePreparation{}
	host := New(Config{CanonicalStore: store, Runtime: runtime, RuntimePreparation: preparation})

	_, err := host.EnsureRuntimeSession(t.Context(), SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
	})
	if !errors.Is(err, resumeErr) {
		t.Fatalf("EnsureRuntimeSession() error = %v, want %v", err, resumeErr)
	}
	if runtime.resumeCalls != 1 || runtime.closeCalls != 1 {
		t.Fatalf("runtime calls resume=%d close=%d, want 1/1", runtime.resumeCalls, runtime.closeCalls)
	}
	if preparation.cleanupCalls != 1 {
		t.Fatalf("preparation cleanup calls = %d, want 1", preparation.cleanupCalls)
	}
	if preparation.cleanupInput.WorkspaceID != "workspace-1" ||
		preparation.cleanupInput.AgentSessionID != "session-1" ||
		preparation.cleanupInput.Provider != "codex" ||
		!preparation.cleanupInput.PreserveRecoverableState {
		t.Fatalf("cleanup input = %#v", preparation.cleanupInput)
	}
}

func TestEnsureRuntimeSessionWaitsForWorkspaceRuntimeDisconnectAdmission(t *testing.T) {
	t.Parallel()
	store := liveResumeCanonicalStore{
		session: storesqlite.Session{
			ID: "session-1", WorkspaceID: "workspace-1", Kind: storesqlite.SessionKindRoot,
			Provider: "codex", ProviderSessionID: "provider-session-1",
		},
		evidence: storesqlite.ProviderSessionResumeEvidence{Established: true},
	}
	runtimeBackend := &disconnectedReprepareRuntime{}
	host := New(Config{CanonicalStore: store, Runtime: runtimeBackend})
	_, releaseDisconnect, err := host.BeginWorkspaceRuntimeDisconnect(context.Background(), "workspace-1")
	if err != nil {
		t.Fatalf("BeginWorkspaceRuntimeDisconnect: %v", err)
	}

	ensureStarted := make(chan struct{})
	ensureDone := make(chan error, 1)
	go func() {
		close(ensureStarted)
		_, ensureErr := host.EnsureRuntimeSession(context.Background(), SessionRef{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		})
		ensureDone <- ensureErr
	}()
	<-ensureStarted
	for {
		host.workspaceRuntimeAdmission.mu.Lock()
		state := host.workspaceRuntimeAdmission.states["workspace-1"]
		waiting := state != nil && state.refs >= 2
		host.workspaceRuntimeAdmission.mu.Unlock()
		if waiting {
			break
		}
		select {
		case ensureErr := <-ensureDone:
			releaseDisconnect()
			t.Fatalf("EnsureRuntimeSession bypassed disconnect admission: %v", ensureErr)
		default:
		}
		runtime.Gosched()
	}
	if runtimeBackend.resumeCalls != 0 {
		t.Fatalf("Resume calls while disconnect admission held = %d, want 0", runtimeBackend.resumeCalls)
	}
	select {
	case ensureErr := <-ensureDone:
		t.Fatalf("EnsureRuntimeSession returned while disconnect admission held: %v", ensureErr)
	default:
	}

	releaseDisconnect()
	if ensureErr := <-ensureDone; ensureErr != nil {
		t.Fatalf("EnsureRuntimeSession after admission release: %v", ensureErr)
	}
	if runtimeBackend.resumeCalls != 1 {
		t.Fatalf("Resume calls after admission release = %d, want 1", runtimeBackend.resumeCalls)
	}
}

func TestReprepareRuntimeSessionUsesRequestScopedPreparationContextAndPreservesIdentity(t *testing.T) {
	store := liveResumeCanonicalStore{
		session: storesqlite.Session{
			ID: "session-1", WorkspaceID: "workspace-1", Kind: storesqlite.SessionKindRoot,
			Provider: "codex", ProviderSessionID: "provider-session-1", Cwd: "/workspace",
			RailSectionKind: storesqlite.RailSectionKindProject,
			RailProjectPath: "/workspace", RailSectionKey: storesqlite.RailSectionKeyForProject("/workspace"),
			InternalRuntimeContext: map[string]any{"canonical": true, "authority": "owner", "sharedAgent": map[string]any{
				"bindingId": "binding-1", "taskKind": "chat", "executionRoute": "caller_peer_command_v1", "invocationId": "old",
			}},
		},
		evidence: storesqlite.ProviderSessionResumeEvidence{Established: true},
	}
	runtime := &reprepareRuntime{session: ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex",
		ProviderSessionID: "provider-session-1", Cwd: "/workspace",
	}}
	preparation := &trackingResumePreparation{prepared: PreparedRuntime{
		Cwd:        "/workspace",
		MCPServers: []MCPServerBinding{{Name: "connectors", Type: "http", URL: "http://127.0.0.1/new"}},
	}}
	host := New(Config{CanonicalStore: store, Runtime: runtime, RuntimePreparation: preparation})

	result, err := host.ReprepareRuntimeSession(t.Context(), ReprepareRuntimeSessionInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		RuntimeContextOverlay: map[string]any{"invocationId": "invocation-1", "authority": "caller", "sharedAgent": map[string]any{"invocationId": "invocation-1"}},
	})
	if err != nil {
		t.Fatalf("ReprepareRuntimeSession() error = %v", err)
	}
	if preparation.prepareInput.RuntimeContext["canonical"] != true ||
		preparation.prepareInput.RuntimeContext["invocationId"] != "invocation-1" ||
		preparation.prepareInput.RuntimeContext["authority"] != "caller" {
		t.Fatalf("preparation runtime context = %#v", preparation.prepareInput.RuntimeContext)
	}
	if runtime.reprepareCalls != 1 || runtime.reprepareInput.ProviderSessionID != "provider-session-1" ||
		len(runtime.reprepareInput.MCPServers) != 1 || runtime.reprepareInput.MCPServers[0].URL != "http://127.0.0.1/new" {
		t.Fatalf("runtime reprepare input = %#v calls=%d", runtime.reprepareInput, runtime.reprepareCalls)
	}
	if runtime.reprepareInput.RuntimeContext["canonical"] != true || runtime.reprepareInput.RuntimeContext["invocationId"] != nil {
		t.Fatalf("request-scoped overlay leaked into provider runtime context: %#v", runtime.reprepareInput.RuntimeContext)
	}
	if runtime.reprepareInput.ProviderLaunchRuntimeContext["invocationId"] != "invocation-1" ||
		runtime.reprepareInput.ProviderLaunchRuntimeContext["authority"] != "caller" {
		t.Fatalf("provider launch runtime context = %#v", runtime.reprepareInput.ProviderLaunchRuntimeContext)
	}
	encodedPlacement, found := testEnvironmentValue(runtime.reprepareInput.Env, AgentRailPlacementEnvironmentVariable)
	if !found {
		t.Fatalf("reprepare env=%#v, want rail placement", runtime.reprepareInput.Env)
	}
	placement, parseErr := ParseAgentRailPlacementEnvironment(encodedPlacement)
	if parseErr != nil || placement.Kind != RailPlacementKindProject ||
		placement.ProjectPath != storesqlite.NormalizeProjectPath("/workspace") ||
		placement.SectionKey != storesqlite.RailSectionKeyForProject("/workspace") {
		t.Fatalf("reprepare rail placement=%#v error=%v", placement, parseErr)
	}
	shared, _ := runtime.reprepareInput.ProviderLaunchRuntimeContext["sharedAgent"].(map[string]any)
	if shared["bindingId"] != "binding-1" || shared["taskKind"] != "chat" || shared["executionRoute"] != "caller_peer_command_v1" || shared["invocationId"] != "invocation-1" {
		t.Fatalf("nested provider launch runtime context = %#v", shared)
	}
	if result.ID != "session-1" || result.ProviderSessionID != "provider-session-1" {
		t.Fatalf("reprepared identity = %#v", result)
	}
}

func TestReprepareRuntimeSessionCommitsReplacementContextBeforeReturning(t *testing.T) {
	expected := map[string]any{"sessionRuntimeSnapshot": map[string]any{"revision": float64(1)}}
	replacement := map[string]any{"sessionRuntimeSnapshot": map[string]any{"revision": float64(2)}}
	store := &runtimeContextCASStore{liveResumeCanonicalStore: liveResumeCanonicalStore{
		session: storesqlite.Session{
			ID: "session-1", WorkspaceID: "workspace-1", Kind: storesqlite.SessionKindRoot,
			Provider: "codex", ProviderSessionID: "provider-session-1", Cwd: "/workspace",
			InternalRuntimeContext: cloneMap(expected),
		},
		evidence: storesqlite.ProviderSessionResumeEvidence{Established: true},
	}}
	runtime := &reprepareRuntime{session: ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex",
		ProviderSessionID: "provider-session-1", Cwd: "/workspace",
	}}
	preparation := &trackingResumePreparation{prepared: PreparedRuntime{Cwd: "/workspace"}}
	host := New(Config{CanonicalStore: store, Runtime: runtime, RuntimePreparation: preparation})

	_, err := host.ReprepareRuntimeSession(t.Context(), ReprepareRuntimeSessionInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		ExpectedRuntimeContext: expected, ReplacementRuntimeContext: replacement,
	})
	if err != nil {
		t.Fatalf("ReprepareRuntimeSession() error = %v", err)
	}
	if store.casCalls != 1 || !reflect.DeepEqual(store.session.InternalRuntimeContext, replacement) {
		t.Fatalf("CAS calls=%d context=%#v", store.casCalls, store.session.InternalRuntimeContext)
	}
	if !reflect.DeepEqual(preparation.prepareInput.RuntimeContext, replacement) ||
		!reflect.DeepEqual(runtime.reprepareInput.RuntimeContext, replacement) {
		t.Fatalf("prepare=%#v runtime=%#v", preparation.prepareInput.RuntimeContext, runtime.reprepareInput.RuntimeContext)
	}
}

func TestReprepareRuntimeSessionRejectsCanonicalActiveTurnBeforePreparation(t *testing.T) {
	store := liveResumeCanonicalStore{
		session: storesqlite.Session{
			ID: "session-1", WorkspaceID: "workspace-1", Kind: storesqlite.SessionKindRoot,
			Provider: "codex", ProviderSessionID: "provider-session-1", ActiveTurnID: "turn-1",
		},
		evidence: storesqlite.ProviderSessionResumeEvidence{Established: true},
	}
	runtime := &reprepareRuntime{session: ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex", ProviderSessionID: "provider-session-1",
	}}
	preparation := &trackingResumePreparation{}
	host := New(Config{CanonicalStore: store, Runtime: runtime, RuntimePreparation: preparation})

	_, err := host.ReprepareRuntimeSession(t.Context(), ReprepareRuntimeSessionInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
	})
	if !errors.Is(err, ErrRuntimeSessionActive) {
		t.Fatalf("ReprepareRuntimeSession() error = %v, want ErrRuntimeSessionActive", err)
	}
	if preparation.prepareInput.WorkspaceID != "" || runtime.reprepareCalls != 0 {
		t.Fatalf("active reprepare reached preparation/runtime: prepare=%#v calls=%d", preparation.prepareInput, runtime.reprepareCalls)
	}
}

func TestReprepareRuntimeSessionResumesDisconnectedRuntimeWithInvocationBinding(t *testing.T) {
	store := liveResumeCanonicalStore{
		session: storesqlite.Session{ID: "session-1", WorkspaceID: "workspace-1", Kind: storesqlite.SessionKindRoot,
			Provider: "codex", ProviderSessionID: "provider-session-1", Cwd: "/workspace",
			InternalRuntimeContext: map[string]any{"canonical": true}},
		evidence: storesqlite.ProviderSessionResumeEvidence{Established: true},
	}
	runtime := &disconnectedReprepareRuntime{}
	preparation := &trackingResumePreparation{prepared: PreparedRuntime{Cwd: "/workspace", MCPServers: []MCPServerBinding{{Name: "connector", URL: "http://127.0.0.1/invocation"}}}}
	host := New(Config{CanonicalStore: store, Runtime: runtime, RuntimePreparation: preparation})

	result, err := host.ReprepareRuntimeSession(t.Context(), ReprepareRuntimeSessionInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		RuntimeContextOverlay: map[string]any{"invocationId": "invocation-2"},
	})
	if err != nil {
		t.Fatalf("ReprepareRuntimeSession() error = %v", err)
	}
	if runtime.resumeCalls != 1 || len(runtime.resumeInput.MCPServers) != 1 || runtime.resumeInput.MCPServers[0].URL != "http://127.0.0.1/invocation" {
		t.Fatalf("resume = calls %d input %#v", runtime.resumeCalls, runtime.resumeInput)
	}
	if preparation.prepareInput.RuntimeContext["invocationId"] != "invocation-2" || runtime.resumeInput.RuntimeContext["invocationId"] != nil ||
		runtime.resumeInput.ProviderLaunchRuntimeContext["invocationId"] != "invocation-2" {
		t.Fatalf("preparation=%#v runtime=%#v launch=%#v", preparation.prepareInput.RuntimeContext, runtime.resumeInput.RuntimeContext, runtime.resumeInput.ProviderLaunchRuntimeContext)
	}
	if result.ID != "session-1" || result.ProviderSessionID != "provider-session-1" {
		t.Fatalf("result = %#v", result)
	}
}

func TestReprepareRuntimeSessionCleansPreparedResourcesWhenRuntimeReplacementFails(t *testing.T) {
	reprepareErr := errors.New("reprepare failed")
	store := liveResumeCanonicalStore{
		session: storesqlite.Session{ID: "session-1", WorkspaceID: "workspace-1", Kind: storesqlite.SessionKindRoot,
			Provider: "codex", ProviderSessionID: "provider-session-1", Cwd: "/workspace"},
		evidence: storesqlite.ProviderSessionResumeEvidence{Established: true},
	}
	runtime := &reprepareRuntime{session: ProviderRuntimeSession{ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex", ProviderSessionID: "provider-session-1", Cwd: "/workspace"}, reprepareErr: reprepareErr}
	preparation := &trackingResumePreparation{prepared: PreparedRuntime{Cwd: "/workspace"}}
	host := New(Config{CanonicalStore: store, Runtime: runtime, RuntimePreparation: preparation})

	_, err := host.ReprepareRuntimeSession(t.Context(), ReprepareRuntimeSessionInput{WorkspaceID: "workspace-1", AgentSessionID: "session-1"})
	if !errors.Is(err, reprepareErr) {
		t.Fatalf("ReprepareRuntimeSession() error = %v, want %v", err, reprepareErr)
	}
	if preparation.cleanupCalls != 1 || !preparation.cleanupInput.PreserveRecoverableState ||
		preparation.cleanupInput.WorkspaceID != "workspace-1" || preparation.cleanupInput.AgentSessionID != "session-1" {
		t.Fatalf("cleanup = calls %d input %#v", preparation.cleanupCalls, preparation.cleanupInput)
	}
}

func TestReprepareRuntimeSessionRejectsRuntimeActiveTurnBeforePreparation(t *testing.T) {
	store := liveResumeCanonicalStore{
		session: storesqlite.Session{
			ID: "session-1", WorkspaceID: "workspace-1", Kind: storesqlite.SessionKindRoot,
			Provider: "codex", ProviderSessionID: "provider-session-1",
		},
		evidence: storesqlite.ProviderSessionResumeEvidence{Established: true},
	}
	activeTurnID := "turn-1"
	runtime := &reprepareRuntime{session: ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex", ProviderSessionID: "provider-session-1",
		TurnLifecycle: &TurnLifecycle{ActiveTurnID: &activeTurnID},
	}}
	preparation := &trackingResumePreparation{}
	host := New(Config{CanonicalStore: store, Runtime: runtime, RuntimePreparation: preparation})

	_, err := host.ReprepareRuntimeSession(t.Context(), ReprepareRuntimeSessionInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
	})
	if !errors.Is(err, ErrRuntimeSessionActive) {
		t.Fatalf("ReprepareRuntimeSession() error = %v, want ErrRuntimeSessionActive", err)
	}
	if preparation.prepareInput.WorkspaceID != "" || runtime.reprepareCalls != 0 {
		t.Fatalf("active reprepare reached preparation/runtime: prepare=%#v calls=%d", preparation.prepareInput, runtime.reprepareCalls)
	}
}

func TestReprepareRuntimeSessionAndSendInputClosesBindingBeforeReturningConfirmedFailure(t *testing.T) {
	store := liveResumeCanonicalStore{
		session: storesqlite.Session{
			ID: "session-1", WorkspaceID: "workspace-1", Kind: storesqlite.SessionKindRoot,
			Provider: "codex", ProviderSessionID: "provider-session-1", Cwd: "/workspace",
		},
		evidence: storesqlite.ProviderSessionResumeEvidence{Established: true},
	}
	runtime := &reprepareRuntime{session: ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex",
		ProviderSessionID: "provider-session-1",
	}, closeEntered: make(chan struct{}), releaseClose: make(chan struct{})}
	history := &mutableEffectiveHistory{history: storesqlite.SessionHistory{RecoveryState: storesqlite.SessionHistoryRecoveryRollbackPending}}
	host := New(Config{
		CanonicalStore: store, Runtime: runtime, RuntimePreparation: &trackingResumePreparation{}, EffectiveHistory: history,
	})
	atomicDone := make(chan error, 1)
	go func() {
		_, err := host.ReprepareRuntimeSessionAndSendInput(context.Background(), ReprepareRuntimeSessionAndSendInputInput{
			Reprepare: ReprepareRuntimeSessionInput{
				WorkspaceID: "workspace-1", AgentSessionID: "session-1",
				RuntimeContextOverlay: map[string]any{"invocationId": "invocation-1"},
			},
			Send: SendInput{Content: []PromptContentBlock{{Type: "text", Text: "hello"}}},
		})
		atomicDone <- err
	}()
	<-runtime.closeEntered
	queuedDone := make(chan error, 1)
	go func() {
		_, err := host.SendInput(context.Background(), SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}, SendInput{
			Content: []PromptContentBlock{{Type: "text", Text: "queued"}},
		})
		queuedDone <- err
	}()
	select {
	case err := <-queuedDone:
		t.Fatalf("queued SendInput bypassed cleanup actor: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(runtime.releaseClose)
	err := <-atomicDone
	if !errors.Is(err, ErrEditRetryInProgress) {
		t.Fatalf("ReprepareRuntimeSessionAndSendInput() error = %v, want ErrEditRetryInProgress", err)
	}
	if runtime.reprepareCalls != 1 || runtime.closeCalls != 1 {
		t.Fatalf("runtime reprepare=%d close=%d, want 1/1", runtime.reprepareCalls, runtime.closeCalls)
	}
	if err := <-queuedDone; !errors.Is(err, ErrEditRetryInProgress) {
		t.Fatalf("queued SendInput error = %v, want ErrEditRetryInProgress", err)
	}
}
