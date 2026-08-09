package agentruntime

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestControllerReleaseIdleLiveSessionsReleasesStaleLiveSession(t *testing.T) {
	t.Parallel()

	adapter := newReleasableAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started := startReleasableSession(t, controller, "agent-session-1")
	setSessionUpdatedAt(t, controller, started.Session, time.Now().Add(-time.Hour))

	result := controller.ReleaseIdleLiveSessions(context.Background(), ReleaseIdleLiveSessionsInput{
		IdleAfter: 30 * time.Minute,
		Now:       time.Now(),
	})
	if result.Released != 1 || result.Scanned != 1 {
		t.Fatalf("release result = %#v, want one released session", result)
	}
	if adapter.hasLiveSession(started.Session.AgentSessionID) {
		t.Fatalf("adapter still has live session after release")
	}
	stored, ok := controller.Session(started.Session.RoomID, started.Session.AgentSessionID)
	if !ok {
		t.Fatalf("controller session was deleted by live release")
	}
	if stored.ProviderSessionID != "provider-session-agent-session-1" {
		t.Fatalf("provider session id = %q, want preserved", stored.ProviderSessionID)
	}
	if stored.Status == SessionStatusCompleted {
		t.Fatalf("session status = completed, want release to be non-destructive")
	}
}

func TestControllerReleaseIdleLiveSessionsSkipsFreshActiveUnsupportedAndNotLive(t *testing.T) {
	t.Parallel()

	adapter := newReleasableAdapter()
	unsupported := &recordingStartAdapter{provider: hermesExtensionTestProvider}
	controller := NewController([]Adapter{adapter, unsupported}, nil)
	fresh := startReleasableSession(t, controller, "fresh-session")
	active := startReleasableSession(t, controller, "active-session")
	notLive := startReleasableSession(t, controller, "not-live-session")
	unsupportedStarted, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "unsupported-session",
		Provider:       hermesExtensionTestProvider,
	})
	if err != nil {
		t.Fatalf("Start unsupported: %v", err)
	}
	stale := time.Now().Add(-time.Hour)
	setSessionUpdatedAt(t, controller, fresh.Session, time.Now())
	setSessionUpdatedAt(t, controller, active.Session, stale)
	setSessionUpdatedAt(t, controller, notLive.Session, stale)
	setSessionUpdatedAt(t, controller, unsupportedStarted.Session, stale)
	adapter.dropLiveSession(notLive.Session.AgentSessionID)

	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         active.Session.RoomID,
		AgentSessionID: active.Session.AgentSessionID,
		Content:        textPrompt("hold"),
	}); err != nil {
		t.Fatalf("Exec active: %v", err)
	}
	adapter.waitForExec(t, "hold")

	result := controller.ReleaseIdleLiveSessions(context.Background(), ReleaseIdleLiveSessionsInput{
		IdleAfter: 30 * time.Minute,
		Now:       time.Now(),
	})
	if result.SkippedFresh != 1 ||
		result.SkippedActiveTurn != 1 ||
		result.SkippedUnsupported != 1 ||
		result.SkippedNotLive != 1 ||
		result.Released != 0 {
		t.Fatalf("release result = %#v, want fresh/active/unsupported/not-live skips", result)
	}
	adapter.releaseNext()
	waitForSessionStatus(t, controller, active.Session.RoomID, active.Session.AgentSessionID, SessionStatusReady)
}

func TestControllerReleaseIdleLiveSessionsFailureDefersSameAdapterAndDoesNotReportCompletion(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	adapter := newReleasableAdapter()
	controller := NewController([]Adapter{adapter}, reporter)
	failing := startReleasableSession(t, controller, "failing-session")
	released := startReleasableSession(t, controller, "released-session")
	stale := time.Now().Add(-time.Hour)
	setSessionUpdatedAt(t, controller, failing.Session, stale)
	setSessionUpdatedAt(t, controller, released.Session, stale)
	adapter.releaseErrByAgentSessionID[failing.Session.AgentSessionID] = errors.New("close failed")
	adapter.releaseErrByAgentSessionID[released.Session.AgentSessionID] = errors.New("close failed too")
	reporter.waitForCalls(t, 2)

	result := controller.ReleaseIdleLiveSessions(context.Background(), ReleaseIdleLiveSessionsInput{
		IdleAfter: 30 * time.Minute,
		Now:       time.Now(),
	})
	if result.Failed != 1 || result.Released != 0 || result.SkippedCleanupBudget != 1 {
		t.Fatalf("release result = %#v, want one failure and one same-adapter defer", result)
	}
	time.Sleep(50 * time.Millisecond)
	for _, call := range reporter.snapshot() {
		for _, patch := range call.report.StatePatches {
			if patch.LifecycleStatus == SessionStatusCompleted {
				t.Fatalf("release reported completed session patch: %#v", call.report)
			}
		}
	}
}

