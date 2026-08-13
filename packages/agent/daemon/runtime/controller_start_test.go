package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestControllerStartFailureDoesNotCreateCanonicalSessionOrTurnlessMessage(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	controller := NewController([]Adapter{failingStartAdapter{}}, reporter)
	controller.pendingCommandSnapshots["agent-session-1"] = AgentSessionCommandSnapshot{AgentSessionID: "agent-session-1"}
	controller.pendingConfigOptionsUpdates[sessionKey("room-1", "agent-session-1")] = []AgentSessionConfigOptionsUpdate{{AgentSessionID: "agent-session-1"}}

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       hermesExtensionTestProvider,
		CWD:            "/workspace",
		Title:          "Hermes",
	})
	if err == nil {
		t.Fatal("Start error = nil")
	}
	if code := AppErrorCode(err); code != "process_exited" {
		t.Fatalf("start error code = %q, want process_exited", code)
	}
	if detail := AppErrorDebugMessage(err); detail != "acp process exited with code 1: Config invalid" {
		t.Fatalf("start error detail = %q", detail)
	}
	if started.Session.AgentSessionID != "" {
		t.Fatalf("start result = %#v, want no failed session result", started)
	}
	if stored, ok := controller.get("room-1", "agent-session-1"); ok {
		t.Fatalf("stored session = %#v, want no canonical session", stored)
	}
	if reports := reporter.snapshot(); len(reports) != 0 {
		t.Fatalf("reports = %#v, want no turnless failure report", reports)
	}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if len(controller.pendingCommandSnapshots) != 0 || len(controller.pendingConfigOptionsUpdates) != 0 {
		t.Fatalf("pending snapshots survived failed start: commands=%#v config=%#v", controller.pendingCommandSnapshots, controller.pendingConfigOptionsUpdates)
	}
}

func TestControllerStartPreservesStructuredCleanupBackpressureError(t *testing.T) {
	t.Parallel()

	controller := NewController([]Adapter{cleanupPendingStartAdapter{}}, nil)
	_, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-cleanup-pending",
		AgentSessionID: "agent-cleanup-pending",
		Provider:       hermesExtensionTestProvider,
		CWD:            "/workspace",
	})
	if AppErrorCode(err) != AppErrorProcessCleanupPending {
		t.Fatalf("Start error code = %q (err=%v), want %q", AppErrorCode(err), err, AppErrorProcessCleanupPending)
	}
	if AppErrorDebugMessage(err) != "old process close failed" {
		t.Fatalf("Start debug message = %q", AppErrorDebugMessage(err))
	}
}

func TestControllerStartupOperationsDoNotBlockIndependentSessions(t *testing.T) {
	tests := []struct {
		name              string
		blocking          string
		following         string
		followingProvider string
	}{
		{name: "other provider start while start is blocked", blocking: "start", following: "start", followingProvider: ProviderCodex},
		{name: "other provider resume while start is blocked", blocking: "start", following: "resume", followingProvider: ProviderCodex},
		{name: "other provider start while resume is blocked", blocking: "resume", following: "start", followingProvider: ProviderCodex},
		{name: "other provider resume while resume is blocked", blocking: "resume", following: "resume", followingProvider: ProviderCodex},
		{name: "same provider start while start is blocked", blocking: "start", following: "start", followingProvider: ProviderClaudeCode},
		{name: "same provider resume while start is blocked", blocking: "start", following: "resume", followingProvider: ProviderClaudeCode},
		{name: "same provider start while resume is blocked", blocking: "resume", following: "start", followingProvider: ProviderClaudeCode},
		{name: "same provider resume while resume is blocked", blocking: "resume", following: "resume", followingProvider: ProviderClaudeCode},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			blocker := &blockingStartupAdapter{
				recordingStartAdapter: recordingStartAdapter{provider: ProviderClaudeCode},
				operation:             test.blocking,
				blockedSessionID:      "blocked-session",
				entered:               make(chan struct{}),
				release:               make(chan struct{}),
			}
			adapters := []Adapter{blocker}
			if test.followingProvider != ProviderClaudeCode {
				adapters = append(adapters, &recordingStartAdapter{provider: test.followingProvider})
			}
			controller := NewController(adapters, nil)

			blocked := make(chan error, 1)
			go func() {
				blocked <- invokeControllerStartupOperation(
					context.Background(),
					controller,
					test.blocking,
					ProviderClaudeCode,
					"blocked-session",
				)
			}()
			select {
			case <-blocker.entered:
			case <-time.After(time.Second):
				t.Fatal("blocking startup operation was not entered")
			}

			completed := make(chan error, 1)
			go func() {
				completed <- invokeControllerStartupOperation(
					context.Background(),
					controller,
					test.following,
					test.followingProvider,
					"independent-session",
				)
			}()

			select {
			case err := <-completed:
				if err != nil {
					close(blocker.release)
					<-blocked
					t.Fatalf("independent startup operation: %v", err)
				}
			case <-time.After(time.Second):
				close(blocker.release)
				<-blocked
				<-completed
				t.Fatal("independent provider startup was blocked")
			}

			close(blocker.release)
			if err := <-blocked; err != nil {
				t.Fatalf("blocking startup operation: %v", err)
			}
		})
	}
}

