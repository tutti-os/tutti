package agentruntime

import (
	"context"
	"errors"
	"sync"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestClaudeCodeSDKAdapterMapsSyntheticTurnStarted(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}

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
	if len(events) != 1 || events[0].Type != activityshared.EventTurnStarted {
		t.Fatalf("events = %#v, want turn.started", events)
	}
	if events[0].Payload.TurnID != "synthetic-1" || events[0].Payload.TurnPhase != string(activityshared.TurnPhaseWorking) {
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
	if err != nil || terminal || len(approvalEvents) != 2 {
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
		agentsessionstore.EventSource{Provider: ProviderClaudeCode},
		approvalEvents[1],
		session.AgentSessionID,
		approvalEvents[1].OccurredAtUnixMS,
	)
	if !ok {
		t.Fatal("approval event did not convert to message update")
	}
	toolUpdate, ok := callMessageUpdateFromSessionEvent(
		agentsessionstore.EventSource{Provider: ProviderClaudeCode},
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
		agentsessionstore.EventSource{Provider: ProviderClaudeCode},
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

func TestClaudeCodeSDKAdapterTracksSDKBackgroundAgents(t *testing.T) {
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
	if len(started) != 3 {
		t.Fatalf("started events = %#v, want call + activity + session update", started)
	}
	backgroundAgents := sdkBackgroundAgentsFromEvents(t, started)
	if backgroundAgents["count"] != 1 {
		t.Fatalf("backgroundAgents = %#v, want count=1", backgroundAgents)
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
	if len(completed) != 2 {
		t.Fatalf("completed events = %#v, want activity + session update", completed)
	}
	if completed[0].Payload.TurnID != "turn-task" {
		t.Fatalf("task completed turnID = %q, want fallback to parent turn", completed[0].Payload.TurnID)
	}
	backgroundAgents = sdkBackgroundAgentsFromEvents(t, completed)
	if backgroundAgents["count"] != 0 {
		t.Fatalf("backgroundAgents = %#v, want count=0", backgroundAgents)
	}
	stateBackgroundAgents, _ := adapter.SessionState(session).RuntimeContext["backgroundAgents"].(map[string]any)
	if stateBackgroundAgents["count"] != 0 {
		t.Fatalf("state backgroundAgents = %#v, want completed count=0", stateBackgroundAgents)
	}
}

func TestClaudeCodeSDKAdapterUpdatesBackgroundAgentByAlias(t *testing.T) {
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
	if backgroundAgents := sdkBackgroundAgentsFromEvents(t, progress); backgroundAgents["count"] != 2 {
		t.Fatalf("task_started backgroundAgents = %#v, want count=2", backgroundAgents)
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
	backgroundAgents := sdkBackgroundAgentsFromEvents(t, completed)
	if backgroundAgents["count"] != 1 {
		t.Fatalf("completed backgroundAgents = %#v, want count=1", backgroundAgents)
	}
	if status := sdkBackgroundAgentStatusByParent(t, backgroundAgents, "toolu-agent-1"); status != "running" {
		t.Fatalf("agent-1 status = %q, want running", status)
	}
	if status := sdkBackgroundAgentStatusByParent(t, backgroundAgents, "toolu-agent-2"); status != "completed" {
		t.Fatalf("agent-2 status = %q, want completed", status)
	}
}

func TestClaudeCodeSDKAdapterKeepsBackgroundAgentsSeparateOnAliasConflict(t *testing.T) {
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
	backgroundAgents := sdkBackgroundAgentsFromEvents(t, launched)
	if backgroundAgents["count"] != 2 {
		t.Fatalf("backgroundAgents = %#v, want two separate running agents", backgroundAgents)
	}
	if status := sdkBackgroundAgentStatusByParent(t, backgroundAgents, "toolu-agent-1"); status != "running" {
		t.Fatalf("agent-1 status = %q, want running", status)
	}
	if status := sdkBackgroundAgentStatusByParent(t, backgroundAgents, "toolu-agent-2"); status != "running" {
		t.Fatalf("agent-2 status = %q, want running", status)
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
	backgroundAgents = sdkBackgroundAgentsFromEvents(t, completed)
	if backgroundAgents["count"] != 1 {
		t.Fatalf("completed backgroundAgents = %#v, want one running agent", backgroundAgents)
	}
	if status := sdkBackgroundAgentStatusByParent(t, backgroundAgents, "toolu-agent-2"); status != "completed" {
		t.Fatalf("agent-2 status = %q, want completed", status)
	}
}

func TestClaudeCodeSDKAdapterKeepsLateBackgroundAgentEventsWithPayloadTurnID(t *testing.T) {
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
	if backgroundAgents := sdkBackgroundAgentsFromEvents(t, started); backgroundAgents["count"] != 1 {
		t.Fatalf("started backgroundAgents = %#v, want count=1", backgroundAgents)
	}

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
	if len(completed) != 2 {
		t.Fatalf("late task_completed events = %#v, want activity + session update", completed)
	}
	if completed[0].Payload.TurnID != "turn-task" {
		t.Fatalf("late task_completed turnID = %q, want payload turn", completed[0].Payload.TurnID)
	}
	backgroundAgents := sdkBackgroundAgentsFromEvents(t, completed)
	if backgroundAgents["count"] != 0 {
		t.Fatalf("late task_completed backgroundAgents = %#v, want count=0", backgroundAgents)
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
	if len(events) != 2 || events[1].Payload.CallType != "interactive" {
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
	if len(events) != 2 || events[1].Payload.CallType != "interactive" {
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
	if len(events) != 2 || events[0].Type != activityshared.EventCallFailed {
		t.Fatalf("cancel events = %#v, want failed pending approval and interrupted turn", events)
	}
	if events[1].Type != activityshared.EventTurnCompleted ||
		events[1].Payload.TurnOutcome != string(activityshared.TurnOutcomeInterrupted) {
		t.Fatalf("cancel turn event = %#v, want interrupted turn", events[1])
	}
	if prompt := adapter.SessionState(session).PendingInteractive; prompt != nil {
		t.Fatalf("pending prompt after cancel = %#v, want nil", prompt)
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
	if len(events) != 1 || events[0].Type != activityshared.EventCallFailed {
		t.Fatalf("disconnect events = %#v, want a single failed pending approval event", events)
	}
	if msg, _ := events[0].Payload.Error["message"].(string); msg != "sidecar connection lost" {
		t.Fatalf("failed approval error = %#v, want the disconnect reason", events[0].Payload.Error)
	}
	if adapter.getSession(session.AgentSessionID) != nil {
		t.Fatal("session should be removed after the reader fails")
	}
}