func TestControllerExecResumesAfterIdleLiveSessionRelease(t *testing.T) {
	t.Parallel()

	adapter := newReleasableAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started := startReleasableSession(t, controller, "agent-session-1")
	setSessionUpdatedAt(t, controller, started.Session, time.Now().Add(-time.Hour))
	if result := controller.ReleaseIdleLiveSessions(context.Background(), ReleaseIdleLiveSessionsInput{
		IdleAfter: 30 * time.Minute,
		Now:       time.Now(),
	}); result.Released != 1 {
		t.Fatalf("release result = %#v, want one released session", result)
	}

	result, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("resume me"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !result.Accepted {
		t.Fatalf("Exec result = %#v, want accepted", result)
	}
	if adapter.resumeCalls != 1 {
		t.Fatalf("resume calls = %d, want 1", adapter.resumeCalls)
	}
}

func TestControllerRecyclesIdleKimiCodeProcessAndResumesOnNextExec(t *testing.T) {
	t.Parallel()

	transport := &multiProcStandardACPTransport{
		agentTitle:               "Kimi Code",
		sessionID:                "kimi-session-idle-recycle",
		supportsAgentLoadSession: true,
	}
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-kimi-idle-recycle",
		AgentSessionID: "kimi-agent-session-idle-recycle",
		Provider:       "acp:kimi-code",
		CWD:            "/workspace/kimi-idle-recycle",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() {
		_, _ = controller.Close(context.Background(), CloseInput{
			RoomID:         started.Session.RoomID,
			AgentSessionID: started.Session.AgentSessionID,
		})
	}()

	nowTime := time.Now()
	setSessionUpdatedAt(t, controller, started.Session, nowTime.Add(-30*time.Minute))
	result := controller.ReleaseIdleLiveSessions(context.Background(), ReleaseIdleLiveSessionsInput{
		IdleAfter: 30 * time.Minute,
		Now:       nowTime,
	})
	if result.Released != 1 || result.Scanned != 1 {
		t.Fatalf("release result = %#v, want one released Kimi Code process", result)
	}
	if spawned, live := transport.snapshot(); spawned != 1 || len(live) != 0 {
		t.Fatalf("processes after release = spawned %d live %d, want 1 spawned and 0 live", spawned, len(live))
	}
	stored, ok := controller.Session(started.Session.RoomID, started.Session.AgentSessionID)
	if !ok || stored.ProviderSessionID != "kimi-session-idle-recycle" {
		t.Fatalf("stored session = %#v ok=%v, want preserved provider session id", stored, ok)
	}

	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("resume after idle release"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !execResult.Accepted {
		t.Fatalf("Exec result = %#v, want accepted", execResult)
	}
	spawned, live := transport.snapshot()
	if spawned != 2 || len(live) != 1 {
		t.Fatalf("processes after Exec = spawned %d live %d, want replacement process", spawned, len(live))
	}
	transport.mu.Lock()
	resumedConnection := transport.conns[1]
	transport.mu.Unlock()
	resumedConnection.mu.Lock()
	providerSessionID := asString(resumedConnection.lastLoadSessionParams["sessionId"])
	resumedConnection.mu.Unlock()
	if providerSessionID != "kimi-session-idle-recycle" {
		t.Fatalf("resumed provider session id = %q, want preserved Kimi Code session", providerSessionID)
	}
}

func TestControllerKeepsIdleStandardACPProcessWithoutResumeCapability(t *testing.T) {
	t.Parallel()

	transport := &multiProcStandardACPTransport{
		agentTitle: "Non-resumable ACP Agent",
		sessionID:  "non-resumable-session",
	}
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-non-resumable",
		AgentSessionID: "agent-session-non-resumable",
		Provider:       "acp:kimi-code",
		CWD:            "/workspace/non-resumable",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() {
		_, _ = controller.Close(context.Background(), CloseInput{
			RoomID:         started.Session.RoomID,
			AgentSessionID: started.Session.AgentSessionID,
		})
	}()

	nowTime := time.Now()
	setSessionUpdatedAt(t, controller, started.Session, nowTime.Add(-31*time.Minute))
	result := controller.ReleaseIdleLiveSessions(context.Background(), ReleaseIdleLiveSessionsInput{
		IdleAfter: 30 * time.Minute,
		Now:       nowTime,
	})
	if result.SkippedUnsupported != 1 || result.Released != 0 {
		t.Fatalf("release result = %#v, want non-resumable handshake skipped", result)
	}
	if spawned, live := transport.snapshot(); spawned != 1 || len(live) != 1 {
		t.Fatalf("processes after release = spawned %d live %d, want original process retained", spawned, len(live))
	}
}

func TestControllerReleaseIdleLiveSessionsWaitsForExecLifecycle(t *testing.T) {
	t.Parallel()

	adapter := newReleasableAdapter()
	adapter.validateEntered = make(chan struct{})
	adapter.validateRelease = make(chan struct{})
	controller := NewController([]Adapter{adapter}, nil)
	started := startReleasableSession(t, controller, "agent-session-1")
	setSessionUpdatedAt(t, controller, started.Session, time.Now().Add(-time.Hour))

	execDone := make(chan error, 1)
	go func() {
		_, err := controller.Exec(context.Background(), ExecInput{
			RoomID:         started.Session.RoomID,
			AgentSessionID: started.Session.AgentSessionID,
			Content:        textPrompt("blocked exec"),
		})
		execDone <- err
	}()
	select {
	case <-adapter.validateEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for prompt validation")
	}
	releaseDone := make(chan ReleaseIdleLiveSessionsResult, 1)
	go func() {
		releaseDone <- controller.ReleaseIdleLiveSessions(context.Background(), ReleaseIdleLiveSessionsInput{
			IdleAfter: 30 * time.Minute,
			Now:       time.Now(),
		})
	}()
	select {
	case result := <-releaseDone:
		t.Fatalf("release completed while Exec lifecycle lock was held: %#v", result)
	case <-time.After(50 * time.Millisecond):
	}
	close(adapter.validateRelease)
	if err := <-execDone; err != nil {
		t.Fatalf("Exec: %v", err)
	}
	result := <-releaseDone
	if result.SkippedActiveTurn != 1 || result.Released != 0 {
		t.Fatalf("release result = %#v, want active turn skip after Exec begins", result)
	}
	adapter.releaseNext()
	waitForSessionStatus(t, controller, started.Session.RoomID, started.Session.AgentSessionID, SessionStatusReady)
}

func TestControllerCloseAllLiveSessionsClosesEveryLiveSession(t *testing.T) {
	t.Parallel()

	adapter := newReleasableAdapter()
	unsupported := &recordingStartAdapter{provider: hermesExtensionTestProvider}
	controller := NewController([]Adapter{adapter, unsupported}, nil)
	fresh := startReleasableSession(t, controller, "fresh-session")
	notLive := startReleasableSession(t, controller, "not-live-session")
	adapter.dropLiveSession(notLive.Session.AgentSessionID)
	unsupportedStarted, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "unsupported-session",
		Provider:       hermesExtensionTestProvider,
	})
	if err != nil {
		t.Fatalf("Start unsupported: %v", err)
	}

	// A freshly started, non-idle session with a live process is exactly the
	// case ReleaseIdleLiveSessions would skip (SkippedFresh); shutdown must
	// still force it closed since there is no "later" to defer to.
	result := controller.CloseAllLiveSessions(context.Background())
	if result.Scanned != 1 || result.Closed != 1 || result.Failed != 0 {
		t.Fatalf("close-all result = %#v, want exactly the live session closed", result)
	}
	if adapter.hasLiveSession(fresh.Session.AgentSessionID) {
		t.Fatalf("adapter still reports live session after CloseAllLiveSessions")
	}
	if calls := adapter.closeCallCount(fresh.Session.AgentSessionID); calls != 1 {
		t.Fatalf("close calls = %d, want exactly one", calls)
	}
	if adapter.closeCallCount(notLive.Session.AgentSessionID) != 0 {
		t.Fatalf("Close called for a session with no live process")
	}

	stored, ok := controller.Session(fresh.Session.RoomID, fresh.Session.AgentSessionID)
	if !ok {
		t.Fatalf("controller session was deleted by CloseAllLiveSessions")
	}
	if stored.Status == SessionStatusCompleted {
		t.Fatalf("session status = completed, want CloseAllLiveSessions to be non-destructive to the session record")
	}
	if stored.ProviderSessionID != "provider-session-"+fresh.Session.AgentSessionID {
		t.Fatalf("provider session id = %q, want preserved for resume", stored.ProviderSessionID)
	}

	// Unsupported/no-live-session-probe adapters must be scanned over
	// without panicking or being counted.
	if _, ok := controller.Session(unsupportedStarted.Session.RoomID, unsupportedStarted.Session.AgentSessionID); !ok {
		t.Fatalf("unsupported provider session missing after CloseAllLiveSessions")
	}
}

