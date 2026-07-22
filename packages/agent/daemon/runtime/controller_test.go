//nolint:unused // Retain migrated test fixtures until the next agent-daemon decomposition pass.
package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func rootCancelInput(roomID string, agentSessionID string, turnID string, reason string) CancelInput {
	return CancelInput{
		RoomID:             roomID,
		RootAgentSessionID: agentSessionID,
		Targets: []CancelTarget{{
			AgentSessionID: agentSessionID,
			TurnID:         turnID,
		}},
		Reason: reason,
	}
}

type recordingReporter struct {
	mu      sync.Mutex
	calls   []reportCall
	updates chan struct{}
}

type reportCall struct {
	report agentsessionstore.ReportActivityInput
}

type goalPrepareBarrierReporter struct {
	mu       sync.Mutex
	prepared chan struct{}
	release  chan struct{}
	once     sync.Once
	phases   []string
}

type blockingGoalReconcileReporter struct{}

type submittedTurnBarrierReporter struct {
	entered chan struct{}
	release chan struct{}
	err     error
	once    sync.Once
}

func (r *submittedTurnBarrierReporter) Report(ctx context.Context, _ agentsessionstore.ReportActivityInput) error {
	r.once.Do(func() { close(r.entered) })
	select {
	case <-r.release:
		return r.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

type executionSignalAdapter struct {
	recordingStartAdapter
	executed chan struct{}
	once     sync.Once
}

func (a *executionSignalAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	a.once.Do(func() { close(a.executed) })
	return nil, nil
}

func (blockingGoalReconcileReporter) Report(ctx context.Context, _ agentsessionstore.ReportActivityInput) error {
	<-ctx.Done()
	return ctx.Err()
}

func (r *goalPrepareBarrierReporter) Report(ctx context.Context, report agentsessionstore.ReportActivityInput) error {
	for _, request := range report.GoalReconcileRequests {
		r.mu.Lock()
		r.phases = append(r.phases, request.Phase)
		r.mu.Unlock()
		if request.Phase == "quiesce_pending" {
			r.once.Do(func() { close(r.prepared) })
			select {
			case <-r.release:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	return nil
}

func (r *goalPrepareBarrierReporter) phaseSnapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.phases...)
}

func TestGoalRecoveryCapabilitiesComeFromAdapterPolicy(t *testing.T) {
	codex := (&CodexAppServerAdapter{}).GoalCapabilities()
	if !codex.QuerySupported || !codex.ReplaySetAfterRestart {
		t.Fatalf("codex capabilities=%#v", codex)
	}
	claude := (&ClaudeCodeSDKAdapter{}).GoalCapabilities()
	if claude.QuerySupported || claude.ReplaySetAfterRestart {
		t.Fatalf("claude capabilities=%#v", claude)
	}

	// A provider name is not a capability. Even an adapter registered under
	// the codex string is rejected if it does not implement GoalAdapter.
	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{RoomID: "room-policy", Provider: ProviderCodex})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := controller.GoalCapabilities(context.Background(), GoalReconcileInput{RoomID: "room-policy", AgentSessionID: started.Session.AgentSessionID}); err == nil {
		t.Fatal("provider-name-only adapter unexpectedly acquired goal recovery capabilities")
	}
}

func stringPtr(value string) *string {
	return &value
}

func boolPtr(value bool) *bool {
	return &value
}

func (r *recordingReporter) Report(_ context.Context, report agentsessionstore.ReportActivityInput) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, reportCall{report: report})
	if r.updates != nil {
		select {
		case r.updates <- struct{}{}:
		default:
		}
	}
	return nil
}

func (r *recordingReporter) snapshot() []reportCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]reportCall(nil), r.calls...)
}

func (r *recordingReporter) waitForCalls(t *testing.T, count int) []reportCall {
	t.Helper()
	return r.waitForReports(t, fmt.Sprintf("at least %d report calls", count), func(calls []reportCall) bool {
		return len(calls) >= count
	})
}

func (r *recordingReporter) waitForReports(
	t *testing.T,
	description string,
	matches func([]reportCall) bool,
) []reportCall {
	t.Helper()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for {
		r.mu.Lock()
		calls := append([]reportCall(nil), r.calls...)
		if matches(calls) {
			r.mu.Unlock()
			return calls
		}
		if r.updates == nil {
			r.updates = make(chan struct{}, 1)
		}
		updates := r.updates
		r.mu.Unlock()
		select {
		case <-updates:
		case <-timer.C:
			t.Fatalf("timed out waiting for %s; report calls = %d", description, len(calls))
		}
	}
}

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

