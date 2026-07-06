package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

func TestDefaultControllerUsesClaudeSDKAdapterByDefault(t *testing.T) {
	t.Setenv(claudeCodeRuntimeEnv, "")

	controller := NewDefaultControllerWithProcessTransport(nil, nil)
	if _, ok := controller.adapters[ProviderClaudeCode].(*ClaudeCodeSDKAdapter); !ok {
		t.Fatalf("claude-code adapter = %T, want *ClaudeCodeSDKAdapter", controller.adapters[ProviderClaudeCode])
	}
}

func TestDefaultControllerUsesClaudeACPAdapterWhenRuntimeFlagSet(t *testing.T) {
	t.Setenv(claudeCodeRuntimeEnv, claudeCodeRuntimeACP)

	controller := NewDefaultControllerWithProcessTransport(nil, nil)
	if _, ok := controller.adapters[ProviderClaudeCode].(*standardACPAdapter); !ok {
		t.Fatalf("claude-code adapter = %T, want *standardACPAdapter", controller.adapters[ProviderClaudeCode])
	}
}

func TestDefaultControllerUsesClaudeSDKAdapterWhenRuntimeFlagSet(t *testing.T) {
	t.Setenv(claudeCodeRuntimeEnv, claudeCodeRuntimeSDK)

	controller := NewDefaultControllerWithProcessTransport(nil, nil)
	if _, ok := controller.adapters[ProviderClaudeCode].(*ClaudeCodeSDKAdapter); !ok {
		t.Fatalf("claude-code adapter = %T, want *ClaudeCodeSDKAdapter", controller.adapters[ProviderClaudeCode])
	}
}

func TestClaudeCodeSDKAdapterInteractiveApprovalRoundTrip(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := &recordingClaudeSDKConnection{}
	adapterSession := &claudeSDKAdapterSession{
		conn:            conn,
		pendingRequests: make(map[string]*pendingACPRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

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
	if len(started) != 2 || started[1].Type != activityshared.EventCallStarted {
		t.Fatalf("started events = %#v, want turn update and call started", started)
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

	result, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RequestID: "approval-1",
		OptionID:  "allow",
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if !result.Accepted || result.OptionID != "allow" {
		t.Fatalf("SubmitInteractive result = %#v", result)
	}
	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "submit_interactive" || sent[0].Payload["requestId"] != "approval-1" || sent[0].Payload["optionId"] != "allow" {
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
	if len(resolved) != 2 || resolved[0].Type != activityshared.EventCallCompleted || resolved[0].Payload.Output["selectedId"] != "allow" {
		t.Fatalf("resolved events = %#v, want completed approval", resolved)
	}
	if prompt := adapter.SessionState(session).PendingInteractive; prompt != nil {
		t.Fatalf("pending prompt after resolve = %#v, want nil", prompt)
	}
}

func TestClaudeCodeSDKAdapterApprovalResolvedUsesStoredTurnIDWhenEventTurnMissing(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := &recordingClaudeSDKConnection{}
	adapterSession := &claudeSDKAdapterSession{
		conn:            conn,
		pendingRequests: make(map[string]*pendingACPRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

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
		pendingRequests: make(map[string]*pendingACPRequest),
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
		pendingRequests: make(map[string]*pendingACPRequest),
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
		pendingRequests: make(map[string]*pendingACPRequest),
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
		pendingRequests: make(map[string]*pendingACPRequest),
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
		pendingRequests: make(map[string]*pendingACPRequest),
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
		pendingRequests: make(map[string]*pendingACPRequest),
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
		pendingRequests: make(map[string]*pendingACPRequest),
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
		pendingRequests: make(map[string]*pendingACPRequest),
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
		pendingRequests: make(map[string]*pendingACPRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

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

	events, err := adapter.Cancel(context.Background(), session, "turn-cancel")
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

func TestClaudeCodeSDKAdapterExecWithSidecarTestDriver(t *testing.T) {
	t.Setenv(claudeSDKSidecarTestDriverEnv, "1")

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
		pendingRequests:   make(map[string]*pendingACPRequest),
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
		pendingRequests:   make(map[string]*pendingACPRequest),
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

func TestClaudeCodeSDKAdapterCanResumeRequiresProviderSessionID(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = ""
	if adapter.CanResume(session) {
		t.Fatal("CanResume without provider session id = true, want false")
	}
	session.ProviderSessionID = "claude-session-1"
	if !adapter.CanResume(session) {
		t.Fatal("CanResume with provider session id = false, want true")
	}
}

func TestClaudeCodeSDKAdapterResumeClassifiesMissingProviderSession(t *testing.T) {
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "00000000-0000-4000-8000-000000000000"
	err := classifyClaudeSDKResumeError(session, errors.New("Claude Code returned an error result: No conversation found with session ID: 00000000-0000-4000-8000-000000000000"))
	if AppErrorCode(err) != AppErrorProviderSessionNotFound {
		t.Fatalf("app error code = %q, want %q", AppErrorCode(err), AppErrorProviderSessionNotFound)
	}
}

func TestClaudeCodeSDKAdapterSessionStateSeedsCommandsAndCapabilities(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	})

	state := adapter.SessionState(session)
	commands, _ := state.RuntimeContext["commands"].([]string)
	for _, want := range []string{"compact", "status", "fast", "goal", "review"} {
		if !containsString(commands, want) {
			t.Fatalf("commands = %#v, missing %q", commands, want)
		}
	}
	capabilities, _ := state.RuntimeContext["capabilities"].([]string)
	for _, want := range []string{CapabilityImageInput, CapabilityCompact, CapabilityTokenUsage, CapabilityRateLimits, CapabilityPlanMode, CapabilityInterrupt, "review"} {
		if !containsString(capabilities, want) {
			t.Fatalf("capabilities = %#v, missing %q", capabilities, want)
		}
	}
	snapshot, ok := adapter.SessionCommandSnapshot(session)
	if !ok || len(snapshot.Commands) == 0 {
		t.Fatalf("SessionCommandSnapshot = %#v ok=%v, want seeded commands", snapshot, ok)
	}
}

func TestClaudeCodeSDKAdapterSessionStateSeedsCanonicalSpeedConfigOption(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.Settings = &SessionSettings{Speed: "fast"}
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	})

	state := adapter.SessionState(session)
	if state.RuntimeContext["speed"] != "fast" {
		t.Fatalf("runtime speed = %#v, want fast", state.RuntimeContext["speed"])
	}
	if !hasClaudeSDKSpeedConfigOptions(state.RuntimeContext, "fast") {
		t.Fatalf("runtimeContext = %#v, want SDK speed config option set to fast", state.RuntimeContext)
	}
}

func TestClaudeCodeSDKAdapterRuntimeContextIncludesProviderConfig(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.Env = append(session.Env, "ANTHROPIC_BASE_URL=https://anthropic.proxy.test")
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	})

	state := adapter.SessionState(session)
	providerConfig, _ := state.RuntimeContext["providerConfig"].(map[string]any)
	if got, _ := providerConfig["baseUrl"].(string); got != "https://anthropic.proxy.test" {
		t.Fatalf("providerConfig = %#v, want SDK baseUrl", providerConfig)
	}
}

func TestClaudeCodeSDKAdapterStartSendsInitialSettings(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"session_started","payload":{"providerSessionId":"provider-session-1"}}` + "\n"),
		}},
	}
	transport := &recordingClaudeSDKTransport{conn: conn}
	adapter := NewClaudeCodeSDKAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "provider-session-1"
	session.PermissionModeID = "bypassPermissions"
	session.Settings = &SessionSettings{
		Model:            "sonnet",
		PermissionModeID: "bypassPermissions",
		PlanMode:         true,
		ReasoningEffort:  "xhigh",
		Speed:            "fast",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "start" {
		t.Fatalf("sent requests = %#v, want start", sent)
	}
	payload := sent[0].Payload
	if payload["permissionModeId"] != "bypassPermissions" {
		t.Fatalf("start payload permissionModeId = %#v", payload["permissionModeId"])
	}
	settings := payloadMap(payload, "settings")
	if settings["model"] != "sonnet" ||
		settings["permissionModeId"] != "bypassPermissions" ||
		settings["planMode"] != true ||
		settings["reasoningEffort"] != "xhigh" ||
		settings["speed"] != "fast" {
		t.Fatalf("start settings = %#v", settings)
	}
}

func TestClaudeSDKSidecarCommandUsesVendoredEntryWithManagedNodeEnv(t *testing.T) {
	t.Setenv(claudeSDKSidecarCommandEnv, "")
	t.Setenv(claudeSDKSidecarEntryPathEnv, "")

	got := claudeSDKSidecarCommand([]string{
		claudeSDKAppNodeEnv + "=/runtime/node/bin/node",
		claudeSDKSidecarEntryPathEnv + "=/resources/bin/claude-sdk-sidecar/src/main.ts",
	})
	want := []string{"/runtime/node/bin/node", claudeSDKSidecarDefaultNodeArg, "/resources/bin/claude-sdk-sidecar/src/main.ts"}
	if !slices.Equal(got, want) {
		t.Fatalf("claudeSDKSidecarCommand() = %#v, want %#v", got, want)
	}
}

func TestClaudeSDKSidecarCommandUsesManagedNodeCacheRoot(t *testing.T) {
	t.Setenv(claudeSDKSidecarCommandEnv, "")
	t.Setenv(claudeSDKSidecarEntryPathEnv, "")

	cacheRoot := t.TempDir()
	nodePath := filepath.Join(cacheRoot, runtime.GOOS+"-"+runtime.GOARCH, "node", "bin", claudeSDKNodeBinaryName())
	if err := os.MkdirAll(filepath.Dir(nodePath), 0o755); err != nil {
		t.Fatalf("mkdir node dir: %v", err)
	}
	if err := os.WriteFile(nodePath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write node: %v", err)
	}

	got := claudeSDKSidecarCommand([]string{
		claudeSDKAppRuntimeCacheEnv + "=" + cacheRoot,
		claudeSDKSidecarEntryPathEnv + "=/resources/bin/claude-sdk-sidecar/src/main.ts",
	})
	want := []string{nodePath, claudeSDKSidecarDefaultNodeArg, "/resources/bin/claude-sdk-sidecar/src/main.ts"}
	if !slices.Equal(got, want) {
		t.Fatalf("claudeSDKSidecarCommand() = %#v, want %#v", got, want)
	}
}

func TestClaudeSDKSidecarCommandOverrideWinsOverVendoredEntry(t *testing.T) {
	t.Setenv(claudeSDKSidecarCommandEnv, "/custom/sidecar --flag")

	got := claudeSDKSidecarCommand([]string{
		claudeSDKAppNodeEnv + "=/runtime/node/bin/node",
		claudeSDKSidecarEntryPathEnv + "=/resources/bin/claude-sdk-sidecar/src/main.ts",
	})
	want := []string{"/custom/sidecar", "--flag"}
	if !slices.Equal(got, want) {
		t.Fatalf("claudeSDKSidecarCommand() = %#v, want %#v", got, want)
	}
}

func TestClaudeCodeSDKAdapterStartEnablesSandboxBypassEnv(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"session_started","payload":{"providerSessionId":"provider-session-1"}}` + "\n"),
		}},
	}
	transport := &recordingClaudeSDKTransport{conn: conn}
	adapter := NewClaudeCodeSDKAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !containsString(transport.spec.Env, "IS_SANDBOX=1") {
		t.Fatalf("env = %#v, want IS_SANDBOX=1 for Claude SDK bypassPermissions availability", transport.spec.Env)
	}
}

