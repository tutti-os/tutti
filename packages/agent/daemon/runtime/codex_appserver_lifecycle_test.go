package agentruntime

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
)

// --- per-process app-server transport ---

// multiProcAppServerTransport spawns a fresh scripted connection per Start so
// tests can count how many app-server OS processes a session spawned and how
// many are still live. The shared-conn scriptedAppServerTransport cannot
// distinguish two processes because every Start reuses the same connection.
type multiProcAppServerTransport struct {
	mu        sync.Mutex
	conns     []*scriptedAppServerConnection
	startErr  error
	configure func(conn *scriptedAppServerConnection)
}

func (t *multiProcAppServerTransport) Start(_ context.Context, _ ProcessSpec) (ProcessConnection, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.startErr != nil {
		return nil, t.startErr
	}
	conn := newScriptedAppServerConnection()
	if t.configure != nil {
		t.configure(conn)
	}
	t.conns = append(t.conns, conn)
	return conn, nil
}

func (t *multiProcAppServerTransport) setStartErr(err error) {
	t.mu.Lock()
	t.startErr = err
	t.mu.Unlock()
}

func (t *multiProcAppServerTransport) setConfigure(configure func(conn *scriptedAppServerConnection)) {
	t.mu.Lock()
	t.configure = configure
	t.mu.Unlock()
}

// snapshot returns how many processes were spawned in total and which of them
// are still live (never closed).
func (t *multiProcAppServerTransport) snapshot() (spawned int, live []*scriptedAppServerConnection) {
	t.mu.Lock()
	conns := append([]*scriptedAppServerConnection(nil), t.conns...)
	t.mu.Unlock()
	for _, conn := range conns {
		conn.mu.Lock()
		closed := conn.closeCount > 0
		conn.mu.Unlock()
		if !closed {
			live = append(live, conn)
		}
	}
	return len(conns), live
}

func (t *multiProcAppServerTransport) conn(index int) *scriptedAppServerConnection {
	t.mu.Lock()
	defer t.mu.Unlock()
	if index < 0 || index >= len(t.conns) {
		return nil
	}
	return t.conns[index]
}

func connClosed(conn *scriptedAppServerConnection) bool {
	if conn == nil {
		return false
	}
	conn.mu.Lock()
	defer conn.mu.Unlock()
	return conn.closeCount > 0
}

func TestCodexAppServerAdapterProviderLaunchPrepareMutatesSpecAndCleansUpOnClose(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	cleanupCalls := 0
	adapter.SetProviderLaunchPreparer(func(_ context.Context, input ProviderLaunchPrepareInput) (ProviderLaunchPrepareResult, error) {
		if input.Provider != ProviderCodex {
			t.Fatalf("Provider = %q, want %q", input.Provider, ProviderCodex)
		}
		if input.DirectStart {
			t.Fatal("DirectStart = true, want false for codex app-server")
		}
		if input.Session.AgentSessionID != "agent-session-1" {
			t.Fatalf("Session.AgentSessionID = %q", input.Session.AgentSessionID)
		}
		return ProviderLaunchPrepareResult{
			Command: []string{"prepared-codex", "app-server"},
			Env:     append(append([]string(nil), input.Env...), "HOOK_ENV=1"),
			CWD:     "/prepared/workspace",
			Cleanup: func(context.Context) error {
				cleanupCalls++
				return nil
			},
		}, nil
	})

	session := testAppServerSession()
	session.Env = []string{"SESSION_ENV=1"}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if cleanupCalls != 0 {
		t.Fatalf("cleanup calls before close = %d, want 0", cleanupCalls)
	}
	transport.mu.Lock()
	specs := append([]ProcessSpec(nil), transport.specs...)
	transport.mu.Unlock()
	if len(specs) != 1 {
		t.Fatalf("transport starts = %d, want 1", len(specs))
	}
	spec := specs[0]
	if !reflect.DeepEqual(spec.Command, []string{"prepared-codex", "app-server"}) {
		t.Fatalf("Command = %#v", spec.Command)
	}
	if spec.CWD != "/prepared/workspace" {
		t.Fatalf("CWD = %q", spec.CWD)
	}
	if !reflect.DeepEqual(spec.Env[len(spec.Env)-2:], []string{"SESSION_ENV=1", "HOOK_ENV=1"}) {
		t.Fatalf("Env tail = %#v", spec.Env)
	}

	if err := adapter.Close(context.Background(), session); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if cleanupCalls != 1 {
		t.Fatalf("cleanup calls after close = %d, want 1", cleanupCalls)
	}
}

