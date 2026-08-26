package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestStandardACPAdapterSessionStateExposesPendingAskUserPrompt(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-interactive-1")
	transport.conn.promptKind = "ask-user"
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "hermes-session-interactive-1"

	var mu sync.Mutex
	var emittedActivity []activityshared.Event
	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("choose renderer"), "", "turn-ask-user", func(events []activityshared.Event) {
			mu.Lock()
			emittedActivity = append(emittedActivity, events...)
			mu.Unlock()
		}, nil)
		execDone <- err
	}()

	waitForCondition(t, func() bool {
		snapshot := adapter.SessionState(session)
		return snapshot.PendingInteractive != nil &&
			snapshot.PendingInteractive.Kind == "ask-user" &&
			snapshot.PendingInteractive.RequestID == "permission-1"
	})

	snapshot := adapter.SessionState(session)
	if snapshot.PendingInteractive == nil {
		t.Fatal("pending interactive = nil, want ask-user prompt")
	}
	if snapshot.PendingInteractive.ToolName != "AskUserQuestion" {
		t.Fatalf("tool name = %q, want AskUserQuestion", snapshot.PendingInteractive.ToolName)
	}
	questions, _ := snapshot.PendingInteractive.Input["questions"].([]any)
	if len(questions) == 0 {
		t.Fatalf("interactive input = %#v, want questions", snapshot.PendingInteractive.Input)
	}
	mu.Lock()
	events := append([]activityshared.Event(nil), emittedActivity...)
	mu.Unlock()
	if requested := eventsOfType(events, activityshared.EventInteractionRequested); len(requested) != 1 ||
		requested[0].Payload.Interaction == nil || requested[0].Payload.Interaction.Kind != "question" {
		t.Fatalf("ask-user events = %#v, want explicit question interaction.requested", events)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := adapter.SubmitInteractive(canceled, session, SubmitInteractiveInput{
		RoomID:         session.RoomID,
		AgentSessionID: session.AgentSessionID,
		TurnID:         "turn-ask-user",
		RequestID:      "permission-1",
		Action:         "submit",
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled SubmitInteractive error = %v, want context canceled", err)
	}
	if pending := adapter.getPendingApproval(session.AgentSessionID, "turn-ask-user", "permission-1"); pending == nil || pending.disposition() != pendingInteractiveRequestStatePending {
		t.Fatalf("pending disposition after canceled submit = %v, want pending", runtimeInteractiveDisposition(pending))
	}

	_, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RoomID:         session.RoomID,
		AgentSessionID: session.AgentSessionID,
		TurnID:         "turn-ask-user",
		RequestID:      "permission-1",
		Action:         "submit",
		// Canonical GUI ask-user payload: flat display list + keyed map.
		Payload: map[string]any{
			"answers":             []any{"Renderer A"},
			"answersByQuestionId": map[string]any{"render-path": "Renderer A"},
		},
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if err := <-execDone; err != nil {
		t.Fatalf("Exec after interactive submission: %v", err)
	}
	outcome := transport.conn.interactiveOutcome()
	if got := asString(outcome["outcome"]); got != "submit" {
		t.Fatalf("interactive outcome = %#v, want submit", outcome)
	}
	payload, _ := outcome["payload"].(map[string]any)
	if payload == nil || payload["answersByQuestionId"] == nil {
		t.Fatalf("interactive payload = %#v, want answersByQuestionId", outcome)
	}
}

func TestCursorACPAskQuestionUsesNativeBlockingRequest(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-native-question")
	transport.conn.promptKind = "cursor-ask-question"
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-native-question"

	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("choose a renderer"), "", "turn-cursor-question", func([]activityshared.Event) {}, nil)
		execDone <- err
	}()
	waitForCondition(t, func() bool {
		snapshot := adapter.SessionState(session)
		return snapshot.PendingInteractive != nil && snapshot.PendingInteractive.Kind == "ask-user"
	})

	snapshot := adapter.SessionState(session)
	if snapshot.PendingInteractive == nil || snapshot.PendingInteractive.ToolName != "AskUserQuestion" {
		t.Fatalf("pending interactive = %#v, want canonical AskUserQuestion", snapshot.PendingInteractive)
	}
	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RoomID:         session.RoomID,
		AgentSessionID: session.AgentSessionID,
		TurnID:         "turn-cursor-question",
		RequestID:      "cursor-ask-1",
		Action:         "submit",
		Payload: map[string]any{
			"answersByQuestionId": map[string]any{"renderer": "Modern"},
		},
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	select {
	case err := <-execDone:
		if err != nil {
			t.Fatalf("Exec after native question response: %v", err)
		}
	case <-time.After(2 * time.Second):
		transport.conn.mu.Lock()
		pendingPromptID := string(transport.conn.pendingPermissionCallID)
		selected := clonePayload(transport.conn.selectedInteractiveResult)
		transport.conn.mu.Unlock()
		t.Fatalf("Exec did not finish after native question response; pendingPromptID=%q selected=%#v", pendingPromptID, selected)
	}
	outcome := transport.conn.interactiveOutcome()
	if got := asString(outcome["outcome"]); got != "answered" {
		t.Fatalf("native question outcome = %#v, want answered", outcome)
	}
	answers := payloadArray(outcome["answers"])
	if len(answers) != 1 || asString(payloadObject(answers[0])["questionId"]) != "renderer" {
		t.Fatalf("native question answers = %#v, want renderer answer", outcome)
	}
	selected, ok := payloadObject(answers[0])["selectedOptionIds"].([]any)
	if !ok || len(selected) != 1 || asString(selected[0]) != "modern" {
		t.Fatalf("native question selected ids = %#v, want modern", outcome)
	}
}

