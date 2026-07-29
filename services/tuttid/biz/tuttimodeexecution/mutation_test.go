package tuttimodeexecution

import (
	"errors"
	"reflect"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

func TestApplyMutationGraphSparseReworkInheritsLaunchAndRebindsDependents(
	t *testing.T,
) {
	now := time.Date(2026, time.July, 29, 2, 0, 0, 0, time.UTC)
	failed := mutationTestTask("task-a", workspaceissues.StatusFailed, 1)
	failed.ModelPlanID = "plan-a"
	failed.Model = "model-a"
	failed.PermissionModeID = "full-access"
	failed.ReasoningEffort = "high"
	failed.ExecutionDirectory = "/tmp/task-a"
	failed.AutoAccept = true
	dependent := mutationTestTask("task-b", workspaceissues.StatusNotStarted, 2)
	dependent.DependencyTaskIDs = []string{"task-a"}

	result, err := ApplyMutationGraph(MutationGraphInput{
		WorkspaceID: "workspace-1",
		IssueID:     "issue-1",
		Tasks: map[string]workspaceissues.Task{
			failed.TaskID:    failed,
			dependent.TaskID: dependent,
		},
		Operations: []MutationOperation{{
			Kind:   MutationOperationRework,
			TaskID: failed.TaskID,
			Task: workspaceissues.Task{
				TaskID: "task-a-retry",
				Title:  "Retry A",
			},
			TaskFields: MutationTaskFields{Title: true},
		}},
		Now: now,
	})
	if err != nil {
		t.Fatalf("ApplyMutationGraph() error = %v", err)
	}
	retry := result.Tasks["task-a-retry"]
	if retry.AgentTargetID != failed.AgentTargetID ||
		retry.ModelPlanID != failed.ModelPlanID ||
		retry.Model != failed.Model ||
		retry.PermissionModeID != failed.PermissionModeID ||
		retry.ReasoningEffort != failed.ReasoningEffort ||
		retry.ExecutionDirectory != failed.ExecutionDirectory ||
		retry.AutoAccept != failed.AutoAccept {
		t.Fatalf("replacement launch fields = %#v, old = %#v", retry, failed)
	}
	if got := result.Tasks["task-b"].DependencyTaskIDs; !reflect.DeepEqual(
		got, []string{"task-a-retry"},
	) {
		t.Fatalf("dependent dependencies = %#v", got)
	}
	if result.Tasks["task-a"].SupersededByTaskID != retry.TaskID ||
		!reflect.DeepEqual(result.AddedTaskIDs, []string{"task-a-retry"}) ||
		!reflect.DeepEqual(result.UpdatedTaskIDs, []string{"task-b"}) ||
		!reflect.DeepEqual(result.SupersededTaskIDs, []string{"task-a"}) {
		t.Fatalf("mutation result = %#v", result)
	}
}

func TestApplyMutationGraphUpdateUsesPresenceAndClearsTargetSpecificDefaults(
	t *testing.T,
) {
	now := time.Date(2026, time.July, 29, 2, 0, 0, 0, time.UTC)
	task := mutationTestTask("task-a", workspaceissues.StatusNotStarted, 1)
	task.Title = "Existing title"
	task.Content = "Existing content"
	task.AgentTargetID = "target-old"
	task.ModelPlanID = "plan-old"
	task.Model = "model-old"
	task.PermissionModeID = "full-access"
	task.ReasoningEffort = "high"
	task.Parallelizable = true
	task.AutoAccept = true

	result, err := ApplyMutationGraph(MutationGraphInput{
		WorkspaceID: "workspace-1",
		IssueID:     "issue-1",
		Tasks:       map[string]workspaceissues.Task{task.TaskID: task},
		Operations: []MutationOperation{{
			Kind:   MutationOperationUpdate,
			TaskID: task.TaskID,
			Task: workspaceissues.Task{
				Content:        "",
				AgentTargetID:  "target-new",
				Parallelizable: false,
				AutoAccept:     false,
			},
			TaskFields: MutationTaskFields{
				Content: true, AgentTargetID: true, Parallelizable: true, AutoAccept: true,
			},
		}},
		Now: now,
	})
	if err != nil {
		t.Fatalf("ApplyMutationGraph() error = %v", err)
	}
	updated := result.Tasks[task.TaskID]
	if updated.Content != "" ||
		updated.AgentTargetID != "target-new" ||
		updated.ModelPlanID != "" ||
		updated.Model != "" ||
		updated.PermissionModeID != "" ||
		updated.ReasoningEffort != "" ||
		updated.Parallelizable ||
		updated.AutoAccept {
		t.Fatalf("presence-aware update = %#v", updated)
	}
}

func TestApplyMutationGraphRejectsMissingTargetWithTypedReason(t *testing.T) {
	_, err := ApplyMutationGraph(MutationGraphInput{
		WorkspaceID: "workspace-1",
		IssueID:     "issue-1",
		Tasks:       map[string]workspaceissues.Task{},
		Operations: []MutationOperation{{
			Kind: MutationOperationAdd,
			Task: workspaceissues.Task{TaskID: "task-a", Title: "Task A"},
		}},
		Now: time.Date(2026, time.July, 29, 2, 0, 0, 0, time.UTC),
	})
	if !errors.Is(err, ErrMutationRejected) {
		t.Fatalf("ApplyMutationGraph() error = %v", err)
	}
	reason, taskID, ok := RejectionDetails(err)
	if !ok || reason != RejectionMissingAgentTarget || taskID != "task-a" {
		t.Fatalf("RejectionDetails() = %q, %q, %v", reason, taskID, ok)
	}
}

func mutationTestTask(
	taskID string,
	status workspaceissues.Status,
	sortIndex int,
) workspaceissues.Task {
	return workspaceissues.Task{
		WorkspaceID:     "workspace-1",
		IssueID:         "issue-1",
		TaskID:          taskID,
		Title:           "Task " + taskID,
		Status:          status,
		AgentTargetID:   "target-a",
		SortIndex:       sortIndex,
		AcceptanceState: workspaceissues.AcceptanceAgentClaimed,
	}
}
