package agentruntime

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestDefaultControllerUsesClaudeSDKAdapterByDefault(t *testing.T) {
	controller := NewDefaultControllerWithProcessTransport(nil, nil)
	if _, ok := controller.adapters[ProviderClaudeCode].(*ClaudeCodeSDKAdapter); !ok {
		t.Fatalf("claude-code adapter = %T, want *ClaudeCodeSDKAdapter", controller.adapters[ProviderClaudeCode])
	}
}

func TestClaudeCodeSDKAdapterInteractiveApprovalRoundTripIgnoresReplayedTerminalRequest(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := &recordingClaudeSDKConnection{}
	adapterSession := &claudeSDKAdapterSession{
		conn:            conn,
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-approval", "provider-turn-approval")

	started, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-approval", claudeSDKSidecarEvent{
		Type: "approval_requested",
		Payload: map[string]any{
			"turnId":     "turn-approval",
			"requestId":  "approval-1",
			"toolCallId": "toolu-approval",
			"toolName":   "Bash",
			"input":      map[string]any{"command": "touch approval.txt"},
			"options": []any{
				map[string]any{"kind": "allow_once", "name": "Allow", "optionId": "allow"},
				map[string]any{"kind": "reject_once", "name": "Reject", "optionId": "reject"},
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("approval_requested err=%v terminal=%v", err, terminal)
	}
	if len(started) != 3 || started[1].Type != activityshared.EventCallStarted || started[2].Type != activityshared.EventInteractionRequested {
		t.Fatalf("started events = %#v, want turn update, call started, and interaction requested", started)
	}
	if started[1].Payload.CallType != "approval" || started[1].Payload.Status != string(activityshared.TurnPhaseWaitingApproval) {
		t.Fatalf("approval event payload = %#v", started[1].Payload)
	}
	if started[1].Payload.CallID != "approval:approval-1" {
		t.Fatalf("approval call id = %q, want synthetic request-scoped id", started[1].Payload.CallID)
	}
	input := started[1].Payload.Input
	toolCall := payloadMap(input, "toolCall")
	if toolCall["toolCallId"] != "toolu-approval" {
		t.Fatalf("approval toolCall = %#v, want original tool use id preserved", toolCall)
	}
	if prompt := adapter.SessionState(session).PendingInteractive; prompt == nil || prompt.Kind != "approval" || prompt.RequestID != "approval-1" {
		t.Fatalf("pending prompt = %#v, want approval", prompt)
	}
	pending := adapter.getClaudeSDKPendingRequest(
		session.AgentSessionID,
		"turn-approval",
		"approval-1",
	)
	if pending == nil ||
		pending.providerTurnID != "provider-turn-approval" ||
		pending.transportTurnID != "turn-approval" {
		t.Fatalf("pending identities = %#v", pending)
	}

	type submitResult struct {
		result SubmitInteractiveResult
		err    error
	}
	submitDone := make(chan submitResult, 1)
	go func() {
		result, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{TurnID: "turn-approval", RequestID: "approval-1", OptionID: "allow"})
		submitDone <- submitResult{result: result, err: err}
	}()
	waitForCondition(t, func() bool { return len(conn.sentRequests()) == 1 })
	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "submit_interactive" || sent[0].Payload["requestId"] != "approval-1" || sent[0].Payload["optionId"] != "allow" || sent[0].Payload["turnId"] != "turn-approval" {
		t.Fatalf("sent requests = %#v", sent)
	}

	resolved, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-approval", claudeSDKSidecarEvent{
		Type: "approval_resolved",
		Payload: map[string]any{
			"turnId":    "turn-approval",
			"requestId": "approval-1",
			"optionId":  "allow",
		},
	})
	if err != nil || terminal {
		t.Fatalf("approval_resolved err=%v terminal=%v", err, terminal)
	}
	submitted := <-submitDone
	if submitted.err != nil || !submitted.result.Accepted || submitted.result.OptionID != "allow" {
		t.Fatalf("SubmitInteractive result = %#v error=%v", submitted.result, submitted.err)
	}
	if len(resolved) != 2 || resolved[0].Type != activityshared.EventCallCompleted || resolved[0].Payload.Output["selectedId"] != "allow" {
		t.Fatalf("resolved events = %#v, want completed approval", resolved)
	}
	if prompt := adapter.SessionState(session).PendingInteractive; prompt != nil {
		t.Fatalf("pending prompt after resolve = %#v, want nil", prompt)
	}
	if got := adapter.InteractiveDisposition(session, "turn-approval", "approval-1"); got != InteractiveDispositionAnswered {
		t.Fatalf("disposition after resolve = %q, want answered", got)
	}

	replayed, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-approval", claudeSDKSidecarEvent{
		Type: "approval_requested",
		Payload: map[string]any{
			"turnId":     "turn-approval",
			"requestId":  "approval-1",
			"toolCallId": "toolu-approval",
			"toolName":   "Bash",
			"input":      map[string]any{"command": "touch approval.txt"},
			"options": []any{
				map[string]any{"kind": "allow_once", "name": "Allow", "optionId": "allow"},
				map[string]any{"kind": "reject_once", "name": "Reject", "optionId": "reject"},
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("replayed approval_requested err=%v terminal=%v", err, terminal)
	}
	if len(replayed) != 0 {
		t.Fatalf("replayed events = %#v, want none after the request is answered", replayed)
	}
	if got := adapter.InteractiveDisposition(session, "turn-approval", "approval-1"); got != InteractiveDispositionAnswered {
		t.Fatalf("disposition after replay = %q, want answered", got)
	}
	if prompt := adapter.SessionState(session).PendingInteractive; prompt != nil {
		t.Fatalf("pending prompt after replay = %#v, want nil", prompt)
	}
}

