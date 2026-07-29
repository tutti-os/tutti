package conformance

import (
	"context"
	"fmt"
	"reflect"
)

func runMaterializedPlanRequiresInitialSchedule(ctx context.Context, driver Driver) error {
	input := AcceptPlanInput{
		WorkspaceID:     "workspace-materialization",
		WorkflowID:      "workflow-materialization",
		RevisionID:      "revision-materialization",
		CheckpointID:    "review-materialization",
		SourceSessionID: "session-materialization",
		TopicID:         "default",
		Title:           "Inert accepted plan",
		Content:         "The source plan body",
		Tasks: []Task{
			{
				TaskID:           "task-1",
				Title:            "Implement the plan",
				Content:          "Build the accepted behavior",
				Status:           "not_started",
				AcceptanceState:  "agent_claimed",
				Priority:         "high",
				SortIndex:        1,
				AgentTargetID:    "local:codex",
				Model:            "gpt-5.4-codex",
				PermissionModeID: "full-access",
			},
			{
				TaskID:            "task-2",
				Title:             "Verify the plan",
				Content:           "Verify the accepted behavior",
				Status:            "not_started",
				AcceptanceState:   "agent_claimed",
				Priority:          "medium",
				SortIndex:         2,
				AgentTargetID:     "local:codex",
				Model:             "gpt-5.4-codex",
				PermissionModeID:  "full-access",
				DependencyTaskIDs: []string{"task-1"},
				Parallelizable:    true,
				AutoAccept:        true,
			},
		},
	}

	issueID, err := driver.AcceptPlan(ctx, input)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	snapshot, err := driver.GetSnapshot(ctx, input.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot() error = %w", err)
	}
	expectedIssue := Issue{
		WorkspaceID:     input.WorkspaceID,
		IssueID:         issueID,
		TopicID:         input.TopicID,
		Title:           input.Title,
		Content:         input.Content,
		Status:          "not_started",
		TaskCount:       len(input.Tasks),
		PlanningSource:  "tutti_mode_plan",
		SourceSessionID: input.SourceSessionID,
	}
	if !reflect.DeepEqual(snapshot.Issue, expectedIssue) {
		return fmt.Errorf("materialized issue = %#v, want %#v", snapshot.Issue, expectedIssue)
	}
	if !reflect.DeepEqual(snapshot.Tasks, input.Tasks) {
		return fmt.Errorf("materialized tasks = %#v, want %#v", snapshot.Tasks, input.Tasks)
	}
	if calls := driver.LauncherCallCount(); calls != 0 {
		return fmt.Errorf("launcher calls = %d, want 0", calls)
	}
	if snapshot.RunCount != 0 {
		return fmt.Errorf("run count = %d, want 0", snapshot.RunCount)
	}

	if snapshot.Execution.Status != "awaiting_schedule" {
		return fmt.Errorf("execution status = %q, want awaiting_schedule", snapshot.Execution.Status)
	}
	if snapshot.Execution.GraphRevision != 1 {
		return fmt.Errorf("execution graph revision = %d, want 1", snapshot.Execution.GraphRevision)
	}
	if len(snapshot.Checkpoints) != 1 {
		return fmt.Errorf("checkpoint count = %d, want 1", len(snapshot.Checkpoints))
	}
	checkpoint := snapshot.Checkpoints[0]
	if checkpoint.Kind != "initial_schedule" || checkpoint.Status != "active" {
		return fmt.Errorf("initial checkpoint = %#v, want active initial_schedule", checkpoint)
	}
	if checkpoint.Sequence != 1 || checkpoint.GraphRevision != 1 {
		return fmt.Errorf("initial checkpoint revision/sequence = %#v, want 1/1", checkpoint)
	}
	return nil
}