func TestControllerCloseCanDiscardRuntimeWithoutCompletingCanonicalSession(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	adapter := &recordingStartAdapter{provider: ProviderClaudeCode}
	controller := NewController([]Adapter{adapter}, reporter)
	if _, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-1", AgentSessionID: "agent-session-rejected", Provider: ProviderClaudeCode,
	}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	reportsBeforeClose := len(reporter.snapshot())

	if _, err := controller.Close(context.Background(), CloseInput{
		RoomID: "room-1", AgentSessionID: "agent-session-rejected", PreserveCanonicalState: true,
	}); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if adapter.closeCalls != 1 {
		t.Fatalf("adapter close calls = %d, want 1", adapter.closeCalls)
	}
	if _, ok := controller.get("room-1", "agent-session-rejected"); ok {
		t.Fatal("discarded runtime session remains live")
	}
	if reportsAfterClose := len(reporter.snapshot()); reportsAfterClose != reportsBeforeClose {
		t.Fatalf("discard close reports = %d, want unchanged %d", reportsAfterClose, reportsBeforeClose)
	}
}

func TestControllerDiscardRemovesRuntimeWhenProviderCloseFails(t *testing.T) {
	t.Parallel()

	closeErr := errors.New("provider close timed out")
	adapter := &recordingStartAdapter{provider: ProviderClaudeCode, closeErr: closeErr}
	controller := NewController([]Adapter{adapter}, nil)
	if _, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-1", AgentSessionID: "agent-session-rejected", Provider: ProviderClaudeCode,
	}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	_, err := controller.Close(context.Background(), CloseInput{
		RoomID: "room-1", AgentSessionID: "agent-session-rejected", PreserveCanonicalState: true,
	})
	if !errors.Is(err, closeErr) {
		t.Fatalf("Close() error = %v, want %v", err, closeErr)
	}
	if _, ok := controller.get("room-1", "agent-session-rejected"); ok {
		t.Fatal("discarded runtime session remains registered after close failure")
	}
}

