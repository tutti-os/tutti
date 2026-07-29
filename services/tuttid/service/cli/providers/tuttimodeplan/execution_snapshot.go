package tuttimodeplan

import (
	"context"
	"errors"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

type issueGetInput struct {
	IssueID string `cli:"issue-id" validate:"required" description:"Tutti-owned Issue id."`
}

func (p Provider) newIssueGetCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueGetInput]{
		ID:          appID + ".plan.issue.get",
		Path:        []string{"plan", "issue", "get"},
		Summary:     "Get authoritative Tutti Mode execution state",
		Description: "Read the source-session-scoped execution, active checkpoint, graph revision, task readiness blockers, and allowed recovery actions.",
		Kind:        framework.KindGet,
		Visibility:  cliservice.CapabilityVisibilityPublic,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueGetInput](),
		Output:      planJSONOutput(framework.ViewDetail),
		Run:         p.runIssueGet,
	})
}

func (p Provider) runIssueGet(
	ctx context.Context,
	invoke framework.InvokeContext,
	input issueGetInput,
) (any, error) {
	sessionID, err := callerAgentSessionID(invoke)
	if err != nil {
		return nil, err
	}
	aggregate, err := p.executionReads.GetByIssue(
		ctx, invoke.WorkspaceID, strings.TrimSpace(input.IssueID),
	)
	if err != nil {
		return nil, agentExecutionGetError(err, input.IssueID)
	}
	if strings.TrimSpace(aggregate.Execution.SourceSessionID) != sessionID {
		return nil, cliservice.InvalidInputReasonError(
			string(executionbiz.RejectionWrongSourceSession),
			"execution belongs to a different source session. "+
				"Hint: run this command from the original Tutti Mode conversation",
			nil,
		)
	}
	detail, err := p.issueDetails.GetIssueDetail(
		ctx, invoke.WorkspaceID, strings.TrimSpace(input.IssueID),
	)
	if err != nil {
		return nil, agentExecutionGetError(err, input.IssueID)
	}
	return issueExecutionSnapshotJSON(aggregate, detail), nil
}

func issueExecutionSnapshotJSON(
	aggregate executionbiz.Aggregate,
	detail workspaceissues.IssueDetail,
) map[string]any {
	activeCheckpoint, checkpoints := visibleExecutionCheckpoints(aggregate)
	tasksByID := make(map[string]workspaceissues.Task, len(detail.Tasks))
	for _, task := range detail.Tasks {
		tasksByID[task.TaskID] = task
	}
	readinessTasksByID := executionReadinessTasks(tasksByID, activeCheckpoint)
	tasks := make([]map[string]any, 0, len(detail.Tasks))
	readyTaskIDs := make([]string, 0)
	for _, task := range detail.Tasks {
		readinessTask := readinessTasksByID[task.TaskID]
		blocker := workspaceissues.IssueTaskRunBlocker(readinessTask, readinessTasksByID)
		ready := blocker == ""
		if ready {
			readyTaskIDs = append(readyTaskIDs, task.TaskID)
		}
		tasks = append(tasks, executionTaskJSON(task, ready, blocker))
	}
	allowedActions := executionAllowedActions(
		aggregate.Execution,
		activeCheckpoint,
		aggregate.Checkpoints,
		detail.Tasks,
		len(readyTaskIDs) > 0,
	)
	return map[string]any{
		"issueId": aggregate.Execution.IssueID,
		"execution": map[string]any{
			"executionId":        aggregate.Execution.ID,
			"status":             string(aggregate.Execution.Status),
			"graphRevision":      aggregate.Execution.GraphRevision,
			"activeCheckpointId": aggregate.Execution.ActiveCheckpointID,
			"reviewMode":         string(aggregate.Execution.ReviewMode),
			"archiveReason":      aggregate.Execution.ArchiveReason,
		},
		"activeCheckpoint": activeCheckpoint,
		"checkpoints":      checkpoints,
		"tasks":            tasks,
		"readyTaskIds":     readyTaskIDs,
		"allowedActions":   allowedActions,
		"recoveryHint":     executionRecoveryHint(activeCheckpoint),
	}
}

func visibleExecutionCheckpoints(
	aggregate executionbiz.Aggregate,
) (map[string]any, []map[string]any) {
	var active map[string]any
	visible := make([]map[string]any, 0)
	for _, checkpoint := range aggregate.Checkpoints {
		if checkpoint.Status != executionbiz.CheckpointStatusActive &&
			checkpoint.Status != executionbiz.CheckpointStatusPending {
			continue
		}
		value := executionCheckpointJSON(checkpoint)
		visible = append(visible, value)
		if checkpoint.ID == aggregate.Execution.ActiveCheckpointID &&
			checkpoint.Status == executionbiz.CheckpointStatusActive {
			active = value
		}
	}
	return active, visible
}