func TestControllerExecWaitsForSubmittedTurnDurableReportBeforeProviderStart(t *testing.T) {
	t.Parallel()
	reporter := &submittedTurnBarrierReporter{entered: make(chan struct{}), release: make(chan struct{})}
	adapter := &executionSignalAdapter{
		recordingStartAdapter: recordingStartAdapter{provider: ProviderCodex},
		executed:              make(chan struct{}),
	}
	controller := NewController([]Adapter{adapter}, reporter)
	_, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-1", AgentSessionID: "agent-session-1", Provider: ProviderCodex, Provisional: true,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	execDone := make(chan error, 1)
	go func() {
		_, execErr := controller.Exec(context.Background(), ExecInput{
			RoomID: "room-1", AgentSessionID: "agent-session-1", Content: textPrompt("hello"),
		})
		execDone <- execErr
	}()
	select {
	case <-reporter.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for submitted-turn report")
	}
	select {
	case <-adapter.executed:
		t.Fatal("provider started before submitted Turn became durable")
	case err := <-execDone:
		t.Fatalf("Exec returned before submitted Turn became durable: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(reporter.release)
	select {
	case err := <-execDone:
		if err != nil {
			t.Fatalf("Exec() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Exec did not return after durable report")
	}
	select {
	case <-adapter.executed:
	case <-time.After(2 * time.Second):
		t.Fatal("provider did not start after durable report")
	}
}

func TestControllerExecRollsBackWhenSubmittedTurnDurableReportFails(t *testing.T) {
	t.Parallel()
	reporter := &submittedTurnBarrierReporter{
		entered: make(chan struct{}), release: make(chan struct{}), err: errors.New("sqlite unavailable"),
	}
	close(reporter.release)
	adapter := &executionSignalAdapter{
		recordingStartAdapter: recordingStartAdapter{provider: ProviderCodex},
		executed:              make(chan struct{}),
	}
	controller := NewController([]Adapter{adapter}, reporter)
	_, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-1", AgentSessionID: "agent-session-1", Provider: ProviderCodex, Provisional: true,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID: "room-1", AgentSessionID: "agent-session-1", Content: textPrompt("hello"),
	}); err == nil || !strings.Contains(err.Error(), "persist submitted agent turn") {
		t.Fatalf("Exec() error = %v, want durable report failure", err)
	}
	select {
	case <-adapter.executed:
		t.Fatal("provider started after submitted Turn report failed")
	default:
	}
	if controller.HasActiveTurn("room-1", "agent-session-1") {
		t.Fatal("active Turn survived submitted report rollback")
	}
	stored, ok := controller.Session("room-1", "agent-session-1")
	if !ok || stored.Status != SessionStatusReady || stored.TurnLifecycle != nil {
		t.Fatalf("rolled-back session = %#v, ok=%v", stored, ok)
	}
	controller.mu.Lock()
	provisional := controller.provisionalSessions[sessionKey("room-1", "agent-session-1")]
	controller.mu.Unlock()
	if !provisional {
		t.Fatal("failed first Turn committed provisional session")
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

func TestControllerSetTitleUpdatesLiveSession(t *testing.T) {
	t.Parallel()

	controller := NewController(nil, nil)
	controller.store(Session{
		RoomID:          "room-1",
		AgentSessionID:  "agent-session-1",
		Provider:        ProviderCodex,
		CWD:             "/workspace",
		Status:          SessionStatusReady,
		Title:           "Old title",
		UpdatedAtUnixMS: 10,
	})

	session, err := controller.SetTitle(context.Background(), "room-1", "agent-session-1", "  New title  ")
	if err != nil {
		t.Fatalf("SetTitle: %v", err)
	}
	if session.Title != "New title" {
		t.Fatalf("returned title = %q, want trimmed title", session.Title)
	}
	if session.UpdatedAtUnixMS <= 10 {
		t.Fatalf("returned updatedAt = %d, want later than previous timestamp", session.UpdatedAtUnixMS)
	}
	stored, ok := controller.get("room-1", "agent-session-1")
	if !ok {
		t.Fatal("session missing after SetTitle")
	}
	if stored.Title != "New title" {
		t.Fatalf("stored title = %q, want new title", stored.Title)
	}
	if _, err := controller.SetTitle(context.Background(), "room-1", "missing-session", "Title"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("missing session error = %v, want ErrSessionNotFound", err)
	}
}

func TestControllerExecInitialTitleCompareAndSetPreservesRename(t *testing.T) {
	t.Parallel()

	controller := NewController([]Adapter{&recordingStartAdapter{provider: ProviderCodex}}, nil)
	_, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.SetTitle(context.Background(), "room-1", "agent-session-1", "Manual title"); err != nil {
		t.Fatalf("SetTitle: %v", err)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-1",
		Content:          textPrompt("hello"),
		InitialTitle:     "hello",
		InitialTitleBase: "",
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	session, ok := controller.get("room-1", "agent-session-1")
	if !ok {
		t.Fatal("session missing after Exec")
	}
	if session.Title != "Manual title" {
		t.Fatalf("session title = %q, want concurrent rename preserved", session.Title)
	}
}

func TestControllerInitialTitleStateSurvivesResume(t *testing.T) {
	t.Parallel()

	adapter := &recordingStartAdapter{provider: ProviderCodex}
	reporter := &recordingReporter{}
	controller := NewController([]Adapter{adapter}, reporter)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Session.InitialTitleEstablished {
		t.Fatal("new empty session title unexpectedly established")
	}
	if established := started.Session.RuntimeContext[initialTitleEstablishedRuntimeContextKey]; established != false {
		t.Fatalf("runtime title marker = %#v, want false", established)
	}
	reporter.waitForCalls(t, 1)
	if _, err := controller.SetTitle(context.Background(), "room-1", "agent-session-1", ""); err != nil {
		t.Fatalf("SetTitle: %v", err)
	}
	persisted, ok := controller.get("room-1", "agent-session-1")
	if !ok {
		t.Fatal("session missing after SetTitle")
	}
	if persisted.RuntimeContext[initialTitleEstablishedRuntimeContextKey] != true {
		t.Fatalf("runtime title marker = %#v, want true", persisted.RuntimeContext)
	}
	reports := reporter.waitForCalls(t, 2)
	lastReport := reports[len(reports)-1].report
	if len(lastReport.StatePatches) != 1 ||
		lastReport.StatePatches[0].RuntimeContext[initialTitleEstablishedRuntimeContextKey] != true {
		t.Fatalf("persisted title marker report = %#v, want true", lastReport.StatePatches)
	}

	resumedController := NewController([]Adapter{adapter}, nil)
	resumed, err := resumedController.Resume(context.Background(), ResumeInput{
		RoomID:            "room-1",
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "provider-session-1",
		CWD:               "/workspace",
		RuntimeContext:    persisted.RuntimeContext,
	})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if !resumed.InitialTitleEstablished {
		t.Fatal("resumed empty title lost established state")
	}
	if _, err := resumedController.Exec(context.Background(), ExecInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-1",
		Content:          textPrompt("later prompt"),
		InitialTitle:     "later prompt",
		InitialTitleBase: "",
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	current, _ := resumedController.get("room-1", "agent-session-1")
	if current.Title != "" {
		t.Fatalf("resumed session title = %q, want explicit empty title preserved", current.Title)
	}
}

func TestInitialTitleEstablishedStateFailsClosedWithoutMarker(t *testing.T) {
	t.Parallel()

	if !initialTitleEstablishedFromRuntimeContext(nil, "") {
		t.Fatal("legacy empty session without marker must fail closed")
	}
	if initialTitleEstablishedFromRuntimeContext(
		map[string]any{initialTitleEstablishedRuntimeContextKey: false},
		"",
	) {
		t.Fatal("new empty session with false marker must remain eligible")
	}

	controller := NewController(
		[]Adapter{&recordingStartAdapter{provider: ProviderCodex}},
		nil,
	)
	resumed, err := controller.Resume(context.Background(), ResumeInput{
		RoomID:            "room-1",
		AgentSessionID:    "legacy-session",
		Provider:          ProviderCodex,
		ProviderSessionID: "provider-session-1",
	})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if resumed.RuntimeContext[initialTitleEstablishedRuntimeContextKey] != true {
		t.Fatalf("legacy resume marker = %#v, want true", resumed.RuntimeContext)
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
}

func TestControllerExecResumesExistingSessionWhenAdapterLiveSessionMissing(t *testing.T) {
	t.Parallel()

	adapter := newReconnectableAdapter()
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		CWD:            "/workspace",
		Title:          "Claude Code",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Session.ProviderSessionID != "provider-session-1" {
		t.Fatalf("provider session id = %q, want provider-session-1", started.Session.ProviderSessionID)
	}

	adapter.dropLiveSession("agent-session-1")
	result, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Content:        textPrompt("hello"),
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

func TestControllerHiddenSessionPublishesLiveEventsAndReportsActivity(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	controller := NewDefaultControllerWithProcessTransport(reporter, newScriptedACPTransport())
	ctx := context.Background()

	started, err := controller.Start(ctx, StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
		Visible:  boolPtr(false),
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Session.Visible {
		t.Fatalf("session visible = true, want false")
	}
	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()
	select {
	case event := <-events:
		if event.EventType != StreamEventStatePatch {
			t.Fatalf("initial stream event = %#v, want state patch", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected hidden session to publish initial live state")
	}
	reports := reporter.waitForCalls(t, 1)
	if len(reports[0].report.StatePatches) != 1 {
		t.Fatalf("initial report state patches = %#v, want one state patch", reports[0].report.StatePatches)
	}
	if reports[0].report.StatePatches[0].RuntimeContext["visible"] != false {
		t.Fatalf("initial report runtime context = %#v, want visible=false", reports[0].report.StatePatches[0].RuntimeContext)
	}

	execResult, err := controller.Exec(ctx, ExecInput{
		RoomID:           "room-1",
		AgentSessionID:   started.Session.AgentSessionID,
		Content:          textPrompt("hello"),
		InitialTitle:     "hello",
		InitialTitleBase: started.Session.Title,
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !execResult.Accepted {
		t.Fatalf("Exec result = %#v, want accepted", execResult)
	}
	waitForStatePatchTitle(t, events, "hello")
	reports = reporter.waitForCalls(t, 2)
	lastReport := reports[len(reports)-1].report
	if len(lastReport.MessageUpdates) == 0 && len(lastReport.StatePatches) == 0 {
		t.Fatalf("exec report = %#v, want message or state updates", lastReport)
	}
}

func TestControllerStartExecPublishesAndReports(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	controller := NewDefaultControllerWithProcessTransport(reporter, newScriptedACPTransport())
	ctx := context.Background()

	started, err := controller.Start(ctx, StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Session.AgentSessionID == "" {
		t.Fatal("Start returned an empty agent session id")
	}
	if started.Session.ProviderSessionID != "codex-thread-1" {
		t.Fatalf("provider session id = %q, want app-server thread id", started.Session.ProviderSessionID)
	}

	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()

	execResult, err := controller.Exec(ctx, ExecInput{
		RoomID:           "room-1",
		AgentSessionID:   started.Session.AgentSessionID,
		Content:          textPrompt("hello"),
		InitialTitle:     "hello",
		InitialTitleBase: started.Session.Title,
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !execResult.Accepted || execResult.TurnID == "" {
		t.Fatalf("Exec result = %#v, want accepted result with turn id", execResult)
	}
	if execResult.SessionStatus != SessionStatusWorking {
		t.Fatalf("exec session status = %q, want %q", execResult.SessionStatus, SessionStatusWorking)
	}
	waitForStatePatchTitle(t, events, "hello")
	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			if event.EventType != StreamEventMessageUpdate {
				continue
			}
			update, ok := event.Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
			if !ok || update.Kind != "text" || update.Role != "user" || update.Payload["text"] != "hello" {
				t.Fatalf("published message event = %#v, want user message", event)
			}
			goto userMessagePublished
		case <-deadline:
			t.Fatal("expected user message event to be published")
		}
	}

userMessagePublished:
	waitForCondition(t, func() bool {
		updatedSession, ok := controller.get("room-1", started.Session.AgentSessionID)
		return ok && updatedSession.Title == "Inspect repository structure"
	})
	reportCalls := reporter.waitForReports(t, "assistant and completed tool reports", func(calls []reportCall) bool {
		reports := reportInputs(calls)
		return len(reportsWithTimelineItem(reports, "message.assistant")) > 0 &&
			len(reportsWithTimelineItem(reports, "call.completed")) > 0
	})
	controller.ReconcileRootTurnSettlement(RootTurnSettlement{
		RoomID: "room-1", AgentSessionID: started.Session.AgentSessionID,
		TurnID: execResult.TurnID, Outcome: "completed",
	})
	waitForCondition(t, func() bool {
		updatedSession, ok := controller.get("room-1", started.Session.AgentSessionID)
		return ok &&
			updatedSession.Status == SessionStatusReady &&
			updatedSession.Title == "Inspect repository structure"
	})
	var hasSessionStartedPatch bool
	for _, call := range reportCalls {
		for _, patch := range call.report.StatePatches {
			if patch.LifecycleStatus == string(activityshared.SessionLifecycleStatusActive) {
				hasSessionStartedPatch = true
			}
		}
	}
	if !hasSessionStartedPatch {
		t.Fatalf("report calls = %#v, want session started state patch", reportCalls)
	}
	turnReport, ok := reportWithTimelineItem(reportInputs(reportCalls), "message.user")
	if !ok || !hasTimelineItem(turnReport, "message.user", "completed", "hello") {
		t.Fatalf("report calls = %#v, want user message report", reportCalls)
	}
	assistantReports := reportsWithTimelineItem(reportInputs(reportCalls), "message.assistant")
	if len(assistantReports) == 0 {
		t.Fatal("assistant reports = 0, want assistant message updates")
	}
	if !hasTimelineItem(assistantReports[len(assistantReports)-1], "message.assistant", "completed", "") {
		t.Fatalf("assistant reports = %#v, want completed assistant update", assistantReports)
	}
	toolReport, ok := reportWithTimelineItem(reportInputs(reportCalls), "call.started")
	if !ok || !hasTimelineItem(toolReport, "call.started", "running", "") {
		t.Fatalf("report calls = %#v, want started tool report", reportCalls)
	}
}

func TestControllerReportsMessageUpdateOnlyRuntimeBatch(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	controller := NewController([]Adapter{streamingMessageOnlyAdapter{}}, reporter)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("stream"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !execResult.Accepted {
		t.Fatalf("Exec result = %#v, want accepted", execResult)
	}

	reports := reporter.waitForCalls(t, 2)
	var report agentsessionstore.ReportActivityInput
	for _, call := range reports {
		if len(call.report.MessageUpdates) == 1 &&
			len(call.report.TimelineItems) == 0 &&
			len(call.report.StatePatches) == 0 {
			report = call.report
			break
		}
	}
	if len(report.TimelineItems) != 0 || len(report.StatePatches) != 0 {
		t.Fatalf("report = %#v, want message-update-only report", report)
	}
	if len(report.MessageUpdates) != 1 {
		t.Fatalf("message updates = %#v, want one", report.MessageUpdates)
	}
	update := report.MessageUpdates[0]
	if update.MessageID != "assistant-stream-1" ||
		update.Role != "assistant" ||
		update.Kind != "text" ||
		update.Status != messageStreamStateStreaming ||
		update.Payload["content"] != "partial" ||
		update.Payload["source"] != "runtime" {
		t.Fatalf("message update = %#v", update)
	}
}

func TestControllerExecRunsOutsideRequestContext(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.promptPermission = true
	reporter := &recordingReporter{}
	controller := NewDefaultControllerWithProcessTransport(reporter, transport)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
		Title:    "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()

	requestCtx, cancelRequest := context.WithCancel(context.Background())
	execResult, err := controller.Exec(requestCtx, ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run tests"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	cancelRequest()
	if !execResult.Accepted || execResult.SessionStatus != SessionStatusWorking {
		t.Fatalf("Exec result = %#v, want accepted working turn", execResult)
	}
	waitForPublishedSessionEvent(t, events, EventCallStarted, "approval", "waiting_approval")
	waitForCondition(t, func() bool {
		for _, call := range reporter.snapshot() {
			if hasTimelineItemWithCallType(call.report, "call.started", "approval", "waiting_approval") {
				return true
			}
		}
		return false
	})

	if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: started.Session.AgentSessionID,
		AgentSessionID:     started.Session.AgentSessionID,
		TurnID:             execResult.TurnID,
		RequestID:          "permission-1",
		OptionID:           "allow_once",
	}); err != nil {
		t.Fatalf("SubmitInteractive after request context cancel: %v", err)
	}
	waitForCondition(t, func() bool {
		return transport.conn.permissionOptionID() == "allow_once"
	})
}

func TestControllerExecTurnContextHasNoDeadline(t *testing.T) {
	t.Parallel()

	adapter := newBlockingExecAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
		Title:    "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	_, err = controller.Exec(context.Background(), ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("wait for approval"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	adapter.waitForPrompt(t, "wait for approval")
	select {
	case ctx := <-adapter.contexts:
		if deadline, ok := ctx.Deadline(); ok {
			t.Fatalf("exec turn context deadline = %s, want none", deadline)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for exec context")
	}
	adapter.releaseNext()
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
}

func TestControllerExecPassesOnlyExplicitDisplayPrompt(t *testing.T) {
	t.Parallel()

	adapter := newBlockingExecAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
		Title:    "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("ordinary prompt"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	adapter.waitForPrompt(t, "ordinary prompt")
	if displays := adapter.displayPrompts(); len(displays) != 1 || displays[0] != "" {
		t.Fatalf("display prompts = %#v, want one empty explicit prompt", displays)
	}
	adapter.releaseNext()
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
}

func TestControllerExecRejectsPromptDuringActiveTurn(t *testing.T) {
	t.Parallel()

	adapter := newBlockingExecAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	ctx := context.Background()

	started, err := controller.Start(ctx, StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	first, err := controller.Exec(ctx, ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("first prompt"),
	})
	if err != nil {
		t.Fatalf("first Exec: %v", err)
	}
	if first.Status != ExecStatusStarted || first.TurnID == "" {
		t.Fatalf("first Exec result = %#v, want started turn", first)
	}
	adapter.waitForPrompt(t, "first prompt")

	if _, err := controller.Exec(ctx, ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("second prompt"),
	}); !errors.Is(err, ErrSessionActiveTurn) {
		t.Fatalf("second Exec error = %v, want %v", err, ErrSessionActiveTurn)
	}
	if prompts := adapter.prompts(); len(prompts) != 1 || prompts[0] != "first prompt" {
		t.Fatalf("adapter prompts after rejected Exec = %#v, want only first prompt running", prompts)
	}

	adapter.releaseNext()
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
}

func TestControllerExecGuidanceDuringActiveTurn(t *testing.T) {
	t.Parallel()

	adapter := &guidanceBlockingAdapter{blockingExecAdapter: newBlockingExecAdapter()}
	reporter := &recordingReporter{}
	controller := NewController([]Adapter{adapter}, reporter)
	ctx := context.Background()

	started, err := controller.Start(ctx, StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	first, err := controller.Exec(ctx, ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("first prompt"),
	})
	if err != nil {
		t.Fatalf("first Exec: %v", err)
	}
	adapter.waitForPrompt(t, "first prompt")

	result, err := controller.Exec(ctx, ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("guide current turn"),
		Guidance:       true,
		Metadata: map[string]any{
			"clientSubmitId": "guidance-submit-1",
		},
	})
	if err != nil {
		t.Fatalf("guidance Exec: %v", err)
	}
	if !result.Accepted || result.TurnID != first.TurnID {
		t.Fatalf("guidance result = %#v, want active turn id %q", result, first.TurnID)
	}
	if got := adapter.guidanceCalls.Load(); got != 1 {
		t.Fatalf("guidance calls = %d, want 1", got)
	}
	if prompts := adapter.prompts(); len(prompts) != 1 || prompts[0] != "first prompt" {
		t.Fatalf("adapter prompts after guidance = %#v, want only first prompt running", prompts)
	}
	reports := reporter.waitForReports(t, "guidance user message report", func(calls []reportCall) bool {
		for _, call := range calls {
			for _, update := range call.report.MessageUpdates {
				if update.Payload["clientSubmitId"] == "guidance-submit-1" {
					return true
				}
			}
		}
		return false
	})
	var guidanceUpdate *agentsessionstore.WorkspaceAgentMessageUpdate
	for _, report := range reportInputs(reports) {
		for index := range report.MessageUpdates {
			update := &report.MessageUpdates[index]
			if update.Payload["clientSubmitId"] == "guidance-submit-1" {
				guidanceUpdate = update
				break
			}
		}
		if guidanceUpdate != nil {
			break
		}
	}
	if guidanceUpdate == nil || guidanceUpdate.TurnID != first.TurnID {
		t.Fatalf("guidance message update = %#v, want active turn id %q", guidanceUpdate, first.TurnID)
	}

	adapter.releaseNext()
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
}

func TestControllerExecGuidanceRequiresActiveTurn(t *testing.T) {
	t.Parallel()

	adapter := &guidanceBlockingAdapter{blockingExecAdapter: newBlockingExecAdapter()}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("guide without active turn"),
		Guidance:       true,
	}); !errors.Is(err, ErrSessionNoActiveTurn) {
		t.Fatalf("guidance without active turn error = %v, want %v", err, ErrSessionNoActiveTurn)
	}
}

func TestControllerExecGuidanceRequiresProviderSupport(t *testing.T) {
	t.Parallel()

	adapter := newBlockingExecAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	ctx := context.Background()
	started, err := controller.Start(ctx, StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.Exec(ctx, ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("first prompt"),
	}); err != nil {
		t.Fatalf("first Exec: %v", err)
	}
	adapter.waitForPrompt(t, "first prompt")
	if _, err := controller.Exec(ctx, ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("guide unsupported provider"),
		Guidance:       true,
	}); !errors.Is(err, ErrActiveTurnGuidanceUnsupported) {
		t.Fatalf("unsupported guidance error = %v, want %v", err, ErrActiveTurnGuidanceUnsupported)
	}
	adapter.releaseNext()
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
}

func TestControllerCancelCancelsActiveTurnContextWhenAdapterReturnsNoEvents(t *testing.T) {
	t.Parallel()

	adapter := newBlockingExecAdapter()
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("long prompt"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	adapter.waitForPrompt(t, "long prompt")

	cancelResult, err := controller.Cancel(context.Background(), rootCancelInput(started.Session.RoomID, started.Session.AgentSessionID, execResult.TurnID, "user_interrupt"))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if !cancelResult.Canceled {
		t.Fatalf("Cancel result = %#v, want canceled active turn", cancelResult)
	}
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusCanceled)
}

func TestControllerCancelInvokesProviderBeforeCancelingActiveTurnContext(t *testing.T) {
	t.Parallel()

	adapter := newCancelOrderingAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("long prompt"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	select {
	case <-adapter.execStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("Exec did not start")
	}

	result, err := controller.Cancel(context.Background(), rootCancelInput(
		started.Session.RoomID,
		started.Session.AgentSessionID,
		execResult.TurnID,
		"user_interrupt",
	))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if !result.Canceled {
		t.Fatalf("Cancel result = %#v, want canceled", result)
	}
	select {
	case observed := <-adapter.providerCancelObservedContextError:
		if observed != nil {
			t.Fatalf("provider Cancel observed Exec context error = %v, want live context", observed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("provider Cancel was not invoked")
	}
	select {
	case <-adapter.execDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Exec context was not canceled after provider Cancel returned")
	}
}

func TestControllerStateRoundTripsSessionSettingsAndPermissionUpdate(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
		Settings: &SessionSettings{
			Model:            "gpt-5.2-codex",
			ReasoningEffort:  "high",
			PlanMode:         false,
			PermissionModeID: "full-access",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Session.Settings == nil {
		t.Fatal("session settings = nil, want round-tripped settings")
	}
	if started.Session.PermissionModeID != "full-access" {
		t.Fatalf("session permission mode = %q, want %q", started.Session.PermissionModeID, "full-access")
	}
	if started.Session.Settings.Model != "gpt-5.2-codex" ||
		started.Session.Settings.ReasoningEffort != "high" ||
		started.Session.Settings.PlanMode ||
		started.Session.Settings.PermissionModeID != "full-access" {
		t.Fatalf("session settings = %#v", started.Session.Settings)
	}

	state, err := controller.State("room-1", "agent-session-1")
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.Settings == nil {
		t.Fatal("state settings = nil, want round-tripped settings")
	}
	if state.Settings.Model != "gpt-5.2-codex" ||
		state.Settings.ReasoningEffort != "high" ||
		state.Settings.PlanMode ||
		state.Settings.PermissionModeID != "full-access" {
		t.Fatalf("state settings = %#v", state.Settings)
	}

	updated, err := controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Settings: SessionSettingsPatch{
			PermissionModeID: stringPtr("auto"),
		},
	})
	if err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}
	if updated.Settings.PermissionModeID != "auto" {
		t.Fatalf("updated settings permission mode = %q, want %q", updated.Settings.PermissionModeID, "auto")
	}
	if updated.Settings.Model != "gpt-5.2-codex" ||
		updated.Settings.ReasoningEffort != "high" ||
		updated.Settings.PlanMode {
		t.Fatalf("updated settings = %#v, want launch facts preserved", updated.Settings)
	}

	session, ok := controller.Session("room-1", "agent-session-1")
	if !ok {
		t.Fatal("Session returned ok=false after update")
	}
	if session.PermissionModeID != "auto" {
		t.Fatalf("session permission mode after update = %q, want %q", session.PermissionModeID, "auto")
	}
	if session.Settings == nil || session.Settings.PermissionModeID != "auto" {
		t.Fatalf("session settings after update = %#v", session.Settings)
	}
	if session.Settings.Model != "gpt-5.2-codex" ||
		session.Settings.ReasoningEffort != "high" ||
		session.Settings.PlanMode {
		t.Fatalf("session settings after update = %#v, want launch facts preserved", session.Settings)
	}

	state, err = controller.State("room-1", "agent-session-1")
	if err != nil {
		t.Fatalf("State after update: %v", err)
	}
	if state.PermissionModeID != "auto" {
		t.Fatalf("state permission mode after update = %q, want %q", state.PermissionModeID, "auto")
	}
	if state.Settings == nil || state.Settings.PermissionModeID != "auto" {
		t.Fatalf("state settings after update = %#v", state.Settings)
	}
	if state.Settings.Model != "gpt-5.2-codex" ||
		state.Settings.ReasoningEffort != "high" ||
		state.Settings.PlanMode {
		t.Fatalf("state settings after update = %#v, want launch facts preserved", state.Settings)
	}
}

func TestControllerRoutesChildInteractionThroughRootLiveSession(t *testing.T) {
	t.Parallel()
	adapter := &statefulInteractiveAdapter{}
	adapter.submitHook = func(session Session) {
		if session.AgentSessionID != "root-session" {
			t.Fatalf("adapter session = %q, want root live session", session.AgentSessionID)
		}
	}
	controller := NewController([]Adapter{adapter}, nil)
	if _, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-1", AgentSessionID: "root-session", Provider: ProviderCodex, Title: "Codex",
	}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: "root-session",
		AgentSessionID:     "child-session",
		TurnID:             "child-turn",
		RequestID:          "child-request",
		OptionID:           "allow",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if adapter.interactiveInput.AgentSessionID != "child-session" ||
		adapter.interactiveInput.TurnID != "child-turn" ||
		adapter.interactiveInput.RequestID != "child-request" {
		t.Fatalf("adapter target = %#v", adapter.interactiveInput)
	}
}

func TestControllerUpdateSettingsMergesModelPatchWithoutRequiringPermissionMode(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
		Settings: &SessionSettings{
			Model:            "gpt-5.2-codex",
			ReasoningEffort:  "high",
			Speed:            "standard",
			PlanMode:         true,
			PermissionModeID: "full-access",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Session.Settings == nil {
		t.Fatal("session settings = nil, want round-tripped settings")
	}

	updated, err := controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Settings: SessionSettingsPatch{
			Model: stringPtr("gpt-5.4"),
			Speed: stringPtr("fast"),
		},
	})
	if err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}
	if updated.Settings.PermissionModeID != "full-access" {
		t.Fatalf("updated settings permission mode = %q, want %q", updated.Settings.PermissionModeID, "full-access")
	}
	if updated.Settings.Model != "gpt-5.4" {
		t.Fatalf("updated settings model = %q, want %q", updated.Settings.Model, "gpt-5.4")
	}
	if updated.Settings.Speed != "fast" {
		t.Fatalf("updated settings speed = %q, want fast", updated.Settings.Speed)
	}
	if updated.Settings.ReasoningEffort != "high" || !updated.Settings.PlanMode {
		t.Fatalf("updated settings = %#v, want non-updated fields preserved", updated.Settings)
	}
}

func TestControllerUpdateSettingsAppliesLiveAdapterSettingsPatch(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		snapshot: SessionStateSnapshot{
			Settings: &SessionSettings{
				Model:            "gpt-5.2-codex",
				ReasoningEffort:  "high",
				PlanMode:         false,
				PermissionModeID: "full-access",
			},
		},
	}
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
		Settings: &SessionSettings{
			Model:            "gpt-5.2-codex",
			ReasoningEffort:  "high",
			PlanMode:         false,
			PermissionModeID: "full-access",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	if _, err := controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Settings: SessionSettingsPatch{
			Model: stringPtr("gpt-5.4"),
		},
	}); err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}

	if len(adapter.appliedSettings) != 1 {
		t.Fatalf("applied settings = %#v, want one live patch", adapter.appliedSettings)
	}
	if adapter.appliedSettings[0].Model == nil || *adapter.appliedSettings[0].Model != "gpt-5.4" {
		t.Fatalf("applied settings model = %#v, want gpt-5.4", adapter.appliedSettings[0].Model)
	}

	state, err := controller.State("room-1", started.Session.AgentSessionID)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.Settings == nil || state.Settings.Model != "gpt-5.4" {
		t.Fatalf("state settings = %#v, want live model override updated", state.Settings)
	}
}

func TestControllerUpdateSettingsRejectsSettingsThatRequireNewSession(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{requiresNewSession: true}
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
		Settings: &SessionSettings{
			Model:            "gpt-5.2-codex",
			ReasoningEffort:  "high",
			PermissionModeID: "full-access",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	_, err = controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Settings: SessionSettingsPatch{
			Model: stringPtr("gpt-5.3-codex-spark"),
		},
	})
	if !errors.Is(err, ErrSessionSettingsRequireNewSession) {
		t.Fatalf("UpdateSettings error = %v, want ErrSessionSettingsRequireNewSession", err)
	}
	if len(adapter.appliedSettings) != 0 {
		t.Fatalf("applied live settings = %#v, want none for new-session-only setting", adapter.appliedSettings)
	}
	session, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false after rejected update")
	}
	if session.Settings == nil || session.Settings.Model != "gpt-5.2-codex" {
		t.Fatalf("session settings after rejected update = %#v, want original model preserved", session.Settings)
	}
}

func TestControllerUpdateSettingsDoesNotPersistFailedLivePatch(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		applySettingsErr: errors.New("live settings unavailable"),
	}
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
		Settings: &SessionSettings{
			Model:            "gpt-5.2-codex",
			ReasoningEffort:  "high",
			PermissionModeID: "full-access",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	_, err = controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Settings: SessionSettingsPatch{
			Model: stringPtr("gpt-5.4"),
		},
	})
	if err == nil {
		t.Fatal("UpdateSettings: expected live settings failure")
	}

	session, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false after failed update")
	}
	if session.Settings == nil {
		t.Fatal("session settings = nil after failed update")
	}
	if session.Settings.Model != "gpt-5.2-codex" {
		t.Fatalf("session settings model = %q, want original value after failed update", session.Settings.Model)
	}

	state, err := controller.State("room-1", started.Session.AgentSessionID)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.Settings == nil {
		t.Fatal("state settings = nil after failed update")
	}
	if state.Settings.Model != "gpt-5.2-codex" {
		t.Fatalf("state settings model = %q, want original value after failed update", state.Settings.Model)
	}
}

