package hostadapter

import (
	"context"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
)

type sideConversationRuntimeBackend interface {
	SideCapabilities(context.Context, string, string) (agentruntime.SideConversationCapabilities, error)
	OpenSide(context.Context, agentruntime.SideConversationOpenInput) (agentruntime.SideConversationOpenResult, error)
}

func (a *RuntimeController) ResolveSideConversation(
	ctx context.Context,
	source host.ProviderRuntimeSession,
) (host.SideConversationCapabilities, error) {
	if err := a.requireBackend(); err != nil {
		return host.SideConversationCapabilities{}, err
	}
	backend, ok := a.Backend.(sideConversationRuntimeBackend)
	if !ok {
		return host.SideConversationCapabilities{}, nil
	}
	capabilities, err := backend.SideCapabilities(
		ctx, source.WorkspaceID, source.ID,
	)
	return hostSideCapabilities(capabilities), mapRuntimeError(err)
}

func (a *RuntimeController) OpenSideConversation(
	ctx context.Context,
	input host.RuntimeOpenSideConversationInput,
) (host.OpenSideConversationResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.OpenSideConversationResult{}, err
	}
	backend, ok := a.Backend.(sideConversationRuntimeBackend)
	if !ok {
		return host.OpenSideConversationResult{}, host.ErrSideConversationUnsupported
	}
	result, err := backend.OpenSide(
		ctx,
		agentruntime.SideConversationOpenInput{
			RoomID:               input.Source.WorkspaceID,
			SourceAgentSessionID: input.Source.ID,
			SideAgentSessionID:   input.SideAgentSessionID,
			RequestID:            input.RequestID,
		},
	)
	if err != nil {
		return host.OpenSideConversationResult{}, mapRuntimeError(err)
	}
	return host.OpenSideConversationResult{
		Session:      a.sessionWithState(result.Session),
		Capabilities: hostSideCapabilities(result.Capabilities),
	}, nil
}

func hostSideCapabilities(
	capabilities agentruntime.SideConversationCapabilities,
) host.SideConversationCapabilities {
	return host.SideConversationCapabilities{
		Supported:             capabilities.Supported,
		ActiveSourceTurn:      capabilities.ActiveSourceTurn,
		Ephemeral:             capabilities.Ephemeral,
		HideInheritedTurns:    capabilities.HideInheritedTurns,
		ModelBoundaryInjected: capabilities.ModelBoundaryInjected,
	}
}