func TestControllerStartupLockPreservesSameSessionSerialization(t *testing.T) {
	tests := []struct {
		name      string
		blocking  string
		following string
	}{
		{name: "start then start", blocking: "start", following: "start"},
		{name: "start then resume", blocking: "start", following: "resume"},
		{name: "resume then start", blocking: "resume", following: "start"},
		{name: "resume then resume", blocking: "resume", following: "resume"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			adapter := &blockingStartupAdapter{
				recordingStartAdapter: recordingStartAdapter{provider: ProviderClaudeCode},
				operation:             test.blocking,
				blockedSessionID:      "same-session",
				entered:               make(chan struct{}),
				release:               make(chan struct{}),
			}
			controller := NewController([]Adapter{adapter}, nil)

			blocked := make(chan error, 1)
			go func() {
				blocked <- invokeControllerStartupOperation(
					context.Background(),
					controller,
					test.blocking,
					ProviderClaudeCode,
					"same-session",
				)
			}()
			select {
			case <-adapter.entered:
			case <-time.After(time.Second):
				t.Fatal("blocking startup operation was not entered")
			}

			waitCtx, cancelWait := context.WithCancel(context.Background())
			waiting := make(chan error, 1)
			go func() {
				waiting <- invokeControllerStartupOperation(
					waitCtx,
					controller,
					test.following,
					ProviderClaudeCode,
					"same-session",
				)
			}()
			cancelWait()
			select {
			case err := <-waiting:
				if !errors.Is(err, context.Canceled) {
					close(adapter.release)
					<-blocked
					t.Fatalf("waiting startup error = %v, want context canceled", err)
				}
			case <-time.After(time.Second):
				close(adapter.release)
				<-blocked
				<-waiting
				t.Fatal("same-session startup lock did not honor context cancellation")
			}

			close(adapter.release)
			if err := <-blocked; err != nil {
				t.Fatalf("blocking startup operation: %v", err)
			}
			if err := invokeControllerStartupOperation(
				context.Background(),
				controller,
				test.following,
				ProviderClaudeCode,
				"same-session",
			); err != nil {
				t.Fatalf("startup replay: %v", err)
			}
			if calls := adapter.startCalls.Load() + adapter.resumeCalls.Load(); calls != 1 {
				t.Fatalf("adapter startup calls = %d, want 1", calls)
			}
			if locks := len(controller.startupLocks); locks != 0 {
				t.Fatalf("startup locks = %d, want 0", locks)
			}
		})
	}
}

func TestControllerAnonymousStartsRemainProviderScopedAndIdempotent(t *testing.T) {
	adapter := &blockingStartupAdapter{
		recordingStartAdapter: recordingStartAdapter{provider: ProviderClaudeCode},
		operation:             "start",
		entered:               make(chan struct{}),
		release:               make(chan struct{}),
	}
	controller := NewController([]Adapter{adapter}, nil)
	input := StartInput{RoomID: "room-1", Provider: ProviderClaudeCode}

	firstResult := make(chan StartResult, 1)
	firstErr := make(chan error, 1)
	go func() {
		result, err := controller.Start(context.Background(), input)
		firstResult <- result
		firstErr <- err
	}()
	select {
	case <-adapter.entered:
	case <-time.After(time.Second):
		t.Fatal("blocking anonymous start was not entered")
	}

	waitCtx, cancelWait := context.WithCancel(context.Background())
	waiting := make(chan error, 1)
	go func() {
		_, err := controller.Start(waitCtx, input)
		waiting <- err
	}()
	cancelWait()
	select {
	case err := <-waiting:
		if !errors.Is(err, context.Canceled) {
			close(adapter.release)
			<-firstResult
			<-firstErr
			t.Fatalf("waiting anonymous start error = %v, want context canceled", err)
		}
	case <-time.After(time.Second):
		close(adapter.release)
		<-firstResult
		<-firstErr
		<-waiting
		t.Fatal("anonymous startup lock did not honor context cancellation")
	}

	close(adapter.release)
	first := <-firstResult
	if err := <-firstErr; err != nil {
		t.Fatalf("first anonymous start: %v", err)
	}
	replayed, err := controller.Start(context.Background(), input)
	if err != nil {
		t.Fatalf("replayed anonymous start: %v", err)
	}
	if replayed.Session.AgentSessionID != first.Session.AgentSessionID {
		t.Fatalf("replayed session = %q, want %q", replayed.Session.AgentSessionID, first.Session.AgentSessionID)
	}
	if !first.Created {
		t.Fatal("first anonymous start Created = false, want true")
	}
	if replayed.Created {
		t.Fatal("replayed anonymous start Created = true, want false")
	}
	if calls := adapter.startCalls.Load(); calls != 1 {
		t.Fatalf("adapter start calls = %d, want 1", calls)
	}
	if locks := len(controller.startupLocks); locks != 0 {
		t.Fatalf("startup locks = %d, want 0", locks)
	}
}

func invokeControllerStartupOperation(
	ctx context.Context,
	controller *Controller,
	operation string,
	provider string,
	agentSessionID string,
) error {
	switch operation {
	case "start":
		_, err := controller.Start(ctx, StartInput{
			RoomID:         "room-1",
			AgentSessionID: agentSessionID,
			Provider:       provider,
		})
		return err
	case "resume":
		_, err := controller.Resume(ctx, ResumeInput{
			RoomID:            "room-1",
			AgentSessionID:    agentSessionID,
			Provider:          provider,
			ProviderSessionID: "provider-" + agentSessionID,
		})
		return err
	default:
		return fmt.Errorf("unsupported startup operation %q", operation)
	}
}

