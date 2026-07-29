package agent

import (
	"fmt"
	"slices"
	"strings"
)

// UnsupportedPermissionModeIDError reports a caller-provided permission ID
// that is not part of the current Composer Options contract. Callers must
// refresh Composer Options and round-trip an advertised ID verbatim; semantic
// labels are not substitutes for runtime-owned IDs.
type UnsupportedPermissionModeIDError struct {
	AgentTargetID              string
	PermissionModeID           string
	AvailablePermissionModeIDs []string
}

func (e *UnsupportedPermissionModeIDError) Error() string {
	if e == nil {
		return "unsupported permission mode id"
	}
	target := strings.TrimSpace(e.AgentTargetID)
	if target == "" {
		target = "agent target"
	}
	available := strings.Join(e.AvailablePermissionModeIDs, ", ")
	if available == "" {
		available = "none"
	}
	return fmt.Sprintf(
		"permission mode %q is not supported by %s; refresh Composer Options and use one of its IDs: %s",
		strings.TrimSpace(e.PermissionModeID),
		target,
		available,
	)
}

func (*UnsupportedPermissionModeIDError) Unwrap() error {
	return ErrInvalidArgument
}

type extensionPermissionRuntimeState struct {
	CurrentRuntimeID string
	Options          []ComposerConfigOptionValue
}

type extensionPermissionProjectionInput struct {
	AgentTargetID string
	FallbackID    string
	Locale        string
	Profile       ExtensionComposerProfile
	Provider      string
	Runtime       *extensionPermissionRuntimeState
	SelectedID    string
}

type extensionPermissionProjectionDiagnostic struct {
	Reason    string
	RuntimeID string
}

type extensionPermissionProjection struct {
	Config      PermissionConfig
	CurrentID   string
	Diagnostics []extensionPermissionProjectionDiagnostic
}

type extensionPermissionDeclaration struct {
	PublicID  string
	RuntimeID string
	Semantic  PermissionModeSemantic
}

