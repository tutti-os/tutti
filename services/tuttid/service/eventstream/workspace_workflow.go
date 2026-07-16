package eventstream

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
)

type WorkspaceWorkflowPublisher struct {
	Service *Service
}

func (p WorkspaceWorkflowPublisher) PublishWorkspaceWorkflowUpdated(ctx context.Context, update workflowbiz.Update) error {
	if p.Service == nil {
		return nil
	}
	update.WorkspaceID = strings.TrimSpace(update.WorkspaceID)
	update.WorkflowID = strings.TrimSpace(update.WorkflowID)
	update.SourceSessionID = strings.TrimSpace(update.SourceSessionID)
	update.CheckpointID = strings.TrimSpace(update.CheckpointID)
	update.ChangeKind = workflowbiz.ChangeKind(strings.TrimSpace(string(update.ChangeKind)))
	if update.WorkspaceID == "" || update.WorkflowID == "" || update.SourceSessionID == "" || update.CheckpointID == "" || update.ChangeKind == "" {
		return nil
	}
	payload, err := json.Marshal(eventprotocol.WorkspaceWorkflowUpdatedPayload{
		WorkflowId:      update.WorkflowID,
		SourceSessionId: update.SourceSessionID,
		CheckpointId:    update.CheckpointID,
		ChangeKind:      string(update.ChangeKind),
	})
	if err != nil {
		return fmt.Errorf("marshal workspace workflow updated payload: %w", err)
	}
	return p.Service.PublishFromServerScoped(ctx, TopicWorkspaceWorkflowUpdated, payload, EventScope{WorkspaceID: update.WorkspaceID})
}
