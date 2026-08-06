package hostadapter

import (
	"context"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
)

type contextRecoveryBackend interface {
	PrepareContextRecovery(
		context.Context,
		agentruntime.PrepareContextRecoveryInput,
	) (agentruntime.PrepareContextRecoveryResult, error)
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
