package conformance

import (
	"context"
	"fmt"
)

func DeletionCatalog() []Scenario {
	return []Scenario{{
		Name: "SourceDeletionRejectsWholeActiveClosureAndFencesMaterialization",
		run:  runSourceDeletionRejectsWholeActiveClosureAndFencesMaterialization,
	}}
}

func runSourceDeletionRejectsWholeActiveClosureAndFencesMaterialization(
	ctx context.Context, driver Driver,
) error {
	workspaceID := "workspace-materialization"
	sourceID := "source-deletion"
	issueID, err := driver.AcceptPlan(ctx, AcceptPlanInput{
		WorkspaceID: workspaceID, WorkflowID: "workflow-deletion",
		RevisionID: "revision-deletion", CheckpointID: "review-deletion",
		SourceSessionID: sourceID, TopicID: "default", Title: "Deletion", Content: "Deletion",
		Tasks: []Task{{TaskID: "task-1", Title: "Task", AgentTargetID: "local:codex"}},
	})
	if err != nil {
		return err
	}
	if err := driver.AdmitSourceDeletion(ctx, workspaceID, []string{"unprotected", sourceID}); err == nil {
		return fmt.Errorf("whole active closure was admitted")
	}
	operation, err := driver.Archive(ctx, ArchiveInput{
		WorkspaceID: workspaceID, IssueID: issueID, RequestID: "archive-deletion",
		RequestedBy: "local-user", Reason: "allow source deletion",
	})
	if err != nil || operation.Status != "completed" {
		return fmt.Errorf("archive idle execution=%#v error=%v", operation, err)
	}
	closure := []string{sourceID}
	if err := driver.AdmitSourceDeletion(ctx, workspaceID, closure); err != nil {
		return fmt.Errorf("admit archived source: %w", err)
	}
	_, err = driver.AcceptPlan(ctx, AcceptPlanInput{
		WorkspaceID: workspaceID, WorkflowID: "workflow-deletion-race",
		RevisionID: "revision-deletion-race", CheckpointID: "review-deletion-race",
		SourceSessionID: sourceID, TopicID: "default", Title: "Race", Content: "Race",
		Tasks: []Task{{TaskID: "task-race", Title: "Task", AgentTargetID: "local:codex"}},
	})
	if err == nil {
		return fmt.Errorf("materialization crossed durable source deletion fence")
	}
	return driver.ReleaseSourceDeletion(ctx, workspaceID, closure, false)
}
