package api

import (
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func generatedAgentProviderSkillOptions(options []agentservice.ComposerSkillOption) []tuttigenerated.AgentProviderSkillOption {
	if len(options) == 0 {
		return []tuttigenerated.AgentProviderSkillOption{}
	}
	result := make([]tuttigenerated.AgentProviderSkillOption, 0, len(options))
	for _, option := range options {
		name := strings.TrimSpace(option.Name)
		trigger := strings.TrimSpace(option.Trigger)
		sourceKind := strings.TrimSpace(option.SourceKind)
		if name == "" || trigger == "" || sourceKind == "" {
			continue
		}
		generated := tuttigenerated.AgentProviderSkillOption{
			Name:       name,
			Trigger:    trigger,
			SourceKind: tuttigenerated.AgentProviderSkillOptionSourceKind(sourceKind),
		}
		if description := strings.TrimSpace(option.Description); description != "" {
			generated.Description = optionalStringPointer(description)
		}
		if pluginName := strings.TrimSpace(option.PluginName); pluginName != "" {
			generated.PluginName = optionalStringPointer(pluginName)
		}
		if path := strings.TrimSpace(option.Path); path != "" {
			generated.Path = optionalStringPointer(path)
		}
		result = append(result, generated)
	}
	return result
}

func generatedAgentProviderCapabilityOptions(options []agentservice.ComposerCapabilityOption) []tuttigenerated.AgentProviderCapabilityOption {
	if len(options) == 0 {
		return []tuttigenerated.AgentProviderCapabilityOption{}
	}
	result := make([]tuttigenerated.AgentProviderCapabilityOption, 0, len(options))
	for _, option := range options {
		id := strings.TrimSpace(option.ID)
		kind := strings.TrimSpace(option.Kind)
		name := strings.TrimSpace(option.Name)
		label := strings.TrimSpace(option.Label)
		status := strings.TrimSpace(option.Status)
		invocation := strings.TrimSpace(option.Invocation)
		if id == "" || kind == "" || name == "" || label == "" || status == "" || invocation == "" {
			continue
		}
		generated := tuttigenerated.AgentProviderCapabilityOption{
			Id:         id,
			Kind:       tuttigenerated.AgentProviderCapabilityOptionKind(kind),
			Name:       name,
			Label:      label,
			Status:     tuttigenerated.AgentProviderCapabilityOptionStatus(status),
			Invocation: tuttigenerated.AgentProviderCapabilityOptionInvocation(invocation),
		}
		if description := strings.TrimSpace(option.Description); description != "" {
			generated.Description = optionalStringPointer(description)
		}
		if source := strings.TrimSpace(option.Source); source != "" {
			generated.Source = optionalStringPointer(source)
		}
		if pluginName := strings.TrimSpace(option.PluginName); pluginName != "" {
			generated.PluginName = optionalStringPointer(pluginName)
		}
		if serverName := strings.TrimSpace(option.ServerName); serverName != "" {
			generated.ServerName = optionalStringPointer(serverName)
		}
		if toolName := strings.TrimSpace(option.ToolName); toolName != "" {
			generated.ToolName = optionalStringPointer(toolName)
		}
		if trigger := strings.TrimSpace(option.Trigger); trigger != "" {
			generated.Trigger = optionalStringPointer(trigger)
		}
		if path := strings.TrimSpace(option.Path); path != "" {
			generated.Path = optionalStringPointer(path)
		}
		result = append(result, generated)
	}
	return result
}

// generatedComposerConfigOptionPointer projects an optional composer config
// (the orthogonal speed dimension) and omits it entirely for providers that do
// not expose it, so the GUI hides the control.
func generatedComposerConfigOptionPointer(config agentservice.ComposerConfigOption) *tuttigenerated.AgentProviderComposerConfig {
	if !config.Configurable && len(config.Options) == 0 {
		return nil
	}
	generated := generatedComposerConfigOption(config)
	return &generated
}

func generatedComposerConfigOption(config agentservice.ComposerConfigOption) tuttigenerated.AgentProviderComposerConfig {
	result := tuttigenerated.AgentProviderComposerConfig{
		Configurable: config.Configurable,
		Options:      make([]tuttigenerated.AgentProviderComposerConfigOptionValue, 0, len(config.Options)),
	}
	if strings.TrimSpace(config.CurrentValue) != "" {
		result.CurrentValue = optionalStringPointer(config.CurrentValue)
	}
	if strings.TrimSpace(config.DefaultValue) != "" {
		result.DefaultValue = optionalStringPointer(config.DefaultValue)
	}
	for _, option := range config.Options {
		value := strings.TrimSpace(option.Value)
		id := strings.TrimSpace(option.ID)
		label := strings.TrimSpace(option.Label)
		if value == "" || id == "" || label == "" {
			continue
		}
		resultOption := tuttigenerated.AgentProviderComposerConfigOptionValue{
			Id:    id,
			Label: label,
			Value: value,
		}
		if strings.TrimSpace(option.Description) != "" {
			resultOption.Description = optionalStringPointer(option.Description)
		}
		if option.SupportsImageInput != nil {
			resultOption.SupportsImageInput = option.SupportsImageInput
		}
		result.Options = append(result.Options, resultOption)
	}
	return result
}
