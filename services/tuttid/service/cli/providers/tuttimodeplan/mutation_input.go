package tuttimodeplan

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

type mutationOperationInput struct {
	Kind   string             `json:"kind"`
	TaskID string             `json:"taskId"`
	Task   *mutationTaskInput `json:"task"`
}

type mutationTaskInput struct {
	TaskID             string    `json:"taskId"`
	Title              *string   `json:"title"`
	Content            *string   `json:"content"`
	Priority           *string   `json:"priority"`
	DueAtUnixMS        *int64    `json:"dueAtUnixMs"`
	AgentTargetID      *string   `json:"agentTargetId"`
	ModelPlanID        *string   `json:"modelPlanId"`
	Model              *string   `json:"model"`
	PermissionModeID   *string   `json:"permissionModeId"`
	ReasoningEffort    *string   `json:"reasoningEffort"`
	ExecutionDirectory *string   `json:"executionDirectory"`
	DependencyTaskIDs  *[]string `json:"dependencyTaskIds"`
	Parallelizable     *bool     `json:"parallelizable"`
	AutoAccept         *bool     `json:"autoAccept"`
}

func parseMutationOperationsJSON(value string) ([]executionbiz.MutationOperation, error) {
	var parsed []mutationOperationInput
	decoder := json.NewDecoder(bytes.NewBufferString(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&parsed); err != nil {
		return nil, invalidMutationInput(
			`operations-json must be one non-empty JSON array using "kind", "taskId", ` +
				`and a "task" object with "taskId": ` +
				err.Error(),
		)
	}
	if len(parsed) == 0 {
		return nil, invalidMutationInput("operations-json must not be empty")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, invalidMutationInput("operations-json must contain exactly one JSON value")
	}

	operations := make([]executionbiz.MutationOperation, 0, len(parsed))
	for _, input := range parsed {
		operation, err := mutationOperation(input)
		if err != nil {
			return nil, err
		}
		operations = append(operations, operation)
	}
	return operations, nil
}

func mutationOperation(input mutationOperationInput) (executionbiz.MutationOperation, error) {
	operation := executionbiz.MutationOperation{
		Kind:   executionbiz.MutationOperationKind(strings.TrimSpace(input.Kind)),
		TaskID: strings.TrimSpace(input.TaskID),
	}
	if input.Task != nil {
		if input.Task.Priority != nil {
			priority := strings.ToLower(strings.TrimSpace(*input.Task.Priority))
			if priority != string(workspaceissues.PriorityHigh) &&
				priority != string(workspaceissues.PriorityMedium) &&
				priority != string(workspaceissues.PriorityLow) {
				return executionbiz.MutationOperation{}, invalidMutationInput(
					"task.priority must be high, medium, or low",
				)
			}
		}
		if input.Task.DueAtUnixMS != nil && *input.Task.DueAtUnixMS < 0 {
			return executionbiz.MutationOperation{}, invalidMutationInput(
				"task.dueAtUnixMs must be zero or greater",
			)
		}
		operation.Task, operation.TaskFields = input.Task.domainTask()
	}
	switch operation.Kind {
	case executionbiz.MutationOperationAdd:
		if input.Task == nil || operation.Task.TaskID == "" ||
			strings.TrimSpace(operation.Task.Title) == "" {
			return executionbiz.MutationOperation{}, invalidMutationInput(
				"add requires task.taskId, task.title, and a complete schedulable task",
			)
		}
		if strings.TrimSpace(operation.Task.AgentTargetID) == "" {
			return executionbiz.MutationOperation{}, cliservice.InvalidInputReasonError(
				string(executionbiz.RejectionMissingAgentTarget),
				"add task "+operation.Task.TaskID+
					" is missing agentTargetId. Hint: choose a target from `tutti agent list --json`",
				nil,
			)
		}
	case executionbiz.MutationOperationUpdate:
		if operation.TaskID == "" || input.Task == nil || !operation.TaskFields.Any() {
			return executionbiz.MutationOperation{}, invalidMutationInput(
				"update requires taskId and at least one explicitly present task field",
			)
		}
	case executionbiz.MutationOperationRework:
		if operation.TaskID == "" || input.Task == nil || operation.Task.TaskID == "" {
			return executionbiz.MutationOperation{}, invalidMutationInput(
				"rework requires taskId plus task.taskId for the replacement",
			)
		}
	case executionbiz.MutationOperationSupersede:
		if operation.TaskID == "" || input.Task != nil {
			return executionbiz.MutationOperation{}, invalidMutationInput(
				"supersede requires taskId and does not accept task",
			)
		}
	default:
		return executionbiz.MutationOperation{}, invalidMutationInput(
			"entries must use kind add, update, rework, or supersede; op and replacement are not supported",
		)
	}
	return operation, nil
}

func (input mutationTaskInput) domainTask() (
	workspaceissues.Task,
	executionbiz.MutationTaskFields,
) {
	task := workspaceissues.Task{TaskID: strings.TrimSpace(input.TaskID)}
	fields := executionbiz.MutationTaskFields{}
	if input.Title != nil {
		task.Title = *input.Title
		fields.Title = true
	}
	if input.Content != nil {
		task.Content = *input.Content
		fields.Content = true
	}
	if input.Priority != nil {
		task.Priority = workspaceissues.Priority(strings.TrimSpace(*input.Priority))
		fields.Priority = true
	}
	if input.DueAtUnixMS != nil {
		task.DueAtUnixMS = *input.DueAtUnixMS
		fields.DueAtUnixMS = true
	}
	if input.AgentTargetID != nil {
		task.AgentTargetID = strings.TrimSpace(*input.AgentTargetID)
		fields.AgentTargetID = true
	}
	if input.ModelPlanID != nil {
		task.ModelPlanID = strings.TrimSpace(*input.ModelPlanID)
		fields.ModelPlanID = true
	}
	if input.Model != nil {
		task.Model = strings.TrimSpace(*input.Model)
		fields.Model = true
	}
	if input.PermissionModeID != nil {
		task.PermissionModeID = strings.TrimSpace(*input.PermissionModeID)
		fields.PermissionModeID = true
	}
	if input.ReasoningEffort != nil {
		task.ReasoningEffort = strings.TrimSpace(*input.ReasoningEffort)
		fields.ReasoningEffort = true
	}
	if input.ExecutionDirectory != nil {
		task.ExecutionDirectory = strings.TrimSpace(*input.ExecutionDirectory)
		fields.ExecutionDirectory = true
	}
	if input.DependencyTaskIDs != nil {
		task.DependencyTaskIDs = append([]string(nil), (*input.DependencyTaskIDs)...)
		fields.DependencyTaskIDs = true
	}
	if input.Parallelizable != nil {
		task.Parallelizable = *input.Parallelizable
		fields.Parallelizable = true
	}
	if input.AutoAccept != nil {
		task.AutoAccept = *input.AutoAccept
		fields.AutoAccept = true
	}
	return task, fields
}

func invalidMutationInput(message string) error {
	return cliservice.InvalidInputReasonError(
		string(executionbiz.RejectionInvalidMutation),
		strings.TrimSpace(message)+
			". Hint: run `tutti plan issue mutate --help` and use the documented schema",
		fmt.Errorf("%w: invalid operations-json", cliservice.ErrInvalidInput),
	)
}