func TestControllerUpdateSettingsDoesNotAdvanceSessionUpdatedAt(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
		Settings: &SessionSettings{
			Model:            "gpt-5.2-codex",
			ReasoningEffort:  "high",
			PermissionModeID: "full-access",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	controller.mu.Lock()
	session := controller.sessions[sessionKey("room-1", started.Session.AgentSessionID)]
	session.UpdatedAtUnixMS = 123
	controller.sessions[sessionKey("room-1", started.Session.AgentSessionID)] = session
	controller.mu.Unlock()

	if _, err := controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Settings: SessionSettingsPatch{
			Model: stringPtr("gpt-5.4"),
		},
	}); err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}

	updated, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false after update")
	}
	if updated.UpdatedAtUnixMS != 123 {
		t.Fatalf("UpdatedAtUnixMS = %d, want preserved value 123", updated.UpdatedAtUnixMS)
	}

	state, err := controller.State("room-1", started.Session.AgentSessionID)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.UpdatedAtUnixMS != 123 {
		t.Fatalf("state UpdatedAtUnixMS = %d, want preserved value 123", state.UpdatedAtUnixMS)
	}
}

func TestControllerStateAppliesAdapterSettingsOverride(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		snapshot: SessionStateSnapshot{
			PermissionModeID: "full-access",
			Settings: &SessionSettings{
				Model:            "opus",
				ReasoningEffort:  "low",
				PlanMode:         true,
				PermissionModeID: "full-access",
			},
		},
	}
	controller := NewController([]Adapter{adapter}, nil)

	_, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
		Settings: &SessionSettings{
			Model:            "gpt-5.2-codex",
			ReasoningEffort:  "high",
			PermissionModeID: "read-only",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	state, err := controller.State("room-1", "agent-session-1")
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.PermissionModeID != "full-access" {
		t.Fatalf("state permission mode = %q, want %q", state.PermissionModeID, "full-access")
	}
	if state.Settings == nil {
		t.Fatal("state settings = nil, want adapter override")
	}
	if state.Settings.Model != "opus" || state.Settings.ReasoningEffort != "low" || !state.Settings.PlanMode {
		t.Fatalf("state settings = %#v, want adapter override", state.Settings)
	}
	if state.Settings.PermissionModeID != "full-access" {
		t.Fatalf("state settings permission mode = %q, want %q", state.Settings.PermissionModeID, "full-access")
	}
	if got := asString(state.RuntimeContext["model"]); got != "opus" {
		t.Fatalf("runtime context model = %q, want opus", got)
	}
	if got := asString(state.RuntimeContext["reasoningEffort"]); got != "low" {
		t.Fatalf("runtime context reasoningEffort = %q, want low", got)
	}
	if got, _ := state.RuntimeContext["planMode"].(bool); !got {
		t.Fatalf("runtime context planMode = %#v, want true", state.RuntimeContext["planMode"])
	}
}

func TestControllerResumeReattachesExistingProviderSession(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	reporter := &recordingReporter{}
	controller := NewDefaultControllerWithProcessTransport(reporter, transport)

	session, err := controller.Resume(context.Background(), ResumeInput{
		RoomID:            "room-1",
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "codex-acp-session-restored",
		CWD:               "/workspace",
		Env:               []string{"CODEX_HOME=/prepared/codex-home"},
		Title:             "Restored",
		Status:            SessionStatusReady,
		CreatedAtUnixMS:   100,
		UpdatedAtUnixMS:   200,
	})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if session.AgentSessionID != "agent-session-1" || session.ProviderSessionID != "codex-acp-session-restored" {
		t.Fatalf("session = %#v, want restored ids", session)
	}
	if session.UpdatedAtUnixMS != 200 {
		t.Fatalf("UpdatedAtUnixMS = %d, want preserved value 200", session.UpdatedAtUnixMS)
	}
	if len(session.Env) != 1 || session.Env[0] != "CODEX_HOME=/prepared/codex-home" {
		t.Fatalf("session env = %#v, want resume env", session.Env)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	if !containsString(transport.specs[0].Env, "CODEX_HOME=/prepared/codex-home") {
		t.Fatalf("process env = %#v, want resume env", transport.specs[0].Env)
	}
	if calls := reporter.snapshot(); len(calls) != 0 {
		t.Fatalf("resume report calls = %#v, want none for attach-only resume", calls)
	}
	_, unsubscribe, ok := controller.Subscribe("room-1", "agent-session-1")
	if !ok {
		t.Fatal("Subscribe after Resume returned ok=false")
	}
	defer unsubscribe()

	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Content:        textPrompt("continue"),
	})
	if err != nil {
		t.Fatalf("Exec after Resume: %v", err)
	}
	if !execResult.Accepted {
		t.Fatalf("Exec result = %#v, want accepted", execResult)
	}
}

func TestControllerResumeRecreatesMissingProviderSessionWhenOptedIn(t *testing.T) {
	t.Parallel()

	restoreErr := &AppError{Code: AppErrorProviderSessionNotFound, Message: "gone"}

	t.Run("without opt-in the restore error surfaces unchanged", func(t *testing.T) {
		t.Parallel()
		adapter := newRecreatableResumeAdapter(restoreErr)
		controller := NewController([]Adapter{adapter}, nil)
		_, err := controller.Resume(context.Background(), ResumeInput{
			RoomID:            "room-1",
			AgentSessionID:    "imported-1",
			Provider:          ProviderClaudeCode,
			ProviderSessionID: "stale-provider-session",
			CWD:               "/workspace",
			Title:             "Imported",
		})
		if AppErrorCode(err) != AppErrorProviderSessionNotFound {
			t.Fatalf("err = %v, want provider session not found", err)
		}
		if adapter.startCalls != 0 {
			t.Fatalf("start calls = %d, want 0 (no recreate)", adapter.startCalls)
		}
	})

	t.Run("with opt-in a fresh provider session is created in place", func(t *testing.T) {
		t.Parallel()
		adapter := newRecreatableResumeAdapter(restoreErr)
		reporter := &recordingReporter{}
		controller := NewController([]Adapter{adapter}, reporter)
		session, err := controller.Resume(context.Background(), ResumeInput{
			RoomID:            "room-1",
			AgentSessionID:    "imported-1",
			Provider:          ProviderClaudeCode,
			ProviderSessionID: "stale-provider-session",
			CWD:               "/workspace",
			Title:             "Imported",
			RecreateIfMissing: true,
		})
		if err != nil {
			t.Fatalf("Resume: %v", err)
		}
		if adapter.startCalls != 1 {
			t.Fatalf("start calls = %d, want 1 (recreate)", adapter.startCalls)
		}
		if session.AgentSessionID != "imported-1" {
			t.Fatalf("agent session id = %q, want imported-1", session.AgentSessionID)
		}
		if session.ProviderSessionID != "fresh-provider-session" {
			t.Fatalf("provider session id = %q, want fresh-provider-session", session.ProviderSessionID)
		}
		// A silently recreated provider session has no memory of anything the
		// user said before this point, even though the transcript still shows
		// the old (imported) messages seamlessly joined with new ones. Without
		// a visible notice this looks exactly like the agent forgot the
		// conversation, so recreation must surface a system notice message.
		reports := reporter.waitForCalls(t, 1)
		var notice *agentsessionstore.WorkspaceAgentMessageUpdate
		for _, call := range reports {
			for i, update := range call.report.MessageUpdates {
				if update.AgentSessionID != "imported-1" {
					continue
				}
				if asString(update.Payload["kind"]) == "agent_system_notice" {
					notice = &call.report.MessageUpdates[i]
				}
			}
		}
		if notice == nil {
			t.Fatalf("no agent_system_notice message reported for recreated session; reports = %#v", reports)
		}
		if title := asString(notice.Payload["title"]); title == "" {
			t.Fatalf("recreated-session notice has empty title: %#v", notice.Payload)
		}
		// The recreated session must be live so a turn can run on it.
		result, err := controller.Exec(context.Background(), ExecInput{
			RoomID:         "room-1",
			AgentSessionID: "imported-1",
			Content:        textPrompt("continue"),
		})
		if err != nil {
			t.Fatalf("Exec after recreate: %v", err)
		}
		if !result.Accepted {
			t.Fatalf("Exec result = %#v, want accepted", result)
		}
	})
}

func TestControllerCancelStopsBackgroundTurn(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.promptPermission = true
	controller := NewDefaultControllerWithProcessTransport(nil, transport)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
		Title:    "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()
	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run tests"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	waitForPublishedSessionEvent(t, events, EventCallStarted, "approval", "waiting_approval")

	if _, err := controller.Cancel(context.Background(), rootCancelInput("room-1", started.Session.AgentSessionID, execResult.TurnID, "user")); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: started.Session.AgentSessionID,
		AgentSessionID:     started.Session.AgentSessionID,
		TurnID:             execResult.TurnID,
		RequestID:          "permission-1",
		OptionID:           "allow_once",
	}); !errors.Is(err, ErrInteractiveRequestNotLive) {
		t.Fatalf("SubmitInteractive after cancel error = %v, want ErrInteractiveRequestNotLive", err)
	}
}

func TestControllerCancelKeepsActiveTurnUntilAdapterFinishes(t *testing.T) {
	t.Parallel()

	adapter := newDeferredRemoteCancelAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("first"),
	})
	if err != nil {
		t.Fatalf("Exec first turn: %v", err)
	}
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusWorking)

	cancelResult, err := controller.Cancel(context.Background(), rootCancelInput("room-1", started.Session.AgentSessionID, execResult.TurnID, "user_interrupt"))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if !cancelResult.Canceled {
		t.Fatalf("Cancel result = %#v, want active turn cancel", cancelResult)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("second"),
	}); !errors.Is(err, ErrSessionActiveTurn) {
		t.Fatalf("Exec while remote cancel is still settling error = %v, want %v", err, ErrSessionActiveTurn)
	}
	current, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false after cancel")
	}
	if current.Status != SessionStatusWorking {
		t.Fatalf("session status after cancel = %q, want %q until adapter finishes", current.Status, SessionStatusWorking)
	}

	close(adapter.releaseExec)
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusCanceled)
}

func TestControllerSessionUpdateDuringActiveTurnDoesNotExposeReady(t *testing.T) {
	t.Parallel()

	adapter := newBlockingSessionUpdateAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Codex",
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

	close(adapter.readyToEmit)
	select {
	case <-adapter.emitted:
	case <-time.After(2 * time.Second):
		t.Fatal("session update was not emitted")
	}
	waitForCondition(t, func() bool {
		updated, ok := controller.get("room-1", started.Session.AgentSessionID)
		return ok && updated.Title == "Provider title" && updated.Status == SessionStatusWorking
	})

	cancelResult, err := controller.Cancel(context.Background(), rootCancelInput("room-1", started.Session.AgentSessionID, execResult.TurnID, "user"))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if !cancelResult.Canceled {
		t.Fatalf("Cancel result = %#v, want active turn cancel", cancelResult)
	}
}

type emittingErrorAdapter struct{}

func (emittingErrorAdapter) Provider() string { return ProviderCodex }