func executionReadinessTasks(
	tasks map[string]workspaceissues.Task,
	activeCheckpoint map[string]any,
) map[string]workspaceissues.Task {
	projected := make(map[string]workspaceissues.Task, len(tasks))
	for taskID, task := range tasks {
		projected[taskID] = task
	}
	if activeCheckpoint == nil ||
		executionbiz.CheckpointKind(activeCheckpoint["kind"].(string)) !=
			executionbiz.CheckpointKindTaskSettled {
		return projected
	}
	subjectTaskID, _ := activeCheckpoint["subjectTaskId"].(string)
	subject, ok := projected[subjectTaskID]
	if ok && subject.Status == workspaceissues.StatusPendingAcceptance {
		// Exact-set scheduling accepts the reviewed settlement atomically.
		// Readiness projects the same dependency fact without changing the
		// persisted status presented to the caller.
		projected[subjectTaskID] =
			workspaceissues.ProjectReviewedSettlementTaskForRun(subject)
	}
	return projected
}

func executionCheckpointJSON(checkpoint executionbiz.Checkpoint) map[string]any {
	return map[string]any{
		"checkpointId":       checkpoint.ID,
		"kind":               string(checkpoint.Kind),
		"status":             string(checkpoint.Status),
		"sequence":           checkpoint.Sequence,
		"graphRevision":      checkpoint.GraphRevision,
		"subjectTaskId":      checkpoint.SubjectTaskID,
		"subjectRunId":       checkpoint.SubjectRunID,
		"creationReason":     checkpoint.CreationReason,
		"requiresGoalReview": checkpoint.RequiresGoalReview,
	}
}

func executionTaskJSON(
	task workspaceissues.Task,
	ready bool,
	blocker workspaceissues.TaskRunBlocker,
) map[string]any {
	return map[string]any{
		"taskId":             task.TaskID,
		"title":              task.Title,
		"status":             string(task.Status),
		"acceptanceState":    string(task.AcceptanceState),
		"agentTargetId":      task.AgentTargetID,
		"modelPlanId":        task.ModelPlanID,
		"model":              task.Model,
		"permissionModeId":   task.PermissionModeID,
		"reasoningEffort":    task.ReasoningEffort,
		"executionDirectory": task.ExecutionDirectory,
		"dependencyTaskIds":  append([]string(nil), task.DependencyTaskIDs...),
		"parallelizable":     task.Parallelizable,
		"autoAccept":         task.AutoAccept,
		"latestRunId":        task.LatestRunID,
		"supersededAtUnixMs": task.SupersededAtUnixMS,
		"supersededByTaskId": task.SupersededByTaskID,
		"ready":              ready,
		"blockerReason":      string(blocker),
	}
}

func executionAllowedActions(
	execution executionbiz.Execution,
	activeCheckpoint map[string]any,
	checkpoints []executionbiz.Checkpoint,
	tasks []workspaceissues.Task,
	hasReadyTasks bool,
) []string {
	if activeCheckpoint == nil ||
		execution.Status == executionbiz.StatusCompleted ||
		execution.Status == executionbiz.StatusArchiving ||
		execution.Status == executionbiz.StatusArchived {
		return []string{}
	}
	kind := executionbiz.CheckpointKind(activeCheckpoint["kind"].(string))
	switch kind {
	case executionbiz.CheckpointKindAllTasksTerminal:
		return []string{
			"plan issue complete",
			"plan issue mutate",
			"plan issue stop",
		}
	case executionbiz.CheckpointKindInitialSchedule:
		return executionWorkActions(hasReadyTasks)
	case executionbiz.CheckpointKindTaskSettled,
		executionbiz.CheckpointKindTaskFailed,
		executionbiz.CheckpointKindTaskCanceled:
		actions := executionWorkActions(hasReadyTasks)
		if executionCanAcknowledge(checkpoints, tasks) {
			actions = append(actions, "plan issue acknowledge")
		}
		return actions
	default:
		actions := executionWorkActions(hasReadyTasks)
		if kind == executionbiz.CheckpointKindWatchdog &&
			executionCanAcknowledge(checkpoints, tasks) {
			actions = append(actions, "plan issue acknowledge")
		}
		return actions
	}
}

func executionWorkActions(hasReadyTasks bool) []string {
	actions := []string{"plan issue mutate"}
	if hasReadyTasks {
		actions = append(actions, "plan issue schedule")
	}
	return append(actions, "plan issue stop")
}

func executionCanAcknowledge(
	checkpoints []executionbiz.Checkpoint,
	tasks []workspaceissues.Task,
) bool {
	for _, task := range tasks {
		if task.Status == workspaceissues.StatusRunning {
			return true
		}
	}
	for _, checkpoint := range checkpoints {
		if checkpoint.Status == executionbiz.CheckpointStatusPending {
			return true
		}
	}
	return false
}

func executionRecoveryHint(activeCheckpoint map[string]any) string {
	if activeCheckpoint == nil {
		return "No active checkpoint accepts a source-Agent command"
	}
	switch executionbiz.CheckpointKind(activeCheckpoint["kind"].(string)) {
	case executionbiz.CheckpointKindTaskFailed,
		executionbiz.CheckpointKindTaskCanceled:
		return "Rework the terminal task with a new taskId, then schedule the replacement using the mutation result graphRevision"
	case executionbiz.CheckpointKindAllTasksTerminal:
		return "Complete Goal Review if satisfied, or mutate and schedule exact follow-up work"
	default:
		return "Choose one allowed action using this exact checkpointId and graphRevision"
	}
}

func agentExecutionGetError(err error, issueID string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, executionbiz.ErrExecutionNotFound) ||
		errors.Is(err, workspaceissues.ErrIssueNotFound) {
		return executionNotFoundError(issueID)
	}
	return err
}
