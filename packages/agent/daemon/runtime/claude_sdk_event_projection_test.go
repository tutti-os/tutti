package agentruntime

import (
	"context"
	"errors"
	"sync"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func TestClaudeCodeSDKAdapterMapsSyntheticTurnStarted(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.beginClaudeSDKRootTurn(adapterSession, "root-turn-1", "provider-turn-1")

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "synthetic-1", claudeSDKSidecarEvent{
		Type: "turn_started",
		Payload: map[string]any{
			"turnId":    "synthetic-1",
			"synthetic": true,
		},
	})
	if err != nil || terminal {
		t.Fatalf("turn_started err=%v terminal=%v", err, terminal)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventRootProviderTurnStarted {
		t.Fatalf("events = %#v, want root provider turn start", events)
	}
	if events[0].Payload.TurnID != "root-turn-1" || events[0].Payload.ProviderTurnID != "synthetic-1" ||
		events[0].Payload.TurnPhase != string(activityshared.TurnPhaseRunning) {
		t.Fatalf("turn started payload = %#v", events[0].Payload)
	}
	if events[0].Payload.Metadata["synthetic"] != true {
		t.Fatalf("turn metadata = %#v, want synthetic=true", events[0].Payload.Metadata)
	}
}

func TestClaudeCodeSDKAdapterUsesSidecarAssistantMessageID(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}

	var events []activityshared.Event
	for _, input := range []struct {
		messageID string
		content   string
	}{
		{messageID: "claude-sdk:assistant:msg-1:live:0", content: "Before tool."},
		{messageID: "claude-sdk:assistant:msg-1:live:1", content: "After tool."},
	} {
		next, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-interleaved", claudeSDKSidecarEvent{
			Type: "assistant_completed",
			Payload: map[string]any{
				"turnId":    "turn-interleaved",
				"messageId": input.messageID,
				"content":   input.content,
			},
		})
		if err != nil || terminal {
			t.Fatalf("assistant_completed err=%v terminal=%v", err, terminal)
		}
		events = append(events, next...)
	}

	messages := activityMessagesWithRole(events, activityshared.MessageRoleAssistant)
	if len(messages) != 2 {
		t.Fatalf("assistant messages = %#v, want two distinct sidecar messages", messages)
	}
	if messages[0].EventID == messages[1].EventID ||
		messages[0].Payload.Content != "Before tool." ||
		messages[1].Payload.Content != "After tool." {
		t.Fatalf("assistant messages = %#v, want distinct ids and contents", messages)
	}
}

func TestClaudeCodeSDKAdapterMapsAssistantSDKErrorToFailedMessage(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-auth", claudeSDKSidecarEvent{
		Type: "assistant_failed",
		Payload: map[string]any{
			"turnId":    "turn-auth",
			"messageId": "claude-sdk:assistant:auth-error:fallback:0",
			"content":   "Failed to authenticate. API Error: 401",
		},
	})
	if err != nil || terminal {
		t.Fatalf("assistant_failed err=%v terminal=%v", err, terminal)
	}
	if len(events) != 1 ||
		events[0].Type != activityshared.EventMessageAppended ||
		events[0].EventID != "claude-sdk:assistant:auth-error:fallback:0" ||
		events[0].Payload.Role != activityshared.MessageRoleAssistant ||
		events[0].Payload.Metadata["streamState"] != messageStreamStateFailed ||
		events[0].Payload.Content != "Failed to authenticate. API Error: 401" {
		t.Fatalf("assistant failed events = %#v", events)
	}
}

func TestClaudeCodeSDKAdapterApprovalDoesNotMergeWithApprovedToolCall(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:            &recordingClaudeSDKConnection{},
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	approvalEvents, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-web", claudeSDKSidecarEvent{
		Type: "approval_requested",
		Payload: map[string]any{
			"turnId":     "turn-web",
			"requestId":  "approval-web",
			"toolCallId": "call_web",
			"toolName":   "WebSearch",
			"input":      map[string]any{"query": "current weather in Tokyo Japan"},
		},
	})
	if err != nil || terminal || len(approvalEvents) != 3 || approvalEvents[2].Type != activityshared.EventInteractionRequested {
		t.Fatalf("approval events=%#v terminal=%v err=%v", approvalEvents, terminal, err)
	}
	toolEvents, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-web", claudeSDKSidecarEvent{
		Type: "tool_started",
		Payload: map[string]any{
			"turnId":     "turn-web",
			"toolCallId": "call_web",
			"toolName":   "WebSearch",
			"input":      map[string]any{"query": "current weather in Tokyo Japan"},
		},
	})
	if err != nil || terminal || len(toolEvents) != 1 {
		t.Fatalf("tool events=%#v terminal=%v err=%v", toolEvents, terminal, err)
	}

	approvalUpdate, ok := callMessageUpdateFromSessionEvent(
		canonical.EventSource{Provider: ProviderClaudeCode},
		approvalEvents[1],
		session.AgentSessionID,
		approvalEvents[1].OccurredAtUnixMS,
	)
	if !ok {
		t.Fatal("approval event did not convert to message update")
	}
	toolUpdate, ok := callMessageUpdateFromSessionEvent(
		canonical.EventSource{Provider: ProviderClaudeCode},
		toolEvents[0],
		session.AgentSessionID,
		toolEvents[0].OccurredAtUnixMS,
	)
	if !ok {
		t.Fatal("tool event did not convert to message update")
	}
	if approvalUpdate.MessageID == toolUpdate.MessageID {
		t.Fatalf("message id = %q for both approval and tool; want separate timeline rows", approvalUpdate.MessageID)
	}
	if approvalUpdate.Payload["callType"] != "approval" || approvalUpdate.Payload["toolName"] != "Approval" || approvalUpdate.Status != "waiting_approval" {
		t.Fatalf("approval update = %#v, want approval waiting row", approvalUpdate)
	}
	if toolUpdate.Payload["callType"] != "tool" || toolUpdate.Payload["toolName"] != "WebSearch" {
		t.Fatalf("tool update = %#v, want web search tool row", toolUpdate)
	}
}