func TestClaudeCodeSDKAdapterStartSendsClaudeProviderMeta(t *testing.T) {
	systemPromptPath := filepath.Join(t.TempDir(), "claude-system-prompt.md")
	if err := os.WriteFile(systemPromptPath, []byte("Use Tutti CLI for issue context."), 0o600); err != nil {
		t.Fatal(err)
	}
	pluginDir := filepath.Join(t.TempDir(), "tutti-cli-plugin")
	if err := os.MkdirAll(pluginDir, 0o700); err != nil {
		t.Fatal(err)
	}
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"session_started","payload":{"providerSessionId":"provider-session-meta"}}` + "\n"),
		}},
	}
	adapter := NewClaudeCodeSDKAdapter(&recordingClaudeSDKTransport{conn: conn})
	session := standardTestSession(ProviderClaudeCode)
	session.Env = []string{
		claudeSystemPromptFileEnv + "=" + systemPromptPath,
		claudePluginDirEnv + "=" + pluginDir,
	}
	session.Settings = &SessionSettings{
		Model:            "MiniMax-M2.7",
		PermissionModeID: "default",
		PlanMode:         true,
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "start" {
		t.Fatalf("sent requests = %#v, want start", sent)
	}
	payload := sent[0].Payload
	if got, _ := payload["systemPromptAppend"].(string); got != "Use Tutti CLI for issue context." {
		t.Fatalf("systemPromptAppend = %q, want prompt file content", got)
	}
	if got, _ := payload["planModeInstructions"].(string); !strings.Contains(got, "do not edit files") || !strings.Contains(got, "implementation plan") {
		t.Fatalf("planModeInstructions = %#v, want Tutti plan workflow instructions", payload["planModeInstructions"])
	}
	allowedTools, ok := payload["allowedTools"].([]any)
	grepAllowed := false
	globAllowed := false
	for _, tool := range allowedTools {
		grepAllowed = grepAllowed || asString(tool) == "Grep"
		globAllowed = globAllowed || asString(tool) == "Glob"
	}
	if !ok || !grepAllowed || !globAllowed {
		t.Fatalf("allowedTools = %#v, want Grep and Glob enabled", payload["allowedTools"])
	}
	disallowedTools, ok := payload["disallowedTools"].([]any)
	monitorDisallowed := false
	for _, tool := range disallowedTools {
		monitorDisallowed = monitorDisallowed || asString(tool) == "Monitor"
	}
	if !ok || !monitorDisallowed {
		t.Fatalf("disallowedTools = %#v, want Monitor disabled", payload["disallowedTools"])
	}
	tools, ok := payload["tools"].(map[string]any)
	if !ok || tools["type"] != "preset" || tools["preset"] != "claude_code" {
		t.Fatalf("tools = %#v, want claude_code preset", payload["tools"])
	}
	plugins, ok := payload["plugins"].([]any)
	if !ok || len(plugins) != 1 {
		t.Fatalf("plugins = %#v, want local plugin dir", payload["plugins"])
	}
	plugin, _ := plugins[0].(map[string]any)
	if plugin["type"] != "local" || plugin["path"] != pluginDir {
		t.Fatalf("plugins = %#v, want local plugin dir", payload["plugins"])
	}
	extraArgs, ok := payload["extraArgs"].(map[string]any)
	if !ok || extraArgs["plugin-dir"] != pluginDir || extraArgs["model"] != "MiniMax-M2.7" {
		t.Fatalf("extraArgs = %#v, want plugin-dir and custom model", payload["extraArgs"])
	}
}

func TestClaudeCodeSDKAdapterStartFailsBeforeProcessForMissingClaudeMetaFiles(t *testing.T) {
	transport := &recordingClaudeSDKTransport{conn: &scriptedClaudeSDKConnection{}}
	adapter := NewClaudeCodeSDKAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.Env = []string{claudeSystemPromptFileEnv + "=" + filepath.Join(t.TempDir(), "missing.md")}

	if _, err := adapter.Start(context.Background(), session); err == nil {
		t.Fatal("Start error = nil, want missing system prompt error")
	}
	if transport.spec.Command != nil {
		t.Fatalf("process spec = %#v, want no sidecar process start on invalid meta", transport.spec)
	}

	pluginTransport := &recordingClaudeSDKTransport{conn: &scriptedClaudeSDKConnection{}}
	pluginAdapter := NewClaudeCodeSDKAdapter(pluginTransport)
	pluginSession := standardTestSession(ProviderClaudeCode)
	pluginSession.Env = []string{claudePluginDirEnv + "=" + filepath.Join(t.TempDir(), "missing-plugin")}

	if _, err := pluginAdapter.Start(context.Background(), pluginSession); err == nil {
		t.Fatal("Start error = nil, want missing plugin dir error")
	}
	if pluginTransport.spec.Command != nil {
		t.Fatalf("process spec = %#v, want no sidecar process start on invalid plugin dir", pluginTransport.spec)
	}
}

func TestClaudeCodeSDKAdapterStartSendsResumeCursor(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"session_started","payload":{"providerSessionId":"provider-session-1","resumeCursor":{"kind":"claude-agent-sdk","version":1,"resume":"provider-session-1","resumeSessionAt":"assistant-1","turnCount":7}}}` + "\n"),
		}},
	}
	adapter := NewClaudeCodeSDKAdapter(&recordingClaudeSDKTransport{conn: conn})
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "provider-session-1"
	session.RuntimeContext = map[string]any{
		"resumeCursor": map[string]any{
			"kind":            "claude-agent-sdk",
			"version":         int64(1),
			"resume":          "provider-session-1",
			"resumeSessionAt": "assistant-1",
			"turnCount":       int64(7),
		},
	}

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session started", events)
	}
	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "start" {
		t.Fatalf("sent requests = %#v, want start", sent)
	}
	cursor := payloadMap(sent[0].Payload, "resumeCursor")
	if cursor["resume"] != "provider-session-1" || cursor["resumeSessionAt"] != "assistant-1" {
		t.Fatalf("resume cursor payload = %#v", cursor)
	}
	stateCursor := payloadMap(events[0].Payload.Metadata, "resumeCursor")
	if stateCursor["resume"] != "provider-session-1" || stateCursor["resumeSessionAt"] != "assistant-1" {
		t.Fatalf("started runtime cursor = %#v", stateCursor)
	}
}