func (emittingErrorAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (emittingErrorAdapter) Resume(context.Context, Session) error {
	return nil
}

func (emittingErrorAdapter) Close(context.Context, Session) error {
	return nil
}

func (emittingErrorAdapter) Exec(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	emit([]activityshared.Event{newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", nil)})
	return nil, context.Canceled
}

func (emittingErrorAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

type streamingMessageOnlyAdapter struct{}

func (streamingMessageOnlyAdapter) Provider() string { return ProviderCodex }

func (streamingMessageOnlyAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (streamingMessageOnlyAdapter) Resume(context.Context, Session) error {
	return nil
}

func (streamingMessageOnlyAdapter) Close(context.Context, Session) error {
	return nil
}

func (streamingMessageOnlyAdapter) Exec(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	emit([]activityshared.Event{newTurnActivityEventWithID(session, "assistant-stream-1", EventMessage, turnID, messageStreamStateStreaming, RoleAssistant, "partial", map[string]any{
		"streamState": messageStreamStateStreaming,
	})})
	return nil, nil
}

func (streamingMessageOnlyAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

type recordingStartAdapter struct {
	provider       string
	started        Session
	cancelCalls    int
	cancelEntered  chan<- struct{}
	cancelReleased <-chan struct{}
}

type recordingPromptAdapter struct {
	recordingStartAdapter
	validated []PromptContentBlock
}

func (a *recordingPromptAdapter) ValidatePromptContent(_ Session, content []PromptContentBlock) error {
	a.validated = append([]PromptContentBlock(nil), content...)
	return validatePromptContentImagesForPreflight(content)
}

func (a *recordingStartAdapter) Provider() string { return a.provider }

func (a *recordingStartAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	a.started = session
	return []activityshared.Event{
		newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil),
	}, nil
}

func (*recordingStartAdapter) Resume(context.Context, Session) error {
	return nil
}

func (*recordingStartAdapter) Close(context.Context, Session) error {
	return nil
}

func (*recordingStartAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *recordingStartAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	a.cancelCalls++
	if a.cancelEntered != nil {
		select {
		case a.cancelEntered <- struct{}{}:
		default:
		}
	}
	if a.cancelReleased != nil {
		<-a.cancelReleased
	}
	return nil, nil
}

type failingStartAdapter struct{}

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

type reconnectableAdapter struct {
	live        map[string]bool
	resumeCalls int
}

func newReconnectableAdapter() *reconnectableAdapter {
	return &reconnectableAdapter{live: make(map[string]bool)}
}

func (*reconnectableAdapter) Provider() string { return ProviderClaudeCode }

func (a *reconnectableAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	session.ProviderSessionID = "provider-session-1"
	a.live[session.AgentSessionID] = true
	return []activityshared.Event{
		newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil),
	}, nil
}

func (a *reconnectableAdapter) Resume(_ context.Context, session Session) error {
	a.resumeCalls++
	a.live[session.AgentSessionID] = true
	return nil
}

func (*reconnectableAdapter) Close(context.Context, Session) error {
	return nil
}

func (a *reconnectableAdapter) Exec(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, _ EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	if !a.live[session.AgentSessionID] {
		return nil, ErrSessionDisconnected
	}
	return []activityshared.Event{
		newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", nil),
	}, nil
}

func (*reconnectableAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *reconnectableAdapter) HasLiveSession(session Session) bool {
	return a.live[session.AgentSessionID]
}

func (a *reconnectableAdapter) dropLiveSession(agentSessionID string) {
	a.live[agentSessionID] = false
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

// recreatableResumeAdapter fails Resume with a configurable restore error and
// mints a fresh provider session on Start, modelling an imported conversation
// whose provider session cannot be restored locally.
type recreatableResumeAdapter struct {
	resumeErr   error
	resumeCalls int
	startCalls  int
	live        map[string]bool
}

func newRecreatableResumeAdapter(resumeErr error) *recreatableResumeAdapter {
	return &recreatableResumeAdapter{resumeErr: resumeErr, live: make(map[string]bool)}
}

func (*recreatableResumeAdapter) Provider() string { return ProviderClaudeCode }

func (a *recreatableResumeAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	a.startCalls++
	session.ProviderSessionID = "fresh-provider-session"
	a.live[session.AgentSessionID] = true
	return []activityshared.Event{
		newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil),
	}, nil
}

func (a *recreatableResumeAdapter) Resume(_ context.Context, session Session) error {
	a.resumeCalls++
	if a.resumeErr != nil {
		return a.resumeErr
	}
	a.live[session.AgentSessionID] = true
	return nil
}

func (*recreatableResumeAdapter) Close(context.Context, Session) error { return nil }

func (a *recreatableResumeAdapter) Exec(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, _ EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	if !a.live[session.AgentSessionID] {
		return nil, ErrSessionDisconnected
	}
	return []activityshared.Event{
		newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", nil),
	}, nil
}

func (*recreatableResumeAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *recreatableResumeAdapter) HasLiveSession(session Session) bool {
	return a.live[session.AgentSessionID]
}

type statefulInteractiveAdapter struct {
	provider            string
	snapshot            SessionStateSnapshot
	commandSnapshot     AgentSessionCommandSnapshot
	hasCommands         bool
	commandSink         CommandSnapshotSink
	interactiveInput    SubmitInteractiveInput
	interactiveOptionID string
	submitHook          func(Session)
	applySettingsErr    error
	appliedSettings     []SessionSettingsPatch
	configSink          ConfigOptionsUpdateSink
	requiresNewSession  bool
}

func (a *statefulInteractiveAdapter) Provider() string {
	if a != nil && strings.TrimSpace(a.provider) != "" {
		return strings.TrimSpace(a.provider)
	}
	return ProviderCodex
}

func (*statefulInteractiveAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	return []activityshared.Event{
		newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil),
	}, nil
}

func (*statefulInteractiveAdapter) Resume(context.Context, Session) error { return nil }

func (*statefulInteractiveAdapter) Close(context.Context, Session) error {
	return nil
}

func (*statefulInteractiveAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (*statefulInteractiveAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *statefulInteractiveAdapter) SessionState(Session) SessionStateSnapshot {
	return a.snapshot
}

func (a *statefulInteractiveAdapter) SessionCommandSnapshot(Session) (AgentSessionCommandSnapshot, bool) {
	return a.commandSnapshot, a.hasCommands
}

func (a *statefulInteractiveAdapter) SetCommandSnapshotSink(sink CommandSnapshotSink) {
	a.commandSink = sink
}

func (a *statefulInteractiveAdapter) SetConfigOptionsUpdateSink(sink ConfigOptionsUpdateSink) {
	a.configSink = sink
}

func (a *statefulInteractiveAdapter) SubmitInteractive(_ context.Context, session Session, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
	a.interactiveInput = input
	optionID := a.interactiveOptionID
	if optionID == "" {
		optionID = input.OptionID
	}
	if a.submitHook != nil {
		a.submitHook(session)
	}
	return SubmitInteractiveResult{
		AgentSessionID: session.AgentSessionID,
		RequestID:      input.RequestID,
		Accepted:       true,
		OptionID:       optionID,
	}, nil
}

func (a *statefulInteractiveAdapter) StateAfterInteractiveSelection(
	_ Session,
	optionID string,
) (InteractiveSelectionState, bool) {
	if a.Provider() != ProviderClaudeCode {
		return InteractiveSelectionState{}, false
	}
	planMode, permissionMode, ok := claudeCodeModeFromID(optionID)
	return InteractiveSelectionState{
		PlanMode:       planMode,
		PermissionMode: permissionMode,
	}, ok
}

func (a *statefulInteractiveAdapter) ApplySessionSettings(_ context.Context, session Session, patch SessionSettingsPatch) error {
	if a.applySettingsErr != nil {
		return a.applySettingsErr
	}
	a.appliedSettings = append(a.appliedSettings, patch)
	if a.snapshot.Settings == nil {
		a.snapshot.Settings = cloneSessionSettings(
			normalizeSessionSettings(session.Settings, session.Provider, session.PermissionModeID),
		)
		if a.snapshot.PermissionModeID == "" {
			a.snapshot.PermissionModeID = session.PermissionModeID
		}
	}
	if patch.Model != nil {
		a.snapshot.Settings.Model = *patch.Model
	}
	if patch.ReasoningEffort != nil {
		a.snapshot.Settings.ReasoningEffort = *patch.ReasoningEffort
	}
	if patch.Speed != nil {
		a.snapshot.Settings.Speed = *patch.Speed
	}
	if patch.PlanMode != nil {
		a.snapshot.Settings.PlanMode = *patch.PlanMode
	}
	if patch.PermissionModeID != nil {
		a.snapshot.Settings.PermissionModeID = *patch.PermissionModeID
		a.snapshot.PermissionModeID = *patch.PermissionModeID
	}
	return nil
}

func (a *statefulInteractiveAdapter) RequiresNewSessionForSettings(Session, SessionSettingsPatch) bool {
	return a.requiresNewSession
}

type commandEmittingAdapter struct {
	statefulInteractiveAdapter
}

func (*commandEmittingAdapter) Exec(_ context.Context, session Session, _ []PromptContentBlock, _ string, _ string, _ EventSink, emitCommands CommandSnapshotSink) ([]activityshared.Event, error) {
	if emitCommands != nil {
		emitCommands(AgentSessionCommandSnapshot{
			AgentSessionID: session.AgentSessionID,
			Commands: []AgentSessionCommand{{
				Name:        "web",
				Description: "Search the web",
				InputHint:   "query",
			}},
		})
	}
	return nil, nil
}

type returnOnlyFinalAdapter struct{}

func (returnOnlyFinalAdapter) Provider() string { return ProviderCodex }

func (returnOnlyFinalAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (returnOnlyFinalAdapter) Resume(context.Context, Session) error {
	return nil
}

func (returnOnlyFinalAdapter) Close(context.Context, Session) error {
	return nil
}

func (returnOnlyFinalAdapter) Exec(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	emit([]activityshared.Event{newTurnActivityEventWithID(session, "turn-start-1", EventTurnStarted, turnID, SessionStatusWorking, "", "", nil)})
	return []activityshared.Event{
		newTurnActivityEventWithID(session, "turn-start-1", EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
		newTurnActivityEventWithID(session, "turn-complete-1", EventTurnCompleted, turnID, SessionStatusReady, "", "", nil),
	}, nil
}

func (returnOnlyFinalAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

type blockingSessionUpdateAdapter struct {
	readyToEmit chan struct{}
	emitted     chan struct{}
	canceled    chan struct{}
	cancelOnce  sync.Once
}

func newBlockingSessionUpdateAdapter() *blockingSessionUpdateAdapter {
	return &blockingSessionUpdateAdapter{
		readyToEmit: make(chan struct{}),
		emitted:     make(chan struct{}),
		canceled:    make(chan struct{}),
	}
}

func (*blockingSessionUpdateAdapter) Provider() string { return ProviderCodex }

func (*blockingSessionUpdateAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil)}, nil
}

func (*blockingSessionUpdateAdapter) Resume(context.Context, Session) error { return nil }

func (*blockingSessionUpdateAdapter) Close(context.Context, Session) error { return nil }

func (a *blockingSessionUpdateAdapter) Exec(ctx context.Context, session Session, _ []PromptContentBlock, _ string, _ string, emit EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	<-a.readyToEmit
	emit([]activityshared.Event{newSessionTitleActivityEvent(session, "Provider title")})
	close(a.emitted)
	select {
	case <-a.canceled:
		return []activityshared.Event{
			newSessionActivityEvent(session, EventSessionCanceled, SessionStatusCanceled, nil),
		}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (a *blockingSessionUpdateAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	a.cancelOnce.Do(func() {
		close(a.canceled)
	})
	return nil, nil
}

type workingOnlyAdapter struct{}

func (workingOnlyAdapter) Provider() string { return ProviderCodex }

func (workingOnlyAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (workingOnlyAdapter) Resume(context.Context, Session) error {
	return nil
}

func (workingOnlyAdapter) Close(context.Context, Session) error {
	return nil
}

func (workingOnlyAdapter) Exec(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	emit([]activityshared.Event{
		newTurnActivityEventWithID(session, "turn-start-working-only", EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
	})
	return nil, nil
}

func (workingOnlyAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

type asyncExecTestAdapter struct {
	mu          sync.Mutex
	execCalled  bool
	asyncCalled bool
	started     chan struct{}
	release     chan struct{}
}

func newAsyncExecTestAdapter() *asyncExecTestAdapter {
	return &asyncExecTestAdapter{
		started: make(chan struct{}, 1),
		release: make(chan struct{}),
	}
}

func (*asyncExecTestAdapter) Provider() string { return ProviderCodex }

func (*asyncExecTestAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (*asyncExecTestAdapter) Resume(context.Context, Session) error { return nil }

func (*asyncExecTestAdapter) Close(context.Context, Session) error { return nil }

func (a *asyncExecTestAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	a.mu.Lock()
	a.execCalled = true
	a.mu.Unlock()
	return nil, nil
}

func (a *asyncExecTestAdapter) ExecAsync(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) error {
	a.mu.Lock()
	a.asyncCalled = true
	a.mu.Unlock()
	if emit != nil {
		emit([]activityshared.Event{
			newTurnActivityEventWithID(session, "turn-start-async", EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
		})
	}
	a.started <- struct{}{}
	go func() {
		<-a.release
		if emit != nil {
			emit([]activityshared.Event{
				newTurnActivityEventWithID(session, "turn-complete-async", EventTurnCompleted, turnID, SessionStatusReady, "", "", nil),
			})
		}
	}()
	return nil
}

func (*asyncExecTestAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *asyncExecTestAdapter) calls() (bool, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.execCalled, a.asyncCalled
}

type lifecycleSnapshotAsyncExecAdapter struct {
	execDone chan struct{}
}

func (*lifecycleSnapshotAsyncExecAdapter) Provider() string { return ProviderCodex }

func (*lifecycleSnapshotAsyncExecAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (*lifecycleSnapshotAsyncExecAdapter) Resume(context.Context, Session) error { return nil }

func (*lifecycleSnapshotAsyncExecAdapter) Close(context.Context, Session) error { return nil }

func (*lifecycleSnapshotAsyncExecAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *lifecycleSnapshotAsyncExecAdapter) ExecAsync(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) error {
	if emit != nil {
		event := newTurnActivityEventWithID(session, "turn-settled-snapshot-async", EventTurnUpdated, turnID, SessionStatusReady, "", "", map[string]any{
			"phase": string(activityshared.TurnPhaseIdle),
		})
		activityshared.StampTurnLifecycleSnapshot(&event, activityshared.TurnLifecycleSnapshot{
			Origin:       activityshared.TurnLifecycleOriginAdapter,
			Seq:          1,
			ActiveTurnID: turnID,
			Phase:        string(activityshared.TurnPhaseSettled),
			Outcome:      string(activityshared.TurnOutcomeCompleted),
		})
		emit([]activityshared.Event{event})
	}
	a.execDone <- struct{}{}
	return nil
}

func (*lifecycleSnapshotAsyncExecAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

type terminalBeforeCallCompleteAsyncAdapter struct {
	callStarted      chan struct{}
	terminalReturned chan struct{}
	releaseCall      chan struct{}
}

func (*terminalBeforeCallCompleteAsyncAdapter) Provider() string { return ProviderCodex }

func (*terminalBeforeCallCompleteAsyncAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (*terminalBeforeCallCompleteAsyncAdapter) Resume(context.Context, Session) error { return nil }

func (*terminalBeforeCallCompleteAsyncAdapter) Close(context.Context, Session) error { return nil }

func (*terminalBeforeCallCompleteAsyncAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *terminalBeforeCallCompleteAsyncAdapter) ExecAsync(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) error {
	if emit != nil {
		emit([]activityshared.Event{
			newTurnActivityEventWithID(session, "call-1-start", EventCallStarted, turnID, messageStreamStateStreaming, "", "Run command", map[string]any{
				"callId": "call-1",
			}),
		})
	}
	a.callStarted <- struct{}{}
	if emit != nil {
		event := newTurnActivityEventWithID(session, "turn-1-settled", EventTurnUpdated, turnID, SessionStatusReady, "", "", map[string]any{
			"phase": string(activityshared.TurnPhaseIdle),
		})
		activityshared.StampTurnLifecycleSnapshot(&event, activityshared.TurnLifecycleSnapshot{
			Origin:       activityshared.TurnLifecycleOriginAdapter,
			Seq:          1,
			ActiveTurnID: turnID,
			Phase:        string(activityshared.TurnPhaseSettled),
			Outcome:      string(activityshared.TurnOutcomeCompleted),
		})
		emit([]activityshared.Event{event})
	}
	a.terminalReturned <- struct{}{}
	go func() {
		<-a.releaseCall
		if emit != nil {
			emit([]activityshared.Event{
				newTurnActivityEventWithID(session, "call-1-complete", EventCallCompleted, turnID, messageStreamStateCompleted, "", "Run command", map[string]any{
					"callId": "call-1",
				}),
			})
		}
	}()
	return nil
}

func (*terminalBeforeCallCompleteAsyncAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

// steeringAsyncExecAdapter mirrors CodexAppServerAdapter.steerActiveTurn: the
// prompt is steered into an already-running provider turn, so ExecAsync emits
// only the steered user message for the new turn id and no terminal event ever
// arrives for it.
// The runtime can own cancellable work the controller's turn registry does
// not know about - linked child agents outliving their parent turn, or a
// desynced turn record. Cancel must reconcile with the adapter instead of
// skipping ("cancel skipped because no active turn exists" band-aid).
func TestControllerCancelWithoutTurnRecordReconcilesWithAdapter(t *testing.T) {
	t.Parallel()

	adapter := &cancelReconcileAdapter{}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// No Exec ran: the controller holds no turn record, but the adapter still
	// has running children to stop.
	result, err := controller.Cancel(context.Background(), rootCancelInput("room-1", started.Session.AgentSessionID, "turn-1", "user requested"))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if adapter.cancelCalls.Load() != 1 {
		t.Fatalf("adapter cancel calls = %d, want 1 (reconcile must reach the adapter)", adapter.cancelCalls.Load())
	}
	if !result.Canceled {
		t.Fatalf("result = %#v, want Canceled=true when the adapter stopped work", result)
	}
}

// When neither the controller nor the adapter has anything to cancel, the
// reconciled path still answers calmly.
func TestControllerCancelWithoutAnyWorkReturnsNotCanceled(t *testing.T) {
	t.Parallel()

	adapter := &cancelReconcileAdapter{empty: true}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	result, err := controller.Cancel(context.Background(), rootCancelInput("room-1", started.Session.AgentSessionID, "turn-1", ""))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if adapter.cancelCalls.Load() != 1 {
		t.Fatalf("adapter cancel calls = %d, want 1", adapter.cancelCalls.Load())
	}
	if result.Canceled {
		t.Fatalf("result = %#v, want Canceled=false when nothing was running", result)
	}
}

func TestControllerExactCancelReportsTargetAbsentWithoutTurnRegistryRecord(t *testing.T) {
	t.Parallel()

	adapter := &cancelReconcileAdapter{empty: true}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-1", AgentSessionID: "agent-session-1", Provider: ProviderCodex, Title: "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	result, err := controller.Cancel(context.Background(), rootCancelInput("room-1", started.Session.AgentSessionID, "turn-1", ""))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if result.Canceled || !result.TargetAbsent {
		t.Fatalf("result = %#v, want exact target absent evidence", result)
	}
	if adapter.cancelCalls.Load() != 1 {
		t.Fatalf("adapter cancel calls = %d, want 1", adapter.cancelCalls.Load())
	}
}

type cancelReconcileAdapter struct {
	cancelCalls atomic.Int64
	empty       bool
}

func (*cancelReconcileAdapter) Provider() string { return ProviderCodex }

func (*cancelReconcileAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (*cancelReconcileAdapter) Resume(context.Context, Session) error { return nil }

func (*cancelReconcileAdapter) Close(context.Context, Session) error { return nil }

func (*cancelReconcileAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *cancelReconcileAdapter) Cancel(_ context.Context, session Session, _ string) ([]activityshared.Event, error) {
	a.cancelCalls.Add(1)
	if a.empty {
		return nil, ErrSessionNoActiveTurn
	}
	// Shape produced by interruptLinkedChildThreads: a non-terminal child
	// cancellation request while provider confirmation is still pending.
	return []activityshared.Event{
		newTurnActivityEvent(session, EventTurnUpdated, "turn-1", SessionStatusWaiting, "", "", map[string]any{"cancelRequested": true}),
	}, nil
}

type steeringAsyncExecAdapter struct {
	execDone chan struct{}
}

func (*steeringAsyncExecAdapter) Provider() string { return ProviderCodex }

func (*steeringAsyncExecAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (*steeringAsyncExecAdapter) Resume(context.Context, Session) error { return nil }

func (*steeringAsyncExecAdapter) Close(context.Context, Session) error { return nil }

func (*steeringAsyncExecAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *steeringAsyncExecAdapter) ExecAsync(_ context.Context, session Session, content []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) error {
	if emit != nil {
		// Exact event shape produced by steerActiveTurn.
		emit([]activityshared.Event{
			newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, "steered prompt", userPromptActivityPayload(content, "", map[string]any{
				"steered": true,
			})),
		})
	}
	a.execDone <- struct{}{}
	return nil
}

func (*steeringAsyncExecAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

type blockingExecAdapter struct {
	mu                  sync.Mutex
	seen                []string
	displays            []string
	contexts            chan context.Context
	started             chan string
	releases            chan struct{}
	provider            string
	interactiveOptionID string
}

type cancelOrderingAdapter struct {
	mu                                 sync.Mutex
	execContext                        context.Context
	execStarted                        chan struct{}
	execDone                           chan struct{}
	providerCancelObservedContextError chan error
}

func newCancelOrderingAdapter() *cancelOrderingAdapter {
	return &cancelOrderingAdapter{
		execStarted:                        make(chan struct{}),
		execDone:                           make(chan struct{}),
		providerCancelObservedContextError: make(chan error, 1),
	}
}

func (*cancelOrderingAdapter) Provider() string { return ProviderCodex }

func (*cancelOrderingAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil)}, nil
}

func (*cancelOrderingAdapter) Resume(context.Context, Session) error { return nil }

func (*cancelOrderingAdapter) Close(context.Context, Session) error { return nil }

func (a *cancelOrderingAdapter) Exec(ctx context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	a.mu.Lock()
	a.execContext = ctx
	a.mu.Unlock()
	close(a.execStarted)
	emit([]activityshared.Event{
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
	})
	<-ctx.Done()
	close(a.execDone)
	return nil, ctx.Err()
}

func (a *cancelOrderingAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	a.mu.Lock()
	execCtx := a.execContext
	a.mu.Unlock()
	var observed error
	if execCtx != nil {
		observed = execCtx.Err()
	}
	a.providerCancelObservedContextError <- observed
	return nil, nil
}

type guidanceBlockingAdapter struct {
	*blockingExecAdapter
	guidanceCalls atomic.Int64
}

func (a *guidanceBlockingAdapter) GuideActiveTurn(ctx context.Context, session Session, content []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	a.guidanceCalls.Add(1)
	events := []activityshared.Event{
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, promptDisplayText(content), userPromptActivityPayload(content, "", userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
			"guidance": true,
			"steered":  true,
		}))),
	}
	if emit != nil {
		emit(events)
	}
	return events, nil
}

func newBlockingExecAdapter() *blockingExecAdapter {
	return &blockingExecAdapter{
		contexts: make(chan context.Context, 8),
		started:  make(chan string, 8),
		releases: make(chan struct{}, 8),
	}
}

func (a *blockingExecAdapter) Provider() string {
	if a != nil && strings.TrimSpace(a.provider) != "" {
		return strings.TrimSpace(a.provider)
	}
	return ProviderCodex
}

func (*blockingExecAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (*blockingExecAdapter) Resume(context.Context, Session) error { return nil }

func (*blockingExecAdapter) Close(context.Context, Session) error { return nil }

func (a *blockingExecAdapter) Exec(ctx context.Context, session Session, content []PromptContentBlock, displayPrompt string, turnID string, emit EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	prompt := promptDisplayText(content)
	a.mu.Lock()
	a.seen = append(a.seen, prompt)
	a.displays = append(a.displays, displayPrompt)
	a.mu.Unlock()
	a.contexts <- ctx
	emit([]activityshared.Event{
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
	})
	a.started <- prompt
	select {
	case <-a.releases:
		return []activityshared.Event{
			newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", nil),
		}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (*blockingExecAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *blockingExecAdapter) SubmitInteractive(_ context.Context, session Session, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
	optionID := strings.TrimSpace(a.interactiveOptionID)
	if optionID == "" {
		optionID = strings.TrimSpace(input.OptionID)
	}
	if optionID == "" && input.Payload != nil {
		optionID = strings.TrimSpace(asString(input.Payload["optionId"]))
	}
	return SubmitInteractiveResult{
		AgentSessionID: session.AgentSessionID,
		RequestID:      strings.TrimSpace(input.RequestID),
		Accepted:       true,
		OptionID:       optionID,
	}, nil
}

func (a *blockingExecAdapter) StateAfterInteractiveSelection(
	_ Session,
	optionID string,
) (InteractiveSelectionState, bool) {
	if a.Provider() != ProviderClaudeCode {
		return InteractiveSelectionState{}, false
	}
	planMode, permissionMode, ok := claudeCodeModeFromID(optionID)
	return InteractiveSelectionState{
		PlanMode:       planMode,
		PermissionMode: permissionMode,
	}, ok
}

func (a *blockingExecAdapter) waitForPrompt(t *testing.T, prompt string) {
	t.Helper()
	select {
	case got := <-a.started:
		if got != prompt {
			t.Fatalf("started prompt = %q, want %q", got, prompt)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for prompt %q", prompt)
	}
}

func (a *blockingExecAdapter) releaseNext() {
	a.releases <- struct{}{}
}

func (a *blockingExecAdapter) prompts() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.seen...)
}

func (a *blockingExecAdapter) displayPrompts() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.displays...)
}

type deferredRemoteCancelAdapter struct {
	releaseExec      chan struct{}
	cancelRequested  chan struct{}
	cancelRequestMux sync.Once
}

func newDeferredRemoteCancelAdapter() *deferredRemoteCancelAdapter {
	return &deferredRemoteCancelAdapter{
		releaseExec:     make(chan struct{}),
		cancelRequested: make(chan struct{}),
	}
}

func (*deferredRemoteCancelAdapter) Provider() string { return ProviderCodex }

func (*deferredRemoteCancelAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil)}, nil
}

func (*deferredRemoteCancelAdapter) Resume(context.Context, Session) error { return nil }

func (*deferredRemoteCancelAdapter) Close(context.Context, Session) error { return nil }

func (a *deferredRemoteCancelAdapter) Exec(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	emit([]activityshared.Event{
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
	})
	<-a.releaseExec
	select {
	case <-a.cancelRequested:
		return []activityshared.Event{
			newSessionActivityEvent(session, EventSessionCanceled, SessionStatusCanceled, map[string]any{
				"reason": "user_interrupt",
			}),
			newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
				"reason": "user_interrupt",
			}),
		}, nil
	default:
		return []activityshared.Event{
			newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", nil),
		}, nil
	}
}

func (a *deferredRemoteCancelAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	a.cancelRequestMux.Do(func() {
		close(a.cancelRequested)
	})
	return nil, nil
}

type noActiveTurnCancelAdapter struct {
	cancelCalls atomic.Int32
}

func (*noActiveTurnCancelAdapter) Provider() string { return ProviderCodex }

func (*noActiveTurnCancelAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil)}, nil
}

func (*noActiveTurnCancelAdapter) Resume(context.Context, Session) error { return nil }

func (*noActiveTurnCancelAdapter) Close(context.Context, Session) error { return nil }

func (*noActiveTurnCancelAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *noActiveTurnCancelAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	a.cancelCalls.Add(1)
	return nil, ErrSessionNoActiveTurn
}

func TestControllerCancelTreatsNoActiveTurnAfterSettleAsIdempotent(t *testing.T) {
	t.Parallel()

	adapter := &noActiveTurnCancelAdapter{}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	turnID := "turn-1"
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := controller.beginTurn(started.Session, turnID, cancel, TurnMetadata{}); err != nil {
		t.Fatalf("beginTurn: %v", err)
	}
	outcome := string(activityshared.TurnOutcomeInterrupted)
	settled := started.Session
	settled.Status = SessionStatusCanceled
	settled.TurnLifecycle = &TurnLifecycle{Phase: "settled", Outcome: &outcome}
	settled.SubmitAvailability = availableSubmitAvailability()
	controller.store(settled)

	result, err := controller.Cancel(context.Background(), rootCancelInput("room-1", started.Session.AgentSessionID, turnID, "user_interrupt"))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if result.Canceled || !result.TargetAbsent {
		t.Fatalf("Cancel result = %#v, want provider target absent evidence", result)
	}
	if adapter.cancelCalls.Load() != 1 {
		t.Fatalf("adapter cancel calls = %d, want 1", adapter.cancelCalls.Load())
	}
	if _, ok := controller.activeTurn("room-1", started.Session.AgentSessionID); ok {
		t.Fatal("active turn record survived idempotent no-active-turn cancel")
	}
}

func TestControllerExecPublishesTerminalEventAfterPartialEmitError(t *testing.T) {
	t.Parallel()

	controller := NewController([]Adapter{emittingErrorAdapter{}}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	waitForPublishedSessionEvent(t, events, EventTurnStarted, "", SessionStatusWorking)
	waitForPublishedSessionEvent(t, events, EventTurnCompleted, "", SessionStatusCanceled)
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusCanceled)
}

func TestControllerExecReconcilesWorkingStatusAfterTurnFinishesWithoutTerminalEvent(t *testing.T) {
	t.Parallel()

	controller := NewController([]Adapter{workingOnlyAdapter{}}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}

	session := waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
	if controller.HasActiveTurn("room-1", started.Session.AgentSessionID) {
		t.Fatal("HasActiveTurn = true, want false after exec completes")
	}

	state, err := controller.State("room-1", started.Session.AgentSessionID)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.Status != SessionStatusReady {
		t.Fatalf("state status = %q, want %q", state.Status, SessionStatusReady)
	}
	if session.Status != SessionStatusReady {
		t.Fatalf("session status = %q, want %q", session.Status, SessionStatusReady)
	}
}

func TestControllerExecReportsTerminalTurnAsSettledAndAvailable(t *testing.T) {
	t.Parallel()

	adapter := newBlockingExecAdapter()
	adapter.provider = ProviderClaudeCode
	reporter := &recordingReporter{}
	controller := NewController([]Adapter{adapter}, reporter)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	adapter.waitForPrompt(t, "run")
	adapter.releaseNext()
	session := waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
	if session.SubmitAvailability == nil || session.SubmitAvailability.State != "available" {
		t.Fatalf("session submit availability = %#v, want available", session.SubmitAvailability)
	}

	reports := reporter.waitForCalls(t, 3)
	var terminalPatch *agentsessionstore.WorkspaceAgentStatePatch
	for _, call := range reports {
		for index := range call.report.StatePatches {
			patch := &call.report.StatePatches[index]
			if patch.Turn != nil && patch.Turn.CompletedAtUnixMS > 0 {
				terminalPatch = patch
			}
		}
	}
	if terminalPatch == nil {
		t.Fatalf("reports = %#v, missing terminal turn patch", reports)
	}
	if terminalPatch.CurrentPhase != string(activityshared.TurnPhaseIdle) {
		t.Fatalf("terminal patch current phase = %q, want idle", terminalPatch.CurrentPhase)
	}
	if terminalPatch.Turn == nil ||
		terminalPatch.Turn.ActiveTurnID != nil ||
		terminalPatch.Turn.Phase != "settled" ||
		terminalPatch.Turn.Outcome != "completed" ||
		terminalPatch.Turn.SubmitAvailability == nil ||
		terminalPatch.Turn.SubmitAvailability.State != "available" {
		t.Fatalf("terminal turn patch = %#v, want settled available with nil active turn", terminalPatch.Turn)
	}
	if terminalPatch.TurnLifecycle == nil ||
		terminalPatch.TurnLifecycle.ActiveTurnID != nil ||
		terminalPatch.TurnLifecycle.Phase != "settled" ||
		terminalPatch.TurnLifecycle.Outcome == nil ||
		*terminalPatch.TurnLifecycle.Outcome != "completed" {
		t.Fatalf("terminal turn lifecycle = %#v, want completed settled with nil active turn", terminalPatch.TurnLifecycle)
	}
	if terminalPatch.SubmitAvailability == nil || terminalPatch.SubmitAvailability.State != "available" {
		t.Fatalf("terminal submit availability = %#v, want available", terminalPatch.SubmitAvailability)
	}
}

func TestControllerExecUsesAsyncAdapterAndFinalizesFromTerminalEvent(t *testing.T) {
	t.Parallel()

	adapter := newAsyncExecTestAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	select {
	case <-adapter.started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for async Exec")
	}
	execCalled, asyncCalled := adapter.calls()
	if execCalled {
		t.Fatal("blocking Exec was called for async adapter")
	}
	if !asyncCalled {
		t.Fatal("ExecAsync was not called")
	}
	if !controller.HasActiveTurn("room-1", started.Session.AgentSessionID) {
		t.Fatal("HasActiveTurn = false before async terminal event")
	}

	close(adapter.release)
	session := waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
	if controller.HasActiveTurn("room-1", started.Session.AgentSessionID) {
		t.Fatal("HasActiveTurn = true after async terminal event")
	}
	if session.TurnLifecycle == nil || session.TurnLifecycle.Phase != "settled" {
		t.Fatalf("turn lifecycle = %#v, want settled", session.TurnLifecycle)
	}
}

func TestControllerExecDefersAsyncTerminalEventUntilOpenCallCompletes(t *testing.T) {
	t.Parallel()

	adapter := &terminalBeforeCallCompleteAsyncAdapter{
		callStarted:      make(chan struct{}, 1),
		terminalReturned: make(chan struct{}, 1),
		releaseCall:      make(chan struct{}),
	}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	select {
	case <-adapter.callStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for call start")
	}
	select {
	case <-adapter.terminalReturned:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for terminal event")
	}
	session, ok := controller.get("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("session missing")
	}
	if session.Status != SessionStatusWorking {
		t.Fatalf("session status = %q, want working while call is open", session.Status)
	}
	if session.SubmitAvailability == nil ||
		session.SubmitAvailability.State != "blocked" ||
		session.SubmitAvailability.Reason != "active_turn" {
		t.Fatalf("submit availability = %#v, want blocked active_turn", session.SubmitAvailability)
	}
	if !controller.HasActiveTurn("room-1", started.Session.AgentSessionID) {
		t.Fatal("HasActiveTurn = false before open call completes")
	}

	close(adapter.releaseCall)
	session = waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
	if controller.HasActiveTurn("room-1", started.Session.AgentSessionID) {
		t.Fatal("HasActiveTurn = true after open call completes")
	}
	if session.TurnLifecycle == nil || session.TurnLifecycle.Phase != "settled" {
		t.Fatalf("turn lifecycle = %#v, want settled", session.TurnLifecycle)
	}
}

func TestControllerExecSteerSettlesTurnRecordWithoutTerminalEvent(t *testing.T) {
	t.Parallel()

	adapter := &steeringAsyncExecAdapter{execDone: make(chan struct{}, 2)}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("also update the docs"),
	}); err != nil {
		t.Fatalf("steer Exec: %v", err)
	}
	select {
	case <-adapter.execDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for steer ExecAsync")
	}
	// The steer submission does not own a provider turn: no terminal event
	// will ever arrive for its turn id, so the controller turn record must
	// settle immediately or the session blocks every future Exec with
	// ErrSessionActiveTurn until daemon restart.
	waitForCondition(t, func() bool {
		return !controller.HasActiveTurn("room-1", started.Session.AgentSessionID)
	})
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("follow-up prompt"),
	}); err != nil {
		t.Fatalf("Exec after steer: %v", err)
	}
}

func TestControllerExecSettledLifecycleSnapshotClearsAsyncTurnRecord(t *testing.T) {
	t.Parallel()

	adapter := &lifecycleSnapshotAsyncExecAdapter{execDone: make(chan struct{}, 1)}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	select {
	case <-adapter.execDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for snapshot ExecAsync")
	}
	waitForCondition(t, func() bool {
		return !controller.HasActiveTurn("room-1", started.Session.AgentSessionID)
	})
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("follow-up prompt"),
	}); err != nil {
		t.Fatalf("Exec after settled snapshot: %v", err)
	}
}

func TestControllerStateReconcilesStoredWorkingStatusWithoutActiveTurn(t *testing.T) {
	t.Parallel()

	controller := NewController([]Adapter{&statefulInteractiveAdapter{}}, nil)
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

	controller.mu.Lock()
	session := controller.sessions[sessionKey("room-1", started.Session.AgentSessionID)]
	session.Status = SessionStatusWorking
	session.UpdatedAtUnixMS = 123
	controller.sessions[sessionKey("room-1", started.Session.AgentSessionID)] = session
	controller.mu.Unlock()

	state, err := controller.State("room-1", started.Session.AgentSessionID)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.Status != SessionStatusReady {
		t.Fatalf("state status = %q, want %q", state.Status, SessionStatusReady)
	}

	reconciled, ok := controller.get("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("get returned ok=false")
	}
	if reconciled.Status != SessionStatusReady {
		t.Fatalf("stored session status = %q, want %q", reconciled.Status, SessionStatusReady)
	}
	if controller.HasActiveTurn("room-1", started.Session.AgentSessionID) {
		t.Fatal("HasActiveTurn = true, want false")
	}
}

func TestControllerExecIgnoresMetadataOnlyEmitForSessionUpdatedAt(t *testing.T) {
	t.Parallel()

	adapter := newBlockingSessionUpdateAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	controller.mu.Lock()
	session := controller.sessions[sessionKey("room-1", started.Session.AgentSessionID)]
	session.UpdatedAtUnixMS = 321
	controller.sessions[sessionKey("room-1", started.Session.AgentSessionID)] = session
	controller.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, execErr := controller.Exec(ctx, ExecInput{
			RoomID:         "room-1",
			AgentSessionID: started.Session.AgentSessionID,
			Content:        textPrompt("hello"),
		})
		done <- execErr
	}()

	waitForCondition(t, func() bool {
		current, ok := controller.Session("room-1", started.Session.AgentSessionID)
		return ok && current.UpdatedAtUnixMS > 321
	})
	current, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false after beginTurn")
	}
	baselineUpdatedAtUnixMS := current.UpdatedAtUnixMS

	close(adapter.readyToEmit)
	select {
	case <-adapter.emitted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for metadata event emit")
	}

	current, ok = controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false after metadata emit")
	}
	if current.UpdatedAtUnixMS != baselineUpdatedAtUnixMS {
		t.Fatalf(
			"UpdatedAtUnixMS after metadata emit = %d, want preserved beginTurn value %d",
			current.UpdatedAtUnixMS,
			baselineUpdatedAtUnixMS,
		)
	}

	cancel()
	<-done
}

