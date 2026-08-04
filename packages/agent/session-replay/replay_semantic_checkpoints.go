package sessionreplay

import (
	"context"
	"errors"
	"fmt"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

type SemanticCheckpointState struct {
	TriggerMatched                  bool
	ReadinessSatisfied              bool
	CanonicalSessionUpdatedAtUnixMS int64
	CanonicalMessageVersion         uint64
}

type semanticObservationState struct {
	projector checkpointRecorder
	matched   map[int]bool
	handled   map[string]ProviderUnitPosition
	failure   error
}

func newSemanticObservationState(
	plan CheckpointPlan,
	rootSessionID string,
	initialState []byte,
) *semanticObservationState {
	state := &semanticObservationState{
		matched: make(map[int]bool),
		handled: make(map[string]ProviderUnitPosition),
	}
	state.projector.reset(Recording{
		ID:                 "semantic-replay",
		RootAgentSessionID: rootSessionID,
	})
	if err := state.projector.entities.seedInitialState(
		initialState,
	); err != nil {
		state.failure = err
	}
	state.projector.plan = plan
	return state
}

func (r *SemanticRuntime) VerifyCheckpoint(
	ctx context.Context,
	cassetteID string,
	checkpointIndex int,
) (SemanticCheckpointState, error) {
	if r == nil {
		return SemanticCheckpointState{},
			fmt.Errorf("agent session replay semantic runtime is unavailable")
	}
	cassetteID = strings.TrimSpace(cassetteID)
	plan, ok := r.plans[cassetteID]
	if !ok || checkpointIndex < 0 || checkpointIndex >= len(plan.Checkpoints) {
		return SemanticCheckpointState{},
			fmt.Errorf("checkpoint_plan_invalid: checkpoint %d", checkpointIndex)
	}
	checkpoint := plan.Checkpoints[checkpointIndex]
	if err := r.flushPendingObservationBatches(ctx, cassetteID); err != nil {
		return SemanticCheckpointState{}, err
	}
	r.mu.Lock()
	observation := r.observations[cassetteID]
	triggerMatched := checkpoint.Trigger.Source !=
		CheckpointTriggerProviderObservation
	if observation != nil {
		if observation.failure != nil {
			err := observation.failure
			r.mu.Unlock()
			return SemanticCheckpointState{}, err
		}
		triggerMatched = triggerMatched || observation.matched[checkpointIndex]
		if !triggerMatched && providerPositionPassed(
			observation.handled,
			checkpoint.Trigger.Position,
		) {
			r.mu.Unlock()
			return SemanticCheckpointState{}, fmt.Errorf(
				"checkpoint_trigger_out_of_order: checkpoint %q",
				checkpoint.ID,
			)
		}
		// The input barrier parks after completing the trigger unit. When the
		// observation stamp for that unit was lost, matched stays false, but
		// the handled lane (fed from transport completion) still reaches the
		// trigger position. Treat that as triggerMatched so readiness can
		// close against canonical state instead of deadlocking the barrier.
		if !triggerMatched &&
			checkpoint.Trigger.Source ==
				CheckpointTriggerProviderObservation &&
			providerPositionReached(
				observation.handled,
				checkpoint.Trigger.Position,
			) {
			triggerMatched = true
		}
	}
	r.mu.Unlock()
	if !triggerMatched {
		return SemanticCheckpointState{}, nil
	}
	if len(checkpoint.Readiness.All) == 0 {
		return SemanticCheckpointState{
			TriggerMatched:     true,
			ReadinessSatisfied: true,
		}, nil
	}
	canonical, err := r.host.GetSession(ctx, agenthost.SessionRef{
		WorkspaceID:    r.workspaceID,
		AgentSessionID: r.registrations[cassetteID].RootSessionID,
	})
	if err != nil {
		if errors.Is(err, agenthost.ErrSessionNotFound) {
			return SemanticCheckpointState{TriggerMatched: true}, nil
		}
		return SemanticCheckpointState{}, err
	}
	ready, err := r.checkpointReadinessSatisfied(
		ctx,
		cassetteID,
		checkpoint,
	)
	if err != nil {
		return SemanticCheckpointState{}, err
	}
	return SemanticCheckpointState{
		TriggerMatched:                  true,
		ReadinessSatisfied:              ready,
		CanonicalSessionUpdatedAtUnixMS: canonical.Canonical.UpdatedAtUnixMS,
		CanonicalMessageVersion:         canonical.Canonical.MessageVersion,
	}, nil
}
