//nolint:unused // Retain migrated test fixtures until the next agent-daemon decomposition pass.
package agentruntime

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

type recordingReporter struct {
	mu    sync.Mutex
	calls []reportCall
}

type reportCall struct {
	report agentsessionstore.ReportActivityInput
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
	return nil
}

func (r *recordingReporter) snapshot() []reportCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]reportCall(nil), r.calls...)
}

func (r *recordingReporter) waitForCalls(t *testing.T, count int) []reportCall {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		calls := r.snapshot()
		if len(calls) >= count {
			return calls
		}
		if time.Now().After(deadline) {
			t.Fatalf("report calls = %d, want at least %d", len(calls), count)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestControllerStartFailureCreatesFailedSessionAndVisibleErrorReport(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	controller := NewController([]Adapter{failingStartAdapter{}}, reporter)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderHermes,
		CWD:            "/workspace",
		Title:          "Hermes",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Session.Status != SessionStatusFailed {
		t.Fatalf("session status = %q, want failed", started.Session.Status)
	}
	if started.Error == nil || started.Error.Code != "process_exited" {
		t.Fatalf("start error = %#v, want process_exited", started.Error)
	}
	if started.Session.LastError != "acp process exited with code 1: Config invalid" {
		t.Fatalf("session last error = %q, want visible start failure detail", started.Session.LastError)
	}
	stored, ok := controller.get("room-1", "agent-session-1")
	if !ok || stored.Status != SessionStatusFailed {
		t.Fatalf("stored session = %#v, ok=%v", stored, ok)
	}
	if stored.LastError != "acp process exited with code 1: Config invalid" {
		t.Fatalf("stored last error = %q, want visible start failure detail", stored.LastError)
	}
	reports := reporter.waitForCalls(t, 1)
	if len(reports[0].report.StatePatches) != 1 {
		t.Fatalf("state patches = %#v, want failed session patch", reports[0].report.StatePatches)
	}
	if len(reports[0].report.MessageUpdates) != 1 {
		t.Fatalf("message updates = %#v, want visible failure message", reports[0].report.MessageUpdates)
	}
	item := reports[0].report.MessageUpdates[0]
	if item.Payload["kind"] != visibleErrorKind ||
		item.Payload["phase"] != "start" ||
		item.Payload["detail"] != "acp process exited with code 1: Config invalid" {
		t.Fatalf("visible start failure item = %#v", item)
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
		Title:    "Codex",
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
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("hello"),
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

func TestControllerStartExecCancelPublishesAndReports(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	controller := NewDefaultControllerWithProcessTransport(reporter, newScriptedACPTransport())
	ctx := context.Background()

	started, err := controller.Start(ctx, StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
		Title:    "Codex",
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
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("hello"),
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
	select {
	case event := <-events:
		update, ok := event.Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
		if event.EventType != StreamEventMessageUpdate ||
			!ok ||
			update.Kind != "text" ||
			update.Role != "user" ||
			update.Payload["text"] != "hello" {
			t.Fatalf("published second exec event = %#v, want user message", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected user message event to be published")
	}
	waitForCondition(t, func() bool {
		updatedSession, ok := controller.get("room-1", started.Session.AgentSessionID)
		return ok &&
			updatedSession.Status == SessionStatusReady &&
			updatedSession.Title == "Inspect repository structure"
	})

	cancelResult, err := controller.Cancel(ctx, CancelInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Reason:         "user",
	})
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if cancelResult.Canceled {
		t.Fatalf("Cancel result = %#v, want no active turn cancel", cancelResult)
	}
	reporter.waitForCalls(t, 2)
	waitForCondition(t, func() bool {
		return len(reportsWithTimelineItem(reportInputs(reporter.snapshot()), "message.assistant")) > 0
	})
	reportCalls := reporter.snapshot()
	if len(reportCalls[0].report.StatePatches) == 0 ||
		reportCalls[0].report.StatePatches[0].LifecycleStatus != string(activityshared.SessionLifecycleStatusActive) {
		t.Fatalf("first report = %#v, want session started state patch", reportCalls[0].report)
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
	if !hasTurnCompletionPatchInReports(reportInputs(reportCalls), execResult.TurnID) {
		t.Fatalf("report calls = %#v, want turn completion state patch", reportCalls)
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

	reports := reporter.waitForCalls(t, 1)
	report := reports[0].report
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

func TestControllerStartPassesOpenclawGatewayReadyToTransport(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	controller := NewDefaultControllerWithProcessTransport(nil, transport)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:               "room-1",
		AgentSessionID:       "agent-session-1",
		Provider:             ProviderOpenClaw,
		CWD:                  "/workspace",
		Title:                "OpenClaw",
		OpenclawGatewayReady: true,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Session.AgentSessionID != "agent-session-1" {
		t.Fatalf("agent session id = %q, want propagated id", started.Session.AgentSessionID)
	}

	transport.mu.Lock()
	defer transport.mu.Unlock()
	if len(transport.specs) != 1 {
		t.Fatalf("transport specs = %d, want 1", len(transport.specs))
	}
	if !transport.specs[0].OpenclawGatewayReady {
		t.Fatalf("process spec = %#v, want openclaw gateway ready", transport.specs[0])
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
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		RequestID:      "permission-1",
		OptionID:       "allow_once",
	}); err != nil {
		t.Fatalf("SubmitInteractive after request context cancel: %v", err)
	}
	waitForCondition(t, func() bool {
		return transport.conn.permissionOptionID() == "allow_once"
	})
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
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
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("wait for approval"),
	}); err != nil {
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
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("long prompt"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	adapter.waitForPrompt(t, "long prompt")

	cancelResult, err := controller.Cancel(context.Background(), CancelInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Reason:         "user_interrupt",
	})
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if !cancelResult.Canceled {
		t.Fatalf("Cancel result = %#v, want canceled active turn", cancelResult)
	}
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusCanceled)
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
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run tests"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	waitForPublishedSessionEvent(t, events, EventCallStarted, "approval", "waiting_approval")

	if _, err := controller.Cancel(context.Background(), CancelInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Reason:         "user",
	}); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusCanceled)
	if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		RequestID:      "permission-1",
		OptionID:       "allow_once",
	}); err == nil {
		t.Fatal("SubmitInteractive after cancel returned nil error, want no longer live")
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
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("first"),
	}); err != nil {
		t.Fatalf("Exec first turn: %v", err)
	}
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusWorking)

	cancelResult, err := controller.Cancel(context.Background(), CancelInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Reason:         "user_interrupt",
	})
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
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("hello"),
	}); err != nil {
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

	cancelResult, err := controller.Cancel(context.Background(), CancelInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Reason:         "user",
	})
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

