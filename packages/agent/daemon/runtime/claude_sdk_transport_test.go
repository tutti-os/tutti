package agentruntime

import (
	"context"
	"strings"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestClaudeCodeSDKAdapterExecWithSidecarTestDriver(t *testing.T) {
	t.Setenv(claudeSDKSidecarTestDriverEnv, "1")
	t.Setenv(claudeSDKSidecarEntryPathEnv, "")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	adapter := NewClaudeCodeSDKAdapter(NewLocalProcessTransport())
	session := standardTestSession(ProviderClaudeCode)
	session.CWD = t.TempDir()

	startEvents, err := adapter.Start(ctx, session)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if len(startEvents) != 1 || startEvents[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("Start() events = %#v, want session.started", startEvents)
	}
	if strings.HasPrefix(startEvents[0].ProviderSessionID, "claude-sdk-") {
		t.Fatalf("ProviderSessionID = %q, want Claude SDK-compatible UUID", startEvents[0].ProviderSessionID)
	}
	if !hasClaudeSDKModelConfigOptions(startEvents[0].Payload.Metadata) {
		t.Fatalf("Start() metadata = %#v, want SDK model config options", startEvents[0].Payload.Metadata)
	}
	session.ProviderSessionID = startEvents[0].ProviderSessionID
	defer func() {
		_ = adapter.Close(context.Background(), session)
	}()

	var streamed []activityshared.Event
	events, err := adapter.Exec(
		ctx,
		session,
		[]PromptContentBlock{{Type: "text", Text: "say hello"}},
		"say hello",
		"turn-sdk-1",
		func(next []activityshared.Event) { streamed = append(streamed, next...) },
		nil,
	)
	if err != nil {
		t.Fatalf("Exec() error = %v", err)
	}
	if len(events) == 0 {
		t.Fatal("Exec() events empty")
	}
	if len(streamed) == 0 {
		t.Fatal("streamed events empty")
	}

	var sawUser bool
	var assistantText string
	var completed bool
	for _, event := range events {
		if event.Type == activityshared.EventMessageAppended &&
			event.Payload.Role == activityshared.MessageRoleUser &&
			event.Payload.Content == "say hello" {
			sawUser = true
		}
		if event.Type == activityshared.EventMessageAppended &&
			event.Payload.Role == activityshared.MessageRoleAssistant {
			assistantText = event.Payload.Content
		}
		if event.Type == activityshared.EventTurnCompleted &&
			event.Payload.TurnOutcome == string(activityshared.TurnOutcomeCompleted) {
			completed = true
		}
	}
	if !sawUser {
		t.Fatalf("events missing user prompt: %#v", events)
	}
	if !strings.Contains(assistantText, "Echo: say hello") {
		t.Fatalf("assistant text = %q, want echo", assistantText)
	}
	if !completed {
		t.Fatalf("events missing completed turn: %#v", events)
	}
}

func TestClaudeCodeSDKAdapterExecApprovalWithSidecarTestDriver(t *testing.T) {
	t.Setenv(claudeSDKSidecarTestDriverEnv, "1")
	t.Setenv(claudeSDKSidecarEntryPathEnv, "")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	adapter := NewClaudeCodeSDKAdapter(NewLocalProcessTransport())
	session := standardTestSession(ProviderClaudeCode)
	session.CWD = t.TempDir()

	startEvents, err := adapter.Start(ctx, session)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	session.ProviderSessionID = startEvents[0].ProviderSessionID
	defer func() {
		_ = adapter.Close(context.Background(), session)
	}()

	streamed := make(chan []activityshared.Event, 16)
	done := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(
			ctx,
			session,
			[]PromptContentBlock{{Type: "text", Text: "approval"}},
			"approval",
			"turn-sdk-approval",
			func(next []activityshared.Event) { streamed <- next },
			nil,
		)
		done <- err
	}()

	requestID := ""
	deadline := time.After(5 * time.Second)
	for requestID == "" {
		select {
		case events := <-streamed:
			for _, event := range events {
				if event.Type == activityshared.EventCallStarted && event.Payload.CallType == "approval" {
					requestID = asString(event.Payload.Input["requestId"])
				}
			}
		case <-deadline:
			t.Fatal("timed out waiting for approval request")
		}
	}

	result, err := adapter.SubmitInteractive(ctx, session, SubmitInteractiveInput{
		TurnID:    "turn-sdk-approval",
		RequestID: requestID,
		OptionID:  "allow",
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if !result.Accepted {
		t.Fatalf("SubmitInteractive result = %#v, want accepted", result)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Exec() error = %v", err)
		}
	case <-deadline:
		t.Fatal("timed out waiting for Exec completion")
	}
}

func TestClaudeCodeSDKAdapterReaderKeepsDrainingAfterTurnTerminal(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		conn:              conn,
		reader:            &claudeSDKLineReader{conn: conn},
		session:           session,
		providerSessionID: "provider-session-1",
		pendingRequests:   make(map[string]*pendingInteractiveRequest),
		pendingResponses:  make(map[string]chan claudeSDKSidecarEvent),
		turns:             make(map[string]*claudeSDKTurnWaiter),
		liveState:         newClaudeSDKLiveState(),
	})
	sessionEvents := make(chan []activityshared.Event, 4)
	adapter.SetSessionEventSink(func(agentSessionID string, events []activityshared.Event) {
		if agentSessionID == session.AgentSessionID {
			sessionEvents <- events
		}
	})

	done := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(ctx, session, []PromptContentBlock{{Type: "text", Text: "delegate"}}, "delegate", "turn-background", nil, nil)
		done <- err
	}()
	waitForClaudeSDKSentRequest(t, conn, "exec")
	conn.pushEvent(claudeSDKSidecarEvent{
		Type:    "turn_completed",
		Payload: map[string]any{"turnId": "turn-background", "stopReason": "end_turn"},
	})
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Exec: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for Exec completion")
	}

	conn.pushEvent(claudeSDKSidecarEvent{
		Type: "assistant_completed",
		Payload: map[string]any{
			"turnId":  "turn-background",
			"content": "background agent finished",
		},
	})
	select {
	case events := <-sessionEvents:
		if len(events) != 1 || events[0].Type != activityshared.EventMessageAppended || events[0].Payload.Content != "background agent finished" {
			t.Fatalf("late events = %#v, want assistant message through session sink", events)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for late background event")
	}
}

