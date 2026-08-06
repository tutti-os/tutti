package agenthost

import (
	"context"
	"strings"
)

// TurnCapabilityInvocation is a provider-neutral request to prepare exactly
// one capability for the Turn being submitted. It is separate from
// CapabilityRefs, which only record provenance after submission.
type TurnCapabilityInvocation struct {
	Semantic string
}

// RuntimeTurnCapabilityInput binds capability preparation to the Host-owned
// submit identity. The runtime must not infer an active Turn from process
// state, and it must never dispatch a provider turn itself.
type RuntimeTurnCapabilityInput struct {
	WorkspaceID    string
	AgentSessionID string
	TurnID         string
	ClientSubmitID string
	Session        ProviderRuntimeSession
	Invocation     TurnCapabilityInvocation
}

// RuntimeTurnCapabilityResult may contribute exactly one structured mention
// to the ordinary Turn. Empty content is never a successful capability result.
type RuntimeTurnCapabilityResult struct {
	PromptAugmentation []PromptContentBlock
}

func (h *Host) ensureTurnCapability(
	ctx context.Context,
	ref SessionRef,
	session ProviderRuntimeSession,
	turnID, clientSubmitID string,
	invocation *TurnCapabilityInvocation,
) ([]PromptContentBlock, error) {
	if invocation == nil {
		return nil, nil
	}
	if h == nil || h.turnCapabilities == nil || strings.TrimSpace(turnID) == "" || strings.TrimSpace(clientSubmitID) == "" {
		return nil, ErrTurnCapabilityUnsupported
	}
	semantic := strings.TrimSpace(invocation.Semantic)
	if semantic == "" {
		return nil, ErrInvalidArgument
	}
	result, err := h.turnCapabilities.EnsureTurnCapability(ctx, RuntimeTurnCapabilityInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		TurnID: turnID, ClientSubmitID: clientSubmitID, Session: session,
		Invocation: TurnCapabilityInvocation{Semantic: semantic},
	})
	if err != nil {
		return nil, err
	}
	if len(result.PromptAugmentation) != 1 {
		return nil, ErrTurnCapabilityUnavailable
	}
	block := result.PromptAugmentation[0]
	if strings.TrimSpace(block.Type) != "mention" || strings.TrimSpace(block.Name) == "" || strings.TrimSpace(block.Path) == "" {
		return nil, ErrTurnCapabilityUnavailable
	}
	return []PromptContentBlock{{Type: "mention", Name: strings.TrimSpace(block.Name), Path: strings.TrimSpace(block.Path)}}, nil
}

func mergeTurnCapabilityPromptContent(base, augmentation []PromptContentBlock) ([]PromptContentBlock, string, error) {
	if len(augmentation) == 0 {
		return normalizePromptContent(base)
	}
	if len(augmentation) != 1 || strings.TrimSpace(augmentation[0].Type) != "mention" ||
		strings.TrimSpace(augmentation[0].Name) == "" || strings.TrimSpace(augmentation[0].Path) == "" {
		return nil, "", ErrTurnCapabilityUnavailable
	}
	merged := make([]PromptContentBlock, 0, len(base)+1)
	merged = append(merged, base...)
	merged = append(merged, augmentation...)
	return normalizePromptContent(merged)
}