func TestCursorACPCreatePlanUsesNativeBlockingRequest(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-native-plan")
	transport.conn.promptKind = "cursor-create-plan"
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-native-plan"

	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("make a plan"), "", "turn-cursor-plan", func([]activityshared.Event) {}, nil)
		execDone <- err
	}()
	waitForCondition(t, func() bool {
		snapshot := adapter.SessionState(session)
		return snapshot.PendingInteractive != nil && snapshot.PendingInteractive.Kind == "exit-plan"
	})

	snapshot := adapter.SessionState(session)
	if snapshot.PendingInteractive == nil || snapshot.PendingInteractive.ToolName != "CreatePlan" {
		t.Fatalf("pending interactive = %#v, want native CreatePlan", snapshot.PendingInteractive)
	}
	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RoomID:         session.RoomID,
		AgentSessionID: session.AgentSessionID,
		TurnID:         "turn-cursor-plan",
		RequestID:      "cursor-plan-1",
		Action:         "allow",
		OptionID:       "accept",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if err := <-execDone; err != nil {
		t.Fatalf("Exec after native plan response: %v", err)
	}
	outcome := transport.conn.interactiveOutcome()
	if got := asString(outcome["outcome"]); got != "accepted" {
		t.Fatalf("native plan outcome = %#v, want accepted", outcome)
	}
}