func TestControllerCloseAllLiveSessionsForcesClosureDuringActiveTurn(t *testing.T) {
	t.Parallel()

	adapter := newReleasableAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started := startReleasableSession(t, controller, "agent-session-1")

	execDone := make(chan error, 1)
	go func() {
		_, err := controller.Exec(context.Background(), ExecInput{
			RoomID:         started.Session.RoomID,
			AgentSessionID: started.Session.AgentSessionID,
			Content:        textPrompt("in flight"),
		})
		execDone <- err
	}()
	adapter.waitForExec(t, "in flight")

	// Unlike ReleaseIdleLiveSessions (which would report SkippedActiveTurn
	// here), shutdown cannot wait for the turn to finish: the daemon process
	// is about to exit either way, so CloseAllLiveSessions must terminate
	// the process even mid-turn rather than leave it running unmanaged.
	result := controller.CloseAllLiveSessions(context.Background())
	if result.Scanned != 1 || result.Closed != 1 {
		t.Fatalf("close-all result = %#v, want the in-flight session force-closed", result)
	}
	if adapter.hasLiveSession(started.Session.AgentSessionID) {
		t.Fatalf("adapter still reports live session after forced close during active turn")
	}

	adapter.releaseNext()
	select {
	case <-execDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for in-flight Exec to finish")
	}
}