func TestControllerStateUsesAdapterSnapshot(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		snapshot: SessionStateSnapshot{
			AuthState: "auth_required",
			RuntimeContext: map[string]any{
				"mode": "plan",
			},
			PendingInteractive: &SessionInteractivePrompt{
				Kind:      "ask-user",
				RequestID: "request-1",
			},
		},
	}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-1",
		Provider:         ProviderCodex,
		CWD:              "/workspace",
		Title:            "Codex",
		PermissionModeID: "auto",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	snapshot, err := controller.State("room-1", started.Session.AgentSessionID)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if snapshot.AuthState != "auth_required" {
		t.Fatalf("auth state = %q, want auth_required", snapshot.AuthState)
	}
	if snapshot.PendingInteractive == nil || snapshot.PendingInteractive.RequestID != "request-1" {
		t.Fatalf("pending interactive = %#v, want request-1", snapshot.PendingInteractive)
	}
	if got := asString(snapshot.RuntimeContext["mode"]); got != "plan" {
		t.Fatalf("runtime context mode = %q, want plan", got)
	}
}

func TestControllerPublishesAndReplaysCommandSnapshots(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		commandSnapshot: AgentSessionCommandSnapshot{
			AgentSessionID: "agent-session-1",
			Commands: []AgentSessionCommand{{
				Name:        "init",
				Description: "Initial command",
				InputHint:   "value",
			}},
		},
		hasCommands: true,
	}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()
	event := waitForStreamEventType(t, events, StreamEventAvailableCommands)
	snapshot, ok := event.Data.(AgentSessionCommandSnapshot)
	if !ok || len(snapshot.Commands) != 1 || snapshot.Commands[0].Name != "init" {
		t.Fatalf("replayed command event = %#v, want initial command snapshot", event)
	}

	liveAdapter := &commandEmittingAdapter{}
	liveController := NewController([]Adapter{liveAdapter}, nil)
	started, err = liveController.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-2",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start live: %v", err)
	}
	liveEvents, liveUnsubscribe, ok := liveController.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe live returned ok=false")
	}
	defer liveUnsubscribe()
	if _, err := liveController.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("hello"),
	}); err != nil {
		t.Fatalf("Exec live: %v", err)
	}
	event = waitForStreamEventType(t, liveEvents, StreamEventAvailableCommands)
	snapshot, ok = event.Data.(AgentSessionCommandSnapshot)
	if !ok || len(snapshot.Commands) != 1 || snapshot.Commands[0].Name != "web" {
		t.Fatalf("live command event = %#v, want web command snapshot", event)
	}

	if _, err := liveController.Close(context.Background(), CloseInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
	}); err != nil {
		t.Fatalf("Close live: %v", err)
	}
	if _, _, ok := liveController.Subscribe("room-1", started.Session.AgentSessionID); ok {
		t.Fatal("Subscribe after close returned ok=true")
	}
}