// TestClaudeCodeSDKAdapterDropsUntrackedTurnTerminalEvent reproduces the
// Rkyo8B report: the same agent session shows both a completion and a
// failure toast simultaneously. The sidecar can settle a turn (e.g. a
// queued/steered turn discarded via its own turnQueue) that never went
// through Exec()/ExecAsync() and therefore never had a waiter registered.
// Forwarding that stray terminal event unconditionally used to publish a
// second, contradictory outcome-carrying activity event for the session
// alongside the real turn's own completion. The dispatcher must drop
// terminal events for turns it never tracked instead of forwarding them.
func TestClaudeCodeSDKAdapterDropsUntrackedTurnTerminalEvent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		conn:              conn,
		reader:            &claudeSDKLineReader{conn: conn},
		session:           session,
		providerSessionID: "provider-session-1",
		pendingRequests:   make(map[string]*pendingInteractiveRequest),
		pendingResponses:  make(map[string]chan claudeSDKSidecarEvent),
		turns:             make(map[string]*claudeSDKTurnWaiter),
		liveState:         newClaudeSDKLiveState(),
	})
	sessionEvents := make(chan []activityshared.Event, 4)
	adapter.SetSessionEventSink(func(agentSessionID string, events []activityshared.Event) {
		if agentSessionID == session.AgentSessionID {
			sessionEvents <- events
		}
	})

	done := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(ctx, session, []PromptContentBlock{{Type: "text", Text: "open the site"}}, "open the site", "turn-real", nil, nil)
		done <- err
	}()
	waitForClaudeSDKSentRequest(t, conn, "exec")
	conn.pushEvent(claudeSDKSidecarEvent{
		Type:    "turn_completed",
		Payload: map[string]any{"turnId": "turn-real", "stopReason": "end_turn"},
	})
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Exec: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for Exec completion")
	}

	// A different, never-Exec'd turn (e.g. discarded from the sidecar's own
	// turnQueue) settles as failed. No waiter was ever registered for it, so
	// this must be dropped rather than published as a stray outcome event.
	conn.pushEvent(claudeSDKSidecarEvent{
		Type:    "turn_failed",
		Payload: map[string]any{"turnId": "turn-queued-orphan", "error": "browser tool call failed"},
	})
	// Follow it with a normal, trackable event on a fresh turn to prove the
	// reader keeps draining and the orphan didn't wedge or crash dispatch.
	conn.pushEvent(claudeSDKSidecarEvent{
		Type:    "assistant_completed",
		Payload: map[string]any{"turnId": "turn-real", "content": "done"},
	})

	select {
	case events := <-sessionEvents:
		if len(events) != 1 || events[0].Type != activityshared.EventMessageAppended {
			t.Fatalf("events = %#v, want only the trailing assistant message (orphan turn_failed must be dropped)", events)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for post-orphan event")
	}

	select {
	case unexpected := <-sessionEvents:
		t.Fatalf("unexpected extra session events published for orphan turn: %#v", unexpected)
	case <-time.After(50 * time.Millisecond):
	}
}

