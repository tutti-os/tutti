package tuttimodeplan

import (
	"errors"
	"fmt"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	workflowdata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
)

func agentPlanError(err error) error {
	var preferenceMismatch *tuttimodeplanservice.PreferenceSnapshotMismatchError
	if errors.As(err, &preferenceMismatch) {
		return cliservice.InvalidInputReasonError(
			"tutti_mode_preference_snapshot_mismatch",
			fmt.Sprintf(
				"Plan preferences do not match this Turn. Set execution.effect to %d and execution.speed to %d exactly, then retry the plan command.",
				preferenceMismatch.ExpectedEffect,
				preferenceMismatch.ExpectedSpeed,
			),
			nil,
		)
	}
	if errors.Is(err, tuttimodeplanservice.ErrTurnSnapshotUnavailable) {
		return cliservice.InvalidInputReasonError(
			"tutti_mode_source_turn_unavailable",
			"The exact Tutti Mode source Turn snapshot is unavailable. Stop and retry from a new active Tutti Mode Turn.",
			nil,
		)
	}
	if errors.Is(err, workflowdata.ErrWorkspaceWorkflowNotFound) {
		return cliservice.InvalidInputReasonError(
			string(executionbiz.RejectionExecutionNotFound),
			"Tutti Mode plan was not found",
			nil,
		)
	}
	if errors.Is(err, tuttimodeplanservice.ErrMutationConflict) {
		return requestIDConflictError(
			"request-id was already used with different plan content. " +
				"Hint: reuse the original content or choose a new request-id",
		)
	}
	if errors.Is(err, executionbiz.ErrScheduleMutationConflict) {
		return requestIDConflictError(
			"request-id was already used with a different schedule payload. " +
				"Hint: reuse it only with the identical task set",
		)
	}
	if errors.Is(err, executionbiz.ErrAcknowledgeMutationConflict) {
		return requestIDConflictError(
			"request-id was already used with a different acknowledge payload. " +
				"Hint: reuse it only for the identical checkpoint",
		)
	}
	if errors.Is(err, executionbiz.ErrExecutionConflict) ||
		errors.Is(err, executionbiz.ErrAcknowledgeRejected) {
		return cliservice.InvalidInputReasonError(
			string(executionbiz.RejectionInactiveCheckpoint),
			"execution caller, checkpoint, or revision is not current. "+
				"Hint: run `tutti plan issue get --issue-id <issue-id> --json` once and use its active checkpoint and graph revision",
			nil,
		)
	}
	if errors.Is(err, executionbiz.ErrScheduleRejected) ||
		errors.Is(err, executionbiz.ErrExecutionNotFound) {
		return rejectionCLIError("schedule", "", err)
	}
	return err
}

func agentScheduleError(err error, issueID string) error {
	if errors.Is(err, executionbiz.ErrScheduleMutationConflict) {
		return requestIDConflictError(
			"request-id was already used with a different schedule payload. " +
				"Hint: reuse it only with the identical task set",
		)
	}
	if errors.Is(err, executionbiz.ErrExecutionNotFound) ||
		errors.Is(err, workspaceissues.ErrIssueNotFound) {
		return executionNotFoundError(issueID)
	}
	if errors.Is(err, executionbiz.ErrScheduleRejected) {
		return rejectionCLIError("schedule", issueID, err)
	}
	return err
}

func agentAcknowledgeError(err error) error {
	if errors.Is(err, executionbiz.ErrExecutionNotFound) {
		return executionNotFoundError("")
	}
	return agentPlanError(err)
}

func agentMutationError(err error, issueID string) error {
	if errors.Is(err, executionbiz.ErrMutationConflict) {
		return requestIDConflictError(
			"request-id was already used with a different graph mutation payload. " +
				"Hint: reuse it only with identical operations or choose a new request-id",
		)
	}
	if errors.Is(err, executionbiz.ErrExecutionNotFound) {
		return executionNotFoundError(issueID)
	}
	if errors.Is(err, executionbiz.ErrMutationRejected) {
		return rejectionCLIError("mutation", issueID, err)
	}
	return err
}

func agentCompleteError(err error) error {
	if errors.Is(err, executionbiz.ErrExecutionNotFound) {
		return executionNotFoundError("")
	}
	if errors.Is(err, executionbiz.ErrCompleteMutationConflict) {
		return requestIDConflictError(
			"request-id was already used with a different completion payload. " +
				"Hint: reuse it only for the identical Goal Review decision",
		)
	}
	if errors.Is(err, executionbiz.ErrExecutionConflict) ||
		errors.Is(err, executionbiz.ErrCompleteRejected) {
		return cliservice.InvalidInputReasonError(
			string(executionbiz.RejectionInactiveCheckpoint),
			"completion checkpoint, revision, decision, or review evidence is not current. "+
				"Hint: refresh with `tutti plan issue get --issue-id <issue-id> --json`",
			nil,
		)
	}
	return err
}

