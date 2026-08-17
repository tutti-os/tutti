package agenthost

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type workspaceDisconnectRuntime struct {
	RuntimeController
	sessions              []ProviderRuntimeSession
	disconnected          map[string]bool
	failures              map[string]error
	calls                 []string
	connectionGenerations map[string]uint64
	targetCalls           []RuntimeDisconnectTarget
}

func (r *workspaceDisconnectRuntime) SnapshotWorkspaceRuntimeDisconnectTargets(workspaceID string) []RuntimeDisconnectTarget {
	result := make([]RuntimeDisconnectTarget, 0)
	for _, session := range r.sessions {
		if session.WorkspaceID != workspaceID {
			continue
		}
		generation := r.connectionGenerations[session.ID]
		if generation == 0 {
			generation = 1
			if r.connectionGenerations == nil {
				r.connectionGenerations = make(map[string]uint64)
			}
			r.connectionGenerations[session.ID] = generation
		}
		result = append(result, RuntimeDisconnectTarget{
			WorkspaceID: workspaceID, AgentSessionID: session.ID, ConnectionGeneration: generation,
		})
	}
	return result
}

func (r *workspaceDisconnectRuntime) DisconnectRuntimeSessionTarget(_ context.Context, target RuntimeDisconnectTarget) (bool, error) {
	r.targetCalls = append(r.targetCalls, target)
	if r.connectionGenerations[target.AgentSessionID] != target.ConnectionGeneration {
		return false, nil
	}
	return r.DisconnectRuntimeSession(context.Background(), SessionRef{
		WorkspaceID: target.WorkspaceID, AgentSessionID: target.AgentSessionID,
	})
}

func TestWorkspaceRuntimeDisconnectWaitsForAdmittedStart(t *testing.T) {
	t.Parallel()
	host := New(Config{Runtime: &workspaceDisconnectRuntime{disconnected: make(map[string]bool)}})
	operationEntered := make(chan struct{})
	releaseOperation := make(chan struct{})
	operationDone := make(chan error, 1)
	go func() {
		operationDone <- host.withWorkspaceRuntimeOperation(context.Background(), "workspace-1", func(context.Context) error {
			close(operationEntered)
			<-releaseOperation
			return nil
		})
	}()
	<-operationEntered

	disconnectEntered := make(chan struct{})
	disconnectDone := make(chan error, 1)
	go func() {
		disconnectCtx, release, err := host.BeginWorkspaceRuntimeDisconnect(context.Background(), "workspace-1")
		if err == nil {
			close(disconnectEntered)
			release()
			_ = disconnectCtx
		}
		disconnectDone <- err
	}()

	select {
	case <-disconnectEntered:
		t.Fatal("disconnect entered while Start was still admitted")
	default:
	}
	close(releaseOperation)
	if err := <-operationDone; err != nil {
		t.Fatalf("Start operation: %v", err)
	}
	if err := <-disconnectDone; err != nil {
		t.Fatalf("BeginWorkspaceRuntimeDisconnect: %v", err)
	}
}

func TestWorkspaceRuntimeDisconnectFencesResumeBeforeSessionActor(t *testing.T) {
	t.Parallel()
	host := New(Config{Runtime: &workspaceDisconnectRuntime{disconnected: make(map[string]bool)}})
	disconnectCtx, releaseDisconnect, err := host.BeginWorkspaceRuntimeDisconnect(context.Background(), "workspace-1")
	if err != nil {
		t.Fatalf("BeginWorkspaceRuntimeDisconnect: %v", err)
	}
	defer releaseDisconnect()

	actorEntered := make(chan struct{})
	operationDone := make(chan error, 1)
	go func() {
		operationDone <- host.withSessionMutationActor(context.Background(), "workspace-1", "session-1", func(context.Context) error {
			close(actorEntered)
			return nil
		})
	}()
	select {
	case <-actorEntered:
		t.Fatal("Send/Resume actor entered while Workspace disconnect admission was held")
	default:
	}

	var sweepRan bool
	err = host.sessionMutationActor.Do(disconnectCtx, SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}, func(context.Context) error {
		sweepRan = true
		return nil
	})
	if err != nil || !sweepRan {
		t.Fatalf("disconnect session sweep err/ran = %v/%v", err, sweepRan)
	}
	releaseDisconnect()
	if err := <-operationDone; err != nil {
		t.Fatalf("Send/Resume operation: %v", err)
	}
}