// Kimi Code sends session/request_permission before the matching tool_call
// update. The first frame identifies AskUserQuestion and its selectable
// outcomes; the next frame carries the question body. AgentGUI reads canonical
// Interactions rather than transcript tool rows, so the adapter must join both
// frames before publishing interaction.requested.
func TestStandardACPAdapterJoinsKimiAskUserQuestionInputAfterPermission(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Kimi Code", "kimi-session-interactive-1")
	transport.conn.promptKind = "ask-user-after-permission"
	toolUpdateGate := make(chan struct{})
	transport.conn.pauseBeforeAskUserToolUpdate = toolUpdateGate
	var releaseToolUpdate sync.Once
	release := func() {
		releaseToolUpdate.Do(func() {
			close(toolUpdateGate)
		})
	}
	defer release()
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)
	session.Provider = "acp:kimi-code"
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "kimi-session-interactive-1"

	var mu sync.Mutex
	var emittedActivity []activityshared.Event
	permissionStarted := make(chan struct{}, 1)
	requested := make(chan activityshared.Event, 1)
	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("ask how I feel"), "", "turn-kimi-ask-user", func(events []activityshared.Event) {
			mu.Lock()
			emittedActivity = append(emittedActivity, events...)
			mu.Unlock()
			for _, event := range events {
				if event.Type == activityshared.EventCallStarted &&
					event.Payload.CallID == "interactive-ask-1" {
					select {
					case permissionStarted <- struct{}{}:
					default:
					}
				}
				if event.Type == activityshared.EventInteractionRequested {
					select {
					case requested <- event:
					default:
					}
				}
			}
		}, nil)
		execDone <- err
	}()

	select {
	case <-permissionStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("Kimi permission request was not observed before the tool update")
	}
	if snapshot := adapter.SessionState(session); snapshot.PendingInteractive != nil {
		t.Fatalf(
			"pending interactive before tool input = %#v, want incomplete prompt hidden from SessionState",
			snapshot.PendingInteractive,
		)
	}
	mu.Lock()
	prematureRequested := eventsOfType(emittedActivity, activityshared.EventInteractionRequested)
	mu.Unlock()
	if len(prematureRequested) != 0 {
		t.Fatalf("premature interaction.requested events = %#v, want none before tool input", prematureRequested)
	}
	release()

	var interaction activityshared.Event
	select {
	case interaction = <-requested:
	case <-time.After(2 * time.Second):
		t.Fatal("AskUserQuestion interaction was not published after the tool input arrived")
	}
	if interaction.Payload.Interaction == nil {
		t.Fatalf("interaction event = %#v, want canonical interaction payload", interaction)
	}
	questions := payloadArray(interaction.Payload.Interaction.Input["questions"])
	if len(questions) != 1 ||
		asString(questions[0]["id"]) != "question-1" ||
		asString(questions[0]["question"]) != "你今天心情怎么样？" ||
		len(payloadArray(questions[0]["options"])) != 3 ||
		questions[0]["allowFreeText"] != false {
		t.Fatalf("interaction questions = %#v, want one normalized option-only Kimi question", questions)
	}

	snapshot := adapter.SessionState(session)
	if snapshot.PendingInteractive == nil ||
		len(payloadArray(snapshot.PendingInteractive.Input["questions"])) != 1 {
		t.Fatalf("pending interactive = %#v, want the joined Kimi question input", snapshot.PendingInteractive)
	}

	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RoomID:         session.RoomID,
		AgentSessionID: session.AgentSessionID,
		TurnID:         "turn-kimi-ask-user",
		RequestID:      "permission-1",
		Action:         "submit",
		Payload: map[string]any{
			"answers":             []any{"很好"},
			"answersByQuestionId": map[string]any{"question-1": "很好"},
		},
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	select {
	case err := <-execDone:
		if err != nil {
			t.Fatalf("Exec after interactive submission: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Exec did not finish after the Kimi interactive response")
	}

	mu.Lock()
	requestedEvents := eventsOfType(emittedActivity, activityshared.EventInteractionRequested)
	mu.Unlock()
	if len(requestedEvents) != 1 {
		t.Fatalf("interaction.requested count = %d, want one complete canonical interaction", len(requestedEvents))
	}
	outcome := transport.conn.interactiveOutcome()
	if got := asString(outcome["outcome"]); got != "selected" {
		t.Fatalf("Kimi ACP outcome = %#v, want selected", outcome)
	}
	if got := asString(outcome["optionId"]); got != "q0_opt_0" {
		t.Fatalf("Kimi ACP outcome = %#v, want optionId q0_opt_0", outcome)
	}
	if payload, _ := outcome["payload"].(map[string]any); len(payload) != 0 {
		t.Fatalf("Kimi ACP outcome = %#v, want protocol-native selected response without payload", outcome)
	}
	callCompletedIndex := -1
	providerCompletedIndex := -1
	var callCompletedOutput map[string]any
	for index, event := range emittedActivity {
		if event.Type == activityshared.EventCallCompleted &&
			event.Payload.CallID == "interactive-ask-1" {
			callCompletedIndex = index
			callCompletedOutput = event.Payload.Output
		}
		if event.Type == activityshared.EventRootProviderTurnCompleted {
			providerCompletedIndex = index
		}
	}
	if callCompletedIndex < 0 ||
		providerCompletedIndex < 0 ||
		callCompletedIndex >= providerCompletedIndex {
		t.Fatalf(
			"interactive call completed index=%d provider turn completed index=%d, want local resolution first",
			callCompletedIndex,
			providerCompletedIndex,
		)
	}
	localPayload := payloadObject(callCompletedOutput["payload"])
	localAnswers, _ := localPayload["answers"].([]any)
	if len(localAnswers) != 1 || asString(localAnswers[0]) != "很好" {
		t.Fatalf("local completed output = %#v, want the canonical answer preserved", callCompletedOutput)
	}
	localAnswersByQuestionID := payloadObject(localPayload["answersByQuestionId"])
	if len(localAnswersByQuestionID) != 1 || asString(localAnswersByQuestionID["question-1"]) != "很好" {
		t.Fatalf("local completed output = %#v, want the canonical per-question answer preserved", callCompletedOutput)
	}
}