func TestClaudeCodeSDKAdapterPreservesSubagentParentToolUseID(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:            &recordingClaudeSDKConnection{},
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-task", claudeSDKSidecarEvent{
		Type: "tool_completed",
		Payload: map[string]any{
			"turnId":     "turn-task",
			"toolCallId": "toolu-read",
			"toolName":   "Read",
			"callType":   "tool",
			"input":      map[string]any{"file_path": "/repo/README.md"},
			"output":     map[string]any{"text": "Read README"},
			"metadata": map[string]any{
				"parentToolUseId": "toolu-task",
			},
		},
	})
	if err != nil || terminal || len(events) != 1 {
		t.Fatalf("tool_completed events=%#v terminal=%v err=%v, want one nonterminal call event", events, terminal, err)
	}
	if events[0].Payload.Metadata["parentToolUseId"] != "toolu-task" {
		t.Fatalf("event metadata = %#v, want parentToolUseId", events[0].Payload.Metadata)
	}
	update, ok := callMessageUpdateFromSessionEvent(
		canonical.EventSource{Provider: ProviderClaudeCode},
		events[0],
		session.AgentSessionID,
		events[0].OccurredAtUnixMS,
	)
	if !ok {
		t.Fatal("tool event did not convert to message update")
	}
	metadata := payloadMap(update.Payload, "metadata")
	if metadata["parentToolUseId"] != "toolu-task" {
		t.Fatalf("message update payload = %#v, want nested metadata parentToolUseId", update.Payload)
	}
}

func TestClaudeCodeSDKAdapterCreatesAndSettlesChildSession(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:            &recordingClaudeSDKConnection{},
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	started, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-task", claudeSDKSidecarEvent{
		Type: "tool_completed",
		Payload: map[string]any{
			"turnId":     "turn-task",
			"toolCallId": "toolu-agent",
			"toolName":   "Agent",
			"callType":   "subagent",
			"input": map[string]any{
				"description": "Explore codebase structure",
				"prompt":      "Find relevant files",
			},
			"output": map[string]any{"text": "Async agent launched successfully"},
			"metadata": map[string]any{
				"subagentAsync":   true,
				"subagentStatus":  "running",
				"agentId":         "agent-1",
				"subagentAgentId": "agent-1",
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("tool_completed terminal=%v err=%v", terminal, err)
	}
	if len(started) != 3 || started[0].Type != activityshared.EventCallCompleted ||
		started[1].Type != activityshared.EventSessionStarted || started[1].SessionKind != "child" ||
		started[2].Type != activityshared.EventTurnStarted {
		t.Fatalf("started events = %#v, want root call plus child session/turn start", started)
	}
	childSessionID := started[1].AgentSessionID
	childTurnID := started[1].Payload.TurnID
	if started[1].RootAgentSessionID != session.AgentSessionID || started[1].RootTurnID != "turn-task" ||
		started[1].ParentAgentSessionID != session.AgentSessionID || started[1].ParentTurnID != "turn-task" ||
		started[1].ParentToolCallID != "toolu-agent" {
		t.Fatalf("child relation = %#v", started[1])
	}

	completed, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "", claudeSDKSidecarEvent{
		Type: "task_completed",
		Payload: map[string]any{
			"taskId":          "task-1",
			"agentId":         "agent-1",
			"parentToolUseId": "toolu-agent",
			"status":          "completed",
			"summary":         "Found relevant files",
		},
	})
	if err != nil || terminal {
		t.Fatalf("task_completed terminal=%v err=%v", terminal, err)
	}
	if len(completed) != 2 || completed[0].Type != activityshared.EventActivityCompleted ||
		completed[1].Type != activityshared.EventTurnCompleted {
		t.Fatalf("completed events = %#v, want child activity and turn completion", completed)
	}
	for _, event := range completed {
		if event.AgentSessionID != childSessionID || event.Payload.TurnID != childTurnID || event.RootTurnID != "turn-task" {
			t.Fatalf("child completion scope = %#v, want child session=%q turn=%q", event, childSessionID, childTurnID)
		}
	}
}