func TestControllerProvisionalStartRollsBackWithoutCanonicalReport(t *testing.T) {
	t.Parallel()
	reporter := &recordingReporter{}
	controller := NewController([]Adapter{&recordingStartAdapter{provider: ProviderCodex}}, reporter)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-1", AgentSessionID: "agent-session-1", Provider: ProviderCodex,
		CWD: "/workspace", Provisional: true,
	})
	if err != nil || started.Session.AgentSessionID != "agent-session-1" {
		t.Fatalf("Start() = %#v, %v", started, err)
	}
	if reports := reporter.snapshot(); len(reports) != 0 {
		t.Fatalf("reports before commit = %#v", reports)
	}
	controller.applySessionEventsByAgentSessionID("agent-session-1", []activityshared.Event{
		newSessionActivityEvent(started.Session, EventSessionStarted, SessionStatusReady, nil),
	})
	controller.applyCommandSnapshotByAgentSessionID(AgentSessionCommandSnapshot{
		AgentSessionID: "agent-session-1",
		Commands:       []AgentSessionCommand{{Name: "review"}},
	})
	controller.applyConfigOptionsUpdateByAgentSessionID(AgentSessionConfigOptionsUpdate{
		RoomID: "room-1", AgentSessionID: "agent-session-1",
	})
	if reports := reporter.snapshot(); len(reports) != 0 {
		t.Fatalf("provider callbacks leaked reports before commit = %#v", reports)
	}
	controller.mu.Lock()
	if _, ok := controller.commands[sessionKey("room-1", "agent-session-1")]; ok {
		controller.mu.Unlock()
		t.Fatal("provider command callback became canonical before commit")
	}
	if len(controller.pendingCommandSnapshots) != 1 || len(controller.pendingConfigOptionsUpdates) != 1 {
		controller.mu.Unlock()
		t.Fatalf("provider callbacks were not retained transactionally: commands=%#v config=%#v", controller.pendingCommandSnapshots, controller.pendingConfigOptionsUpdates)
	}
	controller.mu.Unlock()
	if _, err := controller.Close(context.Background(), CloseInput{RoomID: "room-1", AgentSessionID: "agent-session-1"}); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if _, ok := controller.get("room-1", "agent-session-1"); ok {
		t.Fatal("provisional session survived rollback")
	}
	if reports := reporter.snapshot(); len(reports) != 0 {
		t.Fatalf("rollback reports = %#v", reports)
	}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if len(controller.pendingCommandSnapshots) != 0 || len(controller.pendingConfigOptionsUpdates) != 0 {
		t.Fatalf("rollback retained provider callbacks: commands=%#v config=%#v", controller.pendingCommandSnapshots, controller.pendingConfigOptionsUpdates)
	}
}

func TestControllerProvisionalStartCommitsWithFirstTurn(t *testing.T) {
	t.Parallel()
	reporter := &recordingReporter{}
	controller := NewController([]Adapter{&recordingStartAdapter{provider: ProviderCodex}}, reporter)
	_, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-1", AgentSessionID: "agent-session-1", Provider: ProviderCodex,
		CWD: "/workspace", Provisional: true,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if sessions := controller.Sessions("room-1"); len(sessions) != 0 {
		t.Fatalf("Sessions() before first turn acceptance = %#v, want provisional session hidden", sessions)
	}
	result, err := controller.Exec(context.Background(), ExecInput{
		RoomID: "room-1", AgentSessionID: "agent-session-1",
		Content: []PromptContentBlock{{Type: "text", Text: "hello"}},
	})
	if err != nil || result.TurnID == "" {
		t.Fatalf("Exec() = %#v, %v", result, err)
	}
	reports := reporter.waitForCalls(t, 1)
	if len(reports[0].report.StatePatches) == 0 {
		t.Fatalf("commit report = %#v, want session and turn state", reports[0].report)
	}
	if sessions := controller.Sessions("room-1"); len(sessions) != 1 || sessions[0].AgentSessionID != "agent-session-1" {
		t.Fatalf("Sessions() after first turn acceptance = %#v, want committed session", sessions)
	}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if controller.provisionalSessions[sessionKey("room-1", "agent-session-1")] {
		t.Fatal("session remained provisional after first turn acceptance")
	}
}