func TestStandardACPAdapterJoinsKimiApprovalDetailAfterPermission(t *testing.T) {
	t.Parallel()
	transport := newStandardACPTransport("Kimi Code", "kimi-session-approval-1")
	transport.conn.promptKind = "approval-after-permission"
	gate := make(chan struct{})
	transport.conn.pauseBeforeAskUserToolUpdate = gate
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	session := standardTestSession("acp:kimi-code")
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	session.ProviderSessionID = "kimi-session-approval-1"
	requested := make(chan activityshared.Event, 2)
	started := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("read the file"), "", "turn-kimi-read", func(events []activityshared.Event) {
			for _, event := range events {
				if event.Type == activityshared.EventCallStarted && event.Payload.CallID == "read-file-1" {
					select {
					case started <- struct{}{}:
					default:
					}
				}
				if event.Type == activityshared.EventInteractionRequested {
					requested <- event
				}
			}
		}, nil)
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("permission not observed")
	}
	select {
	case event := <-requested:
		t.Fatalf("premature interaction: %#v", event)
	default:
	}
	wrongTurnUpdate := json.RawMessage(`{"update":{"sessionUpdate":"tool_call","toolCallId":"read-file-1","title":"Read file","kind":"read","status":"pending","rawInput":{"path":"C:\\\\Users\\\\anonymous\\\\workspace\\\\wrong-turn.txt"}}}`)
	wrongTurnNormalizer := newACPTurnNormalizer()
	_ = standardACPUpdateEvents(adapter.config, session, "turn-other", wrongTurnUpdate, wrongTurnNormalizer)
	if events := adapter.standardACPDeferredInteractionRequestedEvents(session, "turn-other", wrongTurnUpdate, wrongTurnNormalizer); len(events) != 0 {
		t.Fatalf("wrong-turn update published interaction: %#v", events)
	}
	close(gate)
	var event activityshared.Event
	select {
	case event = <-requested:
	case <-time.After(2 * time.Second):
		t.Fatal("joined interaction not published")
	}
	toolInput := payloadObject(payloadObject(event.Payload.Interaction.Input["toolCall"])["input"])
	if got := asString(toolInput["path"]); got != `C:\Users\anonymous\workspace\secret.txt` {
		t.Fatalf("path=%q input=%#v", got, event.Payload.Interaction.Input)
	}
	select {
	case duplicate := <-requested:
		t.Fatalf("duplicate interaction: %#v", duplicate)
	default:
	}
	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{TurnID: "turn-kimi-read", RequestID: "permission-1", OptionID: "reject"}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("exec did not finish")
	}
	select {
	case stale := <-requested:
		t.Fatalf("stale interaction after resolution=%#v", stale)
	default:
	}
}

