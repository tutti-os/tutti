package eventstream

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
)

type WorkspaceIssueChangeKind string

const (
	WorkspaceIssueChangeIssueCreated            WorkspaceIssueChangeKind = "issue_created"
	WorkspaceIssueChangeIssueUpdated            WorkspaceIssueChangeKind = "issue_updated"
	WorkspaceIssueChangeIssueDeleted            WorkspaceIssueChangeKind = "issue_deleted"
	WorkspaceIssueChangeIssueContextRefsUpdated WorkspaceIssueChangeKind = "issue_context_refs_updated"
	WorkspaceIssueChangeTaskCreated             WorkspaceIssueChangeKind = "task_created"
	WorkspaceIssueChangeTaskUpdated             WorkspaceIssueChangeKind = "task_updated"
	WorkspaceIssueChangeTaskDeleted             WorkspaceIssueChangeKind = "task_deleted"
	WorkspaceIssueChangeTaskContextRefsUpdated  WorkspaceIssueChangeKind = "task_context_refs_updated"
	WorkspaceIssueChangeRunCreated              WorkspaceIssueChangeKind = "run_created"
	WorkspaceIssueChangeRunCompleted            WorkspaceIssueChangeKind = "run_completed"
)

type WorkspaceIssueUpdate struct {
	WorkspaceID string
	IssueID     string
	TaskID      string
	RunID       string
	ChangeKind  WorkspaceIssueChangeKind
}

type WorkspaceIssuePublisher struct {
	Service *Service
}

func (p WorkspaceIssuePublisher) PublishWorkspaceIssueUpdated(ctx context.Context, update WorkspaceIssueUpdate) error {
	if p.Service == nil {
		return nil
	}
	update.WorkspaceID = strings.TrimSpace(update.WorkspaceID)
	update.IssueID = strings.TrimSpace(update.IssueID)
	update.TaskID = strings.TrimSpace(update.TaskID)
	update.RunID = strings.TrimSpace(update.RunID)
	update.ChangeKind = WorkspaceIssueChangeKind(strings.TrimSpace(string(update.ChangeKind)))
	if update.WorkspaceID == "" || update.IssueID == "" || update.ChangeKind == "" {
		return nil
	}

	var taskID *string
	if update.TaskID != "" {
		taskID = &update.TaskID
	}
	var runID *string
	if update.RunID != "" {
		runID = &update.RunID
	}
	payload, err := json.Marshal(eventprotocol.WorkspaceIssueUpdatedPayload{
		WorkspaceId: update.WorkspaceID,
		IssueId:     update.IssueID,
		TaskId:      taskID,
		RunId:       runID,
		ChangeKind:  string(update.ChangeKind),
	})
	if err != nil {
		return fmt.Errorf("marshal workspace issue updated payload: %w", err)
	}
	return p.Service.PublishFromServerScoped(
		ctx,
		TopicWorkspaceIssueUpdated,
		payload,
		EventScope{WorkspaceID: update.WorkspaceID},
	)
}
