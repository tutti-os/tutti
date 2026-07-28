package tuttimodeexecution

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

const WatchdogInterval = 5 * time.Minute

var ErrInvalidExecution = errors.New("invalid tutti mode execution")
var ErrExecutionNotFound = errors.New("tutti mode execution not found")
var ErrExecutionConflict = errors.New("tutti mode execution conflicts with durable state")
var ErrScheduleRejected = errors.New("tutti mode schedule was rejected")
var ErrScheduleMutationConflict = errors.New("tutti mode schedule request conflicts with durable history")
var ErrMutationRejected = errors.New("tutti mode graph mutation was rejected")
var ErrMutationConflict = errors.New("tutti mode graph mutation request conflicts with durable history")
var ErrAcknowledgeRejected = errors.New("tutti mode acknowledge was rejected")
var ErrAcknowledgeMutationConflict = errors.New("tutti mode acknowledge request conflicts with durable history")
var ErrCompleteRejected = errors.New("tutti mode completion was rejected")
var ErrCompleteMutationConflict = errors.New("tutti mode completion request conflicts with durable history")
var ErrReviewerVerdictRejected = errors.New("tutti mode reviewer verdict was rejected")
var ErrReviewerVerdictMutationConflict = errors.New("tutti mode reviewer verdict request conflicts with durable history")
var ErrSwitchReviewToSelfRejected = errors.New("tutti mode review fallback was rejected")
var ErrSwitchReviewToSelfMutationConflict = errors.New("tutti mode review fallback request conflicts with durable history")
var ErrWakeRejected = errors.New("tutti mode wake operation was rejected")
var ErrWakeIntegrity = errors.New("tutti mode wake conflicts with execution authority")

func ExecutionID(issueID string) (string, bool) {
	issueID = strings.TrimSpace(issueID)
	if issueID == "" {
		return "", false
	}
	return "tutti-execution:" + issueID, true
}

func InitialCheckpointID(executionID string) (string, bool) {
	executionID = strings.TrimSpace(executionID)
	if executionID == "" {
		return "", false
	}
	return executionID + ":checkpoint:initial-schedule", true
}

func MigrationCheckpointID(executionID string) (string, bool) {
	executionID = strings.TrimSpace(executionID)
	if executionID == "" {
		return "", false
	}
	return executionID + ":checkpoint:migration", true
}

func RunSettlementCheckpointID(executionID string, runID string) (string, bool) {
	executionID = strings.TrimSpace(executionID)
	runID = strings.TrimSpace(runID)
	if executionID == "" || runID == "" {
		return "", false
	}
	return executionID + ":checkpoint:run:" + runID, true
}

func AllTasksTerminalCheckpointID(executionID string) (string, bool) {
	executionID = strings.TrimSpace(executionID)
	if executionID == "" {
		return "", false
	}
	return executionID + ":checkpoint:all-tasks-terminal", true
}

func WatchdogCheckpointID(executionID string, sequence int64) (string, bool) {
	executionID = strings.TrimSpace(executionID)
	if executionID == "" || sequence < 1 {
		return "", false
	}
	return executionID + ":checkpoint:watchdog:" + fmt.Sprintf("%d", sequence), true
}

func MainWakeID(checkpointID string, sequence int64) (string, bool) {
	checkpointID = strings.TrimSpace(checkpointID)
	if checkpointID == "" || sequence < 1 {
		return "", false
	}
	return checkpointID + ":wake:main:" + fmt.Sprintf("%d", sequence), true
}

func MainWakeClientSubmitID(wakeID string) (string, bool) {
	wakeID = strings.TrimSpace(wakeID)
	if wakeID == "" {
		return "", false
	}
	return "tutti-execution-wake:" + wakeID, true
}

func GoalReviewID(checkpointID string) (string, bool) {
	checkpointID = strings.TrimSpace(checkpointID)
	if checkpointID == "" {
		return "", false
	}
	return checkpointID + ":goal-review:1", true
}

func GoalReviewSessionID(reviewID string) (string, bool) {
	reviewID = strings.TrimSpace(reviewID)
	if reviewID == "" {
		return "", false
	}
	return reviewID + ":session", true
}