func TestClaudeCodeSDKAdapterScopesChildApprovalBySDKAgentID(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := &recordingClaudeSDKConnection{}
	adapterSession := &claudeSDKAdapterSession{
		conn:            conn,
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-task", "provider-turn-task")

	_, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "provider-turn-task", claudeSDKSidecarEvent{
		Type: "tool_completed",
		Payload: map[string]any{
			"turnId":     "provider-turn-task",
			"toolCallId": "toolu-agent",
			"toolName":   "Agent",
			"callType":   "subagent",
			"input":      map[string]any{"description": "Write a probe file"},
			"output":     map[string]any{"text": "Async agent launched successfully"},
			"metadata": map[string]any{
				"subagentAsync":   true,
				"subagentStatus":  "running",
				"agentId":         "agent-1",
				"subagentAgentId": "agent-1",
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("child launch terminal=%v err=%v", terminal, err)
	}
	child := adapterSession.claudeSDKChildByKey("agent-1")
	if child.AgentSessionID == "" || child.TurnID == "" {
		t.Fatalf("child = %#v, want canonical child identity", child)
	}

	requested, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "provider-turn-task", claudeSDKSidecarEvent{
		Type: "approval_requested",
		Payload: map[string]any{
			"turnId":     "provider-turn-task",
			"requestId":  "approval-child-write",
			"toolCallId": "toolu-child-write",
			"toolName":   "Write",
			"agentId":    "agent-1",
			"input":      map[string]any{"file_path": "/repo/permission-probe.txt", "content": "hello"},
		},
	})
	if err != nil || terminal || len(requested) != 3 {
		t.Fatalf("approval requested events=%#v terminal=%v err=%v", requested, terminal, err)
	}
	for _, event := range requested {
		if event.AgentSessionID != child.AgentSessionID || event.Payload.TurnID != child.TurnID {
			t.Fatalf("approval request scope = %#v, want child session=%q turn=%q", event, child.AgentSessionID, child.TurnID)
		}
	}
	pending := adapter.getClaudeSDKPendingRequest(child.AgentSessionID, child.TurnID, "approval-child-write")
	if pending == nil || pending.agentSessionID != child.AgentSessionID || pending.providerTurnID != "provider-turn-task" {
		t.Fatalf("pending = %#v, want child-owned request", pending)
	}
	submitDone := make(chan claudeSDKSubmitTestResult, 1)
	go func() {
		result, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
			AgentSessionID: child.AgentSessionID,
			TurnID:         child.TurnID,
			RequestID:      "approval-child-write",
			OptionID:       "allow",
		})
		submitDone <- claudeSDKSubmitTestResult{result: result, err: err}
	}()
	waitForCondition(t, func() bool { return len(conn.sentRequests()) == 1 })
	submittedRequest := conn.sentRequests()[0]
	if submittedRequest.Type != "submit_interactive" || submittedRequest.Payload["agentSessionId"] != session.AgentSessionID || submittedRequest.Payload["turnId"] != "provider-turn-task" {
		t.Fatalf("child approval sidecar request = %#v, want root runtime session and provider turn", submittedRequest)
	}

	resolved, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "provider-turn-task", claudeSDKSidecarEvent{
		Type: "approval_resolved",
		Payload: map[string]any{
			"turnId":    "provider-turn-task",
			"requestId": "approval-child-write",
			"optionId":  "allow",
			"action":    "submit",
		},
	})
	if err != nil || terminal || len(resolved) != 2 {
		t.Fatalf("approval resolved events=%#v terminal=%v err=%v", resolved, terminal, err)
	}
	if submitted := <-submitDone; submitted.err != nil || !submitted.result.Accepted {
		t.Fatalf("SubmitInteractive result=%#v error=%v, want accepted child approval", submitted.result, submitted.err)
	}
	for _, event := range resolved {
		if event.AgentSessionID != child.AgentSessionID || event.Payload.TurnID != child.TurnID {
			t.Fatalf("approval resolution scope = %#v, want child session=%q turn=%q", event, child.AgentSessionID, child.TurnID)
		}
	}
}

func TestClaudeCodeSDKAdapterScopesChildApprovalAckEventsToChild(t *testing.T) {
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
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-task", "provider-turn-task")

	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "provider-turn-task", claudeSDKSidecarEvent{
		Type: "tool_completed",
		Payload: map[string]any{
			"turnId":     "provider-turn-task",
			"toolCallId": "toolu-agent",
			"toolName":   "Agent",
			"callType":   "subagent",
			"input":      map[string]any{"description": "Write a probe file"},
			"output":     map[string]any{"text": "Async agent launched successfully"},
			"metadata": map[string]any{
				"subagentAsync":   true,
				"subagentStatus":  "running",
				"agentId":         "agent-1",
				"subagentAgentId": "agent-1",
			},
		},
	}); err != nil {
		t.Fatalf("child launch: %v", err)
	}
	child := adapterSession.claudeSDKChildByKey("agent-1")
	if child.AgentSessionID == "" || child.TurnID == "" {
		t.Fatalf("child = %#v, want canonical child identity", child)
	}
	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "provider-turn-task", claudeSDKSidecarEvent{
		Type: "approval_requested",
		Payload: map[string]any{
			"turnId":     "provider-turn-task",
			"requestId":  "approval-child-write",
			"toolCallId": "toolu-child-write",
			"toolName":   "Write",
			"agentId":    "agent-1",
		},
	}); err != nil {
		t.Fatalf("approval requested: %v", err)
	}

	type emittedBatch struct {
		agentSessionID string
		events         []activityshared.Event
	}
	emitted := make(chan emittedBatch, 1)
	adapter.SetSessionEventSink(func(agentSessionID string, events []activityshared.Event) {
		emitted <- emittedBatch{agentSessionID: agentSessionID, events: events}
	})
	submitDone := make(chan claudeSDKSubmitTestResult, 1)
	go func() {
		result, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
			AgentSessionID: child.AgentSessionID,
			TurnID:         child.TurnID,
			RequestID:      "approval-child-write",
			OptionID:       "allow",
		})
		submitDone <- claudeSDKSubmitTestResult{result: result, err: err}
	}()
	waitForCondition(t, func() bool { return len(conn.sentRequests()) == 1 })
	request := conn.sentRequests()[0]
	adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		ID:   request.ID,
		Type: "ok",
		Payload: map[string]any{
			"disposition": "answered",
		},
	})

	if submitted := <-submitDone; submitted.err != nil || !submitted.result.Accepted {
		t.Fatalf("SubmitInteractive result=%#v error=%v, want accepted child approval", submitted.result, submitted.err)
	}
	batch := <-emitted
	if batch.agentSessionID != session.AgentSessionID {
		t.Fatalf("shared runtime sink session = %q, want root %q", batch.agentSessionID, session.AgentSessionID)
	}
	if len(batch.events) != 2 {
		t.Fatalf("ack events = %#v, want completed call and working turn", batch.events)
	}
	for _, event := range batch.events {
		if event.AgentSessionID != child.AgentSessionID || event.ProviderSessionID != "agent-1" || event.SessionKind != "child" || event.Payload.TurnID != child.TurnID {
			t.Fatalf("ack event scope = %#v, want canonical child identity", event)
		}
	}
	report := reportActivityInput(session, batch.events)
	if len(report.StatePatches) != 1 || report.StatePatches[0].AgentSessionID != child.AgentSessionID || report.StatePatches[0].Kind != "child" {
		t.Fatalf("ack state patches = %#v, want child-owned patch", report.StatePatches)
	}
	if len(report.MessageUpdates) != 1 || report.MessageUpdates[0].AgentSessionID != child.AgentSessionID {
		t.Fatalf("ack message updates = %#v, want child-owned completion", report.MessageUpdates)
	}
}