func TestControllerReplaysCommandSnapshotsQueuedBeforeStartRegistration(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)
	if adapter.commandSink == nil {
		t.Fatal("adapter command snapshot sink was not installed")
	}
	adapter.commandSink(AgentSessionCommandSnapshot{
		AgentSessionID: "agent-session-1",
		Commands: []AgentSessionCommand{{
			Name:        "compact",
			Description: "Compact context",
		}},
	})

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()

	event := waitForStreamEventType(t, events, StreamEventAvailableCommands)
	snapshot, ok := event.Data.(AgentSessionCommandSnapshot)
	if !ok || snapshot.AgentSessionID != "agent-session-1" ||
		len(snapshot.Commands) != 1 ||
		snapshot.Commands[0].Name != "compact" {
		t.Fatalf("replayed command event = %#v, want queued compact command snapshot", event)
	}
}

func TestControllerReplaysCommandSnapshotsQueuedBeforeResumeRegistration(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)
	if adapter.commandSink == nil {
		t.Fatal("adapter command snapshot sink was not installed")
	}
	adapter.commandSink(AgentSessionCommandSnapshot{
		AgentSessionID: "agent-session-1",
		Commands: []AgentSessionCommand{{
			Name:        "plan",
			Description: "Enter plan mode",
		}},
	})

	resumed, err := controller.Resume(context.Background(), ResumeInput{
		RoomID:            "room-1",
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "provider-session-1",
		Title:             "Test",
	})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}

	events, unsubscribe, ok := controller.Subscribe("room-1", resumed.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()

	event := waitForStreamEventType(t, events, StreamEventAvailableCommands)
	snapshot, ok := event.Data.(AgentSessionCommandSnapshot)
	if !ok || snapshot.AgentSessionID != "agent-session-1" ||
		len(snapshot.Commands) != 1 ||
		snapshot.Commands[0].Name != "plan" {
		t.Fatalf("replayed command event = %#v, want queued plan command snapshot", event)
	}
}

func TestControllerPublishesConfigOptionsUpdatesFromAdapterSink(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if adapter.configSink == nil {
		t.Fatal("adapter config options update sink was not installed")
	}

	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()

	adapter.configSink(AgentSessionConfigOptionsUpdate{
		AgentSessionID:  started.Session.AgentSessionID,
		ConfigOptionKey: "model",
	})
	event := waitForStreamEventType(t, events, StreamEventConfigOptions)
	update, ok := event.Data.(AgentSessionConfigOptionsUpdate)
	if !ok {
		t.Fatalf("config options stream event data = %#v, want update payload", event.Data)
	}
	if update.AgentSessionID != started.Session.AgentSessionID ||
		update.Provider != ProviderCodex ||
		update.ProviderSessionID != started.Session.ProviderSessionID ||
		update.ConfigOptionKey != "model" ||
		update.OccurredAtUnixMS <= 0 {
		t.Fatalf("config options update = %#v, want populated payload", update)
	}
}

func TestControllerReplaysConfigOptionsUpdatesQueuedBeforeSessionRegistration(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)
	if adapter.configSink == nil {
		t.Fatal("adapter config options update sink was not installed")
	}
	adapter.configSink(AgentSessionConfigOptionsUpdate{
		RoomID:          "room-1",
		AgentSessionID:  "agent-session-1",
		ConfigOptionKey: "model",
	})

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()

	event := waitForStreamEventType(t, events, StreamEventConfigOptions)
	update, ok := event.Data.(AgentSessionConfigOptionsUpdate)
	if !ok {
		t.Fatalf("config options stream event data = %#v, want update payload", event.Data)
	}
	if update.RoomID != "room-1" ||
		update.AgentSessionID != "agent-session-1" ||
		update.Provider != ProviderCodex ||
		update.ConfigOptionKey != "model" {
		t.Fatalf("config options update = %#v, want replayed model update", update)
	}
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

func TestControllerReplaysCurrentSessionStateOnSubscribe(t *testing.T) {
	t.Parallel()

	controller := NewController([]Adapter{&statefulInteractiveAdapter{}}, nil)
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
	controller.mu.Lock()
	session := controller.sessions[sessionKey("room-1", started.Session.AgentSessionID)]
	session.Status = SessionStatusReady
	session.UpdatedAtUnixMS = 123
	controller.sessions[sessionKey("room-1", started.Session.AgentSessionID)] = session
	controller.mu.Unlock()

	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()
	event := waitForStreamEventType(t, events, StreamEventStatePatch)
	patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
	if !ok {
		t.Fatalf("state replay data = %#v, want WorkspaceAgentStatePatch", event.Data)
	}
	if patch.AgentSessionID != started.Session.AgentSessionID ||
		patch.Provider != ProviderCodex ||
		patch.CurrentPhase != string(activityshared.TurnPhaseIdle) ||
		patch.LifecycleStatus != string(activityshared.SessionLifecycleStatusActive) ||
		patch.OccurredAtUnixMS != 123 {
		t.Fatalf("state replay patch = %#v, want current ready session snapshot", patch)
	}
}

func TestControllerSubmitInteractiveDelegatesToAdapter(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-1",
		Provider:         ProviderCodex,
		CWD:              "/workspace",
		Title:            "Codex",
		PermissionModeID: "auto",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	result, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: started.Session.AgentSessionID,
		AgentSessionID:     started.Session.AgentSessionID,
		RequestID:          "request-1",
		Action:             "submit",
		OptionID:           "option-1",
		Payload: map[string]any{
			"answer": "Use the task renderer",
		},
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if !result.Accepted {
		t.Fatalf("submit result = %#v, want accepted", result)
	}
	if adapter.interactiveInput.RequestID != "request-1" || adapter.interactiveInput.OptionID != "option-1" {
		t.Fatalf("interactive input = %#v", adapter.interactiveInput)
	}
}

func TestControllerSubmitInteractiveSyncsClaudeCodePermissionModeSelection(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		initial  string
		optionID string
		payload  map[string]any
		resolved string
		wantMode string
	}{
		{name: "accept edits", initial: "default", optionID: "acceptEdits", wantMode: "acceptEdits"},
		{name: "bypass permissions", initial: "default", optionID: "bypassPermissions", wantMode: "bypassPermissions"},
		{name: "default", initial: "acceptEdits", optionID: "default", wantMode: "default"},
		{name: "legacy auto", initial: "default", optionID: "auto", wantMode: "acceptEdits"},
		{name: "dont ask from payload", initial: "default", payload: map[string]any{"optionId": "dontAsk"}, resolved: "dontAsk", wantMode: "dontAsk"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			adapter := &statefulInteractiveAdapter{provider: ProviderClaudeCode, interactiveOptionID: tt.resolved}
			controller := NewController([]Adapter{adapter}, nil)
			started, err := controller.Start(context.Background(), StartInput{
				RoomID:           "room-1",
				AgentSessionID:   "agent-session-" + strings.ReplaceAll(tt.name, " ", "-"),
				Provider:         ProviderClaudeCode,
				CWD:              "/workspace",
				Title:            "Claude Code",
				PermissionModeID: tt.initial,
			})
			if err != nil {
				t.Fatalf("Start: %v", err)
			}

			events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
			if !ok {
				t.Fatal("Subscribe returned ok=false")
			}
			defer unsubscribe()
			_ = waitForStreamEventType(t, events, StreamEventStatePatch)

			if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
				RoomID:             "room-1",
				RootAgentSessionID: started.Session.AgentSessionID,
				AgentSessionID:     started.Session.AgentSessionID,
				RequestID:          "permission-1",
				OptionID:           tt.optionID,
				Payload:            tt.payload,
			}); err != nil {
				t.Fatalf("SubmitInteractive: %v", err)
			}

			session, ok := controller.Session("room-1", started.Session.AgentSessionID)
			if !ok {
				t.Fatal("Session returned ok=false")
			}
			if session.PermissionModeID != tt.wantMode {
				t.Fatalf("session permission mode = %q, want %q", session.PermissionModeID, tt.wantMode)
			}
			if session.Settings == nil || session.Settings.PermissionModeID != tt.wantMode {
				t.Fatalf("session settings = %#v, want permission mode %q", session.Settings, tt.wantMode)
			}

			event := waitForStatePatchPermissionMode(t, events, tt.wantMode)
			patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
			if !ok {
				t.Fatalf("event data = %#v, want state patch", event.Data)
			}
			if patch.Settings["permissionModeId"] != tt.wantMode {
				t.Fatalf("patch settings = %#v, want permission mode %q", patch.Settings, tt.wantMode)
			}
			if patch.Settings["planMode"] != false {
				t.Fatalf("patch settings planMode = %#v, want false", patch.Settings["planMode"])
			}
			if patch.RuntimeContext["permissionModeId"] != tt.wantMode {
				t.Fatalf("patch runtime context = %#v, want permission mode %q", patch.RuntimeContext, tt.wantMode)
			}
			if patch.RuntimeContext["planMode"] != false {
				t.Fatalf("patch runtime context planMode = %#v, want false", patch.RuntimeContext["planMode"])
			}
			if patch.LifecycleStatus != "" || patch.CurrentPhase != "" {
				t.Fatalf("patch status fields = %q/%q, want empty permission-only patch", patch.LifecycleStatus, patch.CurrentPhase)
			}
		})
	}
}

func TestClaudeCodeModeFromID(t *testing.T) {
	t.Parallel()

	tests := []struct {
		modeID         string
		wantPlan       bool
		wantPermission string
		wantOK         bool
	}{
		{modeID: "plan", wantPlan: true, wantPermission: "", wantOK: true},
		{modeID: "default", wantPlan: false, wantPermission: "default", wantOK: true},
		{modeID: "acceptEdits", wantPlan: false, wantPermission: "acceptEdits", wantOK: true},
		{modeID: "bypassPermissions", wantPlan: false, wantPermission: "bypassPermissions", wantOK: true},
		{modeID: "auto", wantPlan: false, wantPermission: "acceptEdits", wantOK: true},
		{modeID: "dontAsk", wantPlan: false, wantPermission: "dontAsk", wantOK: true},
		{modeID: "allow_once", wantOK: false},
		{modeID: "reject", wantOK: false},
		{modeID: "", wantOK: false},
	}
	for _, tt := range tests {
		plan, permission, ok := claudeCodeModeFromID(tt.modeID)
		if ok != tt.wantOK || plan != tt.wantPlan || permission != tt.wantPermission {
			t.Fatalf("claudeCodeModeFromID(%q) = (%v, %q, %v), want (%v, %q, %v)",
				tt.modeID, plan, permission, ok, tt.wantPlan, tt.wantPermission, tt.wantOK)
		}
	}
}

func TestControllerSubmitInteractiveExitsPlanModeOnPermissionSelection(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{provider: ProviderClaudeCode}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-exit-plan",
		Provider:         ProviderClaudeCode,
		CWD:              "/workspace",
		Title:            "Claude Code",
		PermissionModeID: "default",
		Settings:         &SessionSettings{PlanMode: true, PermissionModeID: "default"},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()
	_ = waitForStreamEventType(t, events, StreamEventStatePatch)

	if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: started.Session.AgentSessionID,
		AgentSessionID:     started.Session.AgentSessionID,
		RequestID:          "permission-1",
		OptionID:           "auto",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}

	session, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false")
	}
	if session.PermissionModeID != "acceptEdits" {
		t.Fatalf("session permission mode = %q, want acceptEdits", session.PermissionModeID)
	}
	if session.Settings == nil || session.Settings.PlanMode {
		t.Fatalf("session settings = %#v, want plan mode cleared", session.Settings)
	}

	event := waitForStatePatchPermissionMode(t, events, "acceptEdits")
	patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
	if !ok {
		t.Fatalf("event data = %#v, want state patch", event.Data)
	}
	if patch.Settings["planMode"] != false {
		t.Fatalf("patch settings planMode = %#v, want false", patch.Settings["planMode"])
	}
}

func TestControllerSubmitInteractiveModeSurvivesActiveTurnStaleSession(t *testing.T) {
	t.Parallel()

	adapter := newBlockingExecAdapter()
	adapter.provider = ProviderClaudeCode
	adapter.interactiveOptionID = "bypassPermissions"
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-exit-plan-stale-turn",
		Provider:         ProviderClaudeCode,
		CWD:              "/workspace",
		Title:            "Claude Code",
		PermissionModeID: "default",
		Settings:         &SessionSettings{PlanMode: true, PermissionModeID: "default"},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        []PromptContentBlock{{Type: "text", Text: "implement"}},
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	adapter.waitForPrompt(t, "implement")

	if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: started.Session.AgentSessionID,
		AgentSessionID:     started.Session.AgentSessionID,
		RequestID:          "permission-1",
		OptionID:           "bypassPermissions",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	session, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false")
	}
	if session.Settings == nil || session.Settings.PlanMode || session.PermissionModeID != "bypassPermissions" {
		t.Fatalf("session after exit = %#v, want planMode=false and bypassPermissions", session)
	}

	adapter.releaseNext()
	session = waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
	if session.Settings == nil || session.Settings.PlanMode || session.PermissionModeID != "bypassPermissions" {
		t.Fatalf("session after stale turn completion = %#v, want planMode=false and bypassPermissions", session)
	}
	if got, _ := session.RuntimeContext["planMode"].(bool); got {
		t.Fatalf("runtime context planMode = %#v, want false", session.RuntimeContext["planMode"])
	}
	if got, _ := session.RuntimeContext["permissionModeId"].(string); got != "bypassPermissions" {
		t.Fatalf("runtime context permissionModeId = %#v, want bypassPermissions", session.RuntimeContext["permissionModeId"])
	}
}

func TestControllerSubmitInteractiveKeepPlanningStaysInPlanMode(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{provider: ProviderClaudeCode}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-keep-planning",
		Provider:         ProviderClaudeCode,
		CWD:              "/workspace",
		Title:            "Claude Code",
		PermissionModeID: "default",
		Settings:         &SessionSettings{PlanMode: true, PermissionModeID: "default"},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()
	_ = waitForStreamEventType(t, events, StreamEventStatePatch)

	if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: started.Session.AgentSessionID,
		AgentSessionID:     started.Session.AgentSessionID,
		RequestID:          "permission-1",
		OptionID:           "plan",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}

	session, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false")
	}
	if session.Settings == nil || !session.Settings.PlanMode {
		t.Fatalf("session settings = %#v, want plan mode preserved", session.Settings)
	}
	if session.PermissionModeID != "default" {
		t.Fatalf("session permission mode = %q, want unchanged default", session.PermissionModeID)
	}
	// Keeping planning is a no-op for the mode, so no state patch is published.
	expectNoStreamEventType(t, events, StreamEventStatePatch)
}

func TestControllerSubmitInteractiveDoesNotSyncUnsupportedPermissionSelections(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		provider string
		optionID string
		resolved string
	}{
		{name: "ordinary allow", provider: ProviderClaudeCode, optionID: "allow_once"},
		{name: "reject", provider: ProviderClaudeCode, optionID: "reject"},
		{name: "raw permission alias resolves to ordinary allow", provider: ProviderClaudeCode, optionID: "acceptEdits", resolved: "allow_once"},
		{name: "non claude", provider: ProviderCodex, optionID: "acceptEdits"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			adapter := &statefulInteractiveAdapter{provider: tt.provider, interactiveOptionID: tt.resolved}
			controller := NewController([]Adapter{adapter}, nil)
			initialMode := defaultPermissionModeIDForProvider(tt.provider)
			started, err := controller.Start(context.Background(), StartInput{
				RoomID:           "room-1",
				AgentSessionID:   "agent-session-" + strings.ReplaceAll(tt.name, " ", "-"),
				Provider:         tt.provider,
				CWD:              "/workspace",
				Title:            "Agent",
				PermissionModeID: initialMode,
			})
			if err != nil {
				t.Fatalf("Start: %v", err)
			}

			events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
			if !ok {
				t.Fatal("Subscribe returned ok=false")
			}
			defer unsubscribe()
			_ = waitForStreamEventType(t, events, StreamEventStatePatch)

			if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
				RoomID:             "room-1",
				RootAgentSessionID: started.Session.AgentSessionID,
				AgentSessionID:     started.Session.AgentSessionID,
				RequestID:          "permission-1",
				OptionID:           tt.optionID,
			}); err != nil {
				t.Fatalf("SubmitInteractive: %v", err)
			}

			session, ok := controller.Session("room-1", started.Session.AgentSessionID)
			if !ok {
				t.Fatal("Session returned ok=false")
			}
			if session.PermissionModeID != initialMode {
				t.Fatalf("session permission mode = %q, want unchanged %q", session.PermissionModeID, initialMode)
			}
			expectNoStreamEventType(t, events, StreamEventStatePatch)
		})
	}
}