func TestStandardACPAdapterKeepsKimiApprovalHiddenWhenToolUpdateNeverArrives(t *testing.T) {
	t.Parallel()
	transport := newStandardACPTransport("Kimi Code", "kimi-session-fallback")
	transport.conn.promptPermission = true
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	session := standardTestSession("acp:kimi-code")
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	session.ProviderSessionID = "kimi-session-fallback"
	permissionStarted := make(chan struct{}, 1)
	cancellationResolved := make(chan struct{}, 1)
	done := make(chan error, 1)
	var mu sync.Mutex
	var emittedActivity []activityshared.Event
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("run"), "", "turn-fallback", func(events []activityshared.Event) {
			batchStarted := false
			batchResolved := false
			for _, event := range events {
				if event.Type == activityshared.EventCallStarted && event.Payload.CallID == "approval-1" {
					batchStarted = true
				}
				if event.Type == activityshared.EventCallFailed && event.Payload.CallID == "approval-1" {
					batchResolved = true
				}
			}
			mu.Lock()
			emittedActivity = append(emittedActivity, events...)
			mu.Unlock()
			if batchStarted {
				select {
				case permissionStarted <- struct{}{}:
				default:
				}
			}
			if batchResolved {
				select {
				case cancellationResolved <- struct{}{}:
				default:
				}
			}
		}, nil)
		done <- err
	}()
	select {
	case <-permissionStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("permission not observed")
	}
	mu.Lock()
	requestedBeforeCancel := eventsOfType(emittedActivity, activityshared.EventInteractionRequested)
	supersededBeforeCancel := eventsOfType(emittedActivity, activityshared.EventInteractionSuperseded)
	mu.Unlock()
	if len(requestedBeforeCancel) != 0 || len(supersededBeforeCancel) != 0 {
		t.Fatalf("interaction events before cancellation: requested=%#v superseded=%#v", requestedBeforeCancel, supersededBeforeCancel)
	}
	if snapshot := adapter.SessionState(session); snapshot.PendingInteractive != nil {
		t.Fatalf("pending interactive before cancellation=%#v, want hidden approval", snapshot.PendingInteractive)
	}
	cancelEvents, err := adapter.Cancel(context.Background(), session, "user")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if len(cancelEvents) != 0 {
		t.Fatalf("Cancel events=%#v, want provider acknowledgment events only", cancelEvents)
	}
	transport.conn.mu.Lock()
	cancelCalls := transport.conn.cancelCalls
	cancelSessionID := asString(transport.conn.lastCancelParams["sessionId"])
	transport.conn.mu.Unlock()
	if cancelCalls != 1 || cancelSessionID != session.ProviderSessionID {
		t.Fatalf("ACP cancel calls=%d sessionId=%q, want one call for %q", cancelCalls, cancelSessionID, session.ProviderSessionID)
	}
	select {
	case err := <-done:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("Exec error=%v, want nil or canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("exec did not finish")
	}
	select {
	case <-cancellationResolved:
	case <-time.After(2 * time.Second):
		t.Fatal("permission cancellation did not resolve")
	}
	mu.Lock()
	requested := eventsOfType(emittedActivity, activityshared.EventInteractionRequested)
	superseded := eventsOfType(emittedActivity, activityshared.EventInteractionSuperseded)
	failed := eventsOfType(emittedActivity, activityshared.EventCallFailed)
	turnUpdates := eventsOfType(emittedActivity, activityshared.EventTurnUpdated)
	mu.Unlock()
	if len(requested) != 0 || len(superseded) != 0 {
		t.Fatalf("hidden approval interaction events after cancellation: requested=%#v superseded=%#v", requested, superseded)
	}
	if snapshot := adapter.SessionState(session); snapshot.PendingInteractive != nil {
		t.Fatalf("pending interactive after cancellation=%#v, want nil", snapshot.PendingInteractive)
	}
	if pending := adapter.getPendingApproval(session.AgentSessionID, "turn-fallback", "permission-1"); pending != nil {
		t.Fatalf("pending approval after cancellation=%#v, want removed", pending)
	}
	if got := adapter.terminalInteractiveDisposition(session.AgentSessionID, "turn-fallback", "permission-1"); got != InteractiveDispositionInterrupted {
		t.Fatalf("terminal disposition=%q, want %q", got, InteractiveDispositionInterrupted)
	}
	if len(failed) != 1 || failed[0].Payload.CallID != "approval-1" {
		t.Fatalf("call.failed events=%#v, want approval-1 failure", failed)
	}
	foundWorking := false
	for _, event := range turnUpdates {
		if event.Payload.TurnID == "turn-fallback" && event.Payload.TurnPhase == string(activityshared.TurnPhaseWorking) {
			foundWorking = true
		}
	}
	if !foundWorking {
		t.Fatalf("turn.updated events=%#v, want turn-fallback working", turnUpdates)
	}
}

