package agentruntime

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type contextRecoveryReportBarrier struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (r *contextRecoveryReportBarrier) Report(
	ctx context.Context,
	_ agentsessionstore.ReportActivityInput,
) error {
	r.once.Do(func() { close(r.entered) })
	select {
	case <-r.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *contextRecoveryReportBarrier) ReportSubmitProvenance(
	ctx context.Context,
	report agentsessionstore.ReportActivityInput,
) error {
	return r.Report(ctx, report)
}

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

func TestControllerReleaseIdleLiveSessionsFailureContinuesAndDoesNotReportCompletion(t *testing.T) {
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
	reporter.waitForCalls(t, 2)

	result := controller.ReleaseIdleLiveSessions(context.Background(), ReleaseIdleLiveSessionsInput{
		IdleAfter: 30 * time.Minute,
		Now:       time.Now(),
	})
	if result.Failed != 1 || result.Released != 1 {
		t.Fatalf("release result = %#v, want one failure and one release", result)
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

func TestControllerCloseAllLiveSessionsFailureIsCountedAndDoesNotStopOtherSessions(t *testing.T) {
	t.Parallel()

	adapter := newReleasableAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	failing := startReleasableSession(t, controller, "failing-session")
	closes := startReleasableSession(t, controller, "closes-session")
	adapter.closeErrByAgentSessionID[failing.Session.AgentSessionID] = errors.New("close failed")

	result := controller.CloseAllLiveSessions(context.Background())
	if result.Scanned != 2 || result.Failed != 1 || result.Closed != 1 {
		t.Fatalf("close-all result = %#v, want one failure and one closed session", result)
	}
	if !adapter.hasLiveSession(failing.Session.AgentSessionID) {
		t.Fatalf("failing session should remain live since Close returned an error")
	}
	if adapter.hasLiveSession(closes.Session.AgentSessionID) {
		t.Fatalf("closes-session still live, want it closed despite the other session's failure")
	}
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
	startCalls                 int
	contextRecoveryPending     bool
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

func (a *releasableAdapter) PrepareContextRecovery(
	session Session,
) (Session, bool, error) {
	a.mu.Lock()
	pending := a.contextRecoveryPending
	a.mu.Unlock()
	if !pending {
		return session, false, nil
	}
	session.RuntimeContext = clonePayload(session.RuntimeContext)
	if session.RuntimeContext == nil {
		session.RuntimeContext = map[string]any{}
	}
	session.RuntimeContext["testContextRecoveryState"] = "handoff_pending"
	return session, true, nil
}

func (a *releasableAdapter) StartContextRecovery(
	ctx context.Context,
	session Session,
	_ *ContextRecoveryGoal,
) ([]activityshared.Event, error) {
	a.mu.Lock()
	a.contextRecoveryPending = false
	a.mu.Unlock()
	return a.Start(ctx, session)
}

func (a *releasableAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	session.ProviderSessionID = "provider-session-" + session.AgentSessionID
	a.mu.Lock()
	a.startCalls++
	a.live[session.AgentSessionID] = true
	a.mu.Unlock()
	return []activityshared.Event{
		newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil),
	}, nil
}

func TestControllerPrepareContextRecoveryReplacesLiveProviderBetweenTurns(t *testing.T) {
	t.Parallel()

	adapter := newReleasableAdapter()
	adapter.contextRecoveryPending = true
	controller := NewController([]Adapter{adapter}, nil)
	started := startReleasableSession(t, controller, "context-recovery-session")
	controller.mu.Lock()
	key := sessionKey(started.Session.RoomID, started.Session.AgentSessionID)
	pending := controller.sessions[key]
	controller.sessions[key] = pending
	controller.mu.Unlock()

	result, err := controller.PrepareContextRecovery(
		t.Context(),
		PrepareContextRecoveryInput{
			RoomID:         started.Session.RoomID,
			AgentSessionID: started.Session.AgentSessionID,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Recovered || adapter.releaseCalls != 1 || adapter.startCalls != 2 {
		t.Fatalf(
			"recovery=%#v releaseCalls=%d startCalls=%d",
			result,
			adapter.releaseCalls,
			adapter.startCalls,
		)
	}
	if state := payloadString(result.Session.RuntimeContext, "testContextRecoveryState"); state != "handoff_pending" {
		t.Fatalf("recovery state=%q", state)
	}
}

func TestControllerContextRecoveryProbeWaitsForQueuedTerminalGoalReport(t *testing.T) {
	adapter := newReleasableAdapter()
	adapter.contextRecoveryPending = true
	controller := NewController([]Adapter{adapter}, nil)
	started := startReleasableSession(t, controller, "context-recovery-report-barrier")
	reporter := &contextRecoveryReportBarrier{
		entered: make(chan struct{}), release: make(chan struct{}),
	}
	controller.reporter = reporter
	controller.reportQueue = newReportRequestQueue()
	go controller.runReportWorker()
	controller.enqueueReport(t.Context(), agentsessionstore.ReportActivityInput{
		WorkspaceID: started.Session.RoomID,
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: started.Session.AgentSessionID,
			RuntimeContext: map[string]any{
				"goal": map[string]any{"objective": "ship it", "status": "complete"},
			},
		}},
	})
	select {
	case <-reporter.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("queued terminal Goal report did not reach reporter")
	}
	done := make(chan error, 1)
	go func() {
		_, err := controller.ContextRecoveryRequired(t.Context(), PrepareContextRecoveryInput{
			RoomID: started.Session.RoomID, AgentSessionID: started.Session.AgentSessionID,
		})
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("context recovery probe crossed queued terminal report: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(reporter.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestControllerExecFailsClosedWhenRecoveryBecomesPendingAfterHostProbe(t *testing.T) {
	adapter := newReleasableAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started := startReleasableSession(t, controller, "context-recovery-exec-race")
	required, err := controller.ContextRecoveryRequired(t.Context(), PrepareContextRecoveryInput{
		RoomID: started.Session.RoomID, AgentSessionID: started.Session.AgentSessionID,
	})
	if err != nil || required {
		t.Fatalf("initial recovery required=%v error=%v", required, err)
	}
	adapter.mu.Lock()
	adapter.contextRecoveryPending = true
	adapter.mu.Unlock()
	_, err = controller.Exec(t.Context(), ExecInput{
		RoomID: started.Session.RoomID, AgentSessionID: started.Session.AgentSessionID,
		TurnID: "turn-after-probe", Content: []PromptContentBlock{{Type: "text", Text: "continue"}},
	})
	if !errors.Is(err, ErrContextRecoveryRequired) {
		t.Fatalf("Exec error=%v, want ErrContextRecoveryRequired", err)
	}
	select {
	case sessionID := <-adapter.execStarted:
		t.Fatalf("provider Exec started after recovery became pending: %q", sessionID)
	default:
	}
}

func TestControllerResumeStartsContextRecoveryWithoutResumingExhaustedProvider(t *testing.T) {
	t.Parallel()

	adapter := newReleasableAdapter()
	adapter.contextRecoveryPending = true
	controller := NewController([]Adapter{adapter}, nil)
	resumed, err := controller.Resume(t.Context(), ResumeInput{
		RoomID:            "room-context-recovery",
		AgentSessionID:    "session-context-recovery-cold",
		Provider:          ProviderCodex,
		ProviderSessionID: "provider-session-exhausted",
		CWD:               "/workspace",
		RuntimeContext: map[string]any{
			"testContextRecoveryState": "pending",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if adapter.resumeCalls != 0 || adapter.startCalls != 1 {
		t.Fatalf(
			"resumeCalls=%d startCalls=%d, want direct fresh start",
			adapter.resumeCalls,
			adapter.startCalls,
		)
	}
	if resumed.ProviderSessionID !=
		"provider-session-session-context-recovery-cold" {
		t.Fatalf("provider session id=%q", resumed.ProviderSessionID)
	}
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
