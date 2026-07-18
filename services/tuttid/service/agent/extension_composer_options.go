package agent

import (
	"context"
	"strings"
)

func (s *Service) extensionComposerPermissionConfig(
	ctx context.Context,
	providerTargetRef map[string]any,
	selected string,
) (PermissionConfig, error) {
	resolver := s.ExtensionComposerProfiles
	installationID := strings.TrimSpace(stringFromAny(providerTargetRef["extensionInstallationId"]))
	if resolver == nil || installationID == "" {
		return PermissionConfig{}, nil
	}
	profile, err := resolver.ResolveExtensionComposerProfile(ctx, installationID)
	if err != nil {
		return PermissionConfig{}, err
	}
	modes := make([]PermissionModeOption, 0, len(profile.PermissionModes))
	for _, declaration := range profile.PermissionModes {
		runtimeID := strings.TrimSpace(declaration.RuntimeID)
		if runtimeID == "" {
			continue
		}
		modes = append(modes, PermissionModeOption{
			ID:       runtimeID,
			Label:    runtimeID,
			Semantic: normalizeExtensionPermissionModeSemantic(declaration.Semantic),
		})
	}
	return PermissionConfig{
		Configurable: len(modes) > 0,
		DefaultValue: strings.TrimSpace(selected),
		Modes:        modes,
	}, nil
}

func normalizeExtensionPermissionModeSemantic(semantic PermissionModeSemantic) PermissionModeSemantic {
	switch PermissionModeSemantic(strings.TrimSpace(string(semantic))) {
	case PermissionModeSemanticAskBeforeWrite:
		return PermissionModeSemanticAskBeforeWrite
	case PermissionModeSemanticAcceptEdits:
		return PermissionModeSemanticAcceptEdits
	case PermissionModeSemanticFullAccess:
		return PermissionModeSemanticFullAccess
	case PermissionModeSemanticLockedDown, "read-only":
		return PermissionModeSemanticLockedDown
	default:
		return PermissionModeSemanticAuto
	}
}