func TestDurableWorkspaceRuntimeDisconnectFenceRunsSweepWithExclusiveContext(t *testing.T) {
	t.Parallel()
	runtime := &workspaceDisconnectRuntime{
		sessions:     []ProviderRuntimeSession{{ID: "session-1", WorkspaceID: "workspace-1"}},
		disconnected: make(map[string]bool),
	}
	host := New(Config{Runtime: runtime})
	fence, err := host.AcquireWorkspaceRuntimeDisconnectFence(t.Context(), "workspace-1")
	if err != nil {
		t.Fatalf("AcquireWorkspaceRuntimeDisconnectFence: %v", err)
	}
	defer fence.Release()
	disconnectCtx, err := fence.Wait(t.Context())
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	result, err := host.DisconnectWorkspaceRuntime(disconnectCtx, "workspace-1")
	if err != nil {
		t.Fatalf("DisconnectWorkspaceRuntime: %v", err)
	}
	if result.Scanned != 1 || result.Disconnected != 1 || !runtime.disconnected["session-1"] {
		t.Fatalf("disconnect result/state = %#v/%v", result, runtime.disconnected)
	}
}

func TestReentrantAttachmentCleanupDoesNotDisconnectNewConnectionAfterOperationLeaves(t *testing.T) {
	t.Parallel()
	runtime := &workspaceDisconnectRuntime{
		sessions:              []ProviderRuntimeSession{{ID: "session-1", WorkspaceID: "workspace-1"}},
		disconnected:          make(map[string]bool),
		connectionGenerations: map[string]uint64{"session-1": 1},
	}
	host := New(Config{Runtime: runtime})
	err := host.withWorkspaceRuntimeOperation(context.Background(), "workspace-1", func(operationCtx context.Context) error {
		detachCtx, release, beginErr := host.BeginWorkspaceRuntimeDisconnect(operationCtx, "workspace-1")
		if beginErr != nil {
			return beginErr
		}
		defer release()
		result, disconnectErr := host.DisconnectWorkspaceRuntime(detachCtx, "workspace-1")
		if disconnectErr != nil {
			return disconnectErr
		}
		if result.Scanned != 0 || len(runtime.calls) != 0 {
			t.Fatalf("reentrant semantic disconnect ran before operation release: result=%#v calls=%v", result, runtime.calls)
		}
		runtime.connectionGenerations["session-1"] = 2
		return nil
	})
	if err != nil {
		t.Fatalf("reentrant cleanup: %v", err)
	}
	if len(runtime.targetCalls) != 1 || len(runtime.calls) != 0 || runtime.disconnected["session-1"] {
		t.Fatalf("deferred target/broad calls/state = %v/%v/%v", runtime.targetCalls, runtime.calls, runtime.disconnected)
	}
}

func TestReentrantDeferredDisconnectPanicDoesNotStrandWorkspaceAdmission(t *testing.T) {
	t.Parallel()
	host := New(Config{Runtime: &workspaceDisconnectRuntime{
		sessions:     []ProviderRuntimeSession{{ID: "session-1", WorkspaceID: "workspace-1"}},
		disconnected: make(map[string]bool),
	}})
	secondRan := false
	func() {
		defer func() {
			if recovered := recover(); recovered == nil {
				t.Fatal("deferred disconnect panic was swallowed")
			}
		}()
		_ = host.withWorkspaceRuntimeOperation(t.Context(), "workspace-1", func(_ context.Context) error {
			host.workspaceRuntimeAdmission.deferDisconnect("workspace-1", func(context.Context) {
				panic("injected deferred disconnect panic")
			})
			host.workspaceRuntimeAdmission.deferDisconnect("workspace-1", func(context.Context) {
				secondRan = true
			})
			return nil
		})
	}()
	if secondRan {
		t.Fatal("deferred callback after panic ran without its predecessor completing")
	}
	entered := false
	if err := host.withWorkspaceRuntimeOperation(t.Context(), "workspace-1", func(context.Context) error {
		entered = true
		return nil
	}); err != nil {
		t.Fatalf("runtime operation after recovered panic: %v", err)
	}
	if !entered {
		t.Fatal("runtime operation did not enter after recovered panic")
	}
}

