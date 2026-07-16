package eventstream

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	eventsgenerated "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
)

func TestAgentModelConfigurationPublisherPublishesWorkspaceScopedTargets(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(session)
	})
	if err := service.Subscribe(
		session,
		[]string{TopicAgentModelConfigurationChanged},
		EventScope{WorkspaceID: "ws-1"},
	); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	publisher := AgentModelConfigurationPublisher{
		Service: service,
		Now: func() time.Time {
			return time.UnixMilli(1_720_000_000_000)
		},
	}
	if err := publisher.PublishAgentModelConfigurationChanged(
		context.Background(),
		" ws-1 ",
		[]string{" local:codex ", "local:codex", "local:claude", " "},
		map[string]string{"local:codex": " model-new ", "local:claude": ""},
		true,
	); err != nil {
		t.Fatalf("PublishAgentModelConfigurationChanged() error = %v", err)
	}

	event := receiveEvent(t, session)
	if event.Topic != TopicAgentModelConfigurationChanged {
		t.Fatalf("event topic = %q, want %q", event.Topic, TopicAgentModelConfigurationChanged)
	}
	if event.Scope.WorkspaceID != "ws-1" {
		t.Fatalf("event scope = %#v, want workspace ws-1", event.Scope)
	}
	var payload eventsgenerated.AgentModelConfigurationChangedPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload.WorkspaceId != "ws-1" {
		t.Fatalf("payload workspaceId = %q, want ws-1", payload.WorkspaceId)
	}
	if len(payload.AgentTargetIds) != 2 || payload.AgentTargetIds[0] != "local:codex" || payload.AgentTargetIds[1] != "local:claude" {
		t.Fatalf("payload agentTargetIds = %v", payload.AgentTargetIds)
	}
	if payload.DefaultModels["local:codex"] != "model-new" || payload.DefaultModels["local:claude"] != "" || len(payload.DefaultModels) != 2 {
		t.Fatalf("payload defaultModels = %#v", payload.DefaultModels)
	}
	if !payload.ResetComposerModel {
		t.Fatalf("payload resetComposerModel = false, want true")
	}
	if payload.OccurredAtUnixMs != 1_720_000_000_000 {
		t.Fatalf("payload occurredAtUnixMs = %d, want 1720000000000", payload.OccurredAtUnixMs)
	}
}

func TestAgentModelConfigurationChangedValidationRejectsBadPayloads(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"blank workspace":        `{"workspaceId":" ","agentTargetIds":["local:codex"],"defaultModels":{"local:codex":"model-a"},"resetComposerModel":true,"occurredAtUnixMs":1000}`,
		"empty targets":          `{"workspaceId":"ws","agentTargetIds":[],"defaultModels":{},"resetComposerModel":true,"occurredAtUnixMs":1000}`,
		"blank target":           `{"workspaceId":"ws","agentTargetIds":[" "],"defaultModels":{" ":""},"resetComposerModel":true,"occurredAtUnixMs":1000}`,
		"duplicate target":       `{"workspaceId":"ws","agentTargetIds":["local:codex","local:codex"],"defaultModels":{"local:codex":"model-a"},"resetComposerModel":true,"occurredAtUnixMs":1000}`,
		"missing defaults":       `{"workspaceId":"ws","agentTargetIds":["local:codex"],"resetComposerModel":true,"occurredAtUnixMs":1000}`,
		"missing target default": `{"workspaceId":"ws","agentTargetIds":["local:codex"],"defaultModels":{},"resetComposerModel":true,"occurredAtUnixMs":1000}`,
		"extra target default":   `{"workspaceId":"ws","agentTargetIds":["local:codex"],"defaultModels":{"local:codex":"model-a","local:claude":"model-b"},"resetComposerModel":true,"occurredAtUnixMs":1000}`,
		"missing reset intent":   `{"workspaceId":"ws","agentTargetIds":["local:codex"],"defaultModels":{"local:codex":"model-a"},"occurredAtUnixMs":1000}`,
		"null reset intent":      `{"workspaceId":"ws","agentTargetIds":["local:codex"],"defaultModels":{"local:codex":"model-a"},"resetComposerModel":null,"occurredAtUnixMs":1000}`,
		"missing occurredAt":     `{"workspaceId":"ws","agentTargetIds":["local:codex"],"defaultModels":{"local:codex":"model-a"},"resetComposerModel":true}`,
		"unknown field present":  `{"workspaceId":"ws","agentTargetIds":["local:codex"],"defaultModels":{"local:codex":"model-a"},"resetComposerModel":true,"occurredAtUnixMs":1000,"extra":true}`,
	}
	for name, payload := range cases {
		if err := validateAgentModelConfigurationChangedPayload([]byte(payload)); err == nil {
			t.Fatalf("%s: expected validation error", name)
		}
	}

	if err := validateAgentModelConfigurationChangedPayload([]byte(
		`{"workspaceId":"ws","agentTargetIds":["local:codex"],"defaultModels":{"local:codex":""},"resetComposerModel":false,"occurredAtUnixMs":1000}`,
	)); err != nil {
		t.Fatalf("valid payload rejected: %v", err)
	}
	if err := validateAgentModelConfigurationChangedPayload([]byte(
		`{"workspaceId":"ws","agentTargetIds":["local:codex"],"defaultModels":{"local:codex":""},"resetComposerModel":false,"occurredAtUnixMs":0}`,
	)); err != nil {
		t.Fatalf("zero schema-minimum timestamp rejected: %v", err)
	}
}
