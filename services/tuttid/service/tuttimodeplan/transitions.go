package tuttimodeplan

import (
	"fmt"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
)

func validateRevisionPhase(checkpoint workflowbiz.WorkflowCheckpoint, phase PlanPhase) error {
	switch checkpoint.Kind {
	case workflowbiz.CheckpointKindConfigurationReview:
		// Legacy two-phase workflows may still advance an accepted
		// configuration to the complete task-graph document. New
		// configuration-phase revisions are retired.
		if checkpoint.Status == workflowbiz.CheckpointStatusAccepted && phase == PhaseTaskGraph {
			return nil
		}
	case workflowbiz.CheckpointKindTaskReview:
		if checkpoint.Status == workflowbiz.CheckpointStatusPending || checkpoint.Status == workflowbiz.CheckpointStatusRejected || checkpoint.Status == workflowbiz.CheckpointStatusSuperseded {
			if phase == PhaseTaskGraph {
				return nil
			}
		}
	}
	return fmt.Errorf("%w: %s checkpoint in %s cannot accept %s", ErrInvalidTransition, checkpoint.Kind, checkpoint.Status, phase)
}

func checkpointKindForPhase(phase PlanPhase) workflowbiz.CheckpointKind {
	if phase == PhaseTaskGraph {
		return workflowbiz.CheckpointKindTaskReview
	}
	return workflowbiz.CheckpointKindConfigurationReview
}

func checkpointForRevision(checkpoints []workflowbiz.WorkflowCheckpoint, revisionID string) (workflowbiz.WorkflowCheckpoint, bool) {
	for index := len(checkpoints) - 1; index >= 0; index-- {
		if checkpoints[index].RevisionID == revisionID {
			return checkpoints[index], true
		}
	}
	return workflowbiz.WorkflowCheckpoint{}, false
}

func checkpointByID(checkpoints []workflowbiz.WorkflowCheckpoint, checkpointID string) (workflowbiz.WorkflowCheckpoint, bool) {
	for _, checkpoint := range checkpoints {
		if checkpoint.ID == checkpointID {
			return checkpoint, true
		}
	}
	return workflowbiz.WorkflowCheckpoint{}, false
}

func nextRevisionSequence(revisions []workflowbiz.PlanRevision) int {
	sequence := 0
	for _, revision := range revisions {
		if revision.Sequence > sequence {
			sequence = revision.Sequence
		}
	}
	return sequence + 1
}

func isTerminalWorkflow(status workflowbiz.WorkflowStatus) bool {
	switch status {
	case workflowbiz.WorkflowStatusAccepted,
		workflowbiz.WorkflowStatusCompleted,
		workflowbiz.WorkflowStatusFailed,
		workflowbiz.WorkflowStatusCanceled:
		return true
	default:
		return false
	}
}

func decisionTransition(kind workflowbiz.CheckpointKind, decision workflowbiz.CheckpointStatus) (NextAction, workflowbiz.WorkflowStatus, workflowbiz.OperationKind, error) {
	if decision == workflowbiz.CheckpointStatusCanceled {
		return NextActionCanceled, workflowbiz.WorkflowStatusCanceled, "", nil
	}
	switch kind {
	case workflowbiz.CheckpointKindConfigurationReview:
		// The two-phase configuration review is retired. Legacy pending
		// checkpoints can only be canceled; historical accepted/rejected rows
		// keep replaying their durable transition for idempotent reads.
		switch decision {
		case workflowbiz.CheckpointStatusAccepted:
			return NextActionGenerateTaskGraph, workflowbiz.WorkflowStatusInProgress, workflowbiz.OperationKindGenerateTaskGraph, nil
		case workflowbiz.CheckpointStatusRejected:
			return NextActionReviseConfiguration, workflowbiz.WorkflowStatusInProgress, workflowbiz.OperationKindCreateRevision, nil
		}
	case workflowbiz.CheckpointKindTaskReview:
		switch decision {
		case workflowbiz.CheckpointStatusAccepted:
			return NextActionCreateIssue, workflowbiz.WorkflowStatusAccepted, workflowbiz.OperationKindCreateIssue, nil
		case workflowbiz.CheckpointStatusRejected:
			return NextActionReviseTaskGraph, workflowbiz.WorkflowStatusInProgress, workflowbiz.OperationKindCreateRevision, nil
		}
	}
	return "", "", "", fmt.Errorf("%w: %s checkpoint cannot transition to %s", ErrInvalidDecision, kind, decision)
}