func TestClaudeCodeSDKAdapterSessionStateUpdatesResumeCursor(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "session_state",
		Payload: map[string]any{
			"providerSessionId": "provider-session-2",
			"resumeCursor": map[string]any{
				"kind":            "claude-agent-sdk",
				"version":         int64(1),
				"resume":          "provider-session-2",
				"resumeSessionAt": "assistant-2",
				"turnCount":       int64(3),
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("session_state terminal=%v err=%v", terminal, err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("events = %#v, want session.updated", events)
	}
	if adapterSession.providerSessionID != "provider-session-2" {
		t.Fatalf("provider session id = %q, want updated", adapterSession.providerSessionID)
	}
	state := adapter.SessionState(session)
	cursor := payloadMap(state.RuntimeContext, "resumeCursor")
	if cursor["resume"] != "provider-session-2" || cursor["resumeSessionAt"] != "assistant-2" {
		t.Fatalf("runtime cursor = %#v", cursor)
	}
}

func TestClaudeCodeSDKAdapterResumeFailureRestoresPreviousLiveSession(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"error","payload":{"error":"No conversation found with session ID: provider-session-1"}}` + "\n"),
		}},
	}
	adapter := NewClaudeCodeSDKAdapter(&recordingClaudeSDKTransport{conn: conn})
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "provider-session-1"
	previous := &claudeSDKAdapterSession{
		conn:              &recordingClaudeSDKConnection{},
		providerSessionID: "previous-live-session",
		liveState:         newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, previous)

	err := adapter.Resume(context.Background(), session)
	if AppErrorCode(err) != AppErrorProviderSessionNotFound {
		t.Fatalf("Resume error = %v, want provider session not found", err)
	}
	if got := adapter.getSession(session.AgentSessionID); got != previous {
		t.Fatalf("live session not restored after failed resume")
	}
}

func TestClaudeCodeSDKAdapterSessionStateProjectsSettings(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "auto"
	session.Settings = &SessionSettings{
		Model:            "sonnet",
		PermissionModeID: "auto",
		ReasoningEffort:  "xhigh",
		Speed:            "fast",
		PlanMode:         true,
	}
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	})

	state := adapter.SessionState(session)
	if state.RuntimeContext["model"] != "sonnet" ||
		state.RuntimeContext["permissionModeId"] != "auto" ||
		state.RuntimeContext["reasoningEffort"] != "xhigh" ||
		state.RuntimeContext["speed"] != "fast" ||
		state.RuntimeContext["planMode"] != true {
		t.Fatalf("runtimeContext settings = %#v", state.RuntimeContext)
	}
	if !hasClaudeSDKEffortConfigOptions(state.RuntimeContext, "xhigh") {
		t.Fatalf("runtimeContext = %#v, want SDK effort config option set to xhigh", state.RuntimeContext)
	}
}

func TestClaudeCodeSDKAdapterAcceptsImagePromptContent(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)

	if err := adapter.ValidatePromptContent(session, []PromptContentBlock{
		{Type: "text", Text: "what is in this image?"},
		{Type: "image", MimeType: "image/png", Data: "aW1hZ2U="},
	}); err != nil {
		t.Fatalf("ValidatePromptContent supported image = %v, want nil", err)
	}
	if err := adapter.ValidatePromptContent(session, []PromptContentBlock{
		{Type: "image", MimeType: "image/gif", Data: "aW1hZ2U="},
	}); !errors.Is(err, ErrPromptImageUnsupported) {
		t.Fatalf("ValidatePromptContent unsupported image = %v, want ErrPromptImageUnsupported", err)
	}
}

func TestClaudeCodeSDKAdapterExecSendsStructuredPromptContent(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"turn_completed","payload":{"turnId":"turn-image","stopReason":"end_turn"}}` + "\n"),
		}},
	}
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		conn:              conn,
		reader:            &claudeSDKLineReader{conn: conn},
		providerSessionID: "provider-session-1",
		pendingRequests:   make(map[string]*pendingACPRequest),
		liveState:         newClaudeSDKLiveState(),
	})

	if _, err := adapter.Exec(
		context.Background(),
		session,
		[]PromptContentBlock{
			{Type: "text", Text: "what is in this image?"},
			{Type: "image", MimeType: "image/png", Data: "aW1hZ2U="},
		},
		"what is in this image?",
		"turn-image",
		nil,
		nil,
	); err != nil {
		t.Fatalf("Exec: %v", err)
	}

	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "exec" {
		t.Fatalf("sent requests = %#v, want one exec", sent)
	}
	if sent[0].Payload["prompt"] != "what is in this image?" {
		t.Fatalf("exec prompt = %#v, want legacy text prompt", sent[0].Payload["prompt"])
	}
	content, ok := sent[0].Payload["content"].([]any)
	if !ok || len(content) != 2 {
		t.Fatalf("exec content = %#v, want text and image blocks", sent[0].Payload["content"])
	}
	textBlock, _ := content[0].(map[string]any)
	if textBlock["type"] != "text" || textBlock["text"] != "what is in this image?" {
		t.Fatalf("text block = %#v", textBlock)
	}
	imageBlock, _ := content[1].(map[string]any)
	if imageBlock["type"] != "image" || imageBlock["mimeType"] != "image/png" || imageBlock["data"] != "aW1hZ2U=" {
		t.Fatalf("image block = %#v", imageBlock)
	}
}