func TestClaudeCodeSDKAdapterKeepsDelegationCompletionOnParentAndUpdatesChildTitle(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:            &recordingClaudeSDKConnection{},
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	started, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-task", claudeSDKSidecarEvent{
		Type: "tool_started",
		Payload: map[string]any{
			"turnId":     "turn-task",
			"toolCallId": "toolu-agent",
			"toolName":   "Agent",
			"callType":   "subagent",
			"input":      map[string]any{"toolName": "Agent"},
		},
	})
	if err != nil || terminal || len(started) != 3 {
		t.Fatalf("tool_started events=%#v terminal=%v err=%v", started, terminal, err)
	}
	if started[0].Type != activityshared.EventCallStarted || started[0].AgentSessionID != session.AgentSessionID ||
		started[0].Payload.TurnID != "turn-task" {
		t.Fatalf("parent delegation start = %#v", started[0])
	}
	childSessionID := started[1].AgentSessionID
	childTurnID := started[1].Payload.TurnID
	if started[1].Type != activityshared.EventSessionStarted || started[1].Payload.Title != "" ||
		started[2].Type != activityshared.EventTurnStarted {
		t.Fatalf("child start events = %#v", started[1:])
	}

	completed, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-task", claudeSDKSidecarEvent{
		Type: "tool_completed",
		Payload: map[string]any{
			"turnId":     "turn-task",
			"toolCallId": "toolu-agent",
			"toolName":   "Agent",
			"callType":   "subagent",
			"input": map[string]any{
				"description":       "Inspect the repository",
				"prompt":            "Find the relevant files and summarize them.",
				"run_in_background": false,
			},
			"output": map[string]any{"text": "Inspection complete"},
		},
	})
	if err != nil || terminal || len(completed) != 3 {
		t.Fatalf("tool_completed events=%#v terminal=%v err=%v", completed, terminal, err)
	}
	if completed[0].Type != activityshared.EventCallCompleted || completed[0].AgentSessionID != session.AgentSessionID ||
		completed[0].Payload.TurnID != "turn-task" || payloadString(completed[0].Payload.Metadata, "callId") != "toolu-agent" ||
		payloadString(payloadMap(completed[0].Payload.Metadata, "input"), "description") != "Inspect the repository" {
		t.Fatalf("parent delegation completion = %#v", completed[0])
	}
	if completed[1].Type != activityshared.EventSessionUpdated || completed[1].AgentSessionID != childSessionID ||
		completed[1].Payload.Title != "Inspect the repository" {
		t.Fatalf("child title update = %#v", completed[1])
	}
	if completed[2].Type != activityshared.EventTurnCompleted || completed[2].AgentSessionID != childSessionID ||
		completed[2].Payload.TurnID != childTurnID {
		t.Fatalf("child terminal = %#v", completed[2])
	}

	settled, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-task", claudeSDKSidecarEvent{
		Type:    "turn_completed",
		Payload: map[string]any{"turnId": "turn-task"},
	})
	if err != nil || !terminal {
		t.Fatalf("turn_completed events=%#v terminal=%v err=%v", settled, terminal, err)
	}
	for _, event := range settled {
		if event.Type == activityshared.EventCallFailed {
			t.Fatalf("parent delegation was left dangling: %#v", settled)
		}
	}
}

func TestClaudeCodeSDKAdapterCreatesNestedChildUnderParentChildTurn(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.beginClaudeSDKRootTurn(adapterSession, "root-turn-1", "provider-turn-1")

	rootChildEvents, _, err := adapter.sidecarTurnEvents(adapterSession, session, "provider-turn-1", claudeSDKSidecarEvent{
		Type: "tool_started",
		Payload: map[string]any{
			"turnId":     "provider-turn-1",
			"toolCallId": "toolu-parent",
			"callType":   "subagent",
			"toolName":   "Task",
			"input":      map[string]any{"description": "parent", "run_in_background": true},
		},
	})
	if err != nil || len(rootChildEvents) != 3 {
		t.Fatalf("parent child events=%#v err=%v", rootChildEvents, err)
	}
	parent := adapterSession.claudeSDKChildByKey("toolu-parent")

	nestedEvents, _, err := adapter.sidecarTurnEvents(adapterSession, session, "provider-turn-1", claudeSDKSidecarEvent{
		Type: "tool_started",
		Payload: map[string]any{
			"turnId":     "provider-turn-1",
			"toolCallId": "toolu-child",
			"callType":   "subagent",
			"toolName":   "Task",
			"input":      map[string]any{"description": "nested", "run_in_background": true},
			"metadata":   map[string]any{"parentToolUseId": "toolu-parent"},
		},
	})
	if err != nil || len(nestedEvents) != 3 {
		t.Fatalf("nested child events=%#v err=%v", nestedEvents, err)
	}
	nested := adapterSession.claudeSDKChildByKey("toolu-child")
	if nested.RootAgentSessionID != session.AgentSessionID || nested.RootTurnID != "root-turn-1" ||
		nested.ParentAgentSessionID != parent.AgentSessionID || nested.ParentTurnID != parent.TurnID {
		t.Fatalf("nested relation = %#v; parent = %#v", nested, parent)
	}
	if nestedEvents[0].AgentSessionID != parent.AgentSessionID || nestedEvents[0].Payload.TurnID != parent.TurnID ||
		nestedEvents[1].AgentSessionID != nested.AgentSessionID {
		t.Fatalf("nested launch scopes = %#v", nestedEvents)
	}
}

