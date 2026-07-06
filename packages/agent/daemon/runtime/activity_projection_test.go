package agentruntime

import (
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

func TestReportableActivityEventsReportsOnlyCompletedAssistantSnapshots(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"
	streaming := newTurnActivityEvent(session, EventMessage, "turn-1", messageStreamStateStreaming, RoleAssistant, "hel", map[string]any{
		"streamState": messageStreamStateStreaming,
	})
	completed := newTurnActivityEvent(session, EventMessage, "turn-1", messageStreamStateCompleted, RoleAssistant, "hello", map[string]any{
		"streamState": messageStreamStateCompleted,
	})
	thinkingStreaming := newTurnActivityEvent(session, EventMessage, "turn-1", messageStreamStateStreaming, RoleAssistantThinking, "thinking", map[string]any{
		"streamState": messageStreamStateStreaming,
	})
	thinkingCompleted := newTurnActivityEvent(session, EventMessage, "turn-1", messageStreamStateCompleted, RoleAssistantThinking, "thinking done", map[string]any{
		"streamState": messageStreamStateCompleted,
	})

	events := ReportableActivityEvents([]activityshared.Event{
		newTurnActivityEvent(session, EventMessage, "turn-1", "", RoleUser, "say hello", nil),
		streaming,
		completed,
		thinkingStreaming,
		thinkingCompleted,
	})

	if len(events) != 3 {
		t.Fatalf("activity events = %#v, want user, completed assistant, and completed thinking snapshots", events)
	}
	if events[0].Type != activityshared.EventMessageAppended || events[1].Type != activityshared.EventMessageAppended || events[2].Type != activityshared.EventMessageAppended {
		t.Fatalf("activity event types = %#v, want message events", events)
	}
	if events[2].Payload.Role != activityshared.MessageRoleAssistantThinking {
		t.Fatalf("thinking role = %q, want assistant_thinking", events[2].Payload.Role)
	}
	if events[1].Payload.Metadata["streamState"] != messageStreamStateCompleted {
		t.Fatalf("activity metadata streamState = %#v, want completed", events[1].Payload.Metadata)
	}
}

func TestSessionStatusFromActivityPreservesWaiting(t *testing.T) {
	t.Parallel()

	got := sessionStatusFromActivity(string(activityshared.SessionStatusWaiting))

	if got != SessionStatusWaiting {
		t.Fatalf("sessionStatusFromActivity(waiting) = %q, want %q", got, SessionStatusWaiting)
	}
}

func TestActivitySessionStatusFromControllerStatusPreservesWaiting(t *testing.T) {
	t.Parallel()

	got := activitySessionStatusFromControllerStatus(SessionStatusWaiting)

	if got != activityshared.SessionStatusWaiting {
		t.Fatalf("activitySessionStatusFromControllerStatus(waiting) = %q, want %q", got, activityshared.SessionStatusWaiting)
	}
}

func TestReportableActivityEventsReportsFailedAssistantFinalSnapshots(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	normalizer := newACPTurnNormalizer()
	events := append([]activityshared.Event{},
		normalizer.AppendThinkingChunk(session, "turn-1", "thinking")...,
	)
	events = append(events, normalizer.AppendAssistantChunk(session, "turn-1", "answer")...)
	events = append(events, normalizer.Finish(session, "turn-1", messageStreamStateFailed)...)

	report := reportActivityInput(session, events)
	assistant := messageUpdatesWithKind(report, "text")
	if len(assistant) != 2 {
		t.Fatalf("assistant message updates = %#v, want streaming and failed final", assistant)
	}
	if assistant[1].Status != messageStreamStateFailed {
		t.Fatalf("assistant status = %q, want failed", assistant[1].Status)
	}
	thinking := messageUpdatesWithKind(report, "reasoning")
	if len(thinking) != 2 {
		t.Fatalf("thinking message updates = %#v, want streaming and failed final", thinking)
	}
	if thinking[1].Status != messageStreamStateFailed {
		t.Fatalf("thinking status = %q, want failed", thinking[1].Status)
	}
}

func TestReportableActivityEventsReportsInterruptedOpenToolCalls(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	normalizer := newACPTurnNormalizer()
	events, ok := normalizer.ToolCallEvents(session, "turn-1", map[string]any{
		"toolCallId": "tool-1",
		"title":      "Run command",
		"status":     "in_progress",
		"kind":       "execute",
		"rawInput": map[string]any{
			"command": []any{"/bin/zsh", "-lc", "rg TODO"},
		},
	})
	if !ok {
		t.Fatal("ToolCallEvents() returned !ok")
	}

	events = append(events, normalizer.FinishInterrupted(session, "turn-1", "user_interrupt")...)
	report := reportActivityInput(session, events)
	failedCalls := messageUpdatesWithKind(report, "tool_call")
	if len(failedCalls) != 2 {
		t.Fatalf("failed call message updates = %#v, want start and interrupted final", failedCalls)
	}
	failedCall := failedCalls[1]
	if failedCall.Status != "failed" {
		t.Fatalf("failed call status = %q, want failed", failedCall.Status)
	}
	if got := payloadString(failedCall.Payload, "status"); got != SessionStatusCanceled {
		t.Fatalf("failed call payload status = %q, want canceled", got)
	}
	if got := payloadString(payloadMap(failedCall.Payload, "error"), "reason"); got != "user_interrupt" {
		t.Fatalf("failed call error payload = %#v, want interrupt reason", failedCall.Payload)
	}
}

// TestReportableActivityEventsReportsFailedOpenToolCalls covers a tool call
// that is still open (no item/completed ever arrived for it) when its own
// turn otherwise reaches a normal terminal state - for example codex
// silently declining a spawnAgent delegation for a schema conflict, with no
// further notification tied to that call id for the rest of the turn
// (confirmed via exported session transcripts). Reporting it as a
// successful completion would paint a rejected/never-run call as having
// succeeded, which is exactly what previously left rejected sub-agent
// delegations rendered as stuck "running"/"queued" forever instead of
// failed. It must close out as failed, matching how an interrupted/failed
// turn already handles dangling calls.
func TestReportableActivityEventsReportsFailedOpenToolCalls(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	normalizer := newACPTurnNormalizer()
	events, ok := normalizer.ToolCallEvents(session, "turn-1", map[string]any{
		"toolCallId": "tool-1",
		"title":      "Run command",
		"status":     "in_progress",
		"kind":       "execute",
		"rawInput": map[string]any{
			"command": []any{"/bin/zsh", "-lc", "cat .env"},
		},
	})
	if !ok {
		t.Fatal("ToolCallEvents() returned !ok")
	}

	events = append(events, normalizer.FinishCompleted(session, "turn-1")...)
	report := reportActivityInput(session, events)
	completedCalls := messageUpdatesWithKind(report, "tool_call")
	if len(completedCalls) != 2 {
		t.Fatalf("completed call message updates = %#v, want start and failed final", completedCalls)
	}
	if completedCalls[1].MessageID != completedCalls[0].MessageID ||
		completedCalls[1].CallID != completedCalls[0].CallID {
		t.Fatalf("completed call identity = start:%#v completed:%#v, want same message and call IDs", completedCalls[0], completedCalls[1])
	}
	completedCall := completedCalls[1]
	if completedCall.Status != messageStreamStateFailed {
		t.Fatalf("dangling call status = %q, want failed", completedCall.Status)
	}
	if got := payloadString(completedCall.Payload, "status"); got != messageStreamStateFailed {
		t.Fatalf("dangling call payload status = %q, want failed", got)
	}
	if got := payloadMap(completedCall.Payload, "error"); got == nil {
		t.Fatalf("dangling call payload error = %#v, want a non-nil error detail", got)
	}
}

func TestReportableActivityEventsIncludesCallStarted(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"

	events := ReportableActivityEvents([]activityshared.Event{
		newTurnActivityEvent(session, EventCallStarted, "turn-1", messageStreamStateStreaming, "", "Read files", map[string]any{
			"callId":   "tool-1",
			"callType": "tool",
			"name":     "Read files",
		}),
	})

	if len(events) != 1 {
		t.Fatalf("activity events = %#v, want call.started to be reportable", events)
	}
	if events[0].Type != activityshared.EventCallStarted {
		t.Fatalf("activity event type = %q, want call.started", events[0].Type)
	}
}

func TestNewTurnActivityEventDefaultsUserMessageMetadata(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	event := newTurnActivityEventWithID(session, "message-user-1", EventMessage, "turn-1", "", RoleUser, "hello", nil)

	if event.Payload.Metadata["messageId"] != "message-user-1" {
		t.Fatalf("message metadata = %#v, want message id", event.Payload.Metadata)
	}
	if event.Payload.Metadata["contentMode"] != messageContentModeSnapshot {
		t.Fatalf("message metadata = %#v, want snapshot content mode", event.Payload.Metadata)
	}
	if event.Payload.Metadata["streamState"] != messageStreamStateCompleted {
		t.Fatalf("message metadata = %#v, want completed streamState", event.Payload.Metadata)
	}
}

func TestProjectActivityEventsToStreamEventsCarriesApprovalEnvelope(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"

	events := ProjectActivityEventsToStreamEvents(session, []activityshared.Event{
		newTurnActivityEvent(session, EventCallStarted, "turn-approval", SessionStatusWaiting, "", "Read files", map[string]any{
			"callId":   "tool-approval-1",
			"callType": "approval",
			"name":     "Read files",
			"status":   "waiting_approval",
			"input": map[string]any{
				"requestId": "permission-1",
				"options": []map[string]any{
					{"id": "allow_once", "label": "Allow once"},
				},
			},
		}),
	})

	if len(events) != 1 {
		t.Fatalf("stream events = %#v, want one approval call", events)
	}
	item, ok := events[0].Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
	if !ok {
		t.Fatalf("stream event data = %#v, want message update", events[0].Data)
	}
	if got := payloadMap(item.Payload, "input"); got == nil || got["requestId"] != "permission-1" {
		t.Fatalf("approval input payload = %#v, want requestId", item.Payload)
	}
	if item.Payload["callType"] != "approval" {
		t.Fatalf("callType = %#v, want approval", item.Payload["callType"])
	}
}

func TestProjectActivityEventsToStreamEventsCarriesInteractiveMetadata(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"

	events := ProjectActivityEventsToStreamEvents(session, []activityshared.Event{
		newTurnActivityEvent(session, EventCallStarted, "turn-ask-user", SessionStatusWaiting, "", "AskUserQuestion", map[string]any{
			"callId":   "tool-ask-1",
			"callType": "interactive",
			"name":     "AskUserQuestion",
			"status":   "waiting_input",
			"input": map[string]any{
				"questions": []map[string]any{
					{"question": "Which approach should we use?"},
				},
			},
			"metadata": map[string]any{
				"interactiveKind": "ask-user",
			},
		}),
	})

	if len(events) != 1 {
		t.Fatalf("stream events = %#v, want one interactive call", events)
	}
	item, ok := events[0].Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
	if !ok {
		t.Fatalf("stream event data = %#v, want message update", events[0].Data)
	}
	if item.Payload["callType"] != "interactive" {
		t.Fatalf("callType = %#v, want interactive", item.Payload["callType"])
	}
	if got := payloadMap(item.Payload, "input"); got == nil {
		t.Fatalf("interactive input = %#v, want preserved questions", item.Payload)
	}
	if got := payloadString(item.Payload, "status"); got != "waiting_input" {
		t.Fatalf("status = %q, want waiting_input", got)
	}
}

func TestProjectActivityEventsToStreamEventsAddsVisibleTurnFailureMessage(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.Provider = ProviderHermes
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"

	events := ProjectActivityEventsToStreamEvents(session, []activityshared.Event{
		newTurnActivityEventWithID(session, "turn-failed-1", EventTurnFailed, "turn-1", SessionStatusFailed, "", "", map[string]any{
			"error": "\x1b[33mAPI Error: 429 rate limit\x1b[39m",
		}),
	})

	if len(events) != 2 {
		t.Fatalf("stream events = %#v, want state patch and visible failure message", events)
	}
	item, ok := events[1].Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
	if !ok {
		t.Fatalf("stream event data = %#v, want message update", events[1].Data)
	}
	if item.Kind != "text" || item.Status != messageStreamStateFailed {
		t.Fatalf("visible failure item = %#v", item)
	}
	if item.Payload["kind"] != visibleErrorKind ||
		item.Payload["phase"] != "turn" ||
		item.Payload["code"] != "quota_or_rate_limit" ||
		item.Payload["detail"] != "API Error: 429 rate limit" {
		t.Fatalf("visible failure payload = %#v", item.Payload)
	}
}

func TestProjectActivityEventsToStreamEventsDoesNotDuplicateVisibleFailureMessage(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"

	events := ProjectActivityEventsToStreamEvents(session, []activityshared.Event{
		newTurnActivityEventWithID(session, "assistant-failed-1", EventMessage, "turn-1", messageStreamStateFailed, RoleAssistant, "provider failure", map[string]any{
			"streamState": messageStreamStateFailed,
		}),
		newTurnActivityEventWithID(session, "turn-failed-1", EventTurnFailed, "turn-1", SessionStatusFailed, "", "", map[string]any{
			"error": "provider failure",
		}),
	})

	var visibleFailures int
	for _, event := range events {
		item, ok := event.Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
		if ok && item.Payload["kind"] == visibleErrorKind {
			visibleFailures++
		}
	}
	if visibleFailures != 0 {
		t.Fatalf("visible failure count = %d, want provider failed assistant message to suppress synthetic item", visibleFailures)
	}
}

func TestNewActivityEventsCarryProjectionMetadata(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"

	event := newTurnActivityEventWithID(session, "stable-message-id", EventMessage, "turn-1", messageStreamStateCompleted, RoleAssistant, "done", map[string]any{
		"messageId":    "message-1",
		"contentMode":  messageContentModeSnapshot,
		"streamState":  messageStreamStateCompleted,
		"adapterExtra": "kept-for-local-debug",
	})

	if event.EventID != "stable-message-id" {
		t.Fatalf("activity event id = %q, want stable-message-id", event.EventID)
	}
	if event.Type != activityshared.EventMessageAppended {
		t.Fatalf("activity type = %q, want %q", event.Type, activityshared.EventMessageAppended)
	}
	if event.Payload.Metadata["messageId"] != "message-1" {
		t.Fatalf("activity metadata = %#v, want message id copied", event.Payload.Metadata)
	}
}

func TestRuntimeSessionStartUsesSessionStartedEvent(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"

	events := ReportableActivityEvents([]activityshared.Event{
		newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil),
	})

	if len(events) != 1 {
		t.Fatalf("activity events = %#v, want exactly the session.started event", events)
	}
	if events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("activity event type = %q, want %q", events[0].Type, activityshared.EventSessionStarted)
	}
}

func messageUpdatesWithKind(report agentsessionstore.ReportActivityInput, kind string) []agentsessionstore.WorkspaceAgentMessageUpdate {
	var out []agentsessionstore.WorkspaceAgentMessageUpdate
	for _, update := range report.MessageUpdates {
		if update.Kind == kind {
			out = append(out, update)
		}
	}
	return out
}