func TestClaudeCodeSDKAdapterApplySessionSettingsSpeedSendsSidecarAndUpdatesRuntimeContext(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := &ackClaudeSDKConnection{}
	adapterSession := &claudeSDKAdapterSession{
		conn:            conn,
		reader:          &claudeSDKLineReader{conn: conn},
		pendingRequests: make(map[string]*pendingACPRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Speed: stringPtr("fast"),
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "apply_settings" || sent[0].Payload["speed"] != "fast" {
		t.Fatalf("sent requests = %#v, want apply_settings fast", sent)
	}
	state := adapter.SessionState(session)
	if state.RuntimeContext["speed"] != "fast" || !hasClaudeSDKSpeedConfigOptions(state.RuntimeContext, "fast") {
		t.Fatalf("runtimeContext = %#v, want fast speed after live apply", state.RuntimeContext)
	}
}

func TestClaudeCodeSDKAdapterApplyPermissionModeSendsSidecar(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "default"
	session.Settings = &SessionSettings{PlanMode: true, PermissionModeID: "default"}
	conn := &ackClaudeSDKConnection{}
	adapterSession := &claudeSDKAdapterSession{
		conn:      conn,
		reader:    &claudeSDKLineReader{conn: conn},
		liveState: newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	if err := adapter.ApplyPermissionMode(context.Background(), session); err != nil {
		t.Fatalf("ApplyPermissionMode: %v", err)
	}

	sent := conn.sentRequests()
	if len(sent) != 1 ||
		sent[0].Type != "apply_settings" ||
		sent[0].Payload["permissionMode"] != "plan" ||
		sent[0].Payload["planMode"] != true {
		t.Fatalf("sent requests = %#v, want apply_settings plan permission mode", sent)
	}
}

func TestClaudeCodeSDKAdapterApplySessionSettingsSendsLiveSettings(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "auto"
	session.Settings = &SessionSettings{
		Model:            "sonnet",
		PermissionModeID: "auto",
		ReasoningEffort:  "xhigh",
		Speed:            "fast",
		PlanMode:         true,
	}
	conn := &ackClaudeSDKConnection{}
	adapterSession := &claudeSDKAdapterSession{
		conn:      conn,
		reader:    &claudeSDKLineReader{conn: conn},
		liveState: newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	planMode := true

	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Model:           stringPtr("sonnet"),
		ReasoningEffort: stringPtr("xhigh"),
		Speed:           stringPtr("fast"),
		PlanMode:        &planMode,
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "apply_settings" {
		t.Fatalf("sent requests = %#v, want apply_settings", sent)
	}
	payload := sent[0].Payload
	if payload["model"] != "sonnet" ||
		payload["effort"] != "xhigh" ||
		payload["speed"] != "fast" ||
		payload["permissionMode"] != "plan" ||
		payload["planMode"] != true {
		t.Fatalf("apply settings payload = %#v", payload)
	}
	state := adapter.SessionState(session)
	if state.RuntimeContext["model"] != "sonnet" ||
		state.RuntimeContext["reasoningEffort"] != "xhigh" ||
		state.RuntimeContext["speed"] != "fast" ||
		state.RuntimeContext["planMode"] != true {
		t.Fatalf("runtimeContext = %#v, want applied live settings", state.RuntimeContext)
	}
}

func TestClaudeCodeSDKAdapterSettingsDoNotRequireNewSession(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	planMode := true

	if adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{
		Model:           stringPtr("sonnet"),
		ReasoningEffort: stringPtr("xhigh"),
		Speed:           stringPtr("fast"),
		PlanMode:        &planMode,
	}) {
		t.Fatal("RequiresNewSessionForSettings = true, want false for live SDK settings")
	}
}

func TestClaudeCodeSDKAdapterMapsFastModeStateAndKeepsCooldownFromClobberingSpeed(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "speed_updated",
		Payload: map[string]any{
			"turnId": "turn-1",
			"state":  "on",
		},
	})
	if err != nil || terminal || len(events) != 1 {
		t.Fatalf("speed on events=%#v terminal=%v err=%v, want one session update", events, terminal, err)
	}
	if got := adapter.SessionState(session).RuntimeContext["speed"]; got != "fast" {
		t.Fatalf("speed after on = %#v, want fast", got)
	}

	cooldown, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "speed_updated",
		Payload: map[string]any{
			"turnId": "turn-1",
			"state":  "cooldown",
		},
	})
	if err != nil || terminal || len(cooldown) != 0 {
		t.Fatalf("cooldown events=%#v terminal=%v err=%v, want no state clobber", cooldown, terminal, err)
	}
	if got := adapter.SessionState(session).RuntimeContext["speed"]; got != "fast" {
		t.Fatalf("speed after cooldown = %#v, want fast", got)
	}
}

func TestClaudeCodeSDKAdapterMapsCommandsUpdated(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	var snapshots []AgentSessionCommandSnapshot
	adapter.SetCommandSnapshotSink(func(snapshot AgentSessionCommandSnapshot) {
		snapshots = append(snapshots, snapshot)
	})

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "commands_updated",
		Payload: map[string]any{
			"commands": []any{
				map[string]any{"name": "context", "description": "Show context", "input": map[string]any{"hint": "scope"}},
				"usage",
				map[string]any{"name": "context", "description": "Duplicate"},
			},
		},
	})
	if err != nil || terminal || len(events) != 0 {
		t.Fatalf("commands_updated events=%#v terminal=%v err=%v, want non-terminal state update", events, terminal, err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %#v, want one command snapshot", snapshots)
	}
	if len(snapshots[0].Commands) != 2 ||
		snapshots[0].Commands[0].Name != "context" ||
		snapshots[0].Commands[0].InputHint != "scope" ||
		snapshots[0].Commands[1].Name != "usage" {
		t.Fatalf("snapshot commands = %#v", snapshots[0].Commands)
	}
	state := adapter.SessionState(session)
	commands, _ := state.RuntimeContext["commands"].([]string)
	if len(commands) != 2 || commands[0] != "context" || commands[1] != "usage" {
		t.Fatalf("runtime commands = %#v, want replaced command list", commands)
	}
}