func TestClaudeCodeSDKAdapterCanceledSubmissionLeavesRequestPendingForRetry(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := &recordingClaudeSDKConnection{}
	adapterSession := &claudeSDKAdapterSession{
		conn:            conn,
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-approval", "provider-turn-approval")
	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "provider-turn-approval", claudeSDKSidecarEvent{
		Type: "approval_requested",
		Payload: map[string]any{
			"turnId":     "provider-turn-approval",
			"requestId":  "approval-1",
			"toolCallId": "toolu-approval",
			"toolName":   "Bash",
			"options": []any{
				map[string]any{"kind": "allow_once", "name": "Allow", "optionId": "allow"},
			},
		},
	}); err != nil {
		t.Fatalf("approval_requested: %v", err)
	}

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := adapter.SubmitInteractive(canceled, session, SubmitInteractiveInput{TurnID: "turn-approval", RequestID: "approval-1", OptionID: "allow"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled SubmitInteractive error = %v, want context canceled", err)
	}
	pending := adapter.getClaudeSDKPendingRequest(session.AgentSessionID, "turn-approval", "approval-1")
	if pending == nil || pending.disposition() != pendingInteractiveRequestStatePending {
		t.Fatalf("pending disposition = %v, want pending", runtimeInteractiveDisposition(pending))
	}
	if len(conn.sentRequests()) != 0 {
		t.Fatalf("sent requests = %#v, want none before retry", conn.sentRequests())
	}

	type submitResult struct {
		result SubmitInteractiveResult
		err    error
	}
	submitDone := make(chan submitResult, 1)
	go func() {
		result, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{TurnID: "turn-approval", RequestID: "approval-1", OptionID: "allow"})
		submitDone <- submitResult{result: result, err: err}
	}()
	waitForCondition(t, func() bool { return len(conn.sentRequests()) == 1 })
	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "provider-turn-approval", claudeSDKSidecarEvent{
		Type: "approval_resolved",
		Payload: map[string]any{
			"turnId":    "provider-turn-approval",
			"requestId": "approval-1",
			"optionId":  "allow",
		},
	}); err != nil {
		t.Fatalf("approval_resolved: %v", err)
	}
	result := <-submitDone
	if result.err != nil || !result.result.Accepted {
		t.Fatalf("retried SubmitInteractive result = %#v error=%v", result.result, result.err)
	}
}

