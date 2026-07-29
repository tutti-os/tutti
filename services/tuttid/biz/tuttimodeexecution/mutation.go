package tuttimodeexecution

import (
	"sort"
	"strings"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

type MutationGraphInput struct {
	WorkspaceID string
	IssueID     string
	Tasks       map[string]workspaceissues.Task
	Operations  []MutationOperation
	Now         time.Time
}

type MutationGraphResult struct {
	Tasks             map[string]workspaceissues.Task
	InsertedTasks     []workspaceissues.Task
	UpdatedTasks      []workspaceissues.Task
	AddedTaskIDs      []string
	UpdatedTaskIDs    []string
	SupersededTaskIDs []string
}

func ApplyMutationGraph(input MutationGraphInput) (MutationGraphResult, error) {
	result := MutationGraphResult{
		Tasks:             cloneMutationTasks(input.Tasks),
		InsertedTasks:     []workspaceissues.Task{},
		UpdatedTasks:      []workspaceissues.Task{},
		AddedTaskIDs:      []string{},
		UpdatedTaskIDs:    []string{},
		SupersededTaskIDs: []string{},
	}
	nextSortIndex := 1
	replacements := make(map[string]string)
	inserted := make(map[string]bool)
	updated := make(map[string]bool)
	for _, task := range result.Tasks {
		nextSortIndex = max(nextSortIndex, task.SortIndex+1)
	}

	for _, operation := range input.Operations {
		operation.TaskID = strings.TrimSpace(operation.TaskID)
		operation.Task.TaskID = strings.TrimSpace(operation.Task.TaskID)
		switch operation.Kind {
		case MutationOperationAdd:
			if operation.Task.TaskID == "" {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionInvalidMutation, "",
				)
			}
			task := newMutationTask(
				input.WorkspaceID, input.IssueID, operation.Task, nextSortIndex, input.Now,
			)
			nextSortIndex++
			if _, exists := result.Tasks[task.TaskID]; exists ||
				strings.TrimSpace(task.AgentTargetID) == "" {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, mutationAddRejectionReason(result.Tasks, task), task.TaskID,
				)
			}
			result.Tasks[task.TaskID] = task
			inserted[task.TaskID] = true
			result.AddedTaskIDs = append(result.AddedTaskIDs, task.TaskID)
		case MutationOperationUpdate:
			if operation.TaskID == "" {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionInvalidMutation, "",
				)
			}
			task, ok := result.Tasks[operation.TaskID]
			if !ok {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionTaskNotFound, operation.TaskID,
				)
			}
			if task.IsSuperseded() {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionTaskSuperseded, operation.TaskID,
				)
			}
			if task.Status != workspaceissues.StatusNotStarted {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionTaskNotStarted, operation.TaskID,
				)
			}
			if !operation.TaskFields.Any() {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionInvalidMutation, operation.TaskID,
				)
			}
			applyMutationTaskPatch(&task, operation.Task, operation.TaskFields, input.Now)
			result.Tasks[task.TaskID] = task
			updated[task.TaskID] = true
			result.UpdatedTaskIDs = appendUniqueMutationTaskID(result.UpdatedTaskIDs, task.TaskID)
		case MutationOperationSupersede:
			if operation.TaskID == "" {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionInvalidMutation, "",
				)
			}
			task, ok := result.Tasks[operation.TaskID]
			if !ok {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionTaskNotFound, operation.TaskID,
				)
			}
			if task.IsSuperseded() {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionTaskSuperseded, operation.TaskID,
				)
			}
			if task.Status == workspaceissues.StatusRunning ||
				task.Status == workspaceissues.StatusCompleted {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionTaskNotStarted, operation.TaskID,
				)
			}
			task.SupersededAtUnixMS = input.Now.UnixMilli()
			task.UpdatedAtUnixMS = input.Now.UnixMilli()
			result.Tasks[task.TaskID] = task
			updated[task.TaskID] = true
			result.SupersededTaskIDs = append(result.SupersededTaskIDs, task.TaskID)
		case MutationOperationRework:
			if operation.TaskID == "" || operation.Task.TaskID == "" {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionInvalidMutation, operation.TaskID,
				)
			}
			oldTask, ok := result.Tasks[operation.TaskID]
			if !ok {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionTaskNotFound, operation.TaskID,
				)
			}
			if oldTask.IsSuperseded() {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionTaskSuperseded, operation.TaskID,
				)
			}
			if oldTask.Status == workspaceissues.StatusRunning ||
				oldTask.Status == workspaceissues.StatusCompleted {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionTaskNotStarted, operation.TaskID,
				)
			}
			replacementInput := inheritMutationReworkTask(
				oldTask, operation.Task, operation.TaskFields,
			)
			replacement := newMutationTask(
				input.WorkspaceID, input.IssueID, replacementInput, nextSortIndex, input.Now,
			)
			nextSortIndex++
			if _, exists := result.Tasks[replacement.TaskID]; exists {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionDuplicateTask, replacement.TaskID,
				)
			}
			if strings.TrimSpace(replacement.AgentTargetID) == "" {
				return MutationGraphResult{}, Reject(
					ErrMutationRejected, RejectionMissingAgentTarget, replacement.TaskID,
				)
			}
			oldTask.SupersededAtUnixMS = input.Now.UnixMilli()
			oldTask.SupersededByTaskID = replacement.TaskID
			oldTask.UpdatedAtUnixMS = input.Now.UnixMilli()
			result.Tasks[oldTask.TaskID] = oldTask
			result.Tasks[replacement.TaskID] = replacement
			updated[oldTask.TaskID] = true
			inserted[replacement.TaskID] = true
			replacements[oldTask.TaskID] = replacement.TaskID
			result.SupersededTaskIDs = append(result.SupersededTaskIDs, oldTask.TaskID)
			result.AddedTaskIDs = append(result.AddedTaskIDs, replacement.TaskID)
		default:
			return MutationGraphResult{}, Reject(
				ErrMutationRejected, RejectionInvalidMutation, operation.TaskID,
			)
		}
	}

	if err := rebindMutationDependents(
		result.Tasks, replacements, updated, &result, input.Now,
	); err != nil {
		return MutationGraphResult{}, err
	}
	if err := validateMutationGraph(result.Tasks); err != nil {
		return MutationGraphResult{}, err
	}
	result.InsertedTasks = mutationTasksForWrite(result.Tasks, inserted)
	result.UpdatedTasks = mutationTasksForWrite(result.Tasks, updated)
	return result, nil
}