func TestClaudeCodeSDKAdapterMapsUsageUpdatedIntoRuntimeContext(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-1",
			"usage": map[string]any{
				"input_tokens":                100,
				"output_tokens":               20,
				"cache_read_input_tokens":     7,
				"cache_creation_input_tokens": 3,
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("usage_updated terminal=%v err=%v", terminal, err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("usage events = %#v, want session.updated", events)
	}
	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, ok := acpInt64Value(contextWindow["usedTokens"]); !ok || got != 130 {
		t.Fatalf("usedTokens = %#v, want 130", contextWindow["usedTokens"])
	}
	if got, ok := acpInt64Value(contextWindow["totalTokens"]); !ok || got != claudeSDKDefaultContextWindow {
		t.Fatalf("totalTokens = %#v, want default context window", contextWindow["totalTokens"])
	}
}

func TestClaudeCodeSDKAdapterUsesSonnetContextWindowForStreamUsage(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	adapterSession.applyConfigOption("model", "sonnet")

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-1",
			"usage": map[string]any{
				"input_tokens":                2,
				"output_tokens":               145,
				"cache_read_input_tokens":     18_622,
				"cache_creation_input_tokens": 17_688,
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("usage_updated terminal=%v err=%v", terminal, err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("usage events = %#v, want session.updated", events)
	}
	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, ok := acpInt64Value(contextWindow["usedTokens"]); !ok || got != 36_457 {
		t.Fatalf("usedTokens = %#v, want 36457", contextWindow["usedTokens"])
	}
	if got, ok := acpInt64Value(contextWindow["totalTokens"]); !ok || got != claudeSDKLargeContextWindow {
		t.Fatalf("totalTokens = %#v, want large context window", contextWindow["totalTokens"])
	}
}

func TestClaudeCodeSDKAdapterMapsModelUsageContextWindowMap(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	adapterSession.applyConfigOption("model", "sonnet")

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-1",
			"usage": map[string]any{
				"input_tokens":                2,
				"output_tokens":               13,
				"cache_read_input_tokens":     18622,
				"cache_creation_input_tokens": 17466,
			},
			"modelUsage": map[string]any{
				"claude-haiku-4-5-20251001": map[string]any{
					"contextWindow": 200_000,
				},
				"claude-sonnet-5": map[string]any{
					"contextWindow": 1_000_000,
				},
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("usage_updated terminal=%v err=%v", terminal, err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("usage events = %#v, want session.updated", events)
	}
	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, ok := acpInt64Value(contextWindow["usedTokens"]); !ok || got != 36103 {
		t.Fatalf("usedTokens = %#v, want 36103", contextWindow["usedTokens"])
	}
	if got, ok := acpInt64Value(contextWindow["totalTokens"]); !ok || got != 1_000_000 {
		t.Fatalf("totalTokens = %#v, want model usage context window", contextWindow["totalTokens"])
	}
}

func TestClaudeCodeSDKAdapterDoesNotCarryContextWindowAcrossModelChange(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	adapterSession.applyConfigOption("model", "haiku")
	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-1",
			"contextWindow": map[string]any{
				"usedTokens":  20_000,
				"totalTokens": 200_000,
			},
		},
	})
	if err != nil || terminal || len(events) != 1 {
		t.Fatalf("haiku usage events=%#v terminal=%v err=%v, want session.updated", events, terminal, err)
	}

	adapterSession.applyConfigOption("model", "sonnet")
	events, terminal, err = adapter.sidecarTurnEvents(adapterSession, session, "turn-2", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-2",
			"usage": map[string]any{
				"input_tokens":                2,
				"output_tokens":               13,
				"cache_read_input_tokens":     18_622,
				"cache_creation_input_tokens": 17_466,
			},
			"modelUsage": map[string]any{
				"claude-sonnet-5": map[string]any{
					"contextWindow": 1_000_000,
				},
			},
		},
	})
	if err != nil || terminal || len(events) != 1 {
		t.Fatalf("sonnet usage events=%#v terminal=%v err=%v, want session.updated", events, terminal, err)
	}

	adapterSession.applyConfigOption("model", "haiku")
	events, terminal, err = adapter.sidecarTurnEvents(adapterSession, session, "turn-3", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-3",
			"contextWindow": map[string]any{
				"usedTokens": 29_538,
			},
		},
	})
	if err != nil || terminal || len(events) != 1 {
		t.Fatalf("haiku context usage events=%#v terminal=%v err=%v, want session.updated", events, terminal, err)
	}
	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, ok := acpInt64Value(contextWindow["usedTokens"]); !ok || got != 29_538 {
		t.Fatalf("usedTokens = %#v, want latest haiku context usage", contextWindow["usedTokens"])
	}
	if got, ok := acpInt64Value(contextWindow["totalTokens"]); !ok || got != 200_000 {
		t.Fatalf("totalTokens = %#v, want default context window after model switch", contextWindow["totalTokens"])
	}
}

func TestClaudeCodeSDKAdapterMapsContextUsageUpdatedIntoRuntimeContext(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId": "turn-1",
			"contextWindow": map[string]any{
				"usedTokens":  50_062,
				"totalTokens": 200_000,
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("usage_updated terminal=%v err=%v", terminal, err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("usage events = %#v, want session.updated", events)
	}
	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, ok := acpInt64Value(contextWindow["usedTokens"]); !ok || got != 50_062 {
		t.Fatalf("usedTokens = %#v, want getContextUsage snapshot", contextWindow["usedTokens"])
	}
	if got, ok := acpInt64Value(contextWindow["totalTokens"]); !ok || got != 200_000 {
		t.Fatalf("totalTokens = %#v, want model context window", contextWindow["totalTokens"])
	}
}

func TestClaudeCodeSDKAdapterStartAppliesRestoreUsageBeforeSessionStarted(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}

	events := adapter.applySidecarSessionEvent(adapterSession, session, claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"contextWindow": map[string]any{
				"usedTokens":  50_062,
				"totalTokens": 200_000,
			},
		},
	})
	if len(events) != 0 {
		t.Fatalf("restore usage events = %#v, want buffered state only", events)
	}
	events = adapter.applySidecarSessionEvent(adapterSession, session, claudeSDKSidecarEvent{
		Type: "session_started",
		Payload: map[string]any{
			"providerSessionId": "provider-session-1",
		},
	})
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("session_started events = %#v, want started event", events)
	}
	usage, _ := events[0].Payload.Metadata["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, ok := acpInt64Value(contextWindow["usedTokens"]); !ok || got != 50_062 {
		t.Fatalf("started runtime usage = %#v, want restore snapshot", events[0].Payload.Metadata["usage"])
	}
}