func TestControllerCloseAllLiveSessionsBoundsFailedCloseBudgetPerAdapter(t *testing.T) {
	t.Parallel()

	adapter := newReleasableAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	failing := startReleasableSession(t, controller, "failing-session")
	closes := startReleasableSession(t, controller, "closes-session")
	adapter.closeErrByAgentSessionID[failing.Session.AgentSessionID] = errors.New("close failed")
	adapter.closeErrByAgentSessionID[closes.Session.AgentSessionID] = errors.New("close failed too")

	result := controller.CloseAllLiveSessions(context.Background())
	if result.Scanned != 1 || result.Failed != 1 || result.Closed != 0 || result.SkippedCleanupBudget != 1 {
		t.Fatalf("close-all result = %#v, want one failure budget and one deferred session", result)
	}
	if !adapter.hasLiveSession(failing.Session.AgentSessionID) {
		t.Fatalf("failing session should remain live since Close returned an error")
	}
	if !adapter.hasLiveSession(closes.Session.AgentSessionID) {
		t.Fatalf("closes-session was attempted after the adapter spent its failed close budget")
	}
}

func TestControllerDetachedCleanupGivesEveryAdapterOneBoundedAttempt(t *testing.T) {
	t.Parallel()

	first := &detachedCleanupTestAdapter{
		Adapter: &recordingStartAdapter{provider: "acp:cleanup-first"},
		result:  LiveSessionResourceCleanupResult{Attempted: 1, Cleaned: 1},
	}
	second := &detachedCleanupTestAdapter{
		Adapter: &recordingStartAdapter{provider: "acp:cleanup-second"},
		result:  LiveSessionResourceCleanupResult{Attempted: 1, Failed: 1},
	}
	controller := NewController([]Adapter{first, second}, nil)
	result := controller.ReleaseIdleLiveSessions(context.Background(), ReleaseIdleLiveSessionsInput{
		IdleAfter: time.Minute,
	})
	if result.Scanned != 0 || result.Released != 0 || result.Failed != 0 {
		t.Fatalf("canonical release counters = %#v, want unchanged", result)
	}
	if result.ResourceCleanupAttempted != 2 || result.ResourceCleanupCleaned != 1 || result.ResourceCleanupFailed != 1 {
		t.Fatalf("resource cleanup counters = %#v", result)
	}
	if first.callCount() != 1 || second.callCount() != 1 {
		t.Fatalf("cleanup calls = first:%d second:%d, want one each", first.callCount(), second.callCount())
	}
}

