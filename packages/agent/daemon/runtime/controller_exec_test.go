package agentruntime

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func boolPtr(value bool) *bool {
	return &value
}

func TestControllerExecCleanupBackpressurePrecedesTurnAndProviderDispatch(t *testing.T) {
	t.Parallel()

	transport := &multiProcStandardACPTransport{
		agentTitle:               "Kimi Code",
		sessionID:                "kimi-session-exec-backpressure",
		supportsAgentLoadSession: true,
	}
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	controller := NewController([]Adapter{adapter}, &recordingReporter{})
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-exec-backpressure",
		AgentSessionID: "agent-exec-backpressure",
		Provider:       "acp:kimi-code",
		CWD:            "/workspace",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	transport.mu.Lock()
	oldConnection := transport.conns[0]
	transport.mu.Unlock()
	oldConnection.mu.Lock()
	oldConnection.closeFailures = 3
	oldConnection.mu.Unlock()

	if err := adapter.ReleaseLiveSession(context.Background(), started.Session); err == nil {
		t.Fatal("ReleaseLiveSession error = nil, want injected close failure")
	}
	if err := adapter.Resume(context.Background(), started.Session); err != nil {
		t.Fatalf("first replacement Resume: %v", err)
	}
	if err := adapter.ReleaseLiveSession(context.Background(), started.Session); err != nil {
		t.Fatalf("replacement release: %v", err)
	}
	spawnedBefore, _ := transport.snapshot()

	result, err := controller.Exec(context.Background(), ExecInput{
		RoomID:                          started.Session.RoomID,
		AgentSessionID:                  started.Session.AgentSessionID,
		ClientSubmitID:                  "submit-exec-backpressure",
		CanonicalSubmitOccurredAtUnixMS: time.Now().UnixMilli(),
		Content:                         textPrompt("keep this draft"),
		RequireProviderAcceptance:       true,
		TurnID:                          "turn-must-not-exist",
	})
	if AppErrorCode(err) != AppErrorProcessCleanupPending {
		t.Fatalf("Exec error code = %q (err=%v), want %q", AppErrorCode(err), err, AppErrorProcessCleanupPending)
	}
	if result.ProviderDispatch == nil || result.ProviderDispatch.Disposition != DispatchDispositionNotDispatched {
		t.Fatalf("provider dispatch = %#v, want not dispatched", result.ProviderDispatch)
	}
	if controller.HasActiveTurn(started.Session.RoomID, started.Session.AgentSessionID) {
		t.Fatal("cleanup backpressure created an active Turn")
	}
	if session, ok := controller.Session(started.Session.RoomID, started.Session.AgentSessionID); !ok || session.Status != SessionStatusReady {
		t.Fatalf("session after blocked Exec = %#v (ok=%v), want ready canonical session", session, ok)
	}
	spawnedAfter, _ := transport.snapshot()
	if spawnedAfter != spawnedBefore {
		t.Fatalf("spawned processes after blocked Exec = %d, want %d", spawnedAfter, spawnedBefore)
	}
	transport.mu.Lock()
	replacementConnection := transport.conns[1]
	transport.mu.Unlock()
	replacementConnection.mu.Lock()
	promptCalls := replacementConnection.promptCallCount
	replacementConnection.mu.Unlock()
	if promptCalls != 0 {
		t.Fatalf("provider prompt calls = %d, want 0", promptCalls)
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
		RoomID:                          started.Session.RoomID,
		AgentSessionID:                  started.Session.AgentSessionID,
		TurnID:                          first.TurnID,
		Content:                         textPrompt("guide current turn"),
		Guidance:                        true,
		ClientSubmitID:                  "guidance-submit-1",
		CanonicalSubmitOccurredAtUnixMS: 1_234,
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

func TestControllerExecGuidanceRejectsChangedExactTargetBeforeProviderCall(t *testing.T) {
	t.Parallel()

	adapter := &guidanceBlockingAdapter{blockingExecAdapter: newBlockingExecAdapter()}
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
	_, err = controller.Exec(ctx, ExecInput{
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
		TurnID:         "turn-no-longer-active",
		Content:        textPrompt("stale guidance"),
		Guidance:       true,
	})
	if !errors.Is(err, ErrActiveTurnTargetMismatch) {
		t.Fatalf("guidance error = %v, want %v", err, ErrActiveTurnTargetMismatch)
	}
	if result.ProviderDispatch == nil || result.ProviderDispatch.Disposition != DispatchDispositionNotDispatched {
		t.Fatalf("guidance result = %#v, want not-dispatched result", result)
	}
	if got := adapter.guidanceCalls.Load(); got != 0 {
		t.Fatalf("provider guidance calls = %d, want 0", got)
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