func TestControllerKeepsTerminalInteractiveDispositionAfterSessionRemoval(t *testing.T) {
	controller := NewController(nil, nil)
	controller.recordTerminalInteractiveDisposition("session-1", "turn-1", "request-1", InteractiveDispositionAnswered)

	if got := controller.InteractiveDisposition("room-1", "session-1", "session-1", "turn-1", "request-1"); got != InteractiveDispositionAnswered {
		t.Fatalf("disposition without live session = %q, want answered", got)
	}
	if got := controller.InteractiveDisposition("room-1", "session-1", "session-1", "turn-2", "request-1"); got != InteractiveDispositionUnknown {
		t.Fatalf("different-turn disposition = %q, want unknown", got)
	}
}

func TestControllerSubmitInteractivePermissionSyncPreservesCurrentSessionState(t *testing.T) {
	t.Parallel()

	controller := NewController(nil, nil)
	adapter := &statefulInteractiveAdapter{
		provider:            ProviderClaudeCode,
		interactiveOptionID: "acceptEdits",
	}
	adapter.submitHook = func(session Session) {
		current, ok := controller.Session(session.RoomID, session.AgentSessionID)
		if !ok {
			return
		}
		current.Status = SessionStatusCompleted
		current.Title = "Finished title"
		current.ProviderSessionID = "latest-provider-session"
		controller.store(current)
	}
	controller = NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-1",
		Provider:         ProviderClaudeCode,
		CWD:              "/workspace",
		Title:            "Claude Code",
		PermissionModeID: "default",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: started.Session.AgentSessionID,
		AgentSessionID:     started.Session.AgentSessionID,
		RequestID:          "permission-1",
		OptionID:           "acceptEdits",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}

	session, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false")
	}
	if session.PermissionModeID != "acceptEdits" {
		t.Fatalf("session permission mode = %q, want acceptEdits", session.PermissionModeID)
	}
	if session.Status != SessionStatusCompleted || session.Title != "Finished title" || session.ProviderSessionID != "latest-provider-session" {
		t.Fatalf("session after sync = %#v, want latest non-permission fields preserved", session)
	}
}

func TestControllerSubmitInteractiveStartsDenyFollowUpAfterActiveTurn(t *testing.T) {
	t.Parallel()

	adapter := newBlockingExecAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-1",
		Provider:         ProviderCodex,
		CWD:              "/workspace",
		Title:            "Codex",
		PermissionModeID: "auto",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run tests"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	adapter.waitForPrompt(t, "run tests")

	result, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: started.Session.AgentSessionID,
		AgentSessionID:     started.Session.AgentSessionID,
		RequestID:          "permission-1",
		Action:             "deny",
		OptionID:           "abort",
		Payload: map[string]any{
			"denyMessage": "Please split the work into smaller steps.",
		},
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if !result.Accepted {
		t.Fatalf("submit result = %#v, want accepted", result)
	}

	adapter.releaseNext()
	adapter.waitForPrompt(t, "Please split the work into smaller steps.")
	adapter.releaseNext()
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
	if got := adapter.prompts(); len(got) != 2 || got[0] != "run tests" || got[1] != "Please split the work into smaller steps." {
		t.Fatalf("adapter prompts = %#v, want initial prompt then deny follow-up", got)
	}
}

func TestInteractiveDenyFollowUpSkipsClaudeSDKAdapter(t *testing.T) {
	t.Parallel()

	if adapterShouldReceiveInteractiveDenyFollowUp(NewClaudeCodeSDKAdapter(nil)) {
		t.Fatal("Claude SDK adapter should consume deny feedback without daemon follow-up")
	}
	if !adapterShouldReceiveInteractiveDenyFollowUp(newBlockingExecAdapter()) {
		t.Fatal("ACP-style adapter should keep daemon deny follow-up")
	}
}

func hasActivityEvent(events []activityshared.Event, eventType activityshared.EventType, role activityshared.MessageRole) bool {
	for _, event := range events {
		if event.Type != eventType {
			continue
		}
		if role != "" && event.Payload.Role != role {
			continue
		}
		return true
	}
	return false
}

func hasActivityMessage(events []activityshared.Event, role activityshared.MessageRole, content string) bool {
	for _, event := range events {
		if event.Type != activityshared.EventMessageAppended {
			continue
		}
		if role != "" && event.Payload.Role != role {
			continue
		}
		if event.Payload.Content == content {
			return true
		}
	}
	return false
}

func TestControllerExecReportsReturnedEventsNotAlreadyEmitted(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	controller := NewController([]Adapter{returnOnlyFinalAdapter{}}, reporter)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	waitForCondition(t, func() bool {
		return hasTurnCompletionPatchInReports(reportInputs(reporter.snapshot()), execResult.TurnID)
	})
}

func TestControllerSessionEventSinkTracksSyntheticTurnLifecycle(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	controller := NewController(nil, reporter)
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		Status:         SessionStatusReady,
	}
	controller.store(session)

	controller.applySessionEventsByAgentSessionID("agent-session-1", []activityshared.Event{
		newTurnActivityEvent(session, EventTurnStarted, "synthetic-turn-1", SessionStatusWorking, "", "", map[string]any{
			"synthetic": true,
		}),
	})

	stored, ok := controller.get("room-1", "agent-session-1")
	if !ok {
		t.Fatal("stored session missing")
	}
	if stored.Status != SessionStatusWorking {
		t.Fatalf("session status = %q, want working", stored.Status)
	}
	if stored.TurnLifecycle == nil ||
		stored.TurnLifecycle.ActiveTurnID == nil ||
		*stored.TurnLifecycle.ActiveTurnID != "synthetic-turn-1" ||
		stored.TurnLifecycle.Phase != "running" {
		t.Fatalf("turn lifecycle = %#v, want synthetic running", stored.TurnLifecycle)
	}
	if stored.SubmitAvailability == nil ||
		stored.SubmitAvailability.State != "blocked" ||
		stored.SubmitAvailability.Reason != "active_turn" {
		t.Fatalf("submit availability = %#v, want active_turn blocked", stored.SubmitAvailability)
	}

	reports := reporter.waitForCalls(t, 1)
	patches := reports[len(reports)-1].report.StatePatches
	if len(patches) == 0 ||
		patches[0].TurnLifecycle == nil ||
		patches[0].TurnLifecycle.ActiveTurnID == nil ||
		*patches[0].TurnLifecycle.ActiveTurnID != "synthetic-turn-1" {
		t.Fatalf("reported state patches = %#v, want synthetic turn lifecycle", patches)
	}
}

func TestControllerFinishParentTurnDoesNotOverwriteSyntheticLifecycle(t *testing.T) {
	t.Parallel()

	controller := NewController(nil, nil)
	parentTurnID := "parent-turn-1"
	syntheticTurnID := "synthetic-turn-1"
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		Status:         SessionStatusWorking,
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &syntheticTurnID,
			Phase:        "running",
		},
		SubmitAvailability: blockedSubmitAvailability("active_turn"),
	}
	controller.store(session)
	controller.mu.Lock()
	controller.turns[sessionKey("room-1", "agent-session-1")] = activeTurn{turnID: parentTurnID}
	controller.mu.Unlock()

	outcome := "completed"
	controller.finishTurn(Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		Status:         SessionStatusReady,
		TurnLifecycle: &TurnLifecycle{
			Phase:   "settled",
			Outcome: &outcome,
		},
		SubmitAvailability: availableSubmitAvailability(),
	}, parentTurnID)

	stored, ok := controller.get("room-1", "agent-session-1")
	if !ok {
		t.Fatal("stored session missing")
	}
	if stored.TurnLifecycle == nil ||
		stored.TurnLifecycle.ActiveTurnID == nil ||
		*stored.TurnLifecycle.ActiveTurnID != syntheticTurnID ||
		stored.TurnLifecycle.Phase != "running" {
		t.Fatalf("turn lifecycle = %#v, want synthetic running preserved", stored.TurnLifecycle)
	}
	if stored.Status != SessionStatusWorking {
		t.Fatalf("session status = %q, want working", stored.Status)
	}
	if _, ok := controller.activeTurn("room-1", "agent-session-1"); ok {
		t.Fatal("parent active turn map entry still exists")
	}
}

func TestControllerFinishTurnDoesNotRestoreClosedSession(t *testing.T) {
	t.Parallel()

	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	turnID := "turn-1"
	staleTurnSession := started.Session
	staleTurnSession.Status = SessionStatusCanceled
	staleTurnSession.TurnLifecycle = &TurnLifecycle{
		ActiveTurnID: &turnID,
		Phase:        "running",
	}
	controller.store(staleTurnSession)
	controller.mu.Lock()
	controller.turns[sessionKey(staleTurnSession.RoomID, staleTurnSession.AgentSessionID)] = activeTurn{turnID: turnID}
	controller.mu.Unlock()

	if _, err := controller.Close(context.Background(), CloseInput{
		RoomID:         staleTurnSession.RoomID,
		AgentSessionID: staleTurnSession.AgentSessionID,
	}); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// A turn goroutine can finish after Close has removed its session. Its stale
	// snapshot must not recreate the closed session and shadow the next Start.
	controller.finishTurn(staleTurnSession, turnID)
	if restored, ok := controller.Session(staleTurnSession.RoomID, staleTurnSession.AgentSessionID); ok {
		t.Fatalf("late turn finish restored closed session: %#v", restored)
	}
}

func TestControllerFinishTurnDoesNotOverwriteRestartedSession(t *testing.T) {
	t.Parallel()

	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "old session",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	turnID := "turn-1"
	staleTurnSession := started.Session
	staleTurnSession.Status = SessionStatusCanceled
	staleTurnSession.TurnLifecycle = &TurnLifecycle{
		ActiveTurnID: &turnID,
		Phase:        "running",
	}
	controller.store(staleTurnSession)
	controller.mu.Lock()
	controller.turns[sessionKey(staleTurnSession.RoomID, staleTurnSession.AgentSessionID)] = activeTurn{turnID: turnID}
	controller.mu.Unlock()

	if _, err := controller.Close(context.Background(), CloseInput{
		RoomID:         staleTurnSession.RoomID,
		AgentSessionID: staleTurnSession.AgentSessionID,
	}); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := controller.Start(context.Background(), StartInput{
		RoomID:         staleTurnSession.RoomID,
		AgentSessionID: staleTurnSession.AgentSessionID,
		Provider:       ProviderCodex,
		Title:          "fresh session",
	}); err != nil {
		t.Fatalf("restart: %v", err)
	}

	// The canceled turn can unwind after a same-ID session has restarted. Its
	// stale snapshot must not replace the fresh controller session.
	if controller.storeTurnSession(staleTurnSession, turnID) {
		t.Fatal("late turn event stored stale session after restart")
	}
	controller.finishTurn(staleTurnSession, turnID)
	restarted, ok := controller.Session(staleTurnSession.RoomID, staleTurnSession.AgentSessionID)
	if !ok {
		t.Fatal("restarted session missing")
	}
	if restarted.Title != "fresh session" || restarted.Status != SessionStatusReady {
		t.Fatalf("restarted session overwritten by stale turn: %#v", restarted)
	}
}

func TestControllerFinishTurnReconcilesCreatedStatusToReady(t *testing.T) {
	t.Parallel()

	controller := NewController(nil, nil)
	turnID := "turn-1"
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderTuttiAgent,
		Status:         "created",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &turnID,
			Phase:        "running",
		},
		SubmitAvailability: blockedSubmitAvailability("active_turn"),
	}
	controller.store(session)
	controller.mu.Lock()
	controller.turns[sessionKey(session.RoomID, session.AgentSessionID)] = activeTurn{turnID: turnID}
	controller.mu.Unlock()

	outcome := "completed"
	session.TurnLifecycle = &TurnLifecycle{Phase: "settled", Outcome: &outcome}
	session.SubmitAvailability = availableSubmitAvailability()
	controller.finishTurn(session, turnID)

	stored, ok := controller.get(session.RoomID, session.AgentSessionID)
	if !ok {
		t.Fatal("stored session missing")
	}
	if stored.Status != SessionStatusReady {
		t.Fatalf("session status = %q, want ready", stored.Status)
	}
	if stored.SubmitAvailability == nil || stored.SubmitAvailability.State != "available" {
		t.Fatalf("submit availability = %#v, want available", stored.SubmitAvailability)
	}
}

func waitForSessionStatus(t *testing.T, controller *Controller, roomID, agentSessionID, status string) Session {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		session, ok := controller.get(roomID, agentSessionID)
		if ok && session.Status == status {
			return session
		}
		time.Sleep(10 * time.Millisecond)
	}
	session, _ := controller.get(roomID, agentSessionID)
	t.Fatalf("session status = %q, want %q", session.Status, status)
	return Session{}
}

func waitForPublishedSessionEvent(t *testing.T, events <-chan StreamEvent, eventType string, callType string, status string) StreamEvent {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			if streamEventMatches(event, eventType, callType, status) {
				return event
			}
		case <-deadline:
			t.Fatalf("expected published event type=%q callType=%q status=%q", eventType, callType, status)
			return StreamEvent{}
		}
	}
}

func waitForStreamEventType(t *testing.T, events <-chan StreamEvent, eventType string) StreamEvent {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			if event.EventType == eventType {
				return event
			}
		case <-deadline:
			t.Fatalf("expected published stream event type=%q", eventType)
			return StreamEvent{}
		}
	}
}

func waitForStatePatchTitle(t *testing.T, events <-chan StreamEvent, title string) StreamEvent {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
			if event.EventType == StreamEventStatePatch && ok && patch.Title == title {
				return event
			}
		case <-deadline:
			t.Fatalf("expected published state patch title=%q", title)
			return StreamEvent{}
		}
	}
}

func waitForStatePatchPermissionMode(t *testing.T, events <-chan StreamEvent, permissionModeID string) StreamEvent {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
			if event.EventType == StreamEventStatePatch && ok && patch.PermissionModeID == permissionModeID {
				return event
			}
		case <-deadline:
			t.Fatalf("expected published state patch permissionModeId=%q", permissionModeID)
			return StreamEvent{}
		}
	}
}

func expectNoStreamEventType(t *testing.T, events <-chan StreamEvent, eventType string) {
	t.Helper()
	select {
	case event := <-events:
		if event.EventType == eventType {
			t.Fatalf("unexpected published stream event type=%q: %#v", eventType, event)
		}
	case <-time.After(100 * time.Millisecond):
	}
}

func streamEventMatches(event StreamEvent, eventType string, callType string, status string) bool {
	switch eventType {
	case EventCallStarted, EventCallCompleted, EventCallFailed:
		update, ok := event.Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
		if event.EventType != StreamEventMessageUpdate || !ok {
			return false
		}
		if update.Kind != "tool_call" {
			return false
		}
		if callType != "" && asString(update.Payload["callType"]) != callType {
			return false
		}
		return status == "" || update.Status == status || asString(update.Payload["status"]) == status
	case EventTurnStarted, EventTurnCompleted:
		patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
		if event.EventType != StreamEventStatePatch || !ok || patch.Turn == nil {
			return false
		}
		if eventType == EventTurnStarted && patch.Turn.StartedAtUnixMS == 0 {
			return false
		}
		if eventType == EventTurnCompleted && patch.Turn.CompletedAtUnixMS == 0 {
			return false
		}
		if status == SessionStatusCanceled {
			return patch.Turn.Outcome == SessionStatusCanceled ||
				patch.Turn.Outcome == string(activityshared.TurnOutcomeInterrupted)
		}
		if status == SessionStatusWorking {
			return patch.CurrentPhase == string(activityshared.TurnPhaseWorking)
		}
		return true
	default:
		return false
	}
}

func reportInputs(calls []reportCall) []agentsessionstore.ReportActivityInput {
	out := make([]agentsessionstore.ReportActivityInput, 0, len(calls))
	for _, call := range calls {
		out = append(out, call.report)
	}
	return out
}

func hasTimelineItem(report agentsessionstore.ReportActivityInput, itemType string, status string, text string) bool {
	for _, update := range report.MessageUpdates {
		if !messageUpdateMatchesLegacyItemType(update, itemType) {
			continue
		}
		if status != "" && update.Status != status && asString(update.Payload["status"]) != status {
			continue
		}
		if text != "" && update.Payload["text"] != text {
			continue
		}
		return true
	}
	return false
}

func hasTimelineItemWithCallType(report agentsessionstore.ReportActivityInput, itemType string, callType string, status string) bool {
	for _, update := range report.MessageUpdates {
		if !messageUpdateMatchesLegacyItemType(update, itemType) {
			continue
		}
		if callType != "" && asString(update.Payload["callType"]) != callType {
			continue
		}
		if status != "" && update.Status != status {
			continue
		}
		return true
	}
	return false
}

func reportWithTimelineItem(reports []agentsessionstore.ReportActivityInput, itemType string) (agentsessionstore.ReportActivityInput, bool) {
	for _, report := range reports {
		if hasTimelineItem(report, itemType, "", "") {
			return report, true
		}
	}
	return agentsessionstore.ReportActivityInput{}, false
}

func messageUpdateMatchesLegacyItemType(update agentsessionstore.WorkspaceAgentMessageUpdate, itemType string) bool {
	switch itemType {
	case "message.user":
		return update.Kind == "text" && update.Role == "user"
	case "message.assistant":
		return update.Kind == "text" && update.Role == "assistant"
	case "message.assistant_thinking":
		return update.Kind == "reasoning" && update.Role == "assistant"
	case "call.started":
		return update.Kind == "tool_call" && update.CompletedAtUnixMS == 0
	case "call.completed":
		return update.Kind == "tool_call" && update.Status == "completed"
	case "call.errored":
		return update.Kind == "tool_call" && update.Status == "failed"
	default:
		return false
	}
}