func TestControllerReleaseIdleLiveSessionsBoundsFailedCloseBudgetPerAdapter(t *testing.T) {
	t.Parallel()

	adapter := newReleasableAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	first := startReleasableSession(t, controller, "first-failing-session")
	second := startReleasableSession(t, controller, "second-failing-session")
	adapter.releaseErrByAgentSessionID[first.Session.AgentSessionID] = errors.New("release failed")
	adapter.releaseErrByAgentSessionID[second.Session.AgentSessionID] = errors.New("release failed too")
	now := time.Now()
	setSessionUpdatedAt(t, controller, first.Session, now.Add(-2*time.Hour))
	setSessionUpdatedAt(t, controller, second.Session, now.Add(-2*time.Hour))

	result := controller.ReleaseIdleLiveSessions(context.Background(), ReleaseIdleLiveSessionsInput{
		IdleAfter: time.Hour,
		Now:       now,
	})
	if result.Scanned != 2 || result.Failed != 1 || result.SkippedCleanupBudget != 1 {
		t.Fatalf("release result = %#v, want one failed budget and one deferred session", result)
	}
	adapter.mu.Lock()
	releaseCalls := adapter.releaseCalls
	adapter.mu.Unlock()
	if releaseCalls != 1 {
		t.Fatalf("release calls = %d, want one per failed adapter sweep", releaseCalls)
	}
}

type detachedCleanupTestAdapter struct {
	Adapter
	mu     sync.Mutex
	calls  int
	result LiveSessionResourceCleanupResult
}

func (a *detachedCleanupTestAdapter) CleanupLiveSessionResources(_ context.Context, limit int) LiveSessionResourceCleanupResult {
	a.mu.Lock()
	defer a.mu.Unlock()
	if limit != 1 {
		return LiveSessionResourceCleanupResult{Failed: 1}
	}
	a.calls++
	return a.result
}

func (a *detachedCleanupTestAdapter) callCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.calls
}

type releasableAdapter struct {
	mu                         sync.Mutex
	live                       map[string]bool
	resumeCalls                int
	releaseCalls               int
	releaseErrByAgentSessionID map[string]error
	closeCalls                 map[string]int
	closeErrByAgentSessionID   map[string]error
	resumeEntered              chan struct{}
	resumeRelease              chan struct{}
	validateEntered            chan struct{}
	validateRelease            chan struct{}
	execStarted                chan string
	execRelease                chan struct{}
}

func newReleasableAdapter() *releasableAdapter {
	return &releasableAdapter{
		live:                       make(map[string]bool),
		releaseErrByAgentSessionID: make(map[string]error),
		closeCalls:                 make(map[string]int),
		closeErrByAgentSessionID:   make(map[string]error),
		execStarted:                make(chan string, 8),
		execRelease:                make(chan struct{}, 8),
	}
}

func (*releasableAdapter) Provider() string { return ProviderCodex }

func (a *releasableAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	session.ProviderSessionID = "provider-session-" + session.AgentSessionID
	a.mu.Lock()
	a.live[session.AgentSessionID] = true
	a.mu.Unlock()
	return []activityshared.Event{
		newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil),
	}, nil
}

func (a *releasableAdapter) Resume(_ context.Context, session Session) error {
	if a.resumeEntered != nil {
		select {
		case <-a.resumeEntered:
		default:
			close(a.resumeEntered)
		}
	}
	if a.resumeRelease != nil {
		<-a.resumeRelease
	}
	a.mu.Lock()
	a.resumeCalls++
	a.live[session.AgentSessionID] = true
	a.mu.Unlock()
	return nil
}

