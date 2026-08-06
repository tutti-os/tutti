package hostadapter

import (
	"context"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
)

var _ host.RuntimeTurnCapabilityPort = (*RuntimeController)(nil)

type codexTurnCapabilityBackend interface {
	EnsureCodexTurnCapability(context.Context, agentruntime.CodexTurnCapabilityInput) (agentruntime.PromptContentBlock, error)
}

func (a *RuntimeController) EnsureTurnCapability(ctx context.Context, input host.RuntimeTurnCapabilityInput) (host.RuntimeTurnCapabilityResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeTurnCapabilityResult{}, err
	}
	backend, ok := a.Backend.(codexTurnCapabilityBackend)
	if !ok {
		return host.RuntimeTurnCapabilityResult{}, host.ErrTurnCapabilityUnsupported
	}
	block, err := backend.EnsureCodexTurnCapability(ctx, agentruntime.CodexTurnCapabilityInput{
		RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		TurnID: input.TurnID, ClientSubmitID: input.ClientSubmitID,
		Semantic: input.Invocation.Semantic,
	})
	if err != nil {
		return host.RuntimeTurnCapabilityResult{}, mapRuntimeError(err)
	}
	return host.RuntimeTurnCapabilityResult{PromptAugmentation: []host.PromptContentBlock{{
		Type: block.Type, Name: block.Name, Path: block.Path,
	}}}, nil
}