func TestClaudeCodeSDKAdapterSidecarRejectsInteractiveSubmission(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := &recordingClaudeSDKConnection{}
	adapterSession := &claudeSDKAdapterSession{
		conn:             conn,
		pendingRequests:  make(map[string]*pendingInteractiveRequest),
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		readerStarted:    true,
		liveState:        newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-approval", "provider-turn-approval")
	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "provider-turn-approval", claudeSDKSidecarEvent{
		Type: "approval_requested",
		Payload: map[string]any{
			"turnId":     "provider-turn-approval",
			"requestId":  "approval-1",
			"toolCallId": "toolu-approval",
			"toolName":   "Bash",
			"options": []any{
				map[string]any{"kind": "allow_once", "name": "Allow", "optionId": "allow"},
			},
		},
	}); err != nil {
		t.Fatalf("approval_requested: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
			TurnID: "turn-approval", RequestID: "approval-1", OptionID: "allow",
		})
		done <- err
	}()
	waitForCondition(t, func() bool { return len(conn.sentRequests()) == 1 })
	request := conn.sentRequests()[0]
	if err := adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		ID: request.ID, Type: "error", Payload: map[string]any{"error": "interactive request is no longer live"},
	}); err != nil {
		t.Fatalf("dispatch submit error: %v", err)
	}
	if err := <-done; err == nil || !strings.Contains(err.Error(), "no longer live") {
		t.Fatalf("SubmitInteractive error = %v, want sidecar rejection", err)
	}
	if got := adapter.InteractiveDisposition(session, "turn-approval", "approval-1"); got != InteractiveDispositionSuperseded {
		t.Fatalf("disposition = %q, want superseded", got)
	}
	adapter.removeSession(session.AgentSessionID, adapterSession)
	if got := adapter.InteractiveDisposition(session, "turn-approval", "approval-1"); got != InteractiveDispositionSuperseded {
		t.Fatalf("disposition after session removal = %q, want superseded tombstone", got)
	}
}

func TestClaudeCodeSDKAdapterRecoversAnsweredDispositionAfterLostSubmitAck(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	adapter.interactiveAckTimeout = 20 * time.Millisecond
	session := standardTestSession(ProviderClaudeCode)
	conn := &recordingClaudeSDKConnection{}
	adapterSession := &claudeSDKAdapterSession{
		conn:             conn,
		pendingRequests:  make(map[string]*pendingInteractiveRequest),
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		readerStarted:    true,
		liveState:        newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-approval", "provider-turn-approval")
	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "provider-turn-approval", claudeSDKSidecarEvent{
		Type: "approval_requested",
		Payload: map[string]any{
			"turnId":     "provider-turn-approval",
			"requestId":  "approval-1",
			"toolCallId": "toolu-approval",
			"toolName":   "Bash",
			"options": []any{
				map[string]any{"kind": "allow_once", "name": "Allow", "optionId": "allow"},
			},
		},
	}); err != nil {
		t.Fatalf("approval_requested: %v", err)
	}

	emitted := make(chan []activityshared.Event, 1)
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		emitted <- events
	})
	done := make(chan struct {
		result SubmitInteractiveResult
		err    error
	}, 1)
	go func() {
		result, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
			TurnID: "turn-approval", RequestID: "approval-1", OptionID: "allow",
		})
		done <- struct {
			result SubmitInteractiveResult
			err    error
		}{result: result, err: err}
	}()

	waitForCondition(t, func() bool { return len(conn.sentRequests()) >= 2 })
	requests := conn.sentRequests()
	if requests[0].Type != "submit_interactive" || requests[1].Type != "interactive_disposition" {
		t.Fatalf("sent requests = %#v, want submit followed by disposition query", requests)
	}
	if requests[0].Payload["turnId"] != "provider-turn-approval" || requests[1].Payload["turnId"] != "provider-turn-approval" {
		t.Fatalf("sidecar turn ids = (%v, %v), want provider-turn-approval", requests[0].Payload["turnId"], requests[1].Payload["turnId"])
	}
	if err := adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		ID: requests[1].ID, Type: "ok", Payload: map[string]any{"disposition": "answered"},
	}); err != nil {
		t.Fatalf("dispatch disposition: %v", err)
	}

	submitted := <-done
	if submitted.err != nil || !submitted.result.Accepted || submitted.result.Disposition != InteractiveDispositionAnswered {
		t.Fatalf("SubmitInteractive result = %#v error=%v", submitted.result, submitted.err)
	}
	events := <-emitted
	if len(events) != 2 || events[0].Type != activityshared.EventCallCompleted {
		t.Fatalf("emitted events = %#v, want completed call and working turn", events)
	}
}

