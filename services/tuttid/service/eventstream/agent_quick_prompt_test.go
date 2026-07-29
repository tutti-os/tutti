package eventstream

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	agentquickpromptbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentquickprompt"
)

func TestAgentQuickPromptPublisherPublishesPrivateGlobalInvalidation(t *testing.T) {
	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() { service.CloseSession(session) })
	if err := service.Subscribe(session, []string{TopicAgentQuickPromptUpdated}, EventScope{}); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	publisher := AgentQuickPromptPublisher{Service: service}
	if err := publisher.PublishAgentQuickPromptUpdated(context.Background(), agentquickpromptbiz.UpdatedEvent{
		PromptID: "prompt-1", ChangeKind: agentquickpromptbiz.ChangeKindUpdated, Version: 3, OccurredAtUnixMS: 123,
	}); err != nil {
		t.Fatalf("PublishAgentQuickPromptUpdated() error = %v", err)
	}
	event := receiveEvent(t, session)
	if event.Topic != TopicAgentQuickPromptUpdated || event.Scope.WorkspaceID != "" {
		t.Fatalf("event = %#v", event)
	}
	if strings.Contains(string(event.Payload), "content") || strings.Contains(string(event.Payload), "title") {
		t.Fatalf("payload exposes prompt data: %s", event.Payload)
	}
	var payload eventprotocol.AgentQuickpromptUpdatedPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.PromptId != "prompt-1" || payload.ChangeKind != "updated" || payload.Version != 3 || payload.OccurredAtUnixMs != 123 {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestAgentQuickPromptUpdatedCatalogStrictValidation(t *testing.T) {
	catalog := DefaultCatalog()
	tests := []struct {
		name    string
		payload string
		valid   bool
	}{
		{name: "valid", payload: `{"promptId":"prompt-1","changeKind":"created","version":1,"occurredAtUnixMs":1}`, valid: true},
		{name: "blank id", payload: `{"promptId":" ","changeKind":"created","version":1,"occurredAtUnixMs":1}`},
		{name: "unsupported change", payload: `{"promptId":"prompt-1","changeKind":"renamed","version":1,"occurredAtUnixMs":1}`},
		{name: "zero version", payload: `{"promptId":"prompt-1","changeKind":"deleted","version":0,"occurredAtUnixMs":1}`},
		{name: "body leak", payload: `{"promptId":"prompt-1","changeKind":"updated","version":2,"occurredAtUnixMs":1,"content":"secret"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := catalog.ValidatePublish(TopicAgentQuickPromptUpdated, DirectionServerToClient, []byte(test.payload))
			if test.valid && err != nil {
				t.Fatalf("ValidatePublish() error = %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("ValidatePublish() error = nil, want invalid")
			}
		})
	}
}