func TestStandardACPAdapterRejectsUnsupportedKimiAskUserQuestionBeforePublication(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		promptKind string
		wantError  string
	}{
		{
			name:       "multiple questions",
			promptKind: "ask-user-after-permission-multi-question",
			wantError:  "exactly one question",
		},
		{
			name:       "multi select",
			promptKind: "ask-user-after-permission-multi-select",
			wantError:  "does not support multi-select",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			transport := newStandardACPTransport("Kimi Code", "kimi-session-unsupported-"+strings.ReplaceAll(tt.name, " ", "-"))
			transport.conn.promptKind = tt.promptKind
			adapter := newHermesExtensionTestAdapter(transport)
			session := standardTestSession(hermesExtensionTestProvider)
			session.Provider = "acp:kimi-code"
			if _, err := adapter.Start(context.Background(), session); err != nil {
				t.Fatalf("Start: %v", err)
			}
			session.ProviderSessionID = transport.conn.sessionID

			var mu sync.Mutex
			var emittedActivity []activityshared.Event
			execDone := make(chan error, 1)
			go func() {
				_, err := adapter.Exec(context.Background(), session, textPrompt("ask unsupported question"), "", "turn-kimi-unsupported", func(events []activityshared.Event) {
					mu.Lock()
					emittedActivity = append(emittedActivity, events...)
					mu.Unlock()
				}, nil)
				execDone <- err
			}()

			select {
			case err := <-execDone:
				if err != nil {
					t.Fatalf("Exec after unsupported question rejection: %v", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("Exec did not finish after rejecting the unsupported Kimi question")
			}

			mu.Lock()
			requested := eventsOfType(emittedActivity, activityshared.EventInteractionRequested)
			superseded := eventsOfType(emittedActivity, activityshared.EventInteractionSuperseded)
			completed := eventsOfType(emittedActivity, activityshared.EventCallCompleted)
			failed := eventsOfType(emittedActivity, activityshared.EventCallFailed)
			mu.Unlock()
			if len(requested) != 0 {
				t.Fatalf("interaction.requested events = %#v, want none for unsupported provider shape", requested)
			}
			if len(superseded) != 0 {
				t.Fatalf("interaction.superseded events = %#v, want no canonical Interaction before publication", superseded)
			}
			for _, event := range completed {
				if event.Payload.CallID == "interactive-ask-1" {
					t.Fatalf("unsupported AskUserQuestion completed locally: %#v", event)
				}
			}
			if len(failed) == 0 {
				t.Fatal("unsupported AskUserQuestion did not emit call.failed")
			}
			responseErr := transport.conn.interactiveError()
			if responseErr == nil || !strings.Contains(responseErr.Message, tt.wantError) {
				t.Fatalf("provider response error = %#v, want containing %q", responseErr, tt.wantError)
			}
			if snapshot := adapter.SessionState(session); snapshot.PendingInteractive != nil {
				t.Fatalf("pending interactive = %#v, want unsupported request removed", snapshot.PendingInteractive)
			}
		})
	}
}