// projectExtensionPermissionConfig is the single extension permission
// projection boundary. The signed Composer profile owns the launchable mode
// set and ID policy. Runtime config options may enrich current state and
// presentation, but never redefine or collapse the launch contract.
func projectExtensionPermissionConfig(input extensionPermissionProjectionInput) (extensionPermissionProjection, error) {
	policy := input.Profile.PermissionModeIDPolicy
	if policy == "" {
		// Profiles created before the explicit policy field used provider-owned
		// runtime IDs unless launchSettings.permission opted into semantic IDs.
		policy = ExtensionPermissionModeIDPolicyRuntime
	}
	if policy != ExtensionPermissionModeIDPolicyRuntime && policy != ExtensionPermissionModeIDPolicySemantic {
		return extensionPermissionProjection{}, fmt.Errorf("extension composer permission id policy %q is unsupported", policy)
	}

	declarations := make([]extensionPermissionDeclaration, 0, len(input.Profile.PermissionModes))
	byRuntimeID := make(map[string]extensionPermissionDeclaration, len(input.Profile.PermissionModes))
	seenRuntimeIDs := make(map[string]string, len(input.Profile.PermissionModes))
	publicIDs := make(map[string]struct{}, len(input.Profile.PermissionModes))
	for _, mode := range input.Profile.PermissionModes {
		runtimeID := strings.TrimSpace(mode.RuntimeID)
		if runtimeID == "" {
			return extensionPermissionProjection{}, fmt.Errorf("extension composer permission runtime id is required")
		}
		normalizedRuntimeID := strings.ToLower(runtimeID)
		if existing, duplicate := seenRuntimeIDs[normalizedRuntimeID]; duplicate {
			return extensionPermissionProjection{}, fmt.Errorf(
				"extension composer permission runtime id %q conflicts with %q; runtime ids must be unique ignoring case",
				runtimeID,
				existing,
			)
		}
		seenRuntimeIDs[normalizedRuntimeID] = runtimeID
		semantic, supported := normalizeExtensionPermissionModeSemantic(mode.Semantic)
		if !supported {
			return extensionPermissionProjection{}, fmt.Errorf(
				"extension composer permission runtime id %q has unsupported semantic %q",
				runtimeID,
				strings.TrimSpace(string(mode.Semantic)),
			)
		}
		publicID := runtimeID
		if policy == ExtensionPermissionModeIDPolicySemantic {
			publicID = string(semantic)
		}
		if _, duplicate := publicIDs[publicID]; duplicate {
			return extensionPermissionProjection{}, fmt.Errorf("extension composer permission id %q must be unique", publicID)
		}
		declaration := extensionPermissionDeclaration{
			PublicID:  publicID,
			RuntimeID: runtimeID,
			Semantic:  semantic,
		}
		declarations = append(declarations, declaration)
		byRuntimeID[runtimeID] = declaration
		publicIDs[publicID] = struct{}{}
	}

	runtimePresentation := map[string]ComposerConfigOptionValue{}
	diagnostics := make([]extensionPermissionProjectionDiagnostic, 0)
	if input.Runtime != nil {
		for _, option := range input.Runtime.Options {
			runtimeID := strings.TrimSpace(option.Value)
			if runtimeID == "" {
				continue
			}
			if _, declared := byRuntimeID[runtimeID]; !declared {
				diagnostics = append(diagnostics, extensionPermissionProjectionDiagnostic{
					Reason:    "permission_runtime_option_undeclared",
					RuntimeID: runtimeID,
				})
				continue
			}
			if _, duplicate := runtimePresentation[runtimeID]; duplicate {
				diagnostics = append(diagnostics, extensionPermissionProjectionDiagnostic{
					Reason:    "permission_runtime_option_duplicate",
					RuntimeID: runtimeID,
				})
				continue
			}
			runtimePresentation[runtimeID] = option
		}
	}

	modes := make([]PermissionModeOption, 0, len(declarations))
	for _, declaration := range declarations {
		label, description := permissionModeDisplay(
			input.Provider,
			declaration.PublicID,
			declaration.Semantic,
			input.Locale,
		)
		if runtimeOption, ok := runtimePresentation[declaration.RuntimeID]; ok {
			if text := strings.TrimSpace(runtimeOption.Label); text != "" {
				label = text
			}
			if text := strings.TrimSpace(runtimeOption.Description); text != "" {
				description = text
			}
		}
		modes = append(modes, PermissionModeOption{
			Description: description,
			ID:          declaration.PublicID,
			Label:       label,
			Semantic:    declaration.Semantic,
		})
	}
	disambiguateExtensionPermissionLabels(modes, declarations)

	availableIDs := make([]string, 0, len(modes))
	for _, mode := range modes {
		availableIDs = append(availableIDs, mode.ID)
	}
	currentID := strings.TrimSpace(input.SelectedID)
	if currentID != "" {
		if _, supported := publicIDs[currentID]; !supported {
			return extensionPermissionProjection{}, &UnsupportedPermissionModeIDError{
				AgentTargetID:              strings.TrimSpace(input.AgentTargetID),
				PermissionModeID:           currentID,
				AvailablePermissionModeIDs: slices.Clone(availableIDs),
			}
		}
	} else if input.Runtime != nil {
		if declaration, ok := byRuntimeID[strings.TrimSpace(input.Runtime.CurrentRuntimeID)]; ok {
			currentID = declaration.PublicID
		}
	}
	if currentID == "" {
		fallbackID := strings.TrimSpace(input.FallbackID)
		if _, supported := publicIDs[fallbackID]; fallbackID != "" && supported {
			currentID = fallbackID
		} else if fallbackID != "" {
			diagnostics = append(diagnostics, extensionPermissionProjectionDiagnostic{
				Reason:    "permission_configured_default_unsupported",
				RuntimeID: fallbackID,
			})
		}
	}
	if currentID == "" {
		defaultID := strings.TrimSpace(input.Profile.DefaultPermissionModeID)
		if defaultID != "" {
			if _, supported := publicIDs[defaultID]; !supported {
				return extensionPermissionProjection{}, fmt.Errorf(
					"extension composer default permission id %q is not declared",
					defaultID,
				)
			}
			currentID = defaultID
		}
	}

	return extensionPermissionProjection{
		Config: PermissionConfig{
			Configurable: len(modes) > 0,
			DefaultValue: currentID,
			Modes:        modes,
		},
		CurrentID:   currentID,
		Diagnostics: diagnostics,
	}, nil
}

func normalizeExtensionPermissionModeSemantic(value PermissionModeSemantic) (PermissionModeSemantic, bool) {
	switch PermissionModeSemantic(strings.TrimSpace(string(value))) {
	case PermissionModeSemanticAskBeforeWrite:
		return PermissionModeSemanticAskBeforeWrite, true
	case PermissionModeSemanticAcceptEdits:
		return PermissionModeSemanticAcceptEdits, true
	case PermissionModeSemanticFullAccess:
		return PermissionModeSemanticFullAccess, true
	case PermissionModeSemanticLockedDown, "read-only":
		return PermissionModeSemanticLockedDown, true
	case PermissionModeSemanticAuto:
		return PermissionModeSemanticAuto, true
	default:
		return "", false
	}
}

func disambiguateExtensionPermissionLabels(
	modes []PermissionModeOption,
	declarations []extensionPermissionDeclaration,
) {
	labelCounts := make(map[string]int, len(modes))
	for _, mode := range modes {
		labelCounts[strings.ToLower(strings.TrimSpace(mode.Label))]++
	}
	for index := range modes {
		key := strings.ToLower(strings.TrimSpace(modes[index].Label))
		if key == "" || labelCounts[key] < 2 {
			continue
		}
		modes[index].Label = fmt.Sprintf("%s (%s)", modes[index].Label, declarations[index].RuntimeID)
	}
}

func logExtensionPermissionProjectionDiagnostics(
	projection extensionPermissionProjection,
	agentTargetID string,
	provider string,
) {
	for _, diagnostic := range projection.Diagnostics {
		logAgentExtensionComposerDebug(diagnostic.Reason, map[string]any{
			"agentTargetId": strings.TrimSpace(agentTargetID),
			"provider":      strings.TrimSpace(provider),
			"runtimeId":     diagnostic.RuntimeID,
		})
	}
}