func TestCodexAppServerAdapterStartUsesInjectedProviderCommand(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapterWithHostMetadataAndCommandResolver(
		transport,
		LegacyHostMetadata(),
		func(_ context.Context, provider string) (ProviderCommand, error) {
			if provider != ProviderCodex {
				t.Fatalf("provider = %q, want %q", provider, ProviderCodex)
			}
			return ProviderCommand{
				Command: []string{"/user/bin/codex", "app-server"},
				Env:     []string{"PATH=/managed/node/bin:/user/bin", "TUTTI_APP_NODE=/managed/node/bin/node"},
			}, nil
		},
	)
	session := testAppServerSession()
	session.Env = []string{"SESSION_ENV=1"}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	spec := transport.specs[0]
	if !reflect.DeepEqual(spec.Command, []string{"/user/bin/codex", "app-server"}) {
		t.Fatalf("Command = %#v", spec.Command)
	}
	if !containsString(spec.Env, "SESSION_ENV=1") || !containsString(spec.Env, "TUTTI_APP_NODE=/managed/node/bin/node") {
		t.Fatalf("Env = %#v, want session and managed runtime env", spec.Env)
	}
}

func TestCodexAppServerAdapterProviderLaunchPrepareFailureDoesNotSpawn(t *testing.T) {
	t.Parallel()

	transport := &multiProcAppServerTransport{}
	adapter := NewCodexAppServerAdapter(transport)
	prepareErr := errors.New("prepare failed")
	adapter.SetProviderLaunchPreparer(func(context.Context, ProviderLaunchPrepareInput) (ProviderLaunchPrepareResult, error) {
		return ProviderLaunchPrepareResult{}, prepareErr
	})

	if _, err := adapter.Start(context.Background(), testAppServerSession()); !errors.Is(err, prepareErr) {
		t.Fatalf("Start error = %v, want %v", err, prepareErr)
	}
	spawned, _ := transport.snapshot()
	if spawned != 0 {
		t.Fatalf("spawned processes = %d, want 0", spawned)
	}
}

func TestCodexAppServerAdapterProviderLaunchCleanupRunsOnProcessStartFailure(t *testing.T) {
	t.Parallel()

	transport := &multiProcAppServerTransport{}
	startErr := errors.New("process start failed")
	transport.setStartErr(startErr)
	adapter := NewCodexAppServerAdapter(transport)
	cleanupCalls := 0
	cleanupSawCanceledContext := false
	adapter.SetProviderLaunchPreparer(func(_ context.Context, input ProviderLaunchPrepareInput) (ProviderLaunchPrepareResult, error) {
		return ProviderLaunchPrepareResult{
			Command: input.Command,
			Env:     input.Env,
			CWD:     input.CWD,
			Cleanup: func(ctx context.Context) error {
				if ctx.Err() != nil {
					cleanupSawCanceledContext = true
				}
				cleanupCalls++
				return nil
			},
		}, nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := adapter.Start(ctx, testAppServerSession()); !errors.Is(err, startErr) {
		t.Fatalf("Start error = %v, want %v", err, startErr)
	}
	if cleanupCalls != 1 {
		t.Fatalf("cleanup calls = %d, want 1", cleanupCalls)
	}
	if cleanupSawCanceledContext {
		t.Fatal("cleanup received canceled launch context")
	}
}

// --- single-live-process invariant tests ---

func TestCodexAppServerAdapterConcurrentStartsLeaveSingleLiveProcess(t *testing.T) {
	t.Parallel()

	transport := &multiProcAppServerTransport{}
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = adapter.Start(context.Background(), session)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("Start[%d]: %v", i, err)
		}
	}
	spawned, live := transport.snapshot()
	if len(live) != 1 {
		t.Fatalf("live app-server processes = %d (spawned %d), want exactly 1", len(live), spawned)
	}
	if !adapter.HasLiveSession(session) {
		t.Fatalf("HasLiveSession = false, want true after concurrent starts")
	}
}

