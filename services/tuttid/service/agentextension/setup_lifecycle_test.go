package agentextension

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	agentextensionbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentextension"
)

func TestSetupServiceCloseCancelsWorkerWaitsAndPersistsInterrupted(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	runner := &cancelBlockingInstallRunner{
		started:       make(chan struct{}),
		canceled:      make(chan struct{}),
		allowReturn:   make(chan struct{}),
		stagingRootCh: make(chan string, 1),
	}
	service, targetID := setupFixture(
		t, "generic", "Generic Agent", "@example/generic-agent", "1.2.3", "generic-agent", ">=1.2.3 <2.0.0",
		runner, &probeTransport{},
	)
	initial, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	requestCtx, cancelRequest := context.WithCancel(context.Background())
	if _, err := service.Install(requestCtx, InstallInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		PlanDigest: initial.Plan.PlanDigest, ClientActionID: "shutdown-action",
	}); err != nil {
		t.Fatal(err)
	}
	<-runner.started
	cancelRequest()
	select {
	case <-runner.canceled:
		t.Fatal("accepted setup action inherited request cancellation")
	case <-time.After(50 * time.Millisecond):
	}

	closeResult := make(chan error, 1)
	go func() { closeResult <- service.Close() }()
	<-runner.canceled
	select {
	case err := <-closeResult:
		t.Fatalf("Close returned before worker cleanup: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(runner.allowReturn)
	if err := <-closeResult; err != nil {
		t.Fatal(err)
	}

	plan, err := service.Plans.GetInstallPlan(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	action, err := service.readAction(context.Background(), plan)
	if err != nil {
		t.Fatal(err)
	}
	if action == nil || action.Status != SetupActionInterrupted || action.ErrorCode != "daemon_shutdown" {
		t.Fatalf("shutdown action = %#v", action)
	}
	stagingRoot := <-runner.stagingRootCh
	if _, err := os.Stat(stagingRoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging cleanup error = %v", err)
	}
	if _, err := service.Install(context.Background(), InstallInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		PlanDigest: plan.PlanDigest, ClientActionID: "after-close",
	}); !errors.Is(err, ErrSetupServiceClosed) {
		t.Fatalf("install after Close error = %v", err)
	}
}

func TestSetupServiceCloseSurfacesWorkerActionWriteFailure(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	service, targetID := setupFixture(
		t, "generic", "Generic Agent", "@example/generic-agent", "1.2.3", "generic-agent", ">=1.2.3 <2.0.0",
		&fixtureInstallRunner{binary: "generic-agent", packageName: "@example/generic-agent", version: "1.2.3"},
		&probeTransport{},
	)
	writeErr := errors.New("fixture setup action write failed")
	failingStore := &failNthPutSetupActionStore{
		inner: service.Actions, failAt: 2, err: writeErr, failed: make(chan struct{}),
	}
	service.Actions = failingStore
	initial, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Install(context.Background(), InstallInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		PlanDigest: initial.Plan.PlanDigest, ClientActionID: "write-failure-action",
	}); err != nil {
		t.Fatal(err)
	}
	<-failingStore.failed
	if err := service.Close(); !errors.Is(err, writeErr) {
		t.Fatalf("Close error = %v, want write failure", err)
	}

	plan, err := service.Plans.GetInstallPlan(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	action, err := service.readAction(context.Background(), plan)
	if err != nil {
		t.Fatal(err)
	}
	if action == nil || action.Status != SetupActionFailed || !errors.Is(service.Close(), writeErr) {
		t.Fatalf("write-failure action = %#v", action)
	}
}

func TestSetupServiceCloseSurfacesTerminalActionWriteFailure(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	service, targetID := setupFixture(
		t, "generic", "Generic Agent", "@example/generic-agent", "1.2.3", "generic-agent", ">=1.2.3 <2.0.0",
		&fixtureInstallRunner{binary: "generic-agent", packageName: "@example/generic-agent", version: "1.2.3"},
		&probeTransport{},
	)
	writeErr := errors.New("fixture terminal setup action write failed")
	failingStore := &failTerminalPutSetupActionStore{
		inner: service.Actions, err: writeErr, failed: make(chan struct{}),
	}
	service.Actions = failingStore
	initial, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Install(context.Background(), InstallInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		PlanDigest: initial.Plan.PlanDigest, ClientActionID: "terminal-write-failure",
	}); err != nil {
		t.Fatal(err)
	}
	<-failingStore.failed
	if err := service.Close(); !errors.Is(err, writeErr) {
		t.Fatalf("Close error = %v, want terminal write failure", err)
	}
}

type cancelBlockingInstallRunner struct {
	started       chan struct{}
	canceled      chan struct{}
	allowReturn   chan struct{}
	stagingRootCh chan string
	startOnce     sync.Once
	cancelOnce    sync.Once
}

func (r *cancelBlockingInstallRunner) Run(ctx context.Context, command []string, _ string, _ []string) error {
	for index, value := range command {
		if value == "--prefix" && index+1 < len(command) {
			r.stagingRootCh <- command[index+1]
			break
		}
	}
	r.startOnce.Do(func() { close(r.started) })
	<-ctx.Done()
	r.cancelOnce.Do(func() { close(r.canceled) })
	<-r.allowReturn
	return ctx.Err()
}

type failNthPutSetupActionStore struct {
	inner  SetupActionStore
	mu     sync.Mutex
	puts   int
	failAt int
	err    error
	failed chan struct{}
	once   sync.Once
}

func (s *failNthPutSetupActionStore) Read(ctx context.Context, scope agentextensionbiz.SetupActionScope) (*SetupAction, error) {
	return s.inner.Read(ctx, scope)
}

func (s *failNthPutSetupActionStore) Put(ctx context.Context, scope agentextensionbiz.SetupActionScope, action SetupAction) error {
	s.mu.Lock()
	s.puts++
	shouldFail := s.puts == s.failAt
	s.mu.Unlock()
	if shouldFail {
		s.once.Do(func() { close(s.failed) })
		return s.err
	}
	return s.inner.Put(ctx, scope, action)
}

type failTerminalPutSetupActionStore struct {
	inner  SetupActionStore
	err    error
	failed chan struct{}
	once   sync.Once
}

func (s *failTerminalPutSetupActionStore) Read(ctx context.Context, scope agentextensionbiz.SetupActionScope) (*SetupAction, error) {
	return s.inner.Read(ctx, scope)
}

func (s *failTerminalPutSetupActionStore) Put(ctx context.Context, scope agentextensionbiz.SetupActionScope, action SetupAction) error {
	if action.Phase == SetupPhaseComplete {
		s.once.Do(func() { close(s.failed) })
		return s.err
	}
	return s.inner.Put(ctx, scope, action)
}