func TestClaudeCodeSDKAdapterDispositionQueryErrorRemainsResolving(t *testing.T) {
	adapter, session, adapterSession, conn, done := startClaudeSDKLostAckTest(t)
	waitForCondition(t, func() bool { return len(conn.sentRequests()) >= 2 })
	query := conn.sentRequests()[1]
	if err := adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		ID: query.ID, Type: "error", Payload: map[string]any{"error": "query handler failed"},
	}); err != nil {
		t.Fatalf("dispatch query error: %v", err)
	}
	result := <-done
	if result.err == nil || !strings.Contains(result.err.Error(), "query handler failed") {
		t.Fatalf("SubmitInteractive error = %v, want query failure", result.err)
	}
	if result.result.Disposition != InteractiveDispositionResolving {
		t.Fatalf("disposition = %q, want resolving", result.result.Disposition)
	}
	if got := adapter.InteractiveDisposition(session, "turn-approval", "approval-1"); got != InteractiveDispositionResolving {
		t.Fatalf("runtime disposition = %q, want resolving", got)
	}
}

func TestClaudeCodeSDKAdapterPendingDispositionQueryReturnsForRetry(t *testing.T) {
	adapter, session, adapterSession, conn, done := startClaudeSDKLostAckTest(t)
	waitForCondition(t, func() bool { return len(conn.sentRequests()) >= 2 })
	query := conn.sentRequests()[1]
	_ = adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		ID: query.ID, Type: "ok", Payload: map[string]any{"disposition": "pending"},
	})
	select {
	case result := <-done:
		if result.err == nil {
			t.Fatal("SubmitInteractive unexpectedly succeeded")
		}
		if result.result.Disposition != InteractiveDispositionPending {
			t.Fatalf("disposition = %q, want pending", result.result.Disposition)
		}
	case <-time.After(time.Second):
		t.Fatal("SubmitInteractive kept waiting after authoritative pending query")
	}
	if got := adapter.InteractiveDisposition(session, "turn-approval", "approval-1"); got != InteractiveDispositionPending {
		t.Fatalf("runtime disposition = %q, want pending", got)
	}
}

type claudeSDKSubmitTestResult struct {
	result SubmitInteractiveResult
	err    error
}

func startClaudeSDKLostAckTest(t *testing.T) (
	*ClaudeCodeSDKAdapter,
	Session,
	*claudeSDKAdapterSession,
	*recordingClaudeSDKConnection,
	<-chan claudeSDKSubmitTestResult,
) {
	t.Helper()
	adapter := NewClaudeCodeSDKAdapter(nil)
	adapter.interactiveAckTimeout = 20 * time.Millisecond
	session := standardTestSession(ProviderClaudeCode)
	conn := &recordingClaudeSDKConnection{}
	adapterSession := &claudeSDKAdapterSession{
		conn:             conn,
		pendingRequests:  make(map[string]*pendingInteractiveRequest),
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		readerStarted:    true,
		liveState:        newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-approval", "provider-turn-approval")
	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "provider-turn-approval", claudeSDKSidecarEvent{
		Type: "approval_requested",
		Payload: map[string]any{
			"turnId":     "provider-turn-approval",
			"requestId":  "approval-1",
			"toolCallId": "toolu-approval",
			"toolName":   "Bash",
			"options": []any{
				map[string]any{"kind": "allow_once", "name": "Allow", "optionId": "allow"},
			},
		},
	}); err != nil {
		t.Fatalf("approval_requested: %v", err)
	}
	done := make(chan claudeSDKSubmitTestResult, 1)
	go func() {
		result, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
			TurnID: "turn-approval", RequestID: "approval-1", OptionID: "allow",
		})
		done <- claudeSDKSubmitTestResult{result: result, err: err}
	}()
	return adapter, session, adapterSession, conn, done
}