func TestClaudeCodeSDKAdapterUpdatesChildSessionByProviderAlias(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:            &recordingClaudeSDKConnection{},
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	for _, startedAgent := range []struct {
		parentToolUseID string
		agentID         string
	}{
		{parentToolUseID: "toolu-agent-1", agentID: "agent-1"},
		{parentToolUseID: "toolu-agent-2", agentID: "agent-2"},
	} {
		_, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-task", claudeSDKSidecarEvent{
			Type: "tool_completed",
			Payload: map[string]any{
				"turnId":     "turn-task",
				"toolCallId": startedAgent.parentToolUseID,
				"toolName":   "Agent",
				"callType":   "subagent",
				"input":      map[string]any{"description": "Generate number"},
				"output":     map[string]any{"text": "Async agent launched successfully"},
				"metadata": map[string]any{
					"subagentAsync":   true,
					"subagentStatus":  "running",
					"agentId":         startedAgent.agentID,
					"subagentAgentId": startedAgent.agentID,
				},
			},
		})
		if err != nil || terminal {
			t.Fatalf("tool_completed terminal=%v err=%v", terminal, err)
		}
	}

	progress, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "", claudeSDKSidecarEvent{
		Type: "task_started",
		Payload: map[string]any{
			"taskId":      "task-2",
			"agentId":     "agent-2",
			"description": "Generate number",
			"status":      "running",
		},
	})
	if err != nil || terminal {
		t.Fatalf("task_started terminal=%v err=%v", terminal, err)
	}
	if len(adapterSession.childSessions) != 2 {
		t.Fatalf("child sessions = %#v, want two", adapterSession.childSessions)
	}
	childTwo := adapterSession.claudeSDKChildByKey("task-2")
	if childTwo.AgentID != "agent-2" || childTwo.TaskID != "task-2" || childTwo.Status != "running" {
		t.Fatalf("task_started child = %#v", childTwo)
	}
	if len(progress) != 1 || progress[0].Type != activityshared.EventActivityStarted ||
		progress[0].AgentSessionID != childTwo.AgentSessionID || progress[0].Payload.TurnID != childTwo.TurnID {
		t.Fatalf("task_started events = %#v, want child-two scope", progress)
	}

	completed, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "", claudeSDKSidecarEvent{
		Type: "task_completed",
		Payload: map[string]any{
			"taskId":  "task-2",
			"status":  "completed",
			"summary": "Generated number",
		},
	})
	if err != nil || terminal {
		t.Fatalf("task_completed terminal=%v err=%v", terminal, err)
	}
	if first := adapterSession.claudeSDKChildByKey("toolu-agent-1"); first.Status != "running" {
		t.Fatalf("child one = %#v, want running", first)
	}
	childTwo = adapterSession.claudeSDKChildByKey("toolu-agent-2")
	if childTwo.Status != "completed" || len(completed) != 2 || completed[1].Type != activityshared.EventTurnCompleted ||
		completed[1].AgentSessionID != childTwo.AgentSessionID || completed[1].Payload.TurnID != childTwo.TurnID {
		t.Fatalf("completed child/events = %#v / %#v", childTwo, completed)
	}
}

func TestClaudeCodeSDKAdapterKeepsChildSessionsSeparateOnAliasConflict(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:            &recordingClaudeSDKConnection{},
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	// A poisoned upstream binding attaches agent-2's task id to the first
	// Agent tool call.
	_, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "", claudeSDKSidecarEvent{
		Type: "task_started",
		Payload: map[string]any{
			"turnId":          "turn-task",
			"taskId":          "agent-2",
			"parentToolUseId": "toolu-agent-1",
			"description":     "Generate number",
			"status":          "running",
		},
	})
	if err != nil || terminal {
		t.Fatalf("task_started terminal=%v err=%v", terminal, err)
	}

	// The second Agent launch carries its own parent tool call id; it must
	// not merge into toolu-agent-1 through the poisoned agent-2 alias.
	launched, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-task", claudeSDKSidecarEvent{
		Type: "tool_completed",
		Payload: map[string]any{
			"turnId":     "turn-task",
			"toolCallId": "toolu-agent-2",
			"toolName":   "Agent",
			"callType":   "subagent",
			"input":      map[string]any{"description": "Generate number"},
			"output":     map[string]any{"text": "Async agent launched successfully"},
			"metadata": map[string]any{
				"subagentAsync":   true,
				"subagentStatus":  "running",
				"agentId":         "agent-2",
				"subagentAgentId": "agent-2",
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("tool_completed terminal=%v err=%v", terminal, err)
	}
	if len(adapterSession.childSessions) != 2 {
		t.Fatalf("child sessions = %#v, want separate sessions", adapterSession.childSessions)
	}
	first := adapterSession.claudeSDKChildByKey("toolu-agent-1")
	second := adapterSession.claudeSDKChildByKey("toolu-agent-2")
	if first.AgentSessionID == "" || second.AgentSessionID == "" || first.AgentSessionID == second.AgentSessionID ||
		first.Status != "running" || second.Status != "running" {
		t.Fatalf("children = %#v / %#v, want separate running sessions", first, second)
	}
	if len(launched) != 3 || launched[1].AgentSessionID != second.AgentSessionID {
		t.Fatalf("second launch events = %#v", launched)
	}

	completed, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "", claudeSDKSidecarEvent{
		Type: "task_completed",
		Payload: map[string]any{
			"taskId":          "agent-2",
			"agentId":         "agent-2",
			"parentToolUseId": "toolu-agent-2",
			"status":          "completed",
			"summary":         "Generated number",
		},
	})
	if err != nil || terminal {
		t.Fatalf("task_completed terminal=%v err=%v", terminal, err)
	}
	first = adapterSession.claudeSDKChildByKey("toolu-agent-1")
	second = adapterSession.claudeSDKChildByKey("toolu-agent-2")
	if first.Status != "running" || second.Status != "completed" || len(completed) != 2 ||
		completed[1].AgentSessionID != second.AgentSessionID {
		t.Fatalf("settled children/events = %#v / %#v / %#v", first, second, completed)
	}
}