func TestWorkspaceRuntimeAdmissionSerializesConcurrentDisconnects(t *testing.T) {
	t.Parallel()
	host := New(Config{Runtime: &workspaceDisconnectRuntime{disconnected: make(map[string]bool)}})
	ctx, release, err := host.BeginWorkspaceRuntimeDisconnect(context.Background(), "workspace-1")
	if err != nil {
		t.Fatal(err)
	}
	_ = ctx
	var once sync.Once
	done := make(chan error, 1)
	go func() {
		_, secondRelease, beginErr := host.BeginWorkspaceRuntimeDisconnect(context.Background(), "workspace-1")
		if beginErr == nil {
			once.Do(secondRelease)
		}
		done <- beginErr
	}()
	select {
	case err := <-done:
		t.Fatalf("second disconnect was not serialized: %v", err)
	default:
	}
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func (r *workspaceDisconnectRuntime) Session(workspaceID, agentSessionID string) (ProviderRuntimeSession, bool) {
	for _, session := range r.sessions {
		if session.WorkspaceID == workspaceID && session.ID == agentSessionID {
			return session, true
		}
	}
	return ProviderRuntimeSession{}, false
}

func (r *workspaceDisconnectRuntime) RuntimeSessionLive(_, agentSessionID string) bool {
	return !r.disconnected[agentSessionID]
}

type workspaceDisconnectStore struct {
	CanonicalStore
	session storesqlite.Session
}

func (workspaceDisconnectStore) SessionDeleted(context.Context, string, string) (bool, error) {
	return false, nil
}

func (s workspaceDisconnectStore) GetSession(_ context.Context, workspaceID, agentSessionID string) (storesqlite.Session, bool, error) {
	return s.session, s.session.WorkspaceID == workspaceID && s.session.ID == agentSessionID, nil
}

func (r *workspaceDisconnectRuntime) WorkspaceRuntimeSessions(context.Context, string) ([]ProviderRuntimeSession, error) {
	return append([]ProviderRuntimeSession(nil), r.sessions...), nil
}

func (r *workspaceDisconnectRuntime) DisconnectRuntimeSession(
	_ context.Context,
	ref SessionRef,
) (bool, error) {
	r.calls = append(r.calls, ref.AgentSessionID)
	if err := r.failures[ref.AgentSessionID]; err != nil {
		return false, err
	}
	if r.disconnected[ref.AgentSessionID] {
		return false, nil
	}
	r.disconnected[ref.AgentSessionID] = true
	return true, nil
}

func TestDisconnectWorkspaceRuntimeContinuesAfterSessionFailure(t *testing.T) {
	t.Parallel()
	failure := errors.New("transport close failed")
	runtime := &workspaceDisconnectRuntime{
		sessions: []ProviderRuntimeSession{
			{ID: "session-b", WorkspaceID: "workspace-1"},
			{ID: "session-a", WorkspaceID: "workspace-1"},
			{ID: "session-other", WorkspaceID: "workspace-2"},
		},
		disconnected: make(map[string]bool),
		failures:     map[string]error{"session-a": failure},
	}
	host := New(Config{Runtime: runtime})

	result, err := host.DisconnectWorkspaceRuntime(t.Context(), " workspace-1 ")
	if result.Scanned != 2 || result.Disconnected != 1 || result.Failed != 1 {
		t.Fatalf("result=%#v", result)
	}
	if !errors.Is(err, failure) {
		t.Fatalf("error=%v, want failure in aggregate", err)
	}
	if !slices.Equal(runtime.calls, []string{"session-a", "session-b"}) {
		t.Fatalf("calls=%#v, want stable order and continued processing", runtime.calls)
	}
}

func TestDisconnectWorkspaceRuntimeRequiresCapability(t *testing.T) {
	t.Parallel()
	host := New(Config{Runtime: struct{ RuntimeController }{}})
	_, err := host.DisconnectWorkspaceRuntime(t.Context(), "workspace-1")
	if !errors.Is(err, ErrWorkspaceDisconnectUnavailable) {
		t.Fatalf("error=%v, want %v", err, ErrWorkspaceDisconnectUnavailable)
	}
}

func TestGetSessionReportsDisconnectedRegisteredRuntimeAsNotLive(t *testing.T) {
	t.Parallel()
	runtime := &workspaceDisconnectRuntime{
		sessions: []ProviderRuntimeSession{{
			ID: "session-1", WorkspaceID: "workspace-1", ProviderSessionID: "provider-1",
		}},
		disconnected: map[string]bool{"session-1": true},
	}
	host := New(Config{
		Runtime: runtime,
		CanonicalStore: workspaceDisconnectStore{session: storesqlite.Session{
			ID: "session-1", WorkspaceID: "workspace-1", ProviderSessionID: "provider-1",
		}},
	})

	result, err := host.GetSession(t.Context(), SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if result.Live {
		t.Fatalf("GetSession Live=true for disconnected Controller record: %#v", result)
	}
	if result.Session.ID != "session-1" || result.Session.ProviderSessionID != "provider-1" {
		t.Fatalf("registered runtime observation was lost: %#v", result.Session)
	}
}
