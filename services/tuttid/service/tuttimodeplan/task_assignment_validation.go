package tuttimodeplan

import (
	"context"
	"fmt"
	"strings"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
)

// TaskAssignmentModelCatalog supplies an authoritative model catalog at the
// user decision boundary. An empty result means the selected assignment keeps
// its provider's existing validation path.
type TaskAssignmentModelCatalog interface {
	AvailableTaskAssignmentModels(
		context.Context,
		string,
		string,
		string,
	) ([]string, error)
}

// validatedDecisionTaskAssignments enforces the accept-only, task-review-only
// scope of per-task overrides and verifies every override targets a task in
// the current revision document.
func (s *Service) validatedDecisionTaskAssignments(
	ctx context.Context,
	input DecideInput,
	snapshot workflowbiz.Snapshot,
	checkpoint workflowbiz.WorkflowCheckpoint,
) ([]workflowbiz.TaskAssignment, error) {
	assignments, err := workflowbiz.NormalizeTaskAssignments(input.TaskAssignments)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidDecision, err)
	}
	if len(assignments) > 0 &&
		(input.Decision != workflowbiz.CheckpointStatusAccepted || checkpoint.Kind != workflowbiz.CheckpointKindTaskReview) {
		return nil, fmt.Errorf("%w: task assignments are only valid when accepting a task review", ErrInvalidDecision)
	}
	if input.Decision != workflowbiz.CheckpointStatusAccepted || checkpoint.Kind != workflowbiz.CheckpointKindTaskReview {
		return assignments, nil
	}
	if len(assignments) == 0 &&
		(s.TaskAssignmentModelCatalog == nil || checkpoint.Status != workflowbiz.CheckpointStatusPending) {
		return assignments, nil
	}
	revision, found := revisionByID(snapshot.Revisions, checkpoint.RevisionID)
	if !found {
		return nil, ErrCheckpointMissing
	}
	raw, err := s.Revisions.Read(snapshot.Workflow.ID, revision.DocumentPath, revision.SHA256)
	if err != nil {
		return nil, err
	}
	document, err := ParsePlanMarkdown(raw)
	if err != nil {
		return nil, err
	}
	knownTasks := make(map[string]PlanTask, len(document.Tasks))
	for _, task := range document.Tasks {
		knownTasks[task.ID] = task
	}
	for _, assignment := range assignments {
		task, ok := knownTasks[assignment.TaskID]
		if !ok {
			return nil, fmt.Errorf("%w: task assignment references unknown task %q", ErrInvalidDecision, assignment.TaskID)
		}
		applyTaskAssignmentOverride(&task, assignment)
		knownTasks[assignment.TaskID] = task
	}
	if s.TaskAssignmentModelCatalog == nil || checkpoint.Status != workflowbiz.CheckpointStatusPending {
		return assignments, nil
	}
	modelCatalogs := make(map[string][]string)
	for _, documentTask := range document.Tasks {
		task := knownTasks[documentTask.ID]
		model := strings.TrimSpace(task.Model)
		if model == "" {
			continue
		}
		catalogKey := strings.TrimSpace(task.AgentTargetID) + "\x00" + strings.TrimSpace(task.ModelPlanID)
		availableModels, cached := modelCatalogs[catalogKey]
		if !cached {
			availableModels, err = s.TaskAssignmentModelCatalog.AvailableTaskAssignmentModels(
				ctx,
				input.WorkspaceID,
				task.AgentTargetID,
				task.ModelPlanID,
			)
			if err != nil {
				return nil, fmt.Errorf("%w: validate model for task %q: %v", ErrInvalidDecision, task.ID, err)
			}
			modelCatalogs[catalogKey] = availableModels
		}
		if len(availableModels) == 0 {
			continue
		}
		available := false
		for _, candidate := range availableModels {
			if strings.TrimSpace(candidate) == model {
				available = true
				break
			}
		}
		if !available {
			return nil, fmt.Errorf("%w: model %q is unavailable for task %q", ErrInvalidDecision, model, task.ID)
		}
	}
	return assignments, nil
}