func TestClaudeCodeSDKAdapterKeepsLateChildEventsOnOriginalChildTurn(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:            &recordingClaudeSDKConnection{},
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	started, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-task", claudeSDKSidecarEvent{
		Type: "tool_completed",
		Payload: map[string]any{
			"turnId":     "turn-task",
			"toolCallId": "toolu-agent",
			"toolName":   "Agent",
			"callType":   "subagent",
			"input": map[string]any{
				"description": "Explore codebase structure",
				"prompt":      "Find relevant files",
			},
			"output": map[string]any{"text": "Async agent launched successfully"},
			"metadata": map[string]any{
				"subagentAsync":   true,
				"subagentStatus":  "running",
				"agentId":         "agent-1",
				"subagentAgentId": "agent-1",
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("tool_completed terminal=%v err=%v", terminal, err)
	}
	if len(started) != 3 || started[1].Type != activityshared.EventSessionStarted {
		t.Fatalf("started events = %#v, want child session creation", started)
	}
	childSessionID := started[1].AgentSessionID
	childTurnID := started[1].Payload.TurnID
	// Claude may finish the root provider turn before its background child.
	// That weak ordering remains valid unless the exact child was canceled too.
	adapter.markClaudeSDKTurnClosed(adapterSession, "turn-task", "completed")

	completed, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "", claudeSDKSidecarEvent{
		Type: "task_completed",
		Payload: map[string]any{
			"turnId":          "turn-task",
			"taskId":          "task-1",
			"agentId":         "agent-1",
			"parentToolUseId": "toolu-agent",
			"status":          "completed",
			"summary":         "Found relevant files",
		},
	})
	if err != nil || terminal {
		t.Fatalf("late task_completed terminal=%v err=%v", terminal, err)
	}
	if len(completed) != 2 || completed[1].Type != activityshared.EventTurnCompleted {
		t.Fatalf("late task_completed events = %#v, want activity + child turn completion", completed)
	}
	for _, event := range completed {
		if event.AgentSessionID != childSessionID || event.Payload.TurnID != childTurnID || event.RootTurnID != "turn-task" {
			t.Fatalf("late child event scope = %#v", event)
		}
	}
}

func TestClaudeCodeSDKAdapterDropsLateChildFailureAfterTargetedCancel(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &ackClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)

	started, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-cancel", claudeSDKSidecarEvent{
		Type: "tool_completed",
		Payload: map[string]any{
			"turnId":     "turn-cancel",
			"toolCallId": "toolu-agent-cancel",
			"toolName":   "Agent",
			"callType":   "subagent",
			"input": map[string]any{
				"description": "Inspect cancellation",
				"prompt":      "Check the target",
			},
			"output": map[string]any{"text": "Async agent launched successfully"},
			"metadata": map[string]any{
				"subagentAsync":   true,
				"subagentStatus":  "running",
				"agentId":         "agent-cancel",
				"subagentAgentId": "agent-cancel",
			},
		},
	})
	if err != nil || terminal || len(started) != 3 {
		t.Fatalf("child launch events=%#v terminal=%v err=%v", started, terminal, err)
	}
	child := adapterSession.claudeSDKChildByKey("toolu-agent-cancel")
	if child.AgentSessionID == "" || child.TurnID == "" || child.Status != "running" {
		t.Fatalf("child = %#v, want running child", child)
	}

	result, err := adapter.CancelTargets(context.Background(), session, []CancelTarget{
		{AgentSessionID: session.AgentSessionID, TurnID: "turn-cancel"},
		{AgentSessionID: child.AgentSessionID, TurnID: child.TurnID},
	}, "user")
	if err != nil {
		t.Fatalf("CancelTargets: %v", err)
	}
	if len(result.ConfirmedTargets) != 2 || !adapter.turnAlreadySettled(adapterSession, child.TurnID) {
		t.Fatalf("cancel result=%#v childClosed=%v", result, adapter.turnAlreadySettled(adapterSession, child.TurnID))
	}

	failed, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-cancel", claudeSDKSidecarEvent{
		Type: "tool_failed",
		Payload: map[string]any{
			"turnId":     "turn-cancel",
			"toolCallId": "toolu-agent-cancel",
			"toolName":   "Agent",
			"callType":   "subagent",
			"error":      "user_interrupt",
		},
	})
	if err != nil || terminal || len(failed) != 0 {
		t.Fatalf("late tool_failed events=%#v terminal=%v err=%v, want dropped", failed, terminal, err)
	}

	stopped, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-cancel", claudeSDKSidecarEvent{
		Type: "task_completed",
		Payload: map[string]any{
			"turnId":          "turn-cancel",
			"taskId":          "agent-cancel",
			"agentId":         "agent-cancel",
			"parentToolUseId": "toolu-agent-cancel",
			"status":          "stopped",
		},
	})
	if err != nil || terminal || len(stopped) != 0 {
		t.Fatalf("late task_completed events=%#v terminal=%v err=%v, want dropped", stopped, terminal, err)
	}
}