// TestClaudeCodeSDKAdapterClosesSyntheticTurnLifecycleWithoutExecWaiter covers
// the stuck "正在规划下一步" report: after a Claude SDK background Agent finishes,
// the sidecar opens a synthetic continuation turn (turn_started, no Exec waiter)
// and later settles it. Start and completed/failed/canceled must share the same
// session-sink lifecycle; dropping the terminal left durable activeTurn running.
func TestClaudeCodeSDKAdapterClosesSyntheticTurnLifecycleWithoutExecWaiter(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		session:           session,
		providerSessionID: "provider-session-1",
		pendingRequests:   make(map[string]*pendingInteractiveRequest),
		pendingResponses:  make(map[string]chan claudeSDKSidecarEvent),
		turns:             make(map[string]*claudeSDKTurnWaiter),
		liveState:         newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	var published []activityshared.Event
	adapter.SetSessionEventSink(func(agentSessionID string, events []activityshared.Event) {
		if agentSessionID == session.AgentSessionID {
			published = append(published, events...)
		}
	})

	adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "turn_started",
		Payload: map[string]any{
			"turnId":    "synthetic-continuation-1",
			"synthetic": true,
		},
	})
	adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "assistant_completed",
		Payload: map[string]any{
			"turnId":  "synthetic-continuation-1",
			"content": "background agent summary",
		},
	})
	adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "turn_completed",
		Payload: map[string]any{
			"turnId":     "synthetic-continuation-1",
			"stopReason": "end_turn",
		},
	})

	var sawStarted, sawMessage, sawCompleted bool
	for _, event := range published {
		switch event.Type {
		case activityshared.EventTurnStarted:
			sawStarted = true
			if event.Payload.TurnID != "synthetic-continuation-1" {
				t.Fatalf("start turn id = %q", event.Payload.TurnID)
			}
			if event.Payload.Metadata["synthetic"] != true {
				t.Fatalf("start metadata = %#v, want synthetic=true", event.Payload.Metadata)
			}
		case activityshared.EventMessageAppended:
			sawMessage = true
		case activityshared.EventTurnCompleted:
			sawCompleted = true
			if event.Payload.TurnID != "synthetic-continuation-1" {
				t.Fatalf("completed turn id = %q", event.Payload.TurnID)
			}
		}
	}
	if !sawStarted || !sawMessage || !sawCompleted {
		t.Fatalf("published = %#v, want synthetic start + message + completed", published)
	}
}

func TestClaudeCodeSDKAdapterRoundTripUsesReaderDispatcherAfterExec(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		conn:              conn,
		reader:            &claudeSDKLineReader{conn: conn},
		session:           session,
		providerSessionID: "provider-session-1",
		pendingRequests:   make(map[string]*pendingInteractiveRequest),
		pendingResponses:  make(map[string]chan claudeSDKSidecarEvent),
		turns:             make(map[string]*claudeSDKTurnWaiter),
		liveState:         newClaudeSDKLiveState(),
	})

	done := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(ctx, session, []PromptContentBlock{{Type: "text", Text: "hello"}}, "hello", "turn-settings", nil, nil)
		done <- err
	}()
	waitForClaudeSDKSentRequest(t, conn, "exec")
	conn.pushEvent(claudeSDKSidecarEvent{
		Type:    "turn_completed",
		Payload: map[string]any{"turnId": "turn-settings", "stopReason": "end_turn"},
	})
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Exec: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for Exec completion")
	}

	applyDone := make(chan error, 1)
	go func() {
		applyDone <- adapter.ApplySessionSettings(ctx, session, SessionSettingsPatch{Speed: stringPtr("fast")})
	}()
	request := waitForClaudeSDKSentRequest(t, conn, "apply_settings")
	conn.pushEvent(claudeSDKSidecarEvent{ID: request.ID, Type: "ok"})
	select {
	case err := <-applyDone:
		if err != nil {
			t.Fatalf("ApplySessionSettings: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for dispatcher-routed round trip")
	}
	if got := adapter.SessionState(session).RuntimeContext["speed"]; got != "fast" {
		t.Fatalf("runtime speed = %#v, want fast", got)
	}
}

