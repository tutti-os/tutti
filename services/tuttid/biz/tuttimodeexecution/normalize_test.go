package tuttimodeexecution

import (
	"errors"
	"testing"
	"time"
)

func TestValidateInitialAggregateOwnsInitialExecutionInvariants(t *testing.T) {
	t.Parallel()

	aggregate, err := NewInitialAggregate(
		"workspace-1",
		"tutti-mode-plan-workflow-1",
		"workflow-1",
		"session-1",
		time.UnixMilli(1_700_000_000_000).UTC(),
	)
	if err != nil {
		t.Fatalf("NewInitialAggregate() error = %v", err)
	}
	if err := ValidateInitialAggregate(aggregate); err != nil {
		t.Fatalf("ValidateInitialAggregate(valid) error = %v", err)
	}

	tests := map[string]func(*Aggregate){
		"execution identity": func(candidate *Aggregate) {
			candidate.Execution.ID = "another-execution"
		},
		"status": func(candidate *Aggregate) {
			candidate.Execution.Status = StatusRunning
		},
		"graph revision": func(candidate *Aggregate) {
			candidate.Execution.GraphRevision = 2
		},
		"review mode": func(candidate *Aggregate) {
			candidate.Execution.ReviewMode = ReviewModeIndependent
		},
		"active checkpoint": func(candidate *Aggregate) {
			candidate.Execution.ActiveCheckpointID = "another-checkpoint"
		},
		"checkpoint identity": func(candidate *Aggregate) {
			candidate.Checkpoints[0].ID = "another-checkpoint"
		},
		"checkpoint execution": func(candidate *Aggregate) {
			candidate.Checkpoints[0].ExecutionID = "another-execution"
		},
		"checkpoint kind": func(candidate *Aggregate) {
			candidate.Checkpoints[0].Kind = CheckpointKindWatchdog
		},
		"checkpoint status": func(candidate *Aggregate) {
			candidate.Checkpoints[0].Status = CheckpointStatusPending
		},
		"checkpoint sequence": func(candidate *Aggregate) {
			candidate.Checkpoints[0].Sequence = 2
		},
		"checkpoint graph revision": func(candidate *Aggregate) {
			candidate.Checkpoints[0].GraphRevision = 2
		},
		"checkpoint count": func(candidate *Aggregate) {
			candidate.Checkpoints = nil
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			candidate := aggregate
			candidate.Checkpoints = append([]Checkpoint(nil), aggregate.Checkpoints...)
			mutate(&candidate)
			if err := ValidateInitialAggregate(candidate); !errors.Is(err, ErrInvalidExecution) {
				t.Fatalf("ValidateInitialAggregate() error = %v, want ErrInvalidExecution", err)
			}
		})
	}
}