func TestClaudeCodeSDKAdapterSessionStartedUsesSidecarModelConfigOptions(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}

	events := adapter.applySidecarSessionEvent(adapterSession, session, claudeSDKSidecarEvent{
		Type: "session_started",
		Payload: map[string]any{
			"providerSessionId": "provider-session-1",
			"model":             "mimo-v2.5-pro",
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "mimo-v2.5-pro",
					"options": []any{
						map[string]any{
							"value":       "default",
							"name":        "Default",
							"description": "Provider default",
						},
						map[string]any{
							"value":       "mimo-v2.5-pro",
							"name":        "Mimo v2.5 Pro",
							"description": "Custom Mimo model",
						},
					},
				},
			},
		},
	})

	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("session_started events = %#v, want started event", events)
	}
	configOptions, ok := events[0].Payload.Metadata["configOptions"].([]map[string]any)
	if !ok {
		t.Fatalf("configOptions = %#v, want descriptors", events[0].Payload.Metadata["configOptions"])
	}
	modelOption := configOptionByID(configOptions, "model")
	if modelOption == nil {
		t.Fatalf("configOptions = %#v, missing model option", configOptions)
	}
	if modelOption["currentValue"] != "mimo-v2.5-pro" {
		t.Fatalf("model option currentValue = %#v, want mimo", modelOption["currentValue"])
	}
	modelOptions := configOptionEntries(modelOption["options"])
	if len(modelOptions) != 2 || modelOptions[1]["value"] != "mimo-v2.5-pro" || modelOptions[1]["name"] != "Mimo v2.5 Pro" {
		t.Fatalf("model options = %#v, want sidecar options", modelOptions)
	}
	if events[0].Payload.Metadata["model"] != "mimo-v2.5-pro" {
		t.Fatalf("runtime model = %#v, want mimo", events[0].Payload.Metadata["model"])
	}
}