func TestClaudeCodeSDKAdapterStaleRemovalDoesNotDeleteReplacementSession(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	terminalStarted := make(chan struct{})
	releaseTerminal := make(chan struct{})
	pending := &pendingInteractiveRequest{
		agentSessionID: session.AgentSessionID,
		turnID:         "turn-old",
		requestID:      "request-old",
		onTerminal: func(_ *pendingInteractiveRequest, _ pendingInteractiveRequestState) {
			close(terminalStarted)
			<-releaseTerminal
		},
	}
	oldSession := &claudeSDKAdapterSession{
		pendingRequests: map[string]*pendingInteractiveRequest{
			claudeSDKPendingRequestKey(pending.turnID, pending.requestID): pending,
		},
	}
	newSession := &claudeSDKAdapterSession{pendingRequests: make(map[string]*pendingInteractiveRequest)}
	adapter.storeSession(session.AgentSessionID, oldSession)
	removed := make(chan bool, 1)
	go func() {
		removed <- adapter.removeSession(session.AgentSessionID, oldSession)
	}()
	<-terminalStarted
	adapter.storeSession(session.AgentSessionID, newSession)
	close(releaseTerminal)
	if !<-removed {
		t.Fatal("old session was not detached")
	}
	if got := adapter.getSession(session.AgentSessionID); got != newSession {
		t.Fatalf("current session = %p, want replacement %p", got, newSession)
	}
	if adapter.removeSession(session.AgentSessionID, oldSession) {
		t.Fatal("stale removal unexpectedly detached replacement session")
	}
}

func TestClaudeCodeSDKAdapterDoesNotRestoreInvalidOrOverwriteReplacementSession(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	invalidPrevious := &claudeSDKAdapterSession{pendingRequests: make(map[string]*pendingInteractiveRequest)}
	adapter.storeSession(session.AgentSessionID, invalidPrevious)
	adapter.removeSession(session.AgentSessionID, invalidPrevious)
	if adapter.restorePreviousSession(session.AgentSessionID, invalidPrevious) {
		t.Fatal("restored an invalid previous session")
	}

	validPrevious := &claudeSDKAdapterSession{pendingRequests: make(map[string]*pendingInteractiveRequest)}
	replacement := &claudeSDKAdapterSession{pendingRequests: make(map[string]*pendingInteractiveRequest)}
	adapter.storeSession(session.AgentSessionID, replacement)
	if adapter.restorePreviousSession(session.AgentSessionID, validPrevious) {
		t.Fatal("previous session overwrote a concurrent replacement")
	}
	if got := adapter.getSession(session.AgentSessionID); got != replacement {
		t.Fatalf("current session = %p, want replacement %p", got, replacement)
	}
}

