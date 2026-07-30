package agentruntime

import (
	"context"
	"errors"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"sync"
	"testing"
)

func TestCodexAppServerAdapterCommandApprovalApprove(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.commandApproval = true

	var streamed []activityshared.Event
	var streamedMu sync.Mutex
	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "clean the build dir",
		}}, "", "turn-local-1", func(next []activityshared.Event) {
			streamedMu.Lock()
			streamed = append(streamed, next...)
			streamedMu.Unlock()
		}, nil)
		execDone <- events
	}()

	waitForCondition(t, func() bool {
		return adapter.getPendingRequest(session.AgentSessionID, "turn-local-1", "approval-1") != nil
	})
	state := adapter.SessionState(session)
	if state.PendingInteractive == nil || state.PendingInteractive.Kind != "approval" {
		t.Fatalf("pending interactive = %#v, want approval", state.PendingInteractive)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := adapter.SubmitInteractive(canceled, session, SubmitInteractiveInput{
		TurnID:    "turn-local-1",
		RequestID: "approval-1",
		OptionID:  "approve",
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled SubmitInteractive error = %v, want context canceled", err)
	}
	if pending := adapter.getPendingRequest(session.AgentSessionID, "turn-local-1", "approval-1"); pending == nil || pending.disposition() != pendingInteractiveRequestStatePending {
		t.Fatalf("pending disposition after canceled submit = %v, want pending", runtimeInteractiveDisposition(pending))
	}

	result, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		TurnID:    "turn-local-1",
		RequestID: "approval-1",
		OptionID:  "approve",
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if !result.Accepted || result.OptionID != "approve" {
		t.Fatalf("submit result = %#v", result)
	}

	<-execDone
	waitForCondition(t, func() bool {
		transport.server.mu.Lock()
		defer transport.server.mu.Unlock()
		return transport.server.approvalResponse != nil
	})
	waitForCondition(t, func() bool {
		streamedMu.Lock()
		defer streamedMu.Unlock()
		return len(eventsOfType(streamed, activityshared.EventCallCompleted)) > 0
	})
	transport.server.mu.Lock()
	response := transport.server.approvalResponse
	transport.server.mu.Unlock()
	resultPayload := payloadObject(response["result"])
	if asString(resultPayload["decision"]) != "accept" {
		t.Fatalf("approval response = %#v, want decision accept", response)
	}

	streamedMu.Lock()
	streamedCopy := append([]activityshared.Event(nil), streamed...)
	streamedMu.Unlock()
	var sawWaiting bool
	var sawRequested bool
	for _, event := range streamedCopy {
		if event.Type == activityshared.EventCallStarted &&
			asString(event.Payload.Metadata["callType"]) == "approval" {
			sawWaiting = true
		}
		if event.Type == activityshared.EventInteractionRequested &&
			event.Payload.Interaction != nil &&
			event.Payload.Interaction.RequestID == "approval-1" {
			sawRequested = true
		}
	}
	if !sawWaiting {
		t.Fatalf("approval call.started was not streamed: %#v", streamedCopy)
	}
	if !sawRequested {
		t.Fatalf("approval interaction.requested was not streamed: %#v", streamedCopy)
	}
	if completedCalls := eventsOfType(streamedCopy, activityshared.EventCallCompleted); len(completedCalls) == 0 {
		t.Fatalf("approval resolution missing call.completed: %#v", streamedCopy)
	}
}

func TestCodexAppServerAdapterServerRequestResolvedFailsPendingApprovalWithoutClaimingSuccess(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.commandApproval = true

	var streamed []activityshared.Event
	var streamedMu sync.Mutex
	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "clean the build dir",
		}}, "", "turn-local-1", func(next []activityshared.Event) {
			streamedMu.Lock()
			streamed = append(streamed, next...)
			streamedMu.Unlock()
		}, nil)
		execDone <- events
	}()

	waitForCondition(t, func() bool {
		return adapter.getPendingRequest(session.AgentSessionID, "turn-local-1", "approval-1") != nil
	})
	if state := adapter.SessionState(session); state.PendingInteractive == nil {
		t.Fatalf("pending interactive should be visible before serverRequest/resolved")
	}

	transport.conn.notify(appServerNotifyServerRequestResolved, map[string]any{
		"threadId":  "codex-thread-1",
		"requestId": "approval-1",
	})
	waitForCondition(t, func() bool {
		return adapter.InteractiveDisposition(session, "turn-local-1", "approval-1") == InteractiveDispositionSuperseded
	})
	// The provider resolved this request without ever telling tutti the
	// decision, so we must not claim the underlying call succeeded (that
	// previously rendered a phantom "completed" file-output card even
	// though nothing was actually written). It should surface as failed.
	waitForCondition(t, func() bool {
		streamedMu.Lock()
		defer streamedMu.Unlock()
		return len(eventsOfType(streamed, activityshared.EventCallFailed)) > 0
	})
	streamedMu.Lock()
	if completedCalls := eventsOfType(streamed, activityshared.EventCallCompleted); len(completedCalls) > 0 {
		streamedMu.Unlock()
		t.Fatalf("serverRequest/resolved with no known decision must not emit call.completed: %#v", completedCalls)
	}
	streamedMu.Unlock()
	if state := adapter.SessionState(session); state.PendingInteractive != nil {
		t.Fatalf("pending interactive after serverRequest/resolved = %#v, want nil", state.PendingInteractive)
	}
	transport.server.mu.Lock()
	response := transport.server.approvalResponse
	transport.server.mu.Unlock()
	if response != nil {
		t.Fatalf("out-of-band resolved request should not send approval response, got %#v", response)
	}

	transport.server.completePendingTurn()
	events := <-execDone
	if failedCalls := eventsOfType(events, activityshared.EventCallFailed); len(failedCalls) == 0 {
		t.Fatalf("serverRequest/resolved missing call.failed: %#v", events)
	}
	if completedCalls := eventsOfType(events, activityshared.EventCallCompleted); len(completedCalls) > 0 {
		t.Fatalf("serverRequest/resolved with no known decision must not emit call.completed: %#v", completedCalls)
	}
}

