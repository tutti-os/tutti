package agenthost

import (
	"context"
	"errors"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func (h *Host) GetSessionForkCapabilities(
	ctx context.Context,
	input SessionForkCapabilityInput,
) (SessionForkCapabilities, error) {
	normalizeSessionForkCapabilityInput(&input)
	if h == nil || h.sessionForks == nil || h.sessionForkRuntime == nil ||
		input.WorkspaceID == "" || input.SourceAgentSessionID == "" {
		return SessionForkCapabilities{}, nil
	}
	sourceSession, found, err := h.sessionForks.GetSessionForkSource(
		ctx, input.WorkspaceID, input.SourceAgentSessionID,
	)
	if err != nil || !found {
		return SessionForkCapabilities{}, err
	}
	runtimeSource, err := h.sessionForkRuntimeSource(ctx, sourceSession)
	if err != nil {
		return SessionForkCapabilities{}, err
	}
	if _, err := h.prepareSessionForkTargetContext(
		ctx, sourceSession, runtimeSource,
	); err != nil {
		if errors.Is(err, ErrSessionForkUnsupported) {
			return SessionForkCapabilities{}, nil
		}
		return SessionForkCapabilities{}, err
	}
	if strings.TrimSpace(runtimeSource.ProviderSessionID) !=
		strings.TrimSpace(sourceSession.ProviderSessionID) {
		return SessionForkCapabilities{}, nil
	}
	descriptor, err := h.sessionForkRuntime.ResolveSessionFork(
		ctx,
		cloneSessionForkRuntimeSource(runtimeSource),
	)
	if err != nil {
		return SessionForkCapabilities{}, err
	}
	normalizeSessionForkDriverDescriptor(&descriptor)
	capabilities := SessionForkCapabilities{
		FullSession: descriptor.FullSession &&
			descriptor.Kind != "" &&
			descriptor.Version != "" &&
			validSessionForkStateBindingMode(
				descriptor.StateBindingMode,
				h.sessionForkState,
				runtimeSource.Provider,
			),
		ThroughTurn: descriptor.ThroughTurn &&
			descriptor.Kind != "" &&
			descriptor.Version != "" &&
			validSessionForkStateBindingMode(
				descriptor.StateBindingMode,
				h.sessionForkState,
				runtimeSource.Provider,
			),
	}
	if !capabilities.ThroughTurn ||
		!descriptor.ThroughProviderTurnIDsKnown {
		return capabilities, nil
	}
	capabilities.ThroughTurnIDsKnown = true
	identities, err := h.sessionForks.ListSessionForkTurnIdentities(
		ctx,
		input.WorkspaceID,
		input.SourceAgentSessionID,
	)
	if err != nil {
		return SessionForkCapabilities{}, err
	}
	capabilities.ThroughTurnIDs = matchingSessionForkTurnPrefix(
		identities,
		descriptor.ThroughProviderTurnIDs,
	)
	capabilities.ThroughTurn = len(capabilities.ThroughTurnIDs) != 0
	return capabilities, nil
}

func matchingSessionForkTurnPrefix(
	identities []storesqlite.SessionForkTurnIdentity,
	providerTurnIDs []string,
) []string {
	matched := make([]string, 0, min(len(identities), len(providerTurnIDs)))
	for index, identity := range identities {
		if index >= len(providerTurnIDs) ||
			identity.Phase != storesqlite.TurnPhaseSettled ||
			strings.TrimSpace(identity.TurnID) == "" ||
			strings.TrimSpace(identity.ProviderTurnID) == "" ||
			strings.TrimSpace(identity.ProviderTurnID) != providerTurnIDs[index] {
			break
		}
		matched = append(matched, strings.TrimSpace(identity.TurnID))
	}
	return matched
}

func normalizeSessionForkDriverDescriptor(input *SessionForkDriverDescriptor) {
	input.Kind = strings.TrimSpace(input.Kind)
	input.Version = strings.TrimSpace(input.Version)
	if input.StateBindingMode == "" {
		input.StateBindingMode = SessionForkStateBindingHostCopy
	}
	if !input.ThroughProviderTurnIDsKnown {
		input.ThroughProviderTurnIDs = nil
		return
	}
	normalized := make([]string, 0, len(input.ThroughProviderTurnIDs))
	seen := make(map[string]struct{}, len(input.ThroughProviderTurnIDs))
	for _, rawTurnID := range input.ThroughProviderTurnIDs {
		turnID := strings.TrimSpace(rawTurnID)
		if turnID == "" {
			input.ThroughProviderTurnIDs = nil
			return
		}
		if _, duplicate := seen[turnID]; duplicate {
			input.ThroughProviderTurnIDs = nil
			return
		}
		seen[turnID] = struct{}{}
		normalized = append(normalized, turnID)
	}
	input.ThroughProviderTurnIDs = normalized
}

func validSessionForkStateBindingMode(
	mode SessionForkStateBindingMode,
	hostBinder SessionForkProviderStateBinder,
	provider string,
) bool {
	switch mode {
	case SessionForkStateBindingHostCopy:
		return hostBinder != nil &&
			hostBinder.SupportsSessionForkProviderStateBinding(provider)
	case SessionForkStateBindingProviderOwned:
		return true
	default:
		return false
	}
}
