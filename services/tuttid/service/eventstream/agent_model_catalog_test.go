package eventstream

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestAgentModelCatalogPublisherPublishesNormalizedProviders(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(session)
	})
	if err := service.Subscribe(session, []string{TopicAgentModelCatalogInvalidated}, EventScope{}); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	publisher := AgentModelCatalogPublisher{
		Service: service,
		Now: func() time.Time {
			return time.UnixMilli(1_720_000_000_000)
		},
	}
	if err := publisher.PublishAgentModelCatalogInvalidated(
		context.Background(),
		[]string{"codex", "claude", "codex", "  "},
	); err != nil {
		t.Fatalf("PublishAgentModelCatalogInvalidated() error = %v", err)
	}

	event := receiveEvent(t, session)
	if event.Topic != TopicAgentModelCatalogInvalidated {
		t.Fatalf("event topic = %q, want %q", event.Topic, TopicAgentModelCatalogInvalidated)
	}
	var payload agentModelCatalogInvalidatedPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	// "claude" normalizes to the canonical claude-code id and duplicates drop.
	if len(payload.Providers) != 2 || payload.Providers[0] != "codex" || payload.Providers[1] != "claude-code" {
		t.Fatalf("payload providers = %v, want [codex claude-code]", payload.Providers)
	}
	if payload.OccurredAtUnixMS != 1_720_000_000_000 {
		t.Fatalf("payload occurredAtUnixMs = %d, want 1720000000000", payload.OccurredAtUnixMS)
	}
}

func TestAgentModelCatalogPublisherSkipsUnknownProviders(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(session)
	})
	if err := service.Subscribe(session, []string{TopicAgentModelCatalogInvalidated}, EventScope{}); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	publisher := AgentModelCatalogPublisher{Service: service}
	if err := publisher.PublishAgentModelCatalogInvalidated(
		context.Background(),
		[]string{"not-a-provider", ""},
	); err != nil {
		t.Fatalf("PublishAgentModelCatalogInvalidated() error = %v", err)
	}
	assertNoEvent(t, session)
}

func TestAgentModelCatalogInvalidatedValidationRejectsBadPayloads(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"empty providers":       `{"providers":[],"occurredAtUnixMs":1000}`,
		"blank provider":        `{"providers":[" "],"occurredAtUnixMs":1000}`,
		"unknown provider":      `{"providers":["not-a-provider"],"occurredAtUnixMs":1000}`,
		"missing occurredAt":    `{"providers":["codex"]}`,
		"unknown field present": `{"providers":["codex"],"occurredAtUnixMs":1000,"extra":true}`,
	}
	for name, payload := range cases {
		if err := validateAgentModelCatalogInvalidatedPayload([]byte(payload)); err == nil {
			t.Fatalf("%s: expected validation error", name)
		}
	}

	if err := validateAgentModelCatalogInvalidatedPayload(
		[]byte(`{"providers":["codex","claude-code"],"occurredAtUnixMs":1000}`),
	); err != nil {
		t.Fatalf("valid payload rejected: %v", err)
	}
}