func GoalReviewClientSubmitID(reviewID string) (string, bool) {
	reviewID = strings.TrimSpace(reviewID)
	if reviewID == "" {
		return "", false
	}
	return "tutti-goal-review:" + reviewID, true
}
func NewInitialAggregate(
	workspaceID string,
	issueID string,
	workflowID string,
	sourceSessionID string,
	now time.Time,
	reviewConfigurations ...ReviewConfiguration,
) (Aggregate, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	issueID = strings.TrimSpace(issueID)
	workflowID = strings.TrimSpace(workflowID)
	sourceSessionID = strings.TrimSpace(sourceSessionID)
	now = now.UTC()
	executionID, executionOK := ExecutionID(issueID)
	checkpointID, checkpointOK := InitialCheckpointID(executionID)
	if workspaceID == "" || workflowID == "" || sourceSessionID == "" ||
		now.IsZero() || !executionOK || !checkpointOK {
		return Aggregate{}, ErrInvalidExecution
	}
	review := ReviewConfiguration{Mode: ReviewModeSelf}
	if len(reviewConfigurations) > 0 {
		review = reviewConfigurations[0]
	}
	review.Mode = ReviewMode(strings.ToLower(strings.TrimSpace(string(review.Mode))))
	review.AgentTargetID = strings.TrimSpace(review.AgentTargetID)
	if review.Mode == "" {
		review.Mode = ReviewModeSelf
	}
	if (review.Mode == ReviewModeSelf && review.AgentTargetID != "") ||
		(review.Mode == ReviewModeIndependent && review.AgentTargetID == "") ||
		(review.Mode != ReviewModeSelf && review.Mode != ReviewModeIndependent) {
		return Aggregate{}, ErrInvalidExecution
	}
	execution := Execution{
		ID:                         executionID,
		WorkspaceID:                workspaceID,
		IssueID:                    issueID,
		WorkflowID:                 workflowID,
		SourceSessionID:            sourceSessionID,
		Status:                     StatusAwaitingSchedule,
		GraphRevision:              1,
		ActiveCheckpointID:         checkpointID,
		LastOrchestratorActivityAt: now,
		WatchdogDueAt:              now.Add(WatchdogInterval),
		ReviewMode:                 review.Mode,
		ReviewAgentTargetID:        review.AgentTargetID,
		CreatedAt:                  now,
		UpdatedAt:                  now,
	}
	checkpoint := Checkpoint{
		ID:             checkpointID,
		ExecutionID:    executionID,
		Kind:           CheckpointKindInitialSchedule,
		Status:         CheckpointStatusActive,
		Sequence:       1,
		GraphRevision:  1,
		CreationReason: "accepted_plan_materialized",
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	aggregate := Aggregate{Execution: execution, Checkpoints: []Checkpoint{checkpoint}}
	if err := ValidateInitialAggregate(aggregate); err != nil {
		return Aggregate{}, err
	}
	return aggregate, nil
}

// ValidateInitialAggregate owns the execution-domain invariants for the inert
// state created when an accepted plan is materialized. Persistence adapters
// separately validate relations to their Issue and task rows.
func ValidateInitialAggregate(aggregate Aggregate) error {
	execution := aggregate.Execution
	expectedExecutionID, executionOK := ExecutionID(execution.IssueID)
	expectedCheckpointID, checkpointOK := InitialCheckpointID(expectedExecutionID)
	if strings.TrimSpace(execution.WorkspaceID) == "" ||
		strings.TrimSpace(execution.WorkflowID) == "" ||
		strings.TrimSpace(execution.SourceSessionID) == "" ||
		!executionOK || !checkpointOK ||
		execution.ID != expectedExecutionID ||
		execution.Status != StatusAwaitingSchedule ||
		execution.GraphRevision != 1 ||
		((execution.ReviewMode == ReviewModeSelf && execution.ReviewAgentTargetID != "") ||
			(execution.ReviewMode == ReviewModeIndependent && strings.TrimSpace(execution.ReviewAgentTargetID) == "") ||
			(execution.ReviewMode != ReviewModeSelf && execution.ReviewMode != ReviewModeIndependent)) ||
		len(aggregate.Checkpoints) != 1 {
		return ErrInvalidExecution
	}
	checkpoint := aggregate.Checkpoints[0]
	if checkpoint.ExecutionID != execution.ID ||
		checkpoint.ID != expectedCheckpointID ||
		checkpoint.ID != execution.ActiveCheckpointID ||
		checkpoint.Kind != CheckpointKindInitialSchedule ||
		checkpoint.Status != CheckpointStatusActive ||
		checkpoint.Sequence != 1 ||
		checkpoint.GraphRevision != execution.GraphRevision {
		return ErrInvalidExecution
	}
	return nil
}

func IsStatus(value Status) bool {
	switch value {
	case StatusAwaitingSchedule, StatusRunning, StatusAwaitingMain,
		StatusPendingGoalReview, StatusOrphanedSource, StatusCompleted,
		StatusArchiving, StatusArchived:
		return true
	default:
		return false
	}
}

func IsCheckpointKind(value CheckpointKind) bool {
	switch value {
	case CheckpointKindInitialSchedule, CheckpointKindTaskSettled,
		CheckpointKindTaskFailed, CheckpointKindTaskCanceled,
		CheckpointKindWatchdog, CheckpointKindAllTasksTerminal,
		CheckpointKindMigration:
		return true
	default:
		return false
	}
}

func IsCheckpointStatus(value CheckpointStatus) bool {
	switch value {
	case CheckpointStatusPending, CheckpointStatusActive,
		CheckpointStatusResolved, CheckpointStatusSuperseded,
		CheckpointStatusCanceled:
		return true
	default:
		return false
	}
}

func IsReviewMode(value ReviewMode) bool {
	return value == ReviewModeSelf || value == ReviewModeIndependent
}
