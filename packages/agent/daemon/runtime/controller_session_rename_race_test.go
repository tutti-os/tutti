package agentruntime

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// These tests lock in the title-ownership rule under concurrency: the
// controller's current Session is the only accepted state, a turn-execution
// goroutine merges only its owned fields back, and a user title (SetTitle) is
// never overwritten by a late provider title or by the turn-completion write.

// recordingStreamObserver captures every published stream projection in order.
// The observer is synchronous with publish, so the recorded order is the exact
// order consumers would observe.
type recordingStreamObserver struct {
	mu     sync.Mutex
	events []StreamEvent
}

func (o *recordingStreamObserver) ObserveRuntimeStreamEvents(_ context.Context, _, _ string, events []StreamEvent) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.events = append(o.events, events...)
	return nil
}

func (o *recordingStreamObserver) statePatches() []agentsessionstore.WorkspaceAgentStatePatch {
	o.mu.Lock()
	defer o.mu.Unlock()
	var patches []agentsessionstore.WorkspaceAgentStatePatch
	for _, event := range o.events {
		if event.EventType != StreamEventStatePatch {
			continue
		}
		patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
		if !ok {
			continue
		}
		patches = append(patches, patch)
	}
	return patches
}

func (o *recordingStreamObserver) waitForCompletionPatch(t *testing.T, turnID string) agentsessionstore.WorkspaceAgentStatePatch {
	t.Helper()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for {
		for _, patch := range o.statePatches() {
			if patch.Turn != nil &&
				strings.TrimSpace(patch.Turn.TurnID) == strings.TrimSpace(turnID) &&
				patch.Turn.CompletedAtUnixMS > 0 {
				return patch
			}
		}
		select {
		case <-time.After(10 * time.Millisecond):
		case <-timer.C:
			t.Fatalf("timed out waiting for stream completion patch for turn %q; patches=%#v", turnID, o.statePatches())
		}
	}
}

// lateProviderTitleAdapter blocks Exec until the test signals a provider title
// to emit and then until the test releases the turn to complete.
type lateProviderTitleAdapter struct {
	started      chan struct{}
	emitTitle    chan string
	titleEmitted chan struct{}
	releases     chan struct{}
}

func newLateProviderTitleAdapter() *lateProviderTitleAdapter {
	return &lateProviderTitleAdapter{
		started:      make(chan struct{}),
		emitTitle:    make(chan string),
		titleEmitted: make(chan struct{}),
		releases:     make(chan struct{}),
	}
}

func (*lateProviderTitleAdapter) Provider() string { return ProviderCodex }

