package agentruntime

import (
	"context"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestDefaultControllerUsesClaudeSDKAdapterByDefault(t *testing.T) {
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
		pendingRequests: make(map[string]*pendingInteractiveRequest),
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
		pendingRequests: make(map[string]*pendingInteractiveRequest),
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