func TestClaudeSDKLineReaderExitErrorSanitizesCapturedStderrTail(t *testing.T) {
	exitCode := 1
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{
			{Stderr: []byte("TypeError: token sk-secret user@example.com /Users/private/main.ts\n")},
			{ExitCode: &exitCode},
		},
	}
	reader := &claudeSDKLineReader{conn: conn}

	_, err := reader.next(context.Background())
	if err == nil {
		t.Fatal("next() err = nil, want exit error")
	}
	if !strings.Contains(err.Error(), "exited with code 1") {
		t.Fatalf("next() err = %q, want it to mention the exit code", err.Error())
	}
	if !strings.Contains(err.Error(), "sidecar runtime exception") {
		t.Fatalf("next() err = %q, want sanitized failure classification", err.Error())
	}
	for _, sensitive := range []string{"sk-secret", "user@example.com", "/Users/private", "TypeError"} {
		if strings.Contains(err.Error(), sensitive) {
			t.Fatalf("next() err = %q, leaked %q", err.Error(), sensitive)
		}
	}
}

func TestClaudeSDKLineReaderExitErrorOmitsColonWhenNoStderr(t *testing.T) {
	exitCode := -1
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{ExitCode: &exitCode}},
	}
	reader := &claudeSDKLineReader{conn: conn}

	_, err := reader.next(context.Background())
	want := "claude sdk sidecar exited with code -1"
	if err == nil || err.Error() != want {
		t.Fatalf("next() err = %v, want %q", err, want)
	}
}

func TestClaudeCodeSDKAdapterMapsToolFailed(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)

	events, terminal, err := adapter.sidecarTurnEvents(&claudeSDKAdapterSession{}, session, "turn-1", claudeSDKSidecarEvent{
		Type: "tool_failed",
		Payload: map[string]any{
			"toolCallId": "toolu-failed",
			"toolName":   "Bash",
			"callType":   "command",
			"name":       "Bash",
			"error": map[string]any{
				"text": "command failed",
			},
			"output": map[string]any{
				"text": "stderr",
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("tool_failed err=%v terminal=%v", err, terminal)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventCallFailed {
		t.Fatalf("events = %#v, want call.failed", events)
	}
	if events[0].Payload.CallID != "toolu-failed" || events[0].Payload.Status != messageStreamStateFailed {
		t.Fatalf("failed payload = %#v", events[0].Payload)
	}
	if events[0].Payload.Output["text"] != "stderr" {
		t.Fatalf("failed output = %#v, want stderr mirrored", events[0].Payload.Output)
	}
}

func TestClaudeCodeSDKAdapterControllerPublishesUIActivityWithSidecarTestDriver(t *testing.T) {
	t.Setenv(claudeSDKSidecarTestDriverEnv, "1")
	t.Setenv(claudeSDKSidecarEntryPathEnv, "")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	reporter := &recordingReporter{}
	controller := NewController([]Adapter{NewClaudeCodeSDKAdapter(NewLocalProcessTransport())}, reporter)
	started, err := controller.Start(ctx, StartInput{
		RoomID:   "room-1",
		Provider: ProviderClaudeCode,
		CWD:      t.TempDir(),
		Title:    "Claude Code",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	state, err := controller.State(started.Session.RoomID, started.Session.AgentSessionID)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if !hasClaudeSDKModelConfigOptions(state.RuntimeContext) {
		t.Fatalf("State runtimeContext = %#v, want SDK model config options", state.RuntimeContext)
	}
	defer func() {
		_, _ = controller.Close(context.Background(), CloseInput{
			RoomID:         started.Session.RoomID,
			AgentSessionID: started.Session.AgentSessionID,
		})
	}()

	events, unsubscribe, ok := controller.Subscribe(started.Session.RoomID, started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()

	execResult, err := controller.Exec(ctx, ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("say hello"),
		DisplayPrompt:  "say hello",
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !execResult.Accepted || execResult.TurnID == "" {
		t.Fatalf("Exec result = %#v, want accepted result with turn id", execResult)
	}

	var sawUserStream bool
	var sawAssistantStream bool
	deadline := time.After(3 * time.Second)
	for !sawUserStream || !sawAssistantStream {
		select {
		case event := <-events:
			update, ok := event.Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
			if !ok || event.EventType != StreamEventMessageUpdate {
				continue
			}
			if update.Role == "user" && update.Payload["text"] == "say hello" {
				sawUserStream = true
			}
			if update.Role == "assistant" && strings.Contains(asString(update.Payload["content"]), "Echo: say hello") {
				sawAssistantStream = true
			}
		case <-deadline:
			t.Fatalf("stream user=%v assistant=%v, want both", sawUserStream, sawAssistantStream)
		}
	}

	waitForSessionStatus(t, controller, started.Session.RoomID, started.Session.AgentSessionID, SessionStatusReady)
	waitForCondition(t, func() bool {
		reports := reportInputs(reporter.snapshot())
		return hasTimelineItemInReports(reports, "message.user", "completed", "say hello") &&
			hasTimelineItemInReports(reports, "message.assistant", "completed", "") &&
			hasTurnCompletionPatchInReports(reports, execResult.TurnID)
	})
}