func hasTurnCompletionPatch(report agentsessionstore.ReportActivityInput, turnID string) bool {
	for _, patch := range report.StatePatches {
		if patch.Turn != nil &&
			patch.Turn.TurnID == turnID &&
			patch.Turn.CompletedAtUnixMS > 0 {
			return true
		}
	}
	return false
}

func hasTurnCompletionPatchInReports(reports []agentsessionstore.ReportActivityInput, turnID string) bool {
	for _, report := range reports {
		if hasTurnCompletionPatch(report, turnID) {
			return true
		}
	}
	return false
}

func hasSessionPhasePatch(reports []agentsessionstore.ReportActivityInput, phase string) bool {
	for _, report := range reports {
		for _, patch := range report.StatePatches {
			if patch.CurrentPhase == phase {
				return true
			}
		}
	}
	return false
}

func TestEnrichReportStatePatchesWithSessionMetadataFillsSnapshotTitleAndIdentity(t *testing.T) {
	t.Parallel()

	report := &agentsessionstore.ReportActivityInput{
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: "agent-session-1",
			CurrentPhase:   "failed",
		}},
	}
	enrichReportStatePatchesWithSessionMetadata(report, agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID:    "agent-session-1",
		Provider:          "codex",
		ProviderSessionID: "provider-session-1",
		Model:             "gpt-5",
		PermissionModeID:  "bypassPermissions",
		CWD:               "/workspace",
		Title:             "Automation Review",
		Settings:          map[string]any{"model": "gpt-5"},
		RuntimeContext: map[string]any{
			"title": "Automation Review",
			"cwd":   "/workspace",
		},
	})

	patch := report.StatePatches[0]
	if patch.Provider != "codex" ||
		patch.ProviderSessionID != "provider-session-1" ||
		patch.Model != "gpt-5" ||
		patch.PermissionModeID != "bypassPermissions" ||
		patch.CWD != "/workspace" ||
		patch.Title != "Automation Review" {
		t.Fatalf("enriched patch = %#v, want snapshot identity and title", patch)
	}
	if patch.RuntimeContext["title"] != "Automation Review" {
		t.Fatalf("runtime context = %#v, want title fallback", patch.RuntimeContext)
	}
}

func TestEnrichReportStatePatchesWithSessionMetadataKeepsIncomingTitle(t *testing.T) {
	t.Parallel()

	report := &agentsessionstore.ReportActivityInput{
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: "agent-session-1",
			Title:          "Provider title",
		}},
	}
	enrichReportStatePatchesWithSessionMetadata(report, agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID: "agent-session-1",
		Title:          "Automation Review",
	})

	if got := report.StatePatches[0].Title; got != "Provider title" {
		t.Fatalf("title = %q, want incoming provider title", got)
	}
}

func TestEnrichReportStatePatchesWithSessionMetadataDoesNotAttachTurnLifecycle(t *testing.T) {
	t.Parallel()

	activeTurnID := "root-turn-1"
	report := &agentsessionstore.ReportActivityInput{
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: "agent-session-1",
			RootProviderTurn: &canonical.WorkspaceAgentRootProviderTurnTransition{
				RootTurnID:     "root-turn-1",
				ProviderTurnID: "provider-turn-1",
				Phase:          agentsessionstore.RootProviderTurnPhaseCompleted,
			},
		}},
	}
	enrichReportStatePatchesWithSessionMetadata(report, agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{
			ActiveTurnID: &activeTurnID,
			Phase:        "waiting",
		},
		SubmitAvailability: &canonical.WorkspaceAgentSubmitAvailability{
			State:  "blocked",
			Reason: "active_turn",
		},
	})

	patch := report.StatePatches[0]
	if patch.Provider != ProviderClaudeCode {
		t.Fatalf("provider = %q, want session metadata", patch.Provider)
	}
	if patch.TurnLifecycle != nil || patch.SubmitAvailability != nil {
		t.Fatalf("persisted provider patch inherited runtime lifecycle: %#v", patch)
	}
}

func TestEnrichStreamStateEventsWithSessionSnapshotFillsRuntimeContext(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		provider: ProviderClaudeCode,
		snapshot: SessionStateSnapshot{
			AgentSessionID: "agent-session-1",
			Provider:       ProviderClaudeCode,
			TurnLifecycle: &TurnLifecycle{
				ActiveTurnID: stringPtr("synthetic-turn-1"),
				Phase:        "running",
			},
			SubmitAvailability: &SubmitAvailability{
				State:  "blocked",
				Reason: "active_turn",
			},
			PendingInteractive: &SessionInteractivePrompt{
				Kind:      "ask-user",
				RequestID: "request-1",
				ToolName:  "AskUserQuestion",
				Status:    "waiting",
				Input: map[string]any{
					"questions": []any{map[string]any{
						"id":       "scope",
						"question": "Scope?",
					}},
				},
			},
			RuntimeContext: map[string]any{
				"usage": map[string]any{
					"contextWindow": map[string]any{
						"usedTokens":  int64(38414),
						"totalTokens": int64(200000),
					},
				},
			},
		},
	}
	controller := NewController([]Adapter{adapter}, nil)
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
	}
	controller.store(session)
	events := []StreamEvent{{
		EventType: StreamEventStatePatch,
		Data: agentsessionstore.WorkspaceAgentStatePatch{
			AgentSessionID: "agent-session-1",
			CurrentPhase:   "idle",
		},
	}}

	controller.enrichStreamStateEventsWithSessionSnapshot(session, events)

	patch, ok := events[0].Data.(agentsessionstore.WorkspaceAgentStatePatch)
	if !ok {
		t.Fatalf("stream patch type = %T, want WorkspaceAgentStatePatch", events[0].Data)
	}
	usage, _ := patch.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, _ := int64Value(contextWindow["totalTokens"]); got != 200000 {
		t.Fatalf("runtime context usage = %#v, want totalTokens=200000", patch.RuntimeContext["usage"])
	}
	if patch.TurnLifecycle == nil ||
		patch.TurnLifecycle.ActiveTurnID == nil ||
		*patch.TurnLifecycle.ActiveTurnID != "synthetic-turn-1" ||
		patch.TurnLifecycle.Phase != "running" {
		t.Fatalf("turn lifecycle = %#v, want synthetic running", patch.TurnLifecycle)
	}
	if patch.SubmitAvailability == nil ||
		patch.SubmitAvailability.State != "blocked" ||
		patch.SubmitAvailability.Reason != "active_turn" {
		t.Fatalf("submit availability = %#v, want active_turn blocked", patch.SubmitAvailability)
	}
	if patch.InteractionTransition != nil {
		t.Fatalf("snapshot enrichment interaction transition = %#v, want nil", patch.InteractionTransition)
	}
}

func TestDeriveSessionStatusFromEvents(t *testing.T) {
	t.Parallel()

	session := Session{AgentSessionID: "agent-session-1", Provider: ProviderCodex}
	tests := []struct {
		name     string
		events   []activityshared.Event
		fallback string
		want     string
	}{
		{
			name:     "keeps working without terminal event",
			events:   []activityshared.Event{newTurnActivityEvent(session, EventTurnStarted, "turn-1", SessionStatusWorking, "", "", nil)},
			fallback: SessionStatusReady,
			want:     SessionStatusWorking,
		},
		{
			name:     "turn completed makes conversation ready",
			events:   []activityshared.Event{newTurnActivityEvent(session, EventTurnCompleted, "turn-1", SessionStatusCompleted, "", "", nil)},
			fallback: SessionStatusWorking,
			want:     SessionStatusReady,
		},
		{
			name:     "interrupted turn marks session canceled",
			events:   []activityshared.Event{newTurnActivityEvent(session, EventTurnCanceled, "turn-1", SessionStatusCanceled, "", "", nil)},
			fallback: SessionStatusWorking,
			want:     SessionStatusCanceled,
		},
		{
			name:     "failed terminal event wins",
			events:   []activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, "turn-1", SessionStatusFailed, "", "", nil)},
			fallback: SessionStatusWorking,
			want:     SessionStatusFailed,
		},
		{
			name:     "waiting turn update keeps session waiting",
			events:   []activityshared.Event{newTurnActivityEvent(session, EventTurnUpdated, "turn-1", SessionStatusWaiting, "", "", map[string]any{"phase": string(activityshared.TurnPhaseWaitingApproval)})},
			fallback: SessionStatusWorking,
			want:     SessionStatusWaiting,
		},
		{
			name:     "session completed ends session",
			events:   []activityshared.Event{newSessionActivityEvent(session, EventSessionCompleted, SessionStatusCompleted, nil)},
			fallback: SessionStatusWorking,
			want:     SessionStatusCompleted,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := deriveSessionStatusFromEvents(tt.events, tt.fallback); got != tt.want {
				t.Fatalf("status = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestApplySessionEventsTracksLastError(t *testing.T) {
	t.Parallel()

	session := Session{AgentSessionID: "agent-session-1", Provider: ProviderCodex}
	failed := applySessionEvents(session, []activityshared.Event{
		newTurnActivityEvent(session, EventTurnFailed, "turn-1", SessionStatusFailed, "", "", map[string]any{
			"error": "API Error: 403 Key limit exceeded",
		}),
	})
	if failed.LastError != "API Error: 403 Key limit exceeded" {
		t.Fatalf("last error = %q, want turn failure detail", failed.LastError)
	}

	restarted := applySessionEvents(failed, []activityshared.Event{
		newTurnActivityEvent(session, EventTurnStarted, "turn-2", SessionStatusWorking, "", "", nil),
	})
	if restarted.LastError != "" {
		t.Fatalf("last error after new turn = %q, want cleared", restarted.LastError)
	}
}

func TestApplySessionEventsMergesRuntimeContextMetadata(t *testing.T) {
	t.Parallel()

	session := Session{
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		RuntimeContext: map[string]any{
			"cwd": "/workspace",
		},
	}
	updated := applySessionEvents(session, []activityshared.Event{
		newSessionActivityEvent(session, EventSessionUpdated, SessionStatusReady, map[string]any{
			"runtimeContext": map[string]any{
				"providerConfig": map[string]any{
					"threadId": "thread-1",
				},
			},
		}),
	})
	if updated.RuntimeContext["cwd"] != "/workspace" {
		t.Fatalf("runtime context = %#v, want existing cwd kept", updated.RuntimeContext)
	}
	providerConfig := payloadObject(updated.RuntimeContext["providerConfig"])
	if providerConfig["threadId"] != "thread-1" {
		t.Fatalf("runtime context = %#v, want provider config", updated.RuntimeContext)
	}
}

func TestShouldAdvanceSessionUpdatedAtFromEvents(t *testing.T) {
	t.Parallel()

	session := Session{AgentSessionID: "agent-session-1", Provider: ProviderCodex}
	tests := []struct {
		name   string
		events []activityshared.Event
		want   bool
	}{
		{
			name:   "turn started advances recency",
			events: []activityshared.Event{newTurnActivityEvent(session, EventTurnStarted, "turn-1", SessionStatusWorking, "", "", nil)},
			want:   true,
		},
		{
			name:   "turn completed advances recency",
			events: []activityshared.Event{newTurnActivityEvent(session, EventTurnCompleted, "turn-1", SessionStatusReady, "", "", nil)},
			want:   true,
		},
		{
			name:   "turn canceled advances recency",
			events: []activityshared.Event{newTurnActivityEvent(session, EventTurnCanceled, "turn-1", SessionStatusCanceled, "", "", nil)},
			want:   true,
		},
		{
			name:   "turn failed advances recency",
			events: []activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, "turn-1", SessionStatusFailed, "", "", nil)},
			want:   true,
		},
		{
			name:   "turn updated does not advance recency",
			events: []activityshared.Event{newTurnActivityEvent(session, EventTurnUpdated, "turn-1", SessionStatusWaiting, "", "", nil)},
			want:   false,
		},
		{
			name:   "turn updated waiting advances recency",
			events: []activityshared.Event{newTurnActivityEvent(session, EventTurnUpdated, "turn-1", SessionStatusWaiting, "", "", map[string]any{"phase": string(activityshared.TurnPhaseWaitingApproval)})},
			want:   true,
		},
		{
			name:   "session update does not advance recency",
			events: []activityshared.Event{newSessionTitleActivityEvent(session, "Provider title")},
			want:   false,
		},
		{
			name:   "message does not advance recency by itself",
			events: []activityshared.Event{newTurnActivityEvent(session, EventMessage, "turn-1", "", RoleAssistant, "hello", nil)},
			want:   false,
		},
		{
			name:   "tool call does not advance recency by itself",
			events: []activityshared.Event{newTurnActivityEvent(session, EventCallStarted, "turn-1", messageStreamStateStreaming, "", "Read files", nil)},
			want:   false,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := shouldAdvanceSessionUpdatedAtFromEvents(tt.events); got != tt.want {
				t.Fatalf("shouldAdvanceSessionUpdatedAtFromEvents() = %v, want %v", got, tt.want)
			}
		})
	}
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

func TestControllerExactTurnCancelDoesNotCancelNewerActiveTurn(t *testing.T) {
	t.Parallel()

	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, &recordingReporter{})
	controller.store(Session{
		RoomID: "room-1", AgentSessionID: "agent-1", Provider: ProviderCodex,
		ProviderSessionID: "prov-1", Status: SessionStatusWorking,
	})
	controller.mu.Lock()
	controller.turns[sessionKey("room-1", "agent-1")] = activeTurn{turnID: "turn-new"}
	controller.mu.Unlock()

	result, err := controller.Cancel(context.Background(), rootCancelInput("room-1", "agent-1", "turn-old", "user"))
	if err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}
	if result.Canceled {
		t.Fatalf("Cancel() result = %#v, want not canceled", result)
	}
	if adapter.cancelCalls != 0 {
		t.Fatalf("adapter cancel calls = %d, want 0", adapter.cancelCalls)
	}
	active, ok := controller.activeTurn("room-1", "agent-1")
	if !ok || active.turnID != "turn-new" {
		t.Fatalf("active turn after exact cancel = %#v, %v, want turn-new", active, ok)
	}
}

func TestControllerExactTurnCancelHoldsLifecycleLockThroughAdapterCancel(t *testing.T) {
	t.Parallel()

	cancelEntered := make(chan struct{}, 1)
	cancelReleased := make(chan struct{})
	adapter := &recordingStartAdapter{
		provider: ProviderCodex, cancelEntered: cancelEntered, cancelReleased: cancelReleased,
	}
	controller := NewController([]Adapter{adapter}, &recordingReporter{})
	controller.store(Session{
		RoomID: "room-1", AgentSessionID: "agent-1", Provider: ProviderCodex,
		ProviderSessionID: "prov-1", Status: SessionStatusWorking,
	})
	controller.mu.Lock()
	controller.turns[sessionKey("room-1", "agent-1")] = activeTurn{turnID: "turn-1"}
	controller.mu.Unlock()

	cancelDone := make(chan error, 1)
	go func() {
		_, err := controller.Cancel(context.Background(), rootCancelInput("room-1", "agent-1", "turn-1", "user"))
		cancelDone <- err
	}()
	select {
	case <-cancelEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("adapter cancel did not start")
	}

	secondLockAcquired := make(chan struct{})
	go func() {
		release := controller.acquireLifecycleLock("room-1", "agent-1")
		close(secondLockAcquired)
		release()
	}()
	select {
	case <-secondLockAcquired:
		t.Fatal("session lifecycle lock was released before adapter cancel completed")
	case <-time.After(50 * time.Millisecond):
	}

	close(cancelReleased)
	select {
	case err := <-cancelDone:
		if err != nil {
			t.Fatalf("Cancel() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Cancel() did not finish")
	}
	select {
	case <-secondLockAcquired:
	case <-time.After(2 * time.Second):
		t.Fatal("session lifecycle lock was not released after adapter cancel")
	}
}

func TestGoalCapabilitiesWaitObservesContextCancellation(t *testing.T) {
	controller := NewController(nil, nil)
	release := controller.acquireLifecycleLock("room-1", "session-1")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := controller.GoalCapabilities(ctx, GoalReconcileInput{RoomID: "room-1", AgentSessionID: "session-1"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("GoalCapabilities error = %v", err)
	}
	release()
	controller.mu.Lock()
	remaining := len(controller.lifecycleLocks)
	controller.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("lifecycle lock references leaked: %d", remaining)
	}
}

func TestGoalControlWaitObservesContextCancellation(t *testing.T) {
	controller := NewController(nil, nil)
	release := controller.acquireLifecycleLock("room-1", "session-1")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := controller.GoalControl(ctx, GoalControlInput{RoomID: "room-1", AgentSessionID: "session-1"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("GoalControl error = %v", err)
	}
	release()
	controller.mu.Lock()
	remaining := len(controller.lifecycleLocks)
	controller.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("lifecycle lock references leaked: %d", remaining)
	}
}

// TestControllerCancelLeavesSettledSessionUntouched guards against the
// reconciliation disturbing healthy sessions: a session that is already settled
// must not be re-settled or re-reported when stop is pressed with no active turn.
func TestControllerCancelLeavesSettledSessionUntouched(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, reporter)

	outcome := "completed"
	controller.store(Session{
		RoomID:             "room-1",
		AgentSessionID:     "agent-1",
		Provider:           ProviderCodex,
		ProviderSessionID:  "prov-1",
		Status:             SessionStatusReady,
		TurnLifecycle:      &TurnLifecycle{Phase: "settled", Outcome: &outcome},
		SubmitAvailability: availableSubmitAvailability(),
		UpdatedAtUnixMS:    1,
	})

	if _, err := controller.Cancel(context.Background(), rootCancelInput("room-1", "agent-1", "turn-1", "user")); err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	if calls := reporter.snapshot(); len(calls) != 0 {
		t.Fatalf("reporter calls = %d, want 0 for an already-settled session", len(calls))
	}
}