func TestCodexAppServerAdapterStartOverLiveSessionStopsPreviousProcess(t *testing.T) {
	t.Parallel()

	transport := &multiProcAppServerTransport{}
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("second Start: %v", err)
	}
	spawned, live := transport.snapshot()
	if spawned != 2 {
		t.Fatalf("spawned processes = %d, want 2", spawned)
	}
	if len(live) != 1 || live[0] != transport.conn(1) {
		t.Fatalf("live processes = %d, want exactly the replacement process live", len(live))
	}
	if !connClosed(transport.conn(0)) {
		t.Fatalf("previous app-server process was orphaned instead of closed")
	}
}

func TestCodexAppServerAdapterResumeOverLiveSessionClosesPreviousProcess(t *testing.T) {
	t.Parallel()

	transport := &multiProcAppServerTransport{}
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-thread-1"
	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	spawned, live := transport.snapshot()
	if spawned != 2 {
		t.Fatalf("spawned processes = %d, want 2", spawned)
	}
	if len(live) != 1 || live[0] != transport.conn(1) {
		t.Fatalf("live processes = %d, want exactly the resumed process live", len(live))
	}
	if !connClosed(transport.conn(0)) {
		t.Fatalf("pre-resume app-server process was orphaned instead of closed")
	}
	if !adapter.HasLiveSession(session) {
		t.Fatalf("HasLiveSession = false, want true after resume")
	}
}

func TestCodexAppServerAdapterResumeSpawnFailureKeepsPreviousSessionLive(t *testing.T) {
	t.Parallel()

	transport := &multiProcAppServerTransport{}
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	transport.setStartErr(errors.New("spawn failed"))
	session.ProviderSessionID = "codex-thread-1"
	if err := adapter.Resume(context.Background(), session); err == nil {
		t.Fatalf("Resume with failing spawn should error")
	}
	spawned, live := transport.snapshot()
	if spawned != 1 || len(live) != 1 || live[0] != transport.conn(0) {
		t.Fatalf("spawned=%d live=%d, want the original process to stay live", spawned, len(live))
	}
	if !adapter.HasLiveSession(session) {
		t.Fatalf("HasLiveSession = false, want true: failed resume must keep the old session usable")
	}
}

func TestCodexAppServerAdapterResumeThreadFailureKeepsPreviousSessionLive(t *testing.T) {
	t.Parallel()

	transport := &multiProcAppServerTransport{}
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	transport.setConfigure(func(conn *scriptedAppServerConnection) {
		conn.threadResumeError = true
	})
	session.ProviderSessionID = "codex-thread-1"
	if err := adapter.Resume(context.Background(), session); err == nil {
		t.Fatalf("Resume with failing thread/resume should error")
	}
	spawned, live := transport.snapshot()
	if spawned != 2 {
		t.Fatalf("spawned processes = %d, want 2", spawned)
	}
	if len(live) != 1 || live[0] != transport.conn(0) {
		t.Fatalf("live processes = %d, want only the original process live (new one closed)", len(live))
	}
	if !adapter.HasLiveSession(session) {
		t.Fatalf("HasLiveSession = false, want true: failed resume must keep the old session usable")
	}
}

func TestCodexAppServerAdapterStartReleaseRaceLeavesNoOrphanProcess(t *testing.T) {
	t.Parallel()

	for iteration := 0; iteration < 25; iteration++ {
		transport := &multiProcAppServerTransport{}
		adapter := NewCodexAppServerAdapter(transport)
		session := testAppServerSession()
		if _, err := adapter.Start(context.Background(), session); err != nil {
			t.Fatalf("iteration %d Start: %v", iteration, err)
		}

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, _ = adapter.Start(context.Background(), session)
		}()
		go func() {
			defer wg.Done()
			_ = adapter.ReleaseLiveSession(context.Background(), session)
		}()
		wg.Wait()

		wantLive := 0
		if adapter.HasLiveSession(session) {
			wantLive = 1
		}
		spawned, live := transport.snapshot()
		if len(live) != wantLive {
			t.Fatalf("iteration %d: live processes = %d, want %d (spawned %d): process leaked or half-closed",
				iteration, len(live), wantLive, spawned)
		}
	}
}

func TestCodexAppServerClientCloseIsIdempotent(t *testing.T) {
	t.Parallel()

	conn := newScriptedAppServerConnection()
	client := newCodexAppServerClient(conn)
	if err := client.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	conn.mu.Lock()
	closeCount := conn.closeCount
	conn.mu.Unlock()
	if closeCount != 1 {
		t.Fatalf("underlying connection Close calls = %d, want 1 (client Close must be idempotent)", closeCount)
	}
}