func TestClaudeCodeSDKAdapterConfirmedReaderFailureSupersedesResolvingRequest(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	pending := &pendingInteractiveRequest{
		agentSessionID: session.AgentSessionID,
		turnID:         "turn-approval",
		requestID:      "approval-1",
		eventID:        "event-1",
		callID:         "approval:approval-1",
		callType:       "approval",
		name:           "Bash",
		toolName:       "Bash",
		response:       make(chan pendingInteractiveResponse, 1),
	}
	adapterSession := &claudeSDKAdapterSession{
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	adapter.storeClaudeSDKPendingRequest(adapterSession, pending)
	if _, claimed := pending.beginResolving(); !claimed {
		t.Fatal("failed to move request to resolving")
	}
	events := adapter.claudeSDKPendingRequestFailureEvents(adapterSession, session, "turn-approval", errors.New("reader exited"))
	if got := adapter.InteractiveDisposition(session, "turn-approval", "approval-1"); got != InteractiveDispositionSuperseded {
		t.Fatalf("disposition = %q, want superseded after confirmed session death", got)
	}
	if len(events) != 2 || events[0].Type != activityshared.EventInteractionSuperseded || events[1].Type != activityshared.EventCallFailed {
		t.Fatalf("failure events = %#v", events)
	}
}

func TestClaudeCodeSDKAdapterKeepsSameRequestIDIsolatedAcrossTurns(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	for _, turnID := range []string{"turn-1", "turn-2"} {
		adapter.beginClaudeSDKRootTurn(adapterSession, turnID, turnID)
		if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, turnID, claudeSDKSidecarEvent{
			Type: "approval_requested",
			Payload: map[string]any{
				"turnId":     turnID,
				"requestId":  "shared-request",
				"toolCallId": "tool-" + turnID,
				"toolName":   "Bash",
			},
		}); err != nil {
			t.Fatalf("approval_requested(%s): %v", turnID, err)
		}
	}
	first := adapter.getClaudeSDKPendingRequest(session.AgentSessionID, "turn-1", "shared-request")
	second := adapter.getClaudeSDKPendingRequest(session.AgentSessionID, "turn-2", "shared-request")
	if first == nil || second == nil || first == second {
		t.Fatalf("pending requests = (%p, %p), want distinct turn-scoped requests", first, second)
	}
	resolved := adapter.claudeSDKInteractiveResolved(adapterSession, session, "turn-1", map[string]any{
		"turnId": "turn-1", "requestId": "shared-request", "optionId": "allow",
	})
	if len(resolved) != 2 || resolved[0].Type != activityshared.EventCallCompleted {
		t.Fatalf("resolved events = %#v", resolved)
	}
	if adapter.getClaudeSDKPendingRequest(session.AgentSessionID, "turn-1", "shared-request") != nil {
		t.Fatal("resolved first-turn request remained live")
	}
	if got := adapter.getClaudeSDKPendingRequest(session.AgentSessionID, "turn-2", "shared-request"); got != second {
		t.Fatalf("second-turn request = %p, want %p", got, second)
	}
}

func TestClaudeCodeSDKAdapterApprovalResolvedUsesStoredTurnIDWhenEventTurnMissing(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := &recordingClaudeSDKConnection{}
	adapterSession := &claudeSDKAdapterSession{
		conn:            conn,
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	adapter.beginClaudeSDKRootTurn(
		adapterSession,
		"turn-approval",
		"provider-turn-approval",
	)

	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-approval", claudeSDKSidecarEvent{
		Type: "approval_requested",
		Payload: map[string]any{
			"turnId":     "turn-approval",
			"requestId":  "approval-1",
			"toolCallId": "toolu-approval",
			"toolName":   "Bash",
			"input":      map[string]any{"command": "touch approval.txt"},
			"options": []any{
				map[string]any{"kind": "allow_once", "name": "Allow", "optionId": "allow"},
			},
		},
	}); err != nil {
		t.Fatalf("approval_requested: %v", err)
	}

	resolved, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "", claudeSDKSidecarEvent{
		Type: "approval_resolved",
		Payload: map[string]any{
			"requestId": "approval-1",
			"optionId":  "allow",
		},
	})
	if err != nil || terminal {
		t.Fatalf("approval_resolved err=%v terminal=%v", err, terminal)
	}
	if len(resolved) != 2 || resolved[0].Type != activityshared.EventCallCompleted {
		t.Fatalf("resolved events = %#v, want completed approval", resolved)
	}
	if resolved[0].Payload.TurnID != "turn-approval" {
		t.Fatalf("resolved turnID = %q, want stored pending turn id", resolved[0].Payload.TurnID)
	}
}