func TestClaudeCodeSDKAdapterMapsAskUserQuestionInteractive(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:            &recordingClaudeSDKConnection{},
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-ask", claudeSDKSidecarEvent{
		Type: "user_input_requested",
		Payload: map[string]any{
			"turnId":     "turn-ask",
			"requestId":  "ask-1",
			"toolCallId": "toolu-ask",
			"toolName":   "AskUserQuestion",
			"input": map[string]any{
				"questions": []any{map[string]any{"question": "Pick one", "header": "Choice"}},
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("user_input_requested err=%v terminal=%v", err, terminal)
	}
	if len(events) != 3 || events[1].Payload.CallType != "interactive" || events[2].Type != activityshared.EventInteractionRequested {
		t.Fatalf("events = %#v, want interactive call", events)
	}
	prompt := adapter.SessionState(session).PendingInteractive
	if prompt == nil || prompt.Kind != "ask-user" || prompt.ToolName != "AskUserQuestion" {
		t.Fatalf("pending prompt = %#v, want ask-user", prompt)
	}
}

func TestClaudeCodeSDKAdapterMapsExitPlanModeInteractive(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:            &recordingClaudeSDKConnection{},
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-plan", claudeSDKSidecarEvent{
		Type: "user_input_requested",
		Payload: map[string]any{
			"turnId":     "turn-plan",
			"requestId":  "plan-1",
			"toolCallId": "toolu-plan",
			"toolName":   "ExitPlanMode",
			"input":      map[string]any{"plan": "1. Inspect\n2. Implement"},
			"options": []any{
				map[string]any{"kind": "allow_once", "name": "Yes", "optionId": "default"},
				map[string]any{"kind": "reject_once", "name": "No", "optionId": "plan"},
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("exit plan request err=%v terminal=%v", err, terminal)
	}
	if len(events) != 3 || events[1].Payload.CallType != "interactive" || events[2].Type != activityshared.EventInteractionRequested {
		t.Fatalf("events = %#v, want interactive exit plan call", events)
	}
	prompt := adapter.SessionState(session).PendingInteractive
	if prompt == nil || prompt.Kind != "exit-plan" || prompt.Input["plan"] != "1. Inspect\n2. Implement" {
		t.Fatalf("pending prompt = %#v, want exit-plan", prompt)
	}

	resolved, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-plan", claudeSDKSidecarEvent{
		Type: "user_input_resolved",
		Payload: map[string]any{
			"turnId":    "turn-plan",
			"requestId": "plan-1",
			"optionId":  "plan",
			"action":    "deny",
		},
	})
	if err != nil || terminal {
		t.Fatalf("exit plan resolved err=%v terminal=%v", err, terminal)
	}
	if len(resolved) != 2 || resolved[0].Type != activityshared.EventCallCompleted || resolved[0].Payload.Output["selectedId"] != "plan" {
		t.Fatalf("resolved = %#v, want completed plan selection", resolved)
	}
}

func TestClaudeCodeSDKAdapterCancelClearsPendingInteractive(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:            &recordingClaudeSDKConnection{},
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	// A turn parked on an approval has a live Exec waiter in the registry; the
	// interrupted terminal is stamped for that registered turnID, not for the
	// cancel argument (which is the reason).
	adapter.registerClaudeSDKTurn(adapterSession, "turn-cancel", nil)

	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-cancel", claudeSDKSidecarEvent{
		Type: "approval_requested",
		Payload: map[string]any{
			"turnId":    "turn-cancel",
			"requestId": "approval-cancel",
			"toolName":  "Bash",
			"input":     map[string]any{"command": "sleep 10"},
		},
	}); err != nil {
		t.Fatalf("approval_requested: %v", err)
	}
	if prompt := adapter.SessionState(session).PendingInteractive; prompt == nil {
		t.Fatal("pending prompt missing before cancel")
	}

	events, err := adapter.Cancel(context.Background(), session, "user")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if len(events) != 2 || events[0].Type != activityshared.EventInteractionSuperseded || events[1].Type != activityshared.EventCallFailed {
		t.Fatalf("cancel events = %#v, want pending interaction closure while provider cancellation is unconfirmed", events)
	}
	if prompt := adapter.SessionState(session).PendingInteractive; prompt != nil {
		t.Fatalf("pending prompt after cancel = %#v, want nil", prompt)
	}
}

func TestClaudeCodeSDKAdapterCancelFailsOpenToolCalls(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:      &recordingClaudeSDKConnection{},
		liveState: newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	adapter.registerClaudeSDKTurn(adapterSession, "turn-write", nil)

	started, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-write", claudeSDKSidecarEvent{
		Type: "tool_started",
		Payload: map[string]any{
			"turnId":     "turn-write",
			"toolCallId": "toolu-write",
			"toolName":   "Write",
			"name":       "Write",
			"input": map[string]any{
				"file_path": "/tmp/out.txt",
				"content":   "partial",
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("tool_started err=%v terminal=%v", err, terminal)
	}
	if len(started) != 1 || started[0].Type != activityshared.EventCallStarted {
		t.Fatalf("started = %#v, want call.started", started)
	}

	events, err := adapter.Cancel(context.Background(), session, "user")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("cancel events = %#v, want failed open Write while provider cancellation is unconfirmed", events)
	}
	if events[0].Type != activityshared.EventCallFailed ||
		events[0].EventID != "claude-sdk:tool:toolu-write" ||
		events[0].Payload.Status != SessionStatusCanceled {
		t.Fatalf("open tool cancel event = %#v, want call.failed with canceled status", events[0])
	}

	late, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-write", claudeSDKSidecarEvent{
		Type: "tool_completed",
		Payload: map[string]any{
			"turnId":     "turn-write",
			"toolCallId": "toolu-write",
			"toolName":   "Write",
			"name":       "Write",
			"output":     map[string]any{"text": "done"},
		},
	})
	if err != nil || terminal || len(late) != 0 {
		t.Fatalf("late tool_completed after cancel = events=%#v terminal=%v err=%v, want dropped", late, terminal, err)
	}
}

func TestClaudeCodeSDKAdapterCancelFailsOpenThinking(t *testing.T) {
	// Mirrors the open-Write cancel path: thinking must leave the shared turn
	// normalizer so Stop does not leave a forever-"thinking" disclosure.
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:      &recordingClaudeSDKConnection{},
		liveState: newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	adapter.registerClaudeSDKTurn(adapterSession, "turn-think", nil)

	streaming, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-think", claudeSDKSidecarEvent{
		Type: "thinking_delta",
		Payload: map[string]any{
			"turnId":   "turn-think",
			"snapshot": "Still reasoning about the change.",
		},
	})
	if err != nil || terminal {
		t.Fatalf("thinking_delta err=%v terminal=%v", err, terminal)
	}
	if len(streaming) != 1 ||
		streaming[0].Payload.Role != activityshared.MessageRoleAssistantThinking ||
		streaming[0].EventID != "claude-sdk:thinking:turn-think" ||
		streaming[0].Payload.Metadata["streamState"] != messageStreamStateStreaming {
		t.Fatalf("streaming thinking = %#v, want stable streaming thinking row", streaming)
	}

	events, err := adapter.Cancel(context.Background(), session, "user")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("cancel events = %#v, want failed open thinking while provider cancellation is unconfirmed", events)
	}
	if events[0].Type != activityshared.EventMessageAppended ||
		events[0].EventID != "claude-sdk:thinking:turn-think" ||
		events[0].Payload.Role != activityshared.MessageRoleAssistantThinking ||
		events[0].Payload.Metadata["streamState"] != messageStreamStateFailed ||
		events[0].Payload.Content != "Still reasoning about the change." {
		t.Fatalf("open thinking cancel event = %#v, want failed thinking snapshot", events[0])
	}
}

