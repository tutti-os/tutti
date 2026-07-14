package eventstream

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentgui"
)

func TestAgentGUILaunchPublisherPublishesWorkbenchNodeLaunch(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(session)
	})
	if err := service.Subscribe(session, []string{TopicWorkspaceWorkbenchNodeLaunchRequested}, EventScope{
		WorkspaceID: "workspace-1",
	}); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	publisher := AgentGUILaunchPublisher{Service: service}
	if err := publisher.PublishAgentGUILaunchRequested(context.Background(), agentgui.LaunchRequest{
		AgentSessionID: "session-1",
		AgentTargetID:  " extension:gemini ",
		Provider:       "codex",
		RequestID:      "request-1",
		Source:         "cli",
		WorkspaceID:    "workspace-1",
	}); err != nil {
		t.Fatalf("PublishAgentGUILaunchRequested() error = %v", err)
	}

	event := receiveEvent(t, session)
	if event.Topic != TopicWorkspaceWorkbenchNodeLaunchRequested {
		t.Fatalf("event topic = %q, want %q", event.Topic, TopicWorkspaceWorkbenchNodeLaunchRequested)
	}
	if event.Scope.WorkspaceID != "workspace-1" {
		t.Fatalf("event scope workspace = %q, want workspace-1", event.Scope.WorkspaceID)
	}

	var payload struct {
		LaunchSource string `json:"launchSource"`
		Payload      struct {
			AgentSessionID string `json:"agentSessionId"`
			AgentTargetID  string `json:"agentTargetId"`
			Provider       string `json:"provider"`
		} `json:"payload"`
		RequestID string `json:"requestId"`
		Source    string `json:"source"`
		TypeID    string `json:"typeId"`
	}
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("json.Unmarshal(event.Payload) error = %v", err)
	}
	if payload.TypeID != "agent-gui" {
		t.Fatalf("payload typeId = %q, want agent-gui", payload.TypeID)
	}
	if payload.Source != "cli" || payload.LaunchSource != "cli" {
		t.Fatalf("payload source = (%q, %q), want cli", payload.Source, payload.LaunchSource)
	}
	if payload.RequestID != "request-1" {
		t.Fatalf("payload requestId = %q, want request-1", payload.RequestID)
	}
	if payload.Payload.AgentSessionID != "session-1" || payload.Payload.AgentTargetID != "extension:gemini" || payload.Payload.Provider != "codex" {
		t.Fatalf("payload nested launch = %#v, want session/target/provider", payload.Payload)
	}
}
