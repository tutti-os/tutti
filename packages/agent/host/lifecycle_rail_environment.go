package agenthost

import "context"

func runtimeSessionInitializationForCreate(
	session ProviderRuntimeSession,
	input CreateSessionInput,
) RuntimeSessionInitialization {
	return RuntimeSessionInitialization{
		Session:                    session,
		RailPlacement:              input.RailPlacement,
		RailPlacementAuthoritative: input.RailPlacementAuthoritative,
	}
}

func (h *Host) resolveCreateRuntimeRailEnvironment(
	ctx context.Context,
	workspaceID string,
	input CreateSessionInput,
	prepared PreparedRuntime,
) (*RailPlacement, []string, error) {
	if h == nil || h.runtimeRailPlacement == nil {
		return nil, nil, ErrRuntimeRailPlacementUnavailable
	}
	placement, err := h.runtimeRailPlacement.ResolveRuntimeSessionRailPlacement(ctx, ResolveRuntimeSessionRailPlacementInput{
		WorkspaceID:                workspaceID,
		AgentSessionID:             input.AgentSessionID,
		Cwd:                        prepared.Cwd,
		RuntimeContext:             cloneMap(input.RuntimeContext),
		RailPlacement:              input.RailPlacement,
		RailPlacementAuthoritative: input.RailPlacementAuthoritative,
	})
	if err != nil {
		return nil, nil, err
	}
	env, err := withAgentRailPlacementEnvironment(prepared.Env, prepared.Cwd, placement)
	if err != nil {
		return nil, nil, err
	}
	return placement, env, nil
}
