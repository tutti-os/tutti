package hostadapter

import (
	"context"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
)

type contextRecoveryBackend interface {
	ContextRecoveryRequired(
		context.Context,
		agentruntime.PrepareContextRecoveryInput,
	) (bool, error)
	ResumeContextRecoveryRequired(
		context.Context,
		agentruntime.ResumeInput,
	) (bool, error)
	PrepareContextRecovery(
		context.Context,
		agentruntime.PrepareContextRecoveryInput,
	) (agentruntime.PrepareContextRecoveryResult, error)
}

func (a *RuntimeController) ContextRecoveryRequired(
	ctx context.Context,
	input host.RuntimeContextRecoveryInput,
) (bool, error) {
	if err := a.requireBackend(); err != nil {
		return false, err
	}
	backend, ok := a.Backend.(contextRecoveryBackend)
	if !ok {
		return false, nil
	}
	required, err := backend.ContextRecoveryRequired(
		ctx,
		agentruntime.PrepareContextRecoveryInput{
			RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		},
	)
	return required, mapRuntimeError(err)
}

func (a *RuntimeController) ResumeContextRecoveryRequired(
	ctx context.Context,
	input host.RuntimeResumeInput,
) (bool, error) {
	if err := a.requireBackend(); err != nil {
		return false, err
	}
	backend, ok := a.Backend.(contextRecoveryBackend)
	if !ok {
		return false, nil
	}
	required, err := backend.ResumeContextRecoveryRequired(ctx, runtimeResumeInput(input))
	return required, mapRuntimeError(err)
}

func (a *RuntimeController) PrepareContextRecovery(
	ctx context.Context,
	input host.RuntimeContextRecoveryInput,
) (host.RuntimeContextRecoveryResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeContextRecoveryResult{}, err
	}
	backend, ok := a.Backend.(contextRecoveryBackend)
	if !ok {
		return host.RuntimeContextRecoveryResult{}, nil
	}
	result, err := backend.PrepareContextRecovery(
		ctx,
		agentruntime.PrepareContextRecoveryInput{
			RoomID:         input.WorkspaceID,
			AgentSessionID: input.AgentSessionID,
			ActiveGoal:     runtimeContextRecoveryGoal(input.ActiveGoal),
		},
	)
	if err != nil {
		return host.RuntimeContextRecoveryResult{}, mapRuntimeError(err)
	}
	return host.RuntimeContextRecoveryResult{
		Session:   a.sessionWithState(result.Session),
		Recovered: result.Recovered,
	}, nil
}

func runtimeContextRecoveryGoal(
	goal *host.RuntimeContextRecoveryGoal,
) *agentruntime.ContextRecoveryGoal {
	if goal == nil {
		return nil
	}
	return &agentruntime.ContextRecoveryGoal{
		Objective: goal.Objective, OperationID: goal.OperationID,
		Revision: goal.Revision, RepairEpoch: goal.RepairEpoch,
	}
}