// Close mirrors what a real adapter's Close does to a live provider process
// (terminate it) regardless of pending work, unlike ReleaseLiveSession which
// providers may gate on busy state. It always clears live-ness so tests can
// assert CloseAllLiveSessions actually forced the process down.
func (a *releasableAdapter) Close(_ context.Context, session Session) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closeCalls[session.AgentSessionID]++
	if err := a.closeErrByAgentSessionID[session.AgentSessionID]; err != nil {
		return err
	}
	a.live[session.AgentSessionID] = false
	return nil
}

func (a *releasableAdapter) closeCallCount(agentSessionID string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.closeCalls[agentSessionID]
}

func (a *releasableAdapter) ValidatePromptContent(Session, []PromptContentBlock) error {
	if a.validateEntered != nil {
		select {
		case <-a.validateEntered:
		default:
			close(a.validateEntered)
		}
	}
	if a.validateRelease != nil {
		<-a.validateRelease
	}
	return nil
}

func (a *releasableAdapter) Exec(_ context.Context, session Session, content []PromptContentBlock, _ string, turnID string, _ EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	prompt := promptDisplayText(content)
	a.execStarted <- prompt
	<-a.execRelease
	return []activityshared.Event{
		newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", nil),
	}, nil
}

func (*releasableAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *releasableAdapter) HasLiveSession(session Session) bool {
	return a.hasLiveSession(session.AgentSessionID)
}

func (a *releasableAdapter) hasLiveSession(agentSessionID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.live[agentSessionID]
}

func (a *releasableAdapter) ReleaseLiveSession(_ context.Context, session Session) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.releaseCalls++
	if err := a.releaseErrByAgentSessionID[session.AgentSessionID]; err != nil {
		return err
	}
	a.live[session.AgentSessionID] = false
	return nil
}

func (a *releasableAdapter) dropLiveSession(agentSessionID string) {
	a.mu.Lock()
	a.live[agentSessionID] = false
	a.mu.Unlock()
}

func (a *releasableAdapter) waitForExec(t *testing.T, prompt string) {
	t.Helper()
	select {
	case got := <-a.execStarted:
		if got != prompt {
			t.Fatalf("exec prompt = %q, want %q", got, prompt)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for exec prompt %q", prompt)
	}
}

func (a *releasableAdapter) releaseNext() {
	a.execRelease <- struct{}{}
}

func startReleasableSession(t *testing.T, controller *Controller, agentSessionID string) StartResult {
	t.Helper()
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	return started
}

func setSessionUpdatedAt(t *testing.T, controller *Controller, session Session, updatedAt time.Time) {
	t.Helper()
	controller.mu.Lock()
	key := sessionKey(session.RoomID, session.AgentSessionID)
	stored, ok := controller.sessions[key]
	if !ok {
		controller.mu.Unlock()
		t.Fatalf("session %q missing", key)
	}
	stored.UpdatedAtUnixMS = unixMS(updatedAt)
	controller.sessions[key] = stored
	controller.mu.Unlock()
}

func newKimiCodeExtensionTestAdapter(t *testing.T, transport ProcessTransport) *standardACPAdapter {
	t.Helper()
	adapter, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:    "acp:kimi-code",
		Name:        "kimi-code-acp",
		DisplayName: "Kimi Code",
		Command:     []string{"kimi", "acp"},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	return adapter.(*standardACPAdapter)
}

func TestControllerCloseReportsSessionCompleted(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	controller := NewController([]Adapter{&statefulInteractiveAdapter{}}, reporter)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Codex",
		CWD:            "/workspace",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	if _, err := controller.Close(context.Background(), CloseInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
	}); err != nil {
		t.Fatalf("Close: %v", err)
	}

	waitForCondition(t, func() bool {
		for _, report := range reportInputs(reporter.snapshot()) {
			for _, patch := range report.StatePatches {
				if patch.AgentSessionID == started.Session.AgentSessionID &&
					patch.LifecycleStatus == string(activityshared.SessionStatusCompleted) &&
					patch.CurrentPhase == string(activityshared.TurnPhaseIdle) {
					return true
				}
			}
		}
		return false
	})
}