func cloneMutationTasks(
	tasks map[string]workspaceissues.Task,
) map[string]workspaceissues.Task {
	result := make(map[string]workspaceissues.Task, len(tasks))
	for taskID, task := range tasks {
		task.DependencyTaskIDs = append([]string(nil), task.DependencyTaskIDs...)
		result[taskID] = task
	}
	return result
}

func newMutationTask(
	workspaceID string,
	issueID string,
	task workspaceissues.Task,
	sortIndex int,
	now time.Time,
) workspaceissues.Task {
	unixMS := now.UnixMilli()
	task.TaskID = strings.TrimSpace(task.TaskID)
	task.WorkspaceID = workspaceID
	task.IssueID = issueID
	task.Title = strings.TrimSpace(task.Title)
	task.Content = strings.TrimSpace(task.Content)
	task.Status = workspaceissues.StatusNotStarted
	task.Priority = workspaceissues.NormalizePriority(string(task.Priority))
	task.DueAtUnixMS = max(task.DueAtUnixMS, 0)
	task.AgentTargetID = strings.TrimSpace(task.AgentTargetID)
	task.ModelPlanID = strings.TrimSpace(task.ModelPlanID)
	task.Model = strings.TrimSpace(task.Model)
	task.PermissionModeID = strings.TrimSpace(task.PermissionModeID)
	task.ReasoningEffort = strings.TrimSpace(task.ReasoningEffort)
	task.ExecutionDirectory = strings.TrimSpace(task.ExecutionDirectory)
	task.SortIndex = sortIndex
	task.DependencyTaskIDs = workspaceissues.NormalizeDependencyTaskIDs(task.DependencyTaskIDs)
	task.AcceptanceState = workspaceissues.AcceptanceAgentClaimed
	task.AcceptanceSummary = ""
	task.LatestRunID = ""
	task.SupersededAtUnixMS = 0
	task.SupersededByTaskID = ""
	task.CreatedAtUnixMS = unixMS
	task.UpdatedAtUnixMS = unixMS
	task.SearchText = strings.TrimSpace(task.Title + " " + task.Content)
	return task
}

func applyMutationTaskPatch(
	task *workspaceissues.Task,
	patch workspaceissues.Task,
	fields MutationTaskFields,
	now time.Time,
) {
	oldTargetID := strings.TrimSpace(task.AgentTargetID)
	if fields.Title {
		task.Title = strings.TrimSpace(patch.Title)
	}
	if fields.Content {
		task.Content = strings.TrimSpace(patch.Content)
	}
	if fields.Priority {
		task.Priority = workspaceissues.NormalizePriority(string(patch.Priority))
	}
	if fields.DueAtUnixMS {
		task.DueAtUnixMS = max(patch.DueAtUnixMS, 0)
	}
	if fields.AgentTargetID {
		task.AgentTargetID = strings.TrimSpace(patch.AgentTargetID)
		if strings.TrimSpace(patch.AgentTargetID) != oldTargetID {
			if !fields.ModelPlanID {
				task.ModelPlanID = ""
			}
			if !fields.Model {
				task.Model = ""
			}
			if !fields.PermissionModeID {
				task.PermissionModeID = ""
			}
			if !fields.ReasoningEffort {
				task.ReasoningEffort = ""
			}
		}
	}
	if fields.ModelPlanID {
		task.ModelPlanID = strings.TrimSpace(patch.ModelPlanID)
	}
	if fields.Model {
		task.Model = strings.TrimSpace(patch.Model)
	}
	if fields.PermissionModeID {
		task.PermissionModeID = strings.TrimSpace(patch.PermissionModeID)
	}
	if fields.ReasoningEffort {
		task.ReasoningEffort = strings.TrimSpace(patch.ReasoningEffort)
	}
	if fields.ExecutionDirectory {
		task.ExecutionDirectory = strings.TrimSpace(patch.ExecutionDirectory)
	}
	if fields.DependencyTaskIDs {
		task.DependencyTaskIDs = workspaceissues.NormalizeDependencyTaskIDs(
			patch.DependencyTaskIDs,
		)
	}
	if fields.Parallelizable {
		task.Parallelizable = patch.Parallelizable
	}
	if fields.AutoAccept {
		task.AutoAccept = patch.AutoAccept
	}
	task.SearchText = strings.TrimSpace(task.Title + " " + task.Content)
	task.UpdatedAtUnixMS = now.UnixMilli()
}

