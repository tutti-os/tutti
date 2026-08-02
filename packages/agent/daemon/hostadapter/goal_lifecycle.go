package hostadapter

import (
	"context"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
)

type goalControlLifecycleBackend interface {
	SetGoalControlLifecycleObserver(agentruntime.GoalControlLifecycleObserver)
}

type goalControlLifecycleObserver struct {
	sink host.RuntimeGoalControlAppliedSink
}

func (o goalControlLifecycleObserver) ObserveGoalControlApplied(
	ctx context.Context,
	observation agentruntime.GoalControlAppliedObservation,
) (agentruntime.GoalControlAppliedObservationResult, error) {
	if o.sink == nil {
		return agentruntime.GoalControlAppliedObservationResult{}, nil
	}
	result, err := o.sink(ctx, host.RuntimeGoalControlAppliedInput{
		WorkspaceID: observation.WorkspaceID, AgentSessionID: observation.AgentSessionID,
		OperationID: observation.OperationID, GoalRevision: observation.Revision,
		RepairEpoch: observation.RepairEpoch, Action: observation.Action,
		ProviderTurnID: observation.ProviderTurnID, Observed: observation.Observed,
		OccurredAtUnixMS: observation.OccurredAtUnixMS,
	})
	return agentruntime.GoalControlAppliedObservationResult{Accepted: result.Accepted}, err
}

func (a *RuntimeController) SetGoalControlAppliedSink(sink host.RuntimeGoalControlAppliedSink) {
	if a == nil {
		return
	}
	backend, ok := a.Backend.(goalControlLifecycleBackend)
	if !ok {
		return
	}
	backend.SetGoalControlLifecycleObserver(goalControlLifecycleObserver{sink: sink})
}