type failingStartAdapter struct{}

func (failingStartAdapter) Provider() string { return ProviderHermes }

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

type blockingExecAdapter struct {
	mu       sync.Mutex
	seen     []string
	displays []string
	contexts chan context.Context
	started  chan string
	releases chan struct{}
}

func newBlockingExecAdapter() *blockingExecAdapter {
	return &blockingExecAdapter{
		contexts: make(chan context.Context, 8),
		started:  make(chan string, 8),
		releases: make(chan struct{}, 8),
	}
}

func (*blockingExecAdapter) Provider() string { return ProviderCodex }

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

func (*blockingExecAdapter) SubmitInteractive(_ context.Context, session Session, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
	return SubmitInteractiveResult{
		AgentSessionID: session.AgentSessionID,
		RequestID:      strings.TrimSpace(input.RequestID),
		Accepted:       true,
	}, nil
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
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		RequestID:      "request-1",
		Action:         "submit",
		OptionID:       "option-1",
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
				RoomID:         "room-1",
				AgentSessionID: started.Session.AgentSessionID,
				RequestID:      "permission-1",
				OptionID:       tt.optionID,
				Payload:        tt.payload,
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
			if patch.RuntimeContext["permissionModeId"] != tt.wantMode {
				t.Fatalf("patch runtime context = %#v, want permission mode %q", patch.RuntimeContext, tt.wantMode)
			}
			if patch.LifecycleStatus != "" || patch.CurrentPhase != "" {
				t.Fatalf("patch status fields = %q/%q, want empty permission-only patch", patch.LifecycleStatus, patch.CurrentPhase)
			}
		})
	}
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
		{name: "auto", provider: ProviderClaudeCode, optionID: "auto"},
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
				RoomID:         "room-1",
				AgentSessionID: started.Session.AgentSessionID,
				RequestID:      "permission-1",
				OptionID:       tt.optionID,
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
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		RequestID:      "permission-1",
		OptionID:       "acceptEdits",
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
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		RequestID:      "permission-1",
		Action:         "deny",
		OptionID:       "abort",
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
			return patch.Turn.Outcome == string(activityshared.TurnOutcomeInterrupted)
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

func TestEnrichReportStatePatchesFillsSnapshotTitleAndIdentity(t *testing.T) {
	t.Parallel()

	report := &agentsessionstore.ReportActivityInput{
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: "agent-session-1",
			CurrentPhase:   "failed",
		}},
	}
	enrichReportStatePatches(report, agentsessionstore.WorkspaceAgentStatePatch{
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

func TestEnrichReportStatePatchesKeepsIncomingTitle(t *testing.T) {
	t.Parallel()

	report := &agentsessionstore.ReportActivityInput{
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: "agent-session-1",
			Title:          "Provider title",
		}},
	}
	enrichReportStatePatches(report, agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID: "agent-session-1",
		Title:          "Automation Review",
	})

	if got := report.StatePatches[0].Title; got != "Provider title" {
		t.Fatalf("title = %q, want incoming provider title", got)
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