func TestCodexAppServerAdapterUnsupportedServerRequestFailsCall(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true

	var streamed []activityshared.Event
	var streamedMu sync.Mutex
	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "run it",
		}}, "", "turn-local-1", func(next []activityshared.Event) {
			streamedMu.Lock()
			streamed = append(streamed, next...)
			streamedMu.Unlock()
		}, nil)
		execDone <- events
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	transport.conn.sendJSON(map[string]any{
		"id":     "unsupported-1",
		"method": "item/unknown/requestApproval",
		"params": map[string]any{
			"threadId": "codex-thread-1",
			"turnId":   "turn-1",
		},
	})
	waitForCondition(t, func() bool {
		streamedMu.Lock()
		defer streamedMu.Unlock()
		return len(eventsOfType(streamed, activityshared.EventCallFailed)) > 0
	})

	events := <-execDone
	failedCalls := eventsOfType(events, activityshared.EventCallFailed)
	if len(failedCalls) == 0 {
		t.Fatalf("unsupported server request missing call.failed: %#v", events)
	}
	errorPayload := payloadObject(failedCalls[0].Payload.Metadata["error"])
	if got := asString(errorPayload["method"]); got != "item/unknown/requestApproval" {
		t.Fatalf("unsupported request error method = %q", got)
	}
	transport.server.mu.Lock()
	response := transport.server.approvalResponse
	transport.server.mu.Unlock()
	if response == nil || payloadObject(response["error"]) == nil {
		t.Fatalf("unsupported server request response = %#v, want JSON-RPC error", response)
	}
}

func TestCodexAppServerAdapterCommandApprovalDecisionMapping(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"approve_for_session": "acceptForSession",
		"deny":                "decline",
		"abort":               "cancel",
	}
	for optionID, wantDecision := range tests {
		adapter, transport, session := startedAppServerAdapter(t)
		transport.server.commandApproval = true
		execDone := make(chan struct{})
		go func() {
			_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
				Type: "text", Text: "run it",
			}}, "", "turn-local-1", nil, nil)
			close(execDone)
		}()
		waitForCondition(t, func() bool {
			return adapter.getPendingRequest(session.AgentSessionID, "turn-local-1", "approval-1") != nil
		})
		if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
			TurnID:    "turn-local-1",
			RequestID: "approval-1",
			OptionID:  optionID,
		}); err != nil {
			t.Fatalf("SubmitInteractive(%s): %v", optionID, err)
		}
		<-execDone
		transport.server.mu.Lock()
		response := transport.server.approvalResponse
		transport.server.mu.Unlock()
		if got := asString(payloadObject(response["result"])["decision"]); got != wantDecision {
			t.Fatalf("option %q decision = %q, want %q", optionID, got, wantDecision)
		}
	}
}

func TestCodexAppServerAdapterRequestUserInput(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.userInputRequest = true

	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "set up storage",
		}}, "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.getPendingRequest(session.AgentSessionID, "turn-local-1", "question-1") != nil
	})
	state := adapter.SessionState(session)
	if state.PendingInteractive == nil || state.PendingInteractive.Kind != "ask-user" {
		t.Fatalf("pending interactive = %#v, want ask-user", state.PendingInteractive)
	}

	// Mirror the GUI contract: `answers` is a flat display list and the
	// per-question map lives under answersByQuestionId.
	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		TurnID:    "turn-local-1",
		RequestID: "question-1",
		Action:    "submit",
		Payload: map[string]any{
			"answers":             []any{"postgres"},
			"answersByQuestionId": map[string]any{"q1": "postgres"},
		},
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	<-execDone

	transport.server.mu.Lock()
	response := transport.server.approvalResponse
	transport.server.mu.Unlock()
	answers := payloadObject(payloadObject(response["result"])["answers"])
	entry := payloadObject(answers["q1"])
	values, _ := entry["answers"].([]any)
	if len(values) != 1 || asString(values[0]) != "postgres" {
		t.Fatalf("user input response = %#v", response)
	}
}