func (*lateProviderTitleAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (*lateProviderTitleAdapter) Resume(context.Context, Session) error { return nil }

func (*lateProviderTitleAdapter) Close(context.Context, Session) error { return nil }

func (*lateProviderTitleAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *lateProviderTitleAdapter) Exec(
	ctx context.Context,
	session Session,
	_ []PromptContentBlock,
	_ string,
	turnID string,
	emit EventSink,
	_ CommandSnapshotSink,
) ([]activityshared.Event, error) {
	emit([]activityshared.Event{newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", nil)})
	close(a.started)
	select {
	case title := <-a.emitTitle:
		emit([]activityshared.Event{newSessionTitleActivityEvent(session, title)})
		close(a.titleEmitted)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	select {
	case <-a.releases:
		return []activityshared.Event{newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", nil)}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// waitForUserTitle asserts the stream never reverts to the pre-rename title
// after the user title first appears.
func assertStreamKeepsUserTitle(t *testing.T, patches []agentsessionstore.WorkspaceAgentStatePatch, userTitle, oldTitle string) {
	t.Helper()
	seen := false
	for _, patch := range patches {
		title := strings.TrimSpace(patch.Title)
		if !seen && title == userTitle {
			seen = true
			continue
		}
		if seen && title == oldTitle {
			t.Fatalf("stale title %q reappeared after user title %q in stream patches %v", oldTitle, userTitle, streamPatchTitles(patches))
		}
	}
	if !seen {
		t.Fatalf("user title %q never appeared in stream patches %v", userTitle, streamPatchTitles(patches))
	}
}

func streamPatchTitles(patches []agentsessionstore.WorkspaceAgentStatePatch) []string {
	titles := make([]string, 0, len(patches))
	for _, patch := range patches {
		titles = append(titles, strings.TrimSpace(patch.Title))
	}
	return titles
}

func completionReport(reports []reportCall, turnID string) (agentsessionstore.ReportActivityInput, bool) {
	for _, call := range reports {
		if hasTurnCompletionPatch(call.report, turnID) {
			return call.report, true
		}
	}
	return agentsessionstore.ReportActivityInput{}, false
}

func reportStatePatchTitles(report agentsessionstore.ReportActivityInput) []string {
	titles := make([]string, 0, len(report.StatePatches))
	for _, patch := range report.StatePatches {
		titles = append(titles, strings.TrimSpace(patch.Title))
	}
	return titles
}

// SetTitle during an active turn must survive turn completion: the Session, the
// stream projection, and the durable report must all keep the new title, and no
// terminal event may carry the pre-rename title.
func TestControllerSetTitleDuringActiveTurnSurvivesCompletion(t *testing.T) {
	t.Parallel()

	adapter := newBlockingExecAdapter()
	reporter := &recordingReporter{}
	observer := &recordingStreamObserver{}
	controller := NewController([]Adapter{adapter}, reporter)
	controller.SetStreamEventObserver(observer)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Initial title",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("hello"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	adapter.waitForPrompt(t, "hello")

	// The user renames while the turn is still running.
	if _, err := controller.SetTitle(context.Background(), "room-1", started.Session.AgentSessionID, "User title"); err != nil {
		t.Fatalf("SetTitle: %v", err)
	}
	adapter.releaseNext()

	// The turn completes; the accepted session must keep the user title.
	waitForCondition(t, func() bool {
		session, ok := controller.get("room-1", started.Session.AgentSessionID)
		return ok && session.Status == SessionStatusReady && session.Title == "User title"
	})

	completionPatch := observer.waitForCompletionPatch(t, execResult.TurnID)
	if strings.TrimSpace(completionPatch.Title) != "User title" {
		t.Fatalf("stream completion patch title = %q, want user title", completionPatch.Title)
	}
	assertStreamKeepsUserTitle(t, observer.statePatches(), "User title", "Initial title")

	reports := reporter.waitForReports(t, "turn completion report", func(calls []reportCall) bool {
		_, ok := completionReport(calls, execResult.TurnID)
		return ok
	})
	completion, ok := completionReport(reports, execResult.TurnID)
	if !ok {
		t.Fatalf("completion report missing; reports=%#v", reports)
	}
	if titles := reportStatePatchTitles(completion); len(titles) == 0 {
		t.Fatalf("completion report has no state patches")
	} else if titles[len(titles)-1] != "User title" {
		t.Fatalf("completion report titles = %v, want final user title", titles)
	}
}

// A provider title that arrives late must not overwrite a user rename. The
// session keeps the user title and the late provider title never reaches the
// stream or the report.
func TestControllerLateProviderTitleCannotOverwriteUserRename(t *testing.T) {
	t.Parallel()

	adapter := newLateProviderTitleAdapter()
	reporter := &recordingReporter{}
	observer := &recordingStreamObserver{}
	controller := NewController([]Adapter{adapter}, reporter)
	controller.SetStreamEventObserver(observer)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Initial title",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("hello"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	<-adapter.started

	if _, err := controller.SetTitle(context.Background(), "room-1", started.Session.AgentSessionID, "User title"); err != nil {
		t.Fatalf("SetTitle: %v", err)
	}
	adapter.emitTitle <- "Provider old title"
	<-adapter.titleEmitted

	if session, ok := controller.get("room-1", started.Session.AgentSessionID); !ok || session.Title != "User title" {
		t.Fatalf("session title after late provider title = %q, want user title", session.Title)
	}
	// The late provider title must never surface in the stream projection.
	assertStreamKeepsUserTitle(t, observer.statePatches(), "User title", "Initial title")

	adapter.releases <- struct{}{}
	waitForCondition(t, func() bool {
		session, ok := controller.get("room-1", started.Session.AgentSessionID)
		return ok && session.Status == SessionStatusReady && session.Title == "User title"
	})

	completionPatch := observer.waitForCompletionPatch(t, execResult.TurnID)
	if strings.TrimSpace(completionPatch.Title) != "User title" {
		t.Fatalf("stream completion patch title = %q, want user title", completionPatch.Title)
	}
	reports := reporter.waitForReports(t, "turn completion report", func(calls []reportCall) bool {
		_, ok := completionReport(calls, execResult.TurnID)
		return ok
	})
	if completion, ok := completionReport(reports, execResult.TurnID); ok {
		if titles := reportStatePatchTitles(completion); len(titles) == 0 || titles[len(titles)-1] != "User title" {
			t.Fatalf("completion report titles = %v, want final user title", titles)
		}
	} else {
		t.Fatalf("completion report missing; reports=%#v", reports)
	}
}

// The async turn-execution path applies the same merge boundary: a SetTitle
// during an active async turn survives the async completion write-back.
func TestControllerSetTitleDuringActiveAsyncTurnSurvivesCompletion(t *testing.T) {
	t.Parallel()

	adapter := newAsyncExecTestAdapter()
	reporter := &recordingReporter{}
	controller := NewController([]Adapter{adapter}, reporter)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Initial title",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("hello"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	<-adapter.started

	if _, err := controller.SetTitle(context.Background(), "room-1", started.Session.AgentSessionID, "User title"); err != nil {
		t.Fatalf("SetTitle: %v", err)
	}
	adapter.release <- struct{}{}

	waitForCondition(t, func() bool {
		session, ok := controller.get("room-1", started.Session.AgentSessionID)
		return ok && session.Status == SessionStatusReady && session.Title == "User title"
	})
}

// The session-event sink (the adapter channel used by snapshot providers) must
// respect a user-established title: a provider title event folded through the
// general projection neither changes the session title nor leaks its stale
// title into the report.
func TestControllerSessionEventSinkTitleEventRespectsUserRename(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	controller := NewController(nil, reporter)
	initial := Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		Status:         SessionStatusReady,
		Title:          "Initial title",
	}
	controller.store(initial)

	if _, err := controller.SetTitle(context.Background(), "room-1", "agent-session-1", "User title"); err != nil {
		t.Fatalf("SetTitle: %v", err)
	}
	controller.applySessionEventsByAgentSessionID("agent-session-1", []activityshared.Event{
		newSessionTitleActivityEvent(initial, "Provider old title"),
	})

	stored, ok := controller.get("room-1", "agent-session-1")
	if !ok {
		t.Fatal("stored session missing")
	}
	if stored.Title != "User title" {
		t.Fatalf("session title = %q, want user title", stored.Title)
	}
	if !stored.UserTitleSet {
		t.Fatal("session user-title marker lost")
	}

	reports := reporter.waitForCalls(t, 2)
	for _, call := range reports {
		for _, patch := range call.report.StatePatches {
			if strings.TrimSpace(patch.Title) == "Provider old title" {
				t.Fatalf("stale provider title leaked into report: %#v", call.report.StatePatches)
			}
		}
	}
}
