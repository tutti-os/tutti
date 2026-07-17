package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
)

// stopTaskAckConnection acks every request; stop_task acks carry the stopped
// flag in the payload like the real sidecar response.
type stopTaskAckConnection struct {
	mu      sync.Mutex
	sent    []claudeSDKSidecarRequest
	frames  []ProcessFrame
	stopped bool
}

func (c *stopTaskAckConnection) Send(data []byte) error {
	var request claudeSDKSidecarRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return err
	}
	event := claudeSDKSidecarEvent{Version: claudeSDKSidecarProtocolVersion, ID: request.ID, Type: "ok"}
	if request.Type == "stop_task" {
		event.Payload = map[string]any{"stopped": c.stopped}
	}
	response, err := json.Marshal(event)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.sent = append(c.sent, request)
	c.frames = append(c.frames, ProcessFrame{Stdout: append(response, '\n')})
	c.mu.Unlock()
	return nil
}

func (c *stopTaskAckConnection) Recv() (ProcessFrame, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.frames) == 0 {
		return ProcessFrame{}, errors.New("stop task ack connection has no frames")
	}
	frame := versionClaudeSDKTestFrame(c.frames[0])
	c.frames = c.frames[1:]
	return frame, nil
}

func (*stopTaskAckConnection) Close() error {
	return nil
}

func (c *stopTaskAckConnection) sentRequests() []claudeSDKSidecarRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]claudeSDKSidecarRequest(nil), c.sent...)
}

func TestClaudeCodeSDKAdapterCancelTargetsStopsChildTaskWithoutRootInterrupt(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := &stopTaskAckConnection{stopped: true}
	adapterSession := &claudeSDKAdapterSession{
		conn:            conn,
		reader:          &claudeSDKLineReader{conn: conn},
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	child, _, _, ok := adapterSession.updateClaudeSDKChild(session, claudeSDKChildUpdate{
		Key:             "toolu-agent",
		ParentToolUseID: "toolu-agent",
		RootTurnID:      "turn-1",
		TaskID:          "task-1",
		Async:           true,
		Started:         true,
	})
	if !ok || child.AgentSessionID == "" {
		t.Fatalf("child session not registered: %#v", child)
	}

	result, err := adapter.CancelTargets(context.Background(), session, []CancelTarget{
		{AgentSessionID: child.AgentSessionID, TurnID: child.TurnID},
	}, "user_request")
	if err != nil {
		t.Fatalf("CancelTargets: %v", err)
	}
	if len(result.ConfirmedTargets) != 1 || result.ConfirmedTargets[0].AgentSessionID != child.AgentSessionID {
		t.Fatalf("confirmed targets = %#v, want the child target", result.ConfirmedTargets)
	}
	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "stop_task" {
		t.Fatalf("sent requests = %#v, want a single stop_task", sent)
	}
	if sent[0].Payload["taskId"] != "task-1" || sent[0].Payload["agentSessionId"] != session.AgentSessionID {
		t.Fatalf("stop_task payload = %#v, want task-1 on the root session", sent[0].Payload)
	}
}

func TestClaudeCodeSDKAdapterCancelTargetsUnknownChildIsIdempotentNoop(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := &stopTaskAckConnection{stopped: true}
	adapterSession := &claudeSDKAdapterSession{
		conn:            conn,
		reader:          &claudeSDKLineReader{conn: conn},
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	result, err := adapter.CancelTargets(context.Background(), session, []CancelTarget{
		{AgentSessionID: "child-unknown", TurnID: "turn-unknown"},
	}, "user_request")
	if err != nil {
		t.Fatalf("CancelTargets: %v", err)
	}
	if len(result.ConfirmedTargets) != 0 {
		t.Fatalf("confirmed targets = %#v, want none", result.ConfirmedTargets)
	}
	if sent := conn.sentRequests(); len(sent) != 0 {
		t.Fatalf("sent requests = %#v, want none", sent)
	}
}

func TestClaudeCodeSDKAdapterCancelTargetsSettledStopIsUnconfirmed(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := &stopTaskAckConnection{stopped: false}
	adapterSession := &claudeSDKAdapterSession{
		conn:            conn,
		reader:          &claudeSDKLineReader{conn: conn},
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	child, _, _, ok := adapterSession.updateClaudeSDKChild(session, claudeSDKChildUpdate{
		Key:             "toolu-agent",
		ParentToolUseID: "toolu-agent",
		RootTurnID:      "turn-1",
		TaskID:          "task-1",
		Async:           true,
		Started:         true,
	})
	if !ok {
		t.Fatalf("child session not registered: %#v", child)
	}

	result, err := adapter.CancelTargets(context.Background(), session, []CancelTarget{
		{AgentSessionID: child.AgentSessionID, TurnID: child.TurnID},
	}, "user_request")
	if err != nil {
		t.Fatalf("CancelTargets: %v", err)
	}
	if len(result.ConfirmedTargets) != 0 {
		t.Fatalf("confirmed targets = %#v, want none for an already settled task", result.ConfirmedTargets)
	}
}