func agentStopError(err error) error {
	if errors.Is(err, executionbiz.ErrInvalidExecution) {
		return cliservice.InvalidInputReasonError(
			string(executionbiz.RejectionInvalidMutation),
			"stop request is incomplete. Hint: provide the active checkpoint, graph revision, stable request-id, and audited reason",
			nil,
		)
	}
	if errors.Is(err, executionbiz.ErrExecutionNotFound) {
		return executionNotFoundError("")
	}
	if errors.Is(err, executionbiz.ErrExecutionConflict) {
		return cliservice.InvalidInputReasonError(
			string(executionbiz.RejectionInactiveCheckpoint),
			"stop checkpoint, revision, or request history is not current. "+
				"Hint: refresh with `tutti plan issue get --issue-id <issue-id> --json`",
			nil,
		)
	}
	return err
}

func rejectionCLIError(action string, issueID string, err error) error {
	reason, taskID, ok := executionbiz.RejectionDetails(err)
	if !ok {
		if errors.Is(err, executionbiz.ErrExecutionNotFound) {
			return executionNotFoundError(issueID)
		}
		reason = executionbiz.RejectionReason(action + "_rejected")
	}
	message := action + " rejected"
	if taskID != "" {
		message += " for task " + taskID
	}
	message += ". Hint: " + rejectionHint(reason, issueID, taskID)
	return cliservice.InvalidInputReasonError(string(reason), message, nil)
}

func rejectionHint(
	reason executionbiz.RejectionReason,
	issueID string,
	taskID string,
) string {
	get := "`tutti plan issue get --issue-id " + issueIDPlaceholder(issueID) + " --json`"
	switch reason {
	case executionbiz.RejectionWrongSourceSession:
		return "run the command from the original Tutti Mode source session; do not supply or guess a source session id"
	case executionbiz.RejectionInactiveExecution:
		return "run " + get + " and follow its allowedActions; the execution is not accepting this command"
	case executionbiz.RejectionInactiveCheckpoint:
		return "run " + get + " once and use the returned active checkpoint id"
	case executionbiz.RejectionStaleGraphRevision:
		return "run " + get + " once and use the returned graphRevision; never increment or guess it"
	case executionbiz.RejectionTaskNotFound:
		return "run " + get + " and choose an active task id"
	case executionbiz.RejectionTaskNotStarted:
		return "failed or canceled tasks require rework with a new taskId; running and completed tasks cannot be scheduled"
	case executionbiz.RejectionTaskSuperseded:
		return "run " + get + " and use the replacement task named by supersededByTaskId"
	case executionbiz.RejectionMissingAgentTarget:
		return "rework or update " + taskPlaceholder(taskID) +
			" with agentTargetId, or rely on sparse rework inheritance from its superseded task"
	case executionbiz.RejectionDependencyUnsatisfied:
		return "run " + get + " and schedule only tasks whose ready field is true"
	case executionbiz.RejectionDispatchPaused:
		return "run `tutti plan issue resume --issue-id " +
			issueIDPlaceholder(issueID) +
			" --json`; a source Session whose frozen command snapshot predates resume may use " +
			"`tutti issue update --issue-id " + issueIDPlaceholder(issueID) +
			" --dispatch-paused=false --json`; then retry with the same active checkpoint and graph revision"
	case executionbiz.RejectionBudgetUnavailable:
		return "the Issue budget is not active; report the blocker instead of retrying"
	case executionbiz.RejectionCapacityExhausted:
		return "wait for an active Run to settle, then use the next durable checkpoint wake"
	case executionbiz.RejectionParallelismRejected:
		return "schedule a smaller compatible task set shown as ready by " + get
	case executionbiz.RejectionDuplicateTask:
		return "use unique task ids and remove duplicates from the request"
	case executionbiz.RejectionInvalidTaskGraph:
		return "fix missing, superseded, self-referential, or cyclic dependencies in one atomic mutation"
	case executionbiz.RejectionInvalidMutation:
		return "run `tutti plan issue mutate --help` and submit the documented presence-aware operation schema"
	default:
		return "run " + get + " once; if the authoritative snapshot does not explain the rejection, report this exact error without querying SQLite"
	}
}

func requestIDConflictError(message string) error {
	return cliservice.InvalidInputReasonError("request_id_conflict", message, nil)
}

func executionNotFoundError(issueID string) error {
	message := "Tutti Mode execution was not found"
	if strings.TrimSpace(issueID) != "" {
		message += " for Issue " + strings.TrimSpace(issueID)
	}
	message += ". Hint: verify the Issue id with `tutti issue get --issue-id " +
		issueIDPlaceholder(issueID) + " --json`"
	return cliservice.InvalidInputReasonError(
		string(executionbiz.RejectionExecutionNotFound), message, nil,
	)
}

func issueIDPlaceholder(issueID string) string {
	if value := strings.TrimSpace(issueID); value != "" {
		return value
	}
	return "<issue-id>"
}

func taskPlaceholder(taskID string) string {
	if value := strings.TrimSpace(taskID); value != "" {
		return "task " + value
	}
	return "the task"
}
