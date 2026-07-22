package tuttimodeplan

import (
	"fmt"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
)

// ActionableItem is a read-only projection of one accepted task in the
// current task-graph revision. It is deliberately not persisted: the Markdown
// PlanRevision and its accepted checkpoint remain the source of truth.
type ActionableItem struct {
	ID               string
	SourceWorkflowID string
	SourceRevisionID string
	Ordinal          int
	TopicID          string
	Execution        PlanExecution
	Budget           PlanBudget
	Task             PlanTask
}

// ProjectActionableItems derives executable work only from the accepted,
// current task graph. Pending, rejected, superseded, or stale revisions cannot
// leak into downstream issue materialization.
func ProjectActionableItems(view SnapshotView) []ActionableItem {
	currentRevisionID := view.Workflow.CurrentRevisionID
	if currentRevisionID == "" {
		return nil
	}
	checkpoint, ok := checkpointForRevision(view.Checkpoints, currentRevisionID)
	if !ok || checkpoint.Kind != workflowbiz.CheckpointKindTaskReview || checkpoint.Status != workflowbiz.CheckpointStatusAccepted {
		return nil
	}
	overrides := make(map[string]workflowbiz.TaskAssignment, len(checkpoint.TaskAssignments))
	for _, assignment := range checkpoint.TaskAssignments {
		overrides[assignment.TaskID] = assignment
	}
	for _, revision := range view.Revisions {
		if revision.Revision.ID != currentRevisionID || revision.Document.Phase != PhaseTaskGraph {
			continue
		}
		items := make([]ActionableItem, 0, len(revision.Document.Tasks))
		for index, task := range revision.Document.Tasks {
			clonedTask := task
			clonedTask.DependsOn = append([]string(nil), task.DependsOn...)
			if override, ok := overrides[task.ID]; ok {
				applyTaskAssignmentOverride(&clonedTask, override)
			}
			items = append(items, ActionableItem{
				ID:               fmt.Sprintf("%s/%s/%s", view.Workflow.ID, revision.Revision.ID, task.ID),
				SourceWorkflowID: view.Workflow.ID,
				SourceRevisionID: revision.Revision.ID,
				Ordinal:          index + 1,
				TopicID:          revision.Document.TopicID,
				Execution:        revision.Document.Execution,
				Budget:           revision.Document.Budget,
				Task:             clonedTask,
			})
		}
		return items
	}
	return nil
}

// applyTaskAssignmentOverride merges one user-owned decision override into a
// plan task. Nil fields keep the document value; non-nil values replace it,
// including an explicit empty string that clears the assignment.
func applyTaskAssignmentOverride(task *PlanTask, override workflowbiz.TaskAssignment) {
	if override.AgentTargetID != nil {
		task.AgentTargetID = *override.AgentTargetID
	}
	if override.ModelPlanID != nil {
		task.ModelPlanID = *override.ModelPlanID
	}
	if override.Model != nil {
		task.Model = *override.Model
	}
	if override.PermissionModeID != nil {
		task.PermissionModeID = *override.PermissionModeID
	}
	if override.ReasoningEffort != nil {
		task.ReasoningEffort = *override.ReasoningEffort
	}
	if override.Parallelizable != nil {
		task.Parallelizable = *override.Parallelizable
	}
	if override.AutoAccept != nil {
		task.AutoAccept = *override.AutoAccept
	}
}