func TestControllerStartPassesProviderTargetRefToAdapterSession(t *testing.T) {
	t.Parallel()

	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, nil)
	ref := map[string]any{
		"kind":          "sharedAgent",
		"provider":      ProviderCodex,
		"sharedAgentId": "agent-1",
	}

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:            "room-1",
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		CWD:               "/workspace",
		ProviderTargetRef: ref,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if adapter.started.ProviderTargetRef["kind"] != "sharedAgent" ||
		adapter.started.ProviderTargetRef["sharedAgentId"] != "agent-1" {
		t.Fatalf("adapter provider target ref = %#v, want shared agent ref", adapter.started.ProviderTargetRef)
	}
	if started.Session.ProviderTargetRef["kind"] != "sharedAgent" {
		t.Fatalf("started provider target ref = %#v, want shared agent ref", started.Session.ProviderTargetRef)
	}
}

func TestControllerPreflightsPathBackedImageButExecRequiresHydratedContent(t *testing.T) {
	t.Parallel()

	adapter := &recordingPromptAdapter{
		recordingStartAdapter: recordingStartAdapter{provider: ProviderCodex},
	}
	controller := NewController([]Adapter{adapter}, nil)
	_, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	content := []PromptContentBlock{{
		Type:     "image",
		MimeType: "image/png",
		Path:     "/managed/agent-prompt-assets/screen.png",
	}}
	if err := controller.ValidatePromptContent(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Content:        content,
	}); err != nil {
		t.Fatalf("ValidatePromptContent: %v", err)
	}
	if len(adapter.validated) != 1 || adapter.validated[0].Path != content[0].Path {
		t.Fatalf("adapter validated content = %#v, want path-backed image", adapter.validated)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Content:        content,
	}); !errors.Is(err, ErrPromptImageUnsupported) {
		t.Fatalf("Exec error = %v, want ErrPromptImageUnsupported", err)
	}
}

func TestControllerStartDoesNotReuseSessionWithDifferentProviderTargetRef(t *testing.T) {
	t.Parallel()

	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, nil)

	first, err := controller.Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
		ProviderTargetRef: map[string]any{
			"kind":          "sharedAgent",
			"provider":      ProviderCodex,
			"sharedAgentId": "agent-1",
		},
	})
	if err != nil {
		t.Fatalf("first Start: %v", err)
	}
	second, err := controller.Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
		ProviderTargetRef: map[string]any{
			"kind":          "sharedAgent",
			"provider":      ProviderCodex,
			"sharedAgentId": "agent-2",
		},
	})
	if err != nil {
		t.Fatalf("second Start: %v", err)
	}

	if second.Session.AgentSessionID == first.Session.AgentSessionID {
		t.Fatalf("second start reused session %q for a different provider target", second.Session.AgentSessionID)
	}
	if adapter.started.ProviderTargetRef["sharedAgentId"] != "agent-2" {
		t.Fatalf("adapter provider target ref = %#v, want second target", adapter.started.ProviderTargetRef)
	}
}

func TestControllerStartDoesNotReuseTargetSessionWithDifferentProviderTargetRef(t *testing.T) {
	t.Parallel()

	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, nil)

	first, err := controller.Start(context.Background(), StartInput{
		RoomID:        "room-1",
		Provider:      ProviderCodex,
		AgentTargetID: "local:codex",
		CWD:           "/workspace",
		ProviderTargetRef: map[string]any{
			"kind":     "local_cli",
			"provider": ProviderCodex,
			"targetId": "local:codex",
		},
	})
	if err != nil {
		t.Fatalf("first Start: %v", err)
	}
	second, err := controller.Start(context.Background(), StartInput{
		RoomID:        "room-1",
		Provider:      ProviderCodex,
		AgentTargetID: "local:codex",
		CWD:           "/workspace",
		ProviderTargetRef: map[string]any{
			"kind":     "local_cli",
			"provider": ProviderCodex,
			"targetId": "alternate-codex",
		},
	})
	if err != nil {
		t.Fatalf("second Start: %v", err)
	}

	if second.Session.AgentSessionID == first.Session.AgentSessionID {
		t.Fatalf("second start reused session %q for a different provider target ref", second.Session.AgentSessionID)
	}
	if adapter.started.ProviderTargetRef["targetId"] != "alternate-codex" {
		t.Fatalf("adapter provider target ref = %#v, want alternate-codex", adapter.started.ProviderTargetRef)
	}
}

