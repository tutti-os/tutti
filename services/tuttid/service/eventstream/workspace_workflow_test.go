package eventstream

import (
	"context"
	"encoding/json"
	"testing"

	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
)

func TestWorkspaceWorkflowPublisherPublishesSessionCorrelatedScopedInvalidation(t *testing.T) {
	t.Parallel()
	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() { service.CloseSession(session) })
	if err := service.Subscribe(session, []string{TopicWorkspaceWorkflowUpdated}, EventScope{WorkspaceID: "workspace-1"}); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	update := workflowbiz.Update{
		WorkspaceID:     "workspace-1",
		WorkflowID:      "11111111-1111-4111-8111-111111111111",
		SourceSessionID: "session-1",
		CheckpointID:    "33333333-3333-4333-8333-333333333333",
		ChangeKind:      workflowbiz.ChangeKindProposalCreated,
	}
	if err := (WorkspaceWorkflowPublisher{Service: service}).PublishWorkspaceWorkflowUpdated(context.Background(), update); err != nil {
		t.Fatalf("PublishWorkspaceWorkflowUpdated() error = %v", err)
	}
	event := receiveEvent(t, session)
	if event.Topic != TopicWorkspaceWorkflowUpdated || event.Scope.WorkspaceID != "workspace-1" {
		t.Fatalf("event = %#v", event)
	}
	var payload eventprotocol.WorkspaceWorkflowUpdatedPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.WorkflowId != update.WorkflowID || payload.SourceSessionId != "session-1" || payload.CheckpointId != update.CheckpointID || payload.ChangeKind != "proposal_created" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestWorkspaceWorkflowCatalogRejectsUnknownPayloadFields(t *testing.T) {
	t.Parallel()
	err := DefaultCatalog().ValidatePublish(
		TopicWorkspaceWorkflowUpdated,
		DirectionServerToClient,
		[]byte(`{"workflowId":"11111111-1111-4111-8111-111111111111","sourceSessionId":"session-1","checkpointId":"33333333-3333-4333-8333-333333333333","changeKind":"proposal_created","workspaceId":"must-live-in-scope"}`),
	)
	validationErr, ok := err.(*ValidationError)
	if !ok || validationErr.Code != ValidationCodeInvalidPayload {
		t.Fatalf("ValidatePublish() error = %#v, want invalid payload", err)
	}
}