func inheritMutationReworkTask(
	oldTask workspaceissues.Task,
	replacement workspaceissues.Task,
	fields MutationTaskFields,
) workspaceissues.Task {
	result := oldTask
	result.TaskID = replacement.TaskID
	applyMutationTaskPatch(&result, replacement, fields, time.UnixMilli(oldTask.UpdatedAtUnixMS))
	result.TaskID = replacement.TaskID
	return result
}

func rebindMutationDependents(
	tasks map[string]workspaceissues.Task,
	replacements map[string]string,
	updated map[string]bool,
	result *MutationGraphResult,
	now time.Time,
) error {
	if len(replacements) == 0 {
		return nil
	}
	dependents := make([]workspaceissues.Task, 0)
	for _, task := range tasks {
		if task.IsSuperseded() {
			continue
		}
		dependencies := make([]string, 0, len(task.DependencyTaskIDs))
		changed := false
		for _, dependencyID := range task.DependencyTaskIDs {
			reboundID := dependencyID
			for hop := 0; ; hop++ {
				if hop > len(replacements) {
					return Reject(ErrMutationRejected, RejectionInvalidTaskGraph, task.TaskID)
				}
				replacementID, exists := replacements[reboundID]
				if !exists {
					break
				}
				reboundID = replacementID
				changed = true
			}
			dependencies = append(dependencies, reboundID)
		}
		if !changed {
			continue
		}
		if task.Status != workspaceissues.StatusNotStarted {
			return Reject(ErrMutationRejected, RejectionTaskNotStarted, task.TaskID)
		}
		task.DependencyTaskIDs = workspaceissues.NormalizeDependencyTaskIDs(dependencies)
		task.UpdatedAtUnixMS = now.UnixMilli()
		dependents = append(dependents, task)
	}
	sortMutationTasks(dependents)
	for _, task := range dependents {
		tasks[task.TaskID] = task
		updated[task.TaskID] = true
		result.UpdatedTaskIDs = appendUniqueMutationTaskID(result.UpdatedTaskIDs, task.TaskID)
	}
	return nil
}

func validateMutationGraph(tasks map[string]workspaceissues.Task) error {
	active := make([]workspaceissues.Task, 0, len(tasks))
	for _, task := range tasks {
		if task.IsSuperseded() {
			continue
		}
		if strings.TrimSpace(task.Title) == "" {
			return Reject(ErrMutationRejected, RejectionInvalidTaskGraph, task.TaskID)
		}
		if strings.TrimSpace(task.AgentTargetID) == "" {
			return Reject(ErrMutationRejected, RejectionMissingAgentTarget, task.TaskID)
		}
		for _, dependencyID := range task.DependencyTaskIDs {
			dependency, ok := tasks[dependencyID]
			if !ok || dependency.IsSuperseded() {
				return Reject(
					ErrMutationRejected, RejectionDependencyUnsatisfied, task.TaskID,
				)
			}
		}
		active = append(active, task)
	}
	if len(active) == 0 || !workspaceissues.ValidateTaskDependencyGraph(active) {
		return Reject(ErrMutationRejected, RejectionInvalidTaskGraph, "")
	}
	return nil
}

func mutationTasksForWrite(
	tasks map[string]workspaceissues.Task,
	selected map[string]bool,
) []workspaceissues.Task {
	result := make([]workspaceissues.Task, 0, len(selected))
	for taskID := range selected {
		result = append(result, tasks[taskID])
	}
	sortMutationTasks(result)
	return result
}

func sortMutationTasks(tasks []workspaceissues.Task) {
	sort.Slice(tasks, func(left int, right int) bool {
		if tasks[left].SortIndex != tasks[right].SortIndex {
			return tasks[left].SortIndex < tasks[right].SortIndex
		}
		return tasks[left].TaskID < tasks[right].TaskID
	})
}

func mutationAddRejectionReason(
	tasks map[string]workspaceissues.Task,
	task workspaceissues.Task,
) RejectionReason {
	if _, exists := tasks[task.TaskID]; exists {
		return RejectionDuplicateTask
	}
	return RejectionMissingAgentTarget
}

func appendUniqueMutationTaskID(values []string, taskID string) []string {
	for _, value := range values {
		if value == taskID {
			return values
		}
	}
	return append(values, taskID)
}
