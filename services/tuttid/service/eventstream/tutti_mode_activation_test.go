package eventstream

import (
	"context"
	"encoding/json"
	"testing"

	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	tuttimodeactivationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
)

func TestTuttiModeActivationPublisherEmitsScopedInvalidation(t *testing.T) {
	t.Parallel()
	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	defer service.CloseSession(session)
	if err := service.Subscribe(session, []string{TopicWorkspaceTuttiModeUpdated}, EventScope{WorkspaceID: "workspace-1"}); err != nil {
		t.Fatal(err)
	}
	update := tuttimodeactivationbiz.Update{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		ActivationID: "32bb4e49-5d37-423d-a087-c2f1b5881284", Revision: 2,
		State: tuttimodeactivationbiz.StateInactive, ChangeKind: tuttimodeactivationbiz.ChangeKindDeactivated,
	}
	if err := (TuttiModeActivationPublisher{Service: service}).PublishTuttiModeActivationUpdated(context.Background(), update); err != nil {
		t.Fatal(err)
	}
	event := <-service.Events(session)
	if event.Topic != TopicWorkspaceTuttiModeUpdated || event.Scope.WorkspaceID != "workspace-1" {
		t.Fatalf("event = %#v", event)
	}
	var payload eventprotocol.WorkspaceTuttimodeUpdatedPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.AgentSessionId != "session-1" || payload.Revision != 2 || payload.Status != "inactive" || payload.ChangeKind != "deactivated" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestTuttiModeActivationTopicCatalogValidatesProtocol(t *testing.T) {
	t.Parallel()
	payload := []byte(`{"agentSessionId":"session-1","activationId":"32bb4e49-5d37-423d-a087-c2f1b5881284","revision":1,"status":"active","changeKind":"activated"}`)
	if err := DefaultCatalog().ValidatePublish(TopicWorkspaceTuttiModeUpdated, DirectionServerToClient, payload); err != nil {
		t.Fatalf("ValidatePublish() error = %v", err)
	}
	if err := DefaultCatalog().ValidatePublish(TopicWorkspaceTuttiModeUpdated, DirectionServerToClient, []byte(`{"agentSessionId":"session-1","activationId":"bad","revision":0,"status":"active","changeKind":"activated"}`)); err == nil {
		t.Fatal("ValidatePublish() accepted invalid payload")
	}
}
