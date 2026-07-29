package agent

import "strings"

func cloneBoolPointer(value *bool) *bool {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func filterWorkspaceAgentComposerSkills(options []ComposerSkillOption, selected []string, capabilitiesExplicit bool) []ComposerSkillOption {
	selected = normalizedSnapshotStrings(selected)
	if !capabilitiesExplicit && len(selected) == 0 {
		return options
	}
	wanted := make(map[string]struct{}, len(selected))
	for _, value := range selected {
		wanted[strings.ToLower(strings.TrimSpace(value))] = struct{}{}
	}
	result := make([]ComposerSkillOption, 0, len(options))
	for _, option := range options {
		// Daemon/system injected entries are part of the trusted runtime profile
		// and cannot be removed by a user Agent selection.
		if option.SourceKind == composerSkillSourceSystem || option.SourceKind == composerSkillSourceTuttiInjected {
			result = append(result, option)
			continue
		}
		if workspaceAgentComposerSkillSelected(option, wanted) {
			result = append(result, option)
		}
	}
	return result
}

func filterWorkspaceAgentComposerCapabilities(
	options []ComposerCapabilityOption,
	selected []string,
	capabilitiesExplicit bool,
) []ComposerCapabilityOption {
	selected = normalizedSnapshotStrings(selected)
	if !capabilitiesExplicit && len(selected) == 0 {
		return options
	}
	wanted := make(map[string]struct{}, len(selected))
	for _, value := range selected {
		wanted[strings.ToLower(strings.TrimSpace(value))] = struct{}{}
	}
	result := make([]ComposerCapabilityOption, 0, len(options))
	for _, option := range options {
		// Skills have their own allowlist and have already been filtered before
		// they are projected into the unified capability catalog.
		if option.Kind == "skill" || workspaceAgentComposerCapabilitySelected(option, wanted) {
			result = append(result, option)
		}
	}
	return result
}

func workspaceAgentComposerCapabilitySelected(option ComposerCapabilityOption, wanted map[string]struct{}) bool {
	candidates := []string{
		option.ID,
		option.Name,
		option.PluginName,
		option.ServerName,
		option.ToolName,
		option.Trigger,
		option.Path,
	}
	if strings.TrimSpace(option.ServerName) != "" {
		candidates = append(candidates, "mcpServer:"+option.ServerName)
	}
	for _, candidate := range candidates {
		candidate = strings.ToLower(strings.TrimSpace(candidate))
		if candidate == "" {
			continue
		}
		if _, ok := wanted[candidate]; ok {
			return true
		}
	}
	return false
}

func workspaceAgentComposerSkillSelected(option ComposerSkillOption, wanted map[string]struct{}) bool {
	for _, candidate := range []string{option.Name, option.Trigger, option.Path} {
		candidate = strings.ToLower(strings.TrimSpace(candidate))
		if candidate == "" {
			continue
		}
		if _, ok := wanted[candidate]; ok {
			return true
		}
	}
	return false
}