func TestClaudeCodeSDKAdapterMapsSessionTitleUpdated(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.Title = "inspect repo"

	events, terminal, err := adapter.sidecarTurnEvents(&claudeSDKAdapterSession{}, session, "turn-1", claudeSDKSidecarEvent{
		Type: "session_title_updated",
		Payload: map[string]any{
			"title": " Inspect repository structure ",
		},
	})
	if err != nil || terminal {
		t.Fatalf("session_title_updated terminal=%v err=%v", terminal, err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("events = %#v, want session.updated", events)
	}
	if events[0].Payload.Title != "Inspect repository structure" {
		t.Fatalf("title = %q, want provider title", events[0].Payload.Title)
	}
}

func TestClaudeCodeSDKAdapterMirrorsGoalSlashPromptIntoRuntimeContext(t *testing.T) {
	t.Parallel()

	adapterSession := &claudeSDKAdapterSession{
		liveState: newClaudeSDKLiveState(),
	}
	session := standardTestSession(ProviderClaudeCode)

	if event, ok := adapterSession.mirrorGoalSlashPrompt(session, "/goal ship native goal"); !ok {
		t.Fatal("mirrorGoalSlashPrompt ok=false, want goal mirror")
	} else if event.Type != activityshared.EventSessionUpdated {
		t.Fatalf("event type = %q, want session.updated", event.Type)
	}
	goal := payloadObject(claudeSDKRuntimeContext(session, adapterSession)["goal"])
	if asString(goal["objective"]) != "ship native goal" || asString(goal["status"]) != "active" {
		t.Fatalf("runtime goal = %#v, want active objective", goal)
	}

	if _, ok := adapterSession.mirrorGoalSlashPrompt(session, "/goal clear"); !ok {
		t.Fatal("mirrorGoalSlashPrompt clear ok=false")
	}
	if goal := payloadObject(claudeSDKRuntimeContext(session, adapterSession)["goal"]); len(goal) != 0 {
		t.Fatalf("runtime goal after clear = %#v, want empty", goal)
	}
}

func TestClaudeCodeSDKAdapterMapsGoalUpdatedSidecarEvent(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	adapterSession := &claudeSDKAdapterSession{
		liveState: newClaudeSDKLiveState(),
	}
	session := standardTestSession(ProviderClaudeCode)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-goal", claudeSDKSidecarEvent{
		Type: "goal_updated",
		Payload: map[string]any{
			"turnId":     "turn-goal",
			"updateType": "thread_goal_update",
			"goal": map[string]any{
				"objective": "ship native goal",
				"status":    "active",
				"sentinel":  true,
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("goal_updated terminal=%v err=%v", terminal, err)
	}
	if len(activityEventsWithType(events, activityshared.EventSessionUpdated)) < 2 {
		t.Fatalf("events = %#v, want goal session.updated events", events)
	}
	goal := payloadObject(claudeSDKRuntimeContext(session, adapterSession)["goal"])
	if asString(goal["objective"]) != "ship native goal" || asString(goal["status"]) != "active" {
		t.Fatalf("runtime goal = %#v, want active SDK goal status", goal)
	}

	events, terminal, err = adapter.sidecarTurnEvents(adapterSession, session, "turn-goal", claudeSDKSidecarEvent{
		Type: "goal_updated",
		Payload: map[string]any{
			"turnId":     "turn-goal",
			"updateType": "thread_goal_cleared",
		},
	})
	if err != nil || terminal {
		t.Fatalf("goal cleared terminal=%v err=%v", terminal, err)
	}
	if len(events) == 0 {
		t.Fatal("events empty, want goal cleared session.updated")
	}
	if goal := payloadObject(claudeSDKRuntimeContext(session, adapterSession)["goal"]); len(goal) != 0 {
		t.Fatalf("runtime goal after clear = %#v, want empty", goal)
	}
}

func TestClaudeCodeSDKAdapterExecEmitsPromptFallbackTitle(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"turn_completed","payload":{"turnId":"turn-1","stopReason":"end_turn"}}` + "\n"),
		}},
	}
	adapterSession := &claudeSDKAdapterSession{
		conn:              conn,
		reader:            &claudeSDKLineReader{conn: conn},
		providerSessionID: session.ProviderSessionID,
		pendingRequests:   make(map[string]*pendingACPRequest),
		liveState:         newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	var emitted []activityshared.Event
	events, err := adapter.Exec(context.Background(), session, textPrompt(" inspect repo "), "", "turn-1", func(next []activityshared.Event) {
		emitted = append(emitted, next...)
	}, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	titleEvents := activityEventsWithType(emitted, activityshared.EventSessionUpdated)
	if len(titleEvents) != 1 || titleEvents[0].Payload.Title != "inspect repo" {
		t.Fatalf("title events = %#v, want prompt fallback title", titleEvents)
	}
	if !hasActivityMessage(events, activityshared.MessageRoleUser, "inspect repo") {
		t.Fatalf("events = %#v, missing user prompt", events)
	}
}

func TestClaudeCodeSDKAdapterIgnoresCanceledTurnOrphanBeforeCompactResult(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}

	_, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-canceled", claudeSDKSidecarEvent{
		Type:    "turn_canceled",
		Payload: map[string]any{"turnId": "turn-canceled"},
	})
	if err != nil || !terminal {
		t.Fatalf("turn_canceled terminal=%v err=%v, want terminal cancel", terminal, err)
	}
	orphan, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-compact", claudeSDKSidecarEvent{
		Type:    "turn_completed",
		Payload: map[string]any{"turnId": "turn-canceled"},
	})
	if err != nil || terminal || len(orphan) != 0 {
		t.Fatalf("orphan events=%#v terminal=%v err=%v, want ignored stale turn result", orphan, terminal, err)
	}
	compact, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-compact", claudeSDKSidecarEvent{
		Type:    "turn_completed",
		Payload: map[string]any{"turnId": "turn-compact"},
	})
	if err != nil || !terminal || len(compact) != 1 || compact[0].Type != activityshared.EventTurnCompleted {
		t.Fatalf("compact result events=%#v terminal=%v err=%v, want compact turn completion", compact, terminal, err)
	}
}

func TestClaudeCodeSDKAdapterMapsThinkingEvents(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	adapterSession := &claudeSDKAdapterSession{}
	session := standardTestSession(ProviderClaudeCode)

	streaming, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "thinking_delta",
		Payload: map[string]any{
			"snapshot": "Need context.",
		},
	})
	if err != nil || terminal {
		t.Fatalf("thinking_delta err=%v terminal=%v", err, terminal)
	}
	completed, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "thinking_completed",
		Payload: map[string]any{
			"content": "Need context.",
		},
	})
	if err != nil || terminal {
		t.Fatalf("thinking_completed err=%v terminal=%v", err, terminal)
	}
	if len(streaming) != 1 || len(completed) != 1 {
		t.Fatalf("events = %#v %#v, want one streaming and one completed thinking event", streaming, completed)
	}
	if streaming[0].Type != activityshared.EventMessageAppended ||
		streaming[0].Payload.Role != activityshared.MessageRoleAssistantThinking ||
		streaming[0].Payload.Content != "Need context." {
		t.Fatalf("streaming thinking = %#v", streaming[0])
	}
	if completed[0].EventID != streaming[0].EventID {
		t.Fatalf("thinking event IDs = %q and %q, want stable ID", streaming[0].EventID, completed[0].EventID)
	}
	if completed[0].Payload.Metadata["streamState"] != messageStreamStateCompleted {
		t.Fatalf("completed metadata = %#v, want completed stream state", completed[0].Payload.Metadata)
	}
}

func TestClaudeCodeSDKAdapterMapsToolLifecycleAndFileMetadata(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	adapterSession := &claudeSDKAdapterSession{}
	session := standardTestSession(ProviderClaudeCode)

	started, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "tool_started",
		Payload: map[string]any{
			"toolCallId": "toolu-1",
			"toolName":   "Edit",
			"callType":   "file_change",
			"name":       "Edit",
			"status":     "streaming",
			"input": map[string]any{
				"file_path":  "/tmp/a.txt",
				"old_string": "old",
				"new_string": "new",
			},
			"locations": []any{map[string]any{"path": "/tmp/a.txt"}},
			"metadata": map[string]any{
				"fileChange": map[string]any{
					"paths":   []any{"/tmp/a.txt"},
					"oldText": "old",
					"newText": "new",
				},
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("tool_started err=%v terminal=%v", err, terminal)
	}
	completed, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "tool_completed",
		Payload: map[string]any{
			"toolCallId": "toolu-1",
			"toolName":   "Edit",
			"callType":   "file_change",
			"name":       "Edit",
			"status":     "completed",
			"output": map[string]any{
				"text": "updated",
			},
			"metadata": map[string]any{
				"claudeToolResponse": map[string]any{
					"structuredPatch": map[string]any{"path": "/tmp/a.txt"},
				},
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("tool_completed err=%v terminal=%v", err, terminal)
	}
	if len(started) != 1 || started[0].Type != activityshared.EventCallStarted {
		t.Fatalf("started = %#v, want call.started", started)
	}
	if len(completed) != 1 || completed[0].Type != activityshared.EventCallCompleted {
		t.Fatalf("completed = %#v, want call.completed", completed)
	}
	if started[0].EventID != "claude-sdk:tool:toolu-1" || completed[0].EventID != started[0].EventID {
		t.Fatalf("event IDs = %q %q, want stable tool ID", started[0].EventID, completed[0].EventID)
	}
	if started[0].Payload.CallID != "toolu-1" || started[0].Payload.CallType != "file_change" {
		t.Fatalf("started payload = %#v", started[0].Payload)
	}
	if locations, ok := started[0].Payload.Metadata["locations"].([]any); !ok || len(locations) != 1 {
		t.Fatalf("locations metadata = %#v, want one file location", started[0].Payload.Metadata["locations"])
	}
	sidecarMetadata := payloadMap(started[0].Payload.Metadata, "metadata")
	fileChange := payloadMap(sidecarMetadata, "fileChange")
	if fileChange["oldText"] != "old" || fileChange["newText"] != "new" {
		t.Fatalf("fileChange metadata = %#v, want edit diff text", fileChange)
	}
	completedMetadata := payloadMap(completed[0].Payload.Metadata, "metadata")
	if toolResponse := payloadMap(completedMetadata, "claudeToolResponse"); payloadMap(toolResponse, "structuredPatch") == nil {
		t.Fatalf("completed metadata = %#v, want structuredPatch", completed[0].Payload.Metadata)
	}
}

func TestClaudeSDKLineReaderExitErrorIncludesCapturedStderrTail(t *testing.T) {
	// Regression: previously, any sidecar stderr not matching the
	// auth-refresh-debug marker was silently discarded (logClaudeSDKSidecarDebugStderr),
	// so if the sidecar crashed with an uncaught exception, its stack trace
	// never reached the resulting error or the logs — the exit surfaced as a
	// bare "claude sdk sidecar exited with code N" black box. The reader must
	// now quote the captured stderr tail, mirroring acpClient.readLoop's
	// handling of the Codex ACP transport.
	exitCode := 1
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{
			{Stderr: []byte("TypeError: something went wrong\n    at main (main.ts:1:1)\n")},
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
	if !strings.Contains(err.Error(), "TypeError: something went wrong") {
		t.Fatalf("next() err = %q, want it to quote the captured stderr tail", err.Error())
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

func hasTimelineItemInReports(reports []agentsessionstore.ReportActivityInput, itemType string, status string, text string) bool {
	for _, report := range reports {
		if hasTimelineItem(report, itemType, status, text) {
			return true
		}
	}
	return false
}

func sdkBackgroundAgentsFromEvents(t *testing.T, events []activityshared.Event) map[string]any {
	t.Helper()
	for i := len(events) - 1; i >= 0; i-- {
		event := events[i]
		if event.Type != activityshared.EventSessionUpdated {
			continue
		}
		runtimeContext := payloadMap(event.Payload.Metadata, "runtimeContext")
		backgroundAgents := payloadMap(runtimeContext, "backgroundAgents")
		if len(backgroundAgents) > 0 {
			return backgroundAgents
		}
	}
	t.Fatalf("events = %#v, missing runtimeContext.backgroundAgents", events)
	return nil
}

func sdkBackgroundAgentStatusByParent(t *testing.T, backgroundAgents map[string]any, parentToolUseID string) string {
	t.Helper()
	items, ok := backgroundAgents["items"].([]any)
	if !ok {
		t.Fatalf("backgroundAgents items = %#v, want []any", backgroundAgents["items"])
	}
	for _, item := range items {
		record := payloadMap(map[string]any{"item": item}, "item")
		if record["parentToolUseId"] == parentToolUseID {
			return fmt.Sprint(record["status"])
		}
	}
	t.Fatalf("backgroundAgents = %#v, missing parentToolUseId %q", backgroundAgents, parentToolUseID)
	return ""
}

func hasClaudeSDKModelConfigOptions(runtimeContext map[string]any) bool {
	options, ok := runtimeContext["configOptions"].([]map[string]any)
	if !ok {
		return false
	}
	for _, option := range options {
		if option["id"] != "model" {
			continue
		}
		models, ok := option["options"].([]map[string]string)
		if !ok {
			return false
		}
		var sawDefault bool
		var sawHaiku bool
		for _, model := range models {
			if model["value"] == "default" {
				sawDefault = true
			}
			if model["value"] == "haiku" {
				sawHaiku = true
			}
		}
		return sawDefault && sawHaiku
	}
	return false
}

func hasClaudeSDKSpeedConfigOptions(runtimeContext map[string]any, currentValue string) bool {
	options, ok := runtimeContext["configOptions"].([]map[string]any)
	if !ok {
		return false
	}
	for _, option := range options {
		if option["id"] != "fast" || option["currentValue"] != currentValue {
			continue
		}
		speeds, ok := option["options"].([]map[string]string)
		if !ok {
			return false
		}
		var sawStandard bool
		var sawFast bool
		for _, speed := range speeds {
			if speed["value"] == "standard" {
				sawStandard = true
			}
			if speed["value"] == "fast" {
				sawFast = true
			}
		}
		return sawStandard && sawFast
	}
	return false
}

func hasClaudeSDKEffortConfigOptions(runtimeContext map[string]any, currentValue string) bool {
	options, ok := runtimeContext["configOptions"].([]map[string]any)
	if !ok {
		return false
	}
	for _, option := range options {
		if option["id"] != "effort" || option["currentValue"] != currentValue {
			continue
		}
		efforts, ok := option["options"].([]map[string]string)
		if !ok {
			return false
		}
		var sawLow bool
		var sawXHigh bool
		for _, effort := range efforts {
			if effort["value"] == "low" {
				sawLow = true
			}
			if effort["value"] == "xhigh" {
				sawXHigh = true
			}
		}
		return sawLow && sawXHigh
	}
	return false
}

type recordingClaudeSDKTransport struct {
	conn *scriptedClaudeSDKConnection
	spec ProcessSpec
}

func (t *recordingClaudeSDKTransport) Start(_ context.Context, spec ProcessSpec) (ProcessConnection, error) {
	t.spec = spec
	return t.conn, nil
}

type recordingClaudeSDKConnection struct {
	mu   sync.Mutex
	sent []claudeSDKSidecarRequest
}

func (c *recordingClaudeSDKConnection) Send(data []byte) error {
	var request claudeSDKSidecarRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return err
	}
	c.mu.Lock()
	c.sent = append(c.sent, request)
	c.mu.Unlock()
	return nil
}

func (*recordingClaudeSDKConnection) Recv() (ProcessFrame, error) {
	return ProcessFrame{}, errors.New("recording claude sdk connection does not receive")
}

func (*recordingClaudeSDKConnection) Close() error {
	return nil
}

func (c *recordingClaudeSDKConnection) sentRequests() []claudeSDKSidecarRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]claudeSDKSidecarRequest(nil), c.sent...)
}

type ackClaudeSDKConnection struct {
	mu     sync.Mutex
	sent   []claudeSDKSidecarRequest
	frames []ProcessFrame
}

func (c *ackClaudeSDKConnection) Send(data []byte) error {
	var request claudeSDKSidecarRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return err
	}
	response, err := json.Marshal(claudeSDKSidecarEvent{ID: request.ID, Type: "ok"})
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.sent = append(c.sent, request)
	c.frames = append(c.frames, ProcessFrame{Stdout: append(response, '\n')})
	c.mu.Unlock()
	return nil
}

func (c *ackClaudeSDKConnection) Recv() (ProcessFrame, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.frames) == 0 {
		return ProcessFrame{}, errors.New("ack claude sdk connection has no frames")
	}
	frame := c.frames[0]
	c.frames = c.frames[1:]
	return frame, nil
}

func (*ackClaudeSDKConnection) Close() error {
	return nil
}

func (c *ackClaudeSDKConnection) sentRequests() []claudeSDKSidecarRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]claudeSDKSidecarRequest(nil), c.sent...)
}

type scriptedClaudeSDKConnection struct {
	mu     sync.Mutex
	sent   []claudeSDKSidecarRequest
	frames []ProcessFrame
}

func (c *scriptedClaudeSDKConnection) Send(data []byte) error {
	var request claudeSDKSidecarRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return err
	}
	c.mu.Lock()
	c.sent = append(c.sent, request)
	c.mu.Unlock()
	return nil
}

func (c *scriptedClaudeSDKConnection) Recv() (ProcessFrame, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.frames) == 0 {
		return ProcessFrame{}, errors.New("scripted claude sdk connection has no frames")
	}
	frame := c.frames[0]
	c.frames = c.frames[1:]
	return frame, nil
}

func (*scriptedClaudeSDKConnection) Close() error {
	return nil
}

func (c *scriptedClaudeSDKConnection) sentRequests() []claudeSDKSidecarRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]claudeSDKSidecarRequest(nil), c.sent...)
}

type blockingClaudeSDKConnection struct {
	mu     sync.Mutex
	sent   []claudeSDKSidecarRequest
	frames chan ProcessFrame
	closed chan struct{}
	once   sync.Once
}

func newBlockingClaudeSDKConnection() *blockingClaudeSDKConnection {
	return &blockingClaudeSDKConnection{
		frames: make(chan ProcessFrame, 16),
		closed: make(chan struct{}),
	}
}

func (c *blockingClaudeSDKConnection) Send(data []byte) error {
	var request claudeSDKSidecarRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return err
	}
	c.mu.Lock()
	c.sent = append(c.sent, request)
	c.mu.Unlock()
	return nil
}

func (c *blockingClaudeSDKConnection) Recv() (ProcessFrame, error) {
	select {
	case frame := <-c.frames:
		return frame, nil
	case <-c.closed:
		return ProcessFrame{}, io.EOF
	}
}

func (c *blockingClaudeSDKConnection) Close() error {
	c.once.Do(func() {
		close(c.closed)
	})
	return nil
}

func (c *blockingClaudeSDKConnection) sentRequests() []claudeSDKSidecarRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]claudeSDKSidecarRequest(nil), c.sent...)
}

func (c *blockingClaudeSDKConnection) pushEvent(event claudeSDKSidecarEvent) {
	data, err := json.Marshal(event)
	if err != nil {
		panic(err)
	}
	c.frames <- ProcessFrame{Stdout: append(data, '\n')}
}

func waitForClaudeSDKSentRequest(t *testing.T, conn *blockingClaudeSDKConnection, requestType string) claudeSDKSidecarRequest {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, request := range conn.sentRequests() {
			if request.Type == requestType {
				return request
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s request; sent=%#v", requestType, conn.sentRequests())
	return claudeSDKSidecarRequest{}
}