func TestClaudeCodeSDKAdapterCancelFailsOpenToolsAfterWaiterUnregistered(t *testing.T) {
	// Mirrors controller Cancel ordering: active.cancel() makes Exec unregister
	// its waiter before adapter.Cancel runs. Open tools must still close.
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:      &recordingClaudeSDKConnection{},
		liveState: newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	waiter := adapter.registerClaudeSDKTurn(adapterSession, "turn-write", nil)

	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-write", claudeSDKSidecarEvent{
		Type: "tool_started",
		Payload: map[string]any{
			"turnId":     "turn-write",
			"toolCallId": "toolu-write",
			"toolName":   "Write",
			"name":       "Write",
			"input":      map[string]any{"file_path": "/tmp/out.txt", "content": "partial"},
		},
	}); err != nil {
		t.Fatalf("tool_started: %v", err)
	}

	adapter.unregisterClaudeSDKTurn(adapterSession, "turn-write", waiter)
	if got := adapter.liveClaudeSDKTurnIDs(adapterSession); len(got) != 0 {
		t.Fatalf("live turns after unregister = %#v, want empty", got)
	}

	events, err := adapter.Cancel(context.Background(), session, "user")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if len(events) != 1 ||
		events[0].Type != activityshared.EventCallFailed ||
		events[0].EventID != "claude-sdk:tool:toolu-write" ||
		events[0].Payload.Status != SessionStatusCanceled {
		t.Fatalf("cancel events = %#v, want failed open Write even with no live waiter", events)
	}
}

func TestClaudeCodeSDKAdapterTurnCanceledFailsOpenToolCalls(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}

	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-write", claudeSDKSidecarEvent{
		Type: "tool_started",
		Payload: map[string]any{
			"turnId":     "turn-write",
			"toolCallId": "toolu-write",
			"toolName":   "Write",
			"name":       "Write",
			"input":      map[string]any{"file_path": "/tmp/out.txt", "content": "partial"},
		},
	}); err != nil {
		t.Fatalf("tool_started: %v", err)
	}

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-write", claudeSDKSidecarEvent{
		Type:    "turn_canceled",
		Payload: map[string]any{"turnId": "turn-write"},
	})
	if err != nil || !terminal {
		t.Fatalf("turn_canceled err=%v terminal=%v", err, terminal)
	}
	if len(events) < 2 ||
		events[0].Type != activityshared.EventCallFailed ||
		events[0].EventID != "claude-sdk:tool:toolu-write" ||
		events[0].Payload.Status != SessionStatusCanceled {
		t.Fatalf("turn_canceled events = %#v, want failed open Write then provider cancellation", events)
	}
	if events[1].Type != activityshared.EventRootProviderTurnCompleted ||
		events[1].Payload.TurnOutcome != string(activityshared.TurnOutcomeCanceled) ||
		events[1].Payload.ProviderTurnID != "turn-write" {
		t.Fatalf("provider terminal = %#v, want confirmed canceled", events[1])
	}
}

// TestClaudeCodeSDKAdapterReaderFailureFailsPendingInteractive guards against
// a real bug found while investigating a Feishu report (LENj32): if the
// sidecar connection/process dies while a permission dialog is still
// unanswered (e.g. the user left it open for a while), failClaudeSDKReader
// used to discard the pending approval bookkeeping silently along with the
// rest of the session. The GUI would then see the request vanish on the next
// reconnect with no terminal event explaining why, while the turn itself
// failed for an unrelated-looking reason -- giving the impression the
// approval was answered or bypassed when it never was.
func TestClaudeCodeSDKAdapterReaderFailureFailsPendingInteractive(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:             &recordingClaudeSDKConnection{},
		session:          session,
		pendingRequests:  make(map[string]*pendingInteractiveRequest),
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		turns:            make(map[string]*claudeSDKTurnWaiter),
		liveState:        newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-disconnect", claudeSDKSidecarEvent{
		Type: "approval_requested",
		Payload: map[string]any{
			"turnId":    "turn-disconnect",
			"requestId": "approval-disconnect",
			"toolName":  "Bash",
			"input":     map[string]any{"command": "sleep 10"},
		},
	}); err != nil {
		t.Fatalf("approval_requested: %v", err)
	}
	if prompt := adapter.SessionState(session).PendingInteractive; prompt == nil {
		t.Fatal("pending prompt missing before disconnect")
	}

	var mu sync.Mutex
	var received []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		mu.Lock()
		defer mu.Unlock()
		received = append(received, events...)
	})

	adapter.failClaudeSDKReader(session.AgentSessionID, adapterSession, errors.New("sidecar connection lost"))

	mu.Lock()
	events := append([]activityshared.Event(nil), received...)
	mu.Unlock()
	if len(events) != 2 || events[0].Type != activityshared.EventInteractionSuperseded || events[1].Type != activityshared.EventCallFailed {
		t.Fatalf("disconnect events = %#v, want superseded interaction and failed pending approval", events)
	}
	if msg, _ := events[1].Payload.Error["message"].(string); msg != "sidecar connection lost" {
		t.Fatalf("failed approval error = %#v, want the disconnect reason", events[1].Payload.Error)
	}
	if adapter.getSession(session.AgentSessionID) != nil {
		t.Fatal("session should be removed after the reader fails")
	}
}
