package agentdaemon

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
	agentruntime "github.com/tutti-os/tutti/packages/agentactivity/daemon/runtime"
)

func TestNewRuntimeCreatesDefaultController(t *testing.T) {
	t.Parallel()

	runtime, err := NewRuntime(Config{
		ProcessTransport: NewLocalProcessTransport(),
		HostMetadata:     testHostMetadata(),
	})
	if err != nil {
		t.Fatalf("NewRuntime() error = %v", err)
	}
	t.Cleanup(runtime.Close)
	if runtime.Controller() == nil {
		t.Fatal("Controller() = nil, want controller")
	}
	if runtime.done == nil {
		t.Fatal("default runtime did not start live session reaper")
	}
}

func TestNewRuntimeRequiresHostMetadataForDefaultAdapters(t *testing.T) {
	t.Parallel()

	_, err := NewRuntime(Config{})
	if !errors.Is(err, ErrHostMetadataRequired) {
		t.Fatalf("NewRuntime() error = %v, want ErrHostMetadataRequired", err)
	}
}

func TestNewRuntimeRequiresProcessTransportForDefaultAdapters(t *testing.T) {
	t.Parallel()

	_, err := NewRuntime(Config{HostMetadata: testHostMetadata()})
	if !errors.Is(err, ErrProcessTransportRequired) {
		t.Fatalf("NewRuntime() error = %v, want ErrProcessTransportRequired", err)
	}
}

func TestNewRuntimeUsesCustomAdapters(t *testing.T) {
	t.Parallel()

	runtime, err := NewRuntime(Config{
		Adapters: []agentruntime.Adapter{testAdapter{provider: "test-agent"}},
	})
	if err != nil {
		t.Fatalf("NewRuntime() error = %v", err)
	}
	t.Cleanup(runtime.Close)
	started, err := runtime.Controller().Start(context.Background(), agentruntime.StartInput{
		RoomID:         "workspace-1",
		AgentSessionID: "agent-session-1",
		Provider:       "test-agent",
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if started.Session.Provider != "test-agent" {
		t.Fatalf("provider = %q, want test-agent", started.Session.Provider)
	}
}

func TestNewRuntimeCanDisableLiveSessionReaper(t *testing.T) {
	t.Parallel()

	enabled := false
	runtime, err := NewRuntime(Config{
		Adapters: []agentruntime.Adapter{testAdapter{provider: "test-agent"}},
		LiveSessionReaper: LiveSessionReaperConfig{
			Enabled:       &enabled,
			IdleAfter:     time.Minute,
			SweepInterval: time.Minute,
		},
	})
	if err != nil {
		t.Fatalf("NewRuntime() error = %v", err)
	}
	t.Cleanup(runtime.Close)
	if runtime.done != nil {
		t.Fatal("disabled live session reaper started a background loop")
	}
}

// TestRuntimeCloseForceClosesLiveProviderSessions guards against orphaned
// provider subprocesses (e.g. a Codex app-server) surviving daemon
// shutdown. An OS process spawned by the daemon is not killed just because
// the daemon exits — it is reparented and keeps running — so Runtime.Close
// must proactively close every live session's provider process first.
func TestRuntimeCloseForceClosesLiveProviderSessions(t *testing.T) {
	t.Parallel()

	adapter := &liveSessionTestAdapter{provider: "test-agent", live: make(map[string]bool)}
	runtime, err := NewRuntime(Config{
		Adapters: []agentruntime.Adapter{adapter},
	})
	if err != nil {
		t.Fatalf("NewRuntime() error = %v", err)
	}
	started, err := runtime.Controller().Start(context.Background(), agentruntime.StartInput{
		RoomID:         "workspace-1",
		AgentSessionID: "agent-session-1",
		Provider:       "test-agent",
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	adapter.setLive(started.Session.AgentSessionID, true)

	runtime.Close()

	if adapter.closeCallCount(started.Session.AgentSessionID) != 1 {
		t.Fatalf("adapter Close called %d times for live session, want exactly once", adapter.closeCallCount(started.Session.AgentSessionID))
	}
	if adapter.isLive(started.Session.AgentSessionID) {
		t.Fatal("adapter still reports live session after Runtime.Close")
	}
}

func testHostMetadata() HostMetadata {
	return HostMetadata{
		ClientInfo: ClientInfo{
			Name:    "test-desktop",
			Title:   "Test Desktop",
			Version: "1.0.0",
		},
		WorkspaceEnvName:         "TEST_WORKSPACE_ID",
		OpenClawSessionKeyPrefix: "agent:main:test-",
	}
}

type testAdapter struct {
	provider string
}

func (a testAdapter) Provider() string {
	return a.provider
}

func (testAdapter) Start(context.Context, agentruntime.Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (testAdapter) Resume(context.Context, agentruntime.Session) error {
	return nil
}

func (testAdapter) Close(context.Context, agentruntime.Session) error {
	return nil
}

func (testAdapter) Exec(
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

func (testAdapter) Cancel(
	context.Context,
	agentruntime.Session,
	string,
) ([]activityshared.Event, error) {
	return nil, nil
}

// liveSessionTestAdapter is a testAdapter variant that also implements
// agentruntime.LiveSessionProbeAdapter, so it can stand in for a provider
// (Codex app-server, Claude Code SDK) that holds a live, long-running
// subprocess per session.
type liveSessionTestAdapter struct {
	provider string

	mu         sync.Mutex
	live       map[string]bool
	closeCalls map[string]int
}

func (a *liveSessionTestAdapter) Provider() string { return a.provider }

func (*liveSessionTestAdapter) Start(context.Context, agentruntime.Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (*liveSessionTestAdapter) Resume(context.Context, agentruntime.Session) error { return nil }

func (a *liveSessionTestAdapter) Close(_ context.Context, session agentruntime.Session) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closeCalls == nil {
		a.closeCalls = make(map[string]int)
	}
	a.closeCalls[session.AgentSessionID]++
	a.live[session.AgentSessionID] = false
	return nil
}

func (*liveSessionTestAdapter) Exec(
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

func (*liveSessionTestAdapter) Cancel(
	context.Context,
	agentruntime.Session,
	string,
) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *liveSessionTestAdapter) HasLiveSession(session agentruntime.Session) bool {
	return a.isLive(session.AgentSessionID)
}

func (a *liveSessionTestAdapter) setLive(agentSessionID string, live bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.live[agentSessionID] = live
}

func (a *liveSessionTestAdapter) isLive(agentSessionID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.live[agentSessionID]
}

func (a *liveSessionTestAdapter) closeCallCount(agentSessionID string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.closeCalls[agentSessionID]
}