func TestStandardACPAdapterRejectsNonCanonicalKimiAskUserAnswer(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Kimi Code", "kimi-session-invalid-answer")
	transport.conn.promptKind = "ask-user-after-permission"
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)
	session.Provider = "acp:kimi-code"
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "kimi-session-invalid-answer"

	var mu sync.Mutex
	var emittedActivity []activityshared.Event
	requested := make(chan struct{}, 1)
	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("ask how I feel"), "", "turn-kimi-invalid-answer", func(events []activityshared.Event) {
			mu.Lock()
			emittedActivity = append(emittedActivity, events...)
			mu.Unlock()
			for _, event := range events {
				if event.Type == activityshared.EventInteractionRequested {
					select {
					case requested <- struct{}{}:
					default:
					}
				}
			}
		}, nil)
		execDone <- err
	}()

	select {
	case <-requested:
	case <-time.After(2 * time.Second):
		t.Fatal("supported Kimi question was not published")
	}
	result, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RoomID:         session.RoomID,
		AgentSessionID: session.AgentSessionID,
		TurnID:         "turn-kimi-invalid-answer",
		RequestID:      "permission-1",
		Action:         "submit",
		Payload: map[string]any{
			"answers": []any{"很好", "一般"},
			"answersByQuestionId": map[string]any{
				"question-1": "很好",
				"question-2": "一般",
			},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "exactly one canonical answer") {
		t.Fatalf("SubmitInteractive error = %v, want canonical-answer rejection", err)
	}
	if result.Disposition != InteractiveDispositionSuperseded {
		t.Fatalf("SubmitInteractive disposition = %q, want superseded", result.Disposition)
	}
	select {
	case err := <-execDone:
		if err != nil {
			t.Fatalf("Exec after invalid answer rejection: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Exec did not finish after invalid answer rejection")
	}

	mu.Lock()
	completed := eventsOfType(emittedActivity, activityshared.EventCallCompleted)
	failed := eventsOfType(emittedActivity, activityshared.EventCallFailed)
	superseded := eventsOfType(emittedActivity, activityshared.EventInteractionSuperseded)
	mu.Unlock()
	for _, event := range completed {
		if event.Payload.CallID == "interactive-ask-1" {
			t.Fatalf("invalid AskUser answer completed locally: %#v", event)
		}
	}
	if len(failed) == 0 || len(superseded) == 0 {
		t.Fatalf("failed events = %d, superseded events = %d, want both", len(failed), len(superseded))
	}
	if responseErr := transport.conn.interactiveError(); responseErr == nil ||
		!strings.Contains(responseErr.Message, "exactly one canonical answer") {
		t.Fatalf("provider response error = %#v, want canonical-answer rejection", responseErr)
	}
	if disposition := adapter.InteractiveDisposition(session, "turn-kimi-invalid-answer", "permission-1"); disposition != InteractiveDispositionSuperseded {
		t.Fatalf("terminal disposition = %q, want superseded", disposition)
	}
}

func TestStandardACPAdapterSessionStateExposesPendingExitPlanPrompt(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-plan-1")
	transport.conn.promptKind = "exit-plan"
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "hermes-session-plan-1"

	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("review plan"), "", "turn-plan", func([]activityshared.Event) {}, nil)
		execDone <- err
	}()

	waitForCondition(t, func() bool {
		snapshot := adapter.SessionState(session)
		return snapshot.PendingInteractive != nil &&
			snapshot.PendingInteractive.Kind == "exit-plan" &&
			snapshot.PendingInteractive.RequestID == "permission-1"
	})

	snapshot := adapter.SessionState(session)
	if snapshot.PendingInteractive == nil || snapshot.PendingInteractive.ToolName != "ExitPlanMode" {
		t.Fatalf("pending interactive = %#v, want ExitPlanMode", snapshot.PendingInteractive)
	}

	_, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RoomID:         session.RoomID,
		AgentSessionID: session.AgentSessionID,
		TurnID:         "turn-plan",
		RequestID:      "permission-1",
		Action:         "allow",
		OptionID:       "acceptEdits",
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if err := <-execDone; err != nil {
		t.Fatalf("Exec after exit-plan submission: %v", err)
	}
	outcome := transport.conn.interactiveOutcome()
	if got := asString(outcome["optionId"]); got != "acceptEdits" {
		t.Fatalf("interactive outcome = %#v, want optionId acceptEdits", outcome)
	}
}