func TestControllerStartReusesTargetSessionWithSameProviderTargetRef(t *testing.T) {
	t.Parallel()

	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, nil)
	ref := map[string]any{
		"kind":     "local_cli",
		"provider": ProviderCodex,
		"targetId": "local:codex",
	}

	first, err := controller.Start(context.Background(), StartInput{
		RoomID:            "room-1",
		Provider:          ProviderCodex,
		AgentTargetID:     "local:codex",
		CWD:               "/workspace",
		ProviderTargetRef: ref,
	})
	if err != nil {
		t.Fatalf("first Start: %v", err)
	}
	second, err := controller.Start(context.Background(), StartInput{
		RoomID:        "room-1",
		Provider:      ProviderCodex,
		AgentTargetID: "local:codex",
		CWD:           "/workspace",
		ProviderTargetRef: map[string]any{
			"kind":     "local_cli",
			"provider": ProviderCodex,
			"targetId": "local:codex",
		},
	})
	if err != nil {
		t.Fatalf("second Start: %v", err)
	}

	if second.Session.AgentSessionID != first.Session.AgentSessionID {
		t.Fatalf("second start session = %q, want reused %q", second.Session.AgentSessionID, first.Session.AgentSessionID)
	}
	if !first.Created {
		t.Fatal("first start Created = false, want true")
	}
	if second.Created {
		t.Fatal("reused start Created = true, want false")
	}
}

type blockingStartupAdapter struct {
	recordingStartAdapter
	operation        string
	blockedSessionID string
	entered          chan struct{}
	release          chan struct{}
	enterOnce        sync.Once
	startCalls       atomic.Int32
	resumeCalls      atomic.Int32
}

func (a *blockingStartupAdapter) Start(ctx context.Context, session Session) ([]activityshared.Event, error) {
	a.startCalls.Add(1)
	if a.operation == "start" && a.blocks(session) {
		if err := a.wait(ctx); err != nil {
			return nil, err
		}
	}
	return []activityshared.Event{
		newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil),
	}, nil
}

func (a *blockingStartupAdapter) Resume(ctx context.Context, session Session) error {
	a.resumeCalls.Add(1)
	if a.operation == "resume" && a.blocks(session) {
		return a.wait(ctx)
	}
	return nil
}

func (a *blockingStartupAdapter) blocks(session Session) bool {
	return a.blockedSessionID == "" || a.blockedSessionID == session.AgentSessionID
}

func (a *blockingStartupAdapter) wait(ctx context.Context) error {
	a.enterOnce.Do(func() { close(a.entered) })
	select {
	case <-a.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type recordingPromptAdapter struct {
	recordingStartAdapter
	validated []PromptContentBlock
}

func (a *recordingPromptAdapter) ValidatePromptContent(_ Session, content []PromptContentBlock) error {
	a.validated = append([]PromptContentBlock(nil), content...)
	return validatePromptContentImagesForPreflight(content)
}

type failingStartAdapter struct{}

type cleanupPendingStartAdapter struct{ failingStartAdapter }

func (cleanupPendingStartAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, &AppError{
		Code:         AppErrorProcessCleanupPending,
		Message:      "agent process cleanup is still pending",
		DebugMessage: "old process close failed",
	}
}

func (failingStartAdapter) Provider() string { return hermesExtensionTestProvider }

func (failingStartAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, errors.New("\x1b[33macp process exited with code 1: Config invalid\x1b[39m")
}

func (failingStartAdapter) Resume(context.Context, Session) error {
	return nil
}

func (failingStartAdapter) Close(context.Context, Session) error {
	return nil
}

func (failingStartAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (failingStartAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func TestControllerRejectsUnsupportedProvider(t *testing.T) {
	t.Parallel()

	_, err := NewController(nil, nil).Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: "unknown",
	})
	if err == nil {
		t.Fatal("Start returned nil error for unsupported provider")
	}
}
