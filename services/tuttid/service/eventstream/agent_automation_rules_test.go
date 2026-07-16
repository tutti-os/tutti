package eventstream

import (
	"encoding/json"
	"testing"
	"time"

	eventsgenerated "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
)

func TestAgentAutomationRulesPublisherPublishesWorkspaceScopedChange(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(session)
	})
	if err := service.Subscribe(
		session,
		[]string{TopicAgentAutomationRulesChanged},
		EventScope{WorkspaceID: "ws-1"},
	); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	publisher := AgentAutomationRulesPublisher{
		Service: service,
		Now: func() time.Time {
			return time.UnixMilli(1_720_000_000_000)
		},
	}
	publisher.PublishAutomationRulesChanged(" ws-1 ")

	event := receiveEvent(t, session)
	if event.Topic != TopicAgentAutomationRulesChanged {
		t.Fatalf("event topic = %q, want %q", event.Topic, TopicAgentAutomationRulesChanged)
	}
	if event.Scope.WorkspaceID != "ws-1" {
		t.Fatalf("event scope = %#v, want workspace ws-1", event.Scope)
	}
	var payload eventsgenerated.AgentAutomationRulesChangedPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload.WorkspaceId != "ws-1" {
		t.Fatalf("payload workspaceId = %q, want ws-1", payload.WorkspaceId)
	}
	if payload.OccurredAtUnixMs != 1_720_000_000_000 {
		t.Fatalf("payload occurredAtUnixMs = %d, want 1720000000000", payload.OccurredAtUnixMs)
	}
}

func TestAgentAutomationRulesPublisherSkipsBlankWorkspace(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(session)
	})
	if err := service.Subscribe(session, []string{TopicAgentAutomationRulesChanged}, EventScope{}); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	AgentAutomationRulesPublisher{Service: service}.PublishAutomationRulesChanged(" ")
	assertNoEvent(t, session)
}

func TestAgentAutomationRulesChangedValidationRejectsBadPayloads(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"missing workspaceId":   `{"occurredAtUnixMs":1000}`,
		"blank workspaceId":     `{"workspaceId":" ","occurredAtUnixMs":1000}`,
		"missing occurredAt":    `{"workspaceId":"ws"}`,
		"negative occurredAt":   `{"workspaceId":"ws","occurredAtUnixMs":-1}`,
		"unknown field present": `{"workspaceId":"ws","occurredAtUnixMs":1000,"extra":true}`,
	}
	for name, payload := range cases {
		if err := validateAgentAutomationRulesChangedPayload([]byte(payload)); err == nil {
			t.Fatalf("%s: expected validation error", name)
		}
	}

	if err := validateAgentAutomationRulesChangedPayload(
		[]byte(`{"workspaceId":"ws","occurredAtUnixMs":1000}`),
	); err != nil {
		t.Fatalf("valid payload rejected: %v", err)
	}
	if err := validateAgentAutomationRulesChangedPayload(
		[]byte(`{"workspaceId":"ws","occurredAtUnixMs":0}`),
	); err != nil {
		t.Fatalf("zero schema-minimum timestamp rejected: %v", err)
	}
}
