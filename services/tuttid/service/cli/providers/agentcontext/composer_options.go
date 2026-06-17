package agentcontext

import (
	"context"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func (p Provider) newComposerOptionsCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          appID + ".agent.composer-options",
			Path:        []string{"agent", "composer-options"},
			Summary:     "Get agent composer options",
			Description: "Get provider-specific model and reasoning options without starting an agent session.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"provider":         map[string]any{"type": "string"},
					"locale":           map[string]any{"type": "string"},
					"model":            map[string]any{"type": "string"},
					"permission-mode":  map[string]any{"type": "string"},
					"reasoning-effort": map[string]any{"type": "string"},
				},
				"required": []string{"provider"},
			},
			Output: cliservice.CapabilityOutput{DefaultMode: cliservice.OutputModeJSON, JSON: true},
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			if err := p.requireSessions(); err != nil {
				return cliservice.CommandOutput{}, err
			}
			provider, err := cliservice.RequiredStringInput(request.Input, "provider")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			model, _, err := cliservice.StringInput(request.Input, "model")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			permissionModeID, _, err := cliservice.StringInput(request.Input, "permission-mode")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			reasoningEffort, _, err := cliservice.StringInput(request.Input, "reasoning-effort")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			locale, _, err := cliservice.StringInput(request.Input, "locale")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			defaults := p.composerDefaultsForProvider(ctx, provider)
			if locale == "" {
				locale = p.composerDefaultLocale(ctx)
			}
			if model == "" {
				model = defaults.Model
			}
			if permissionModeID == "" {
				permissionModeID = defaults.PermissionModeID
			}
			if reasoningEffort == "" {
				reasoningEffort = defaults.ReasoningEffort
			}
			options, err := p.sessions.GetComposerOptions(ctx, agentservice.ComposerOptionsInput{
				Locale:   locale,
				Provider: provider,
				Settings: agentservice.ComposerSettings{
					Model:            model,
					PermissionModeID: permissionModeID,
					ReasoningEffort:  reasoningEffort,
				},
			})
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			return cliservice.CommandOutput{Kind: cliservice.OutputModeJSON, Value: composerOptionsValue(options)}, nil
		},
	}
}

func (p Provider) composerDefaultLocale(ctx context.Context) string {
	if p.preferences == nil {
		return ""
	}
	preferences, err := p.preferences.Get(ctx)
	if err != nil {
		return ""
	}
	return preferences.Locale
}

func (p Provider) composerDefaultsForProvider(ctx context.Context, provider string) agentservice.ComposerSettings {
	if p.preferences == nil {
		return agentservice.ComposerSettings{}
	}
	preferences, err := p.preferences.Get(ctx)
	if err != nil {
		return agentservice.ComposerSettings{}
	}
	defaults := preferences.AgentComposerDefaultsByProvider[agentproviderbiz.Normalize(provider)]
	return agentservice.ComposerSettings{
		Model:            defaults.Model,
		PermissionModeID: defaults.PermissionModeID,
		ReasoningEffort:  defaults.ReasoningEffort,
	}
}

func composerOptionsValue(options agentservice.ComposerOptions) map[string]any {
	return map[string]any{
		"provider":          options.Provider,
		"effectiveSettings": agentservice.ComposerSettingsToMap(options.EffectiveSettings),
		"modelConfig":       composerConfigOptionValue(options.ModelConfig),
		"permissionConfig":  permissionConfigValue(options.PermissionConfig),
		"reasoningConfig":   composerConfigOptionValue(options.ReasoningConfig),
		"runtimeContext":    options.RuntimeContext,
	}
}

func permissionConfigValue(config agentservice.PermissionConfig) map[string]any {
	modes := make([]any, 0, len(config.Modes))
	for _, mode := range config.Modes {
		value := map[string]any{
			"id":          mode.ID,
			"description": mode.Description,
			"label":       mode.Label,
			"semantic":    string(mode.Semantic),
		}
		modes = append(modes, value)
	}
	return map[string]any{
		"configurable": config.Configurable,
		"defaultValue": config.DefaultValue,
		"modes":        modes,
	}
}

func composerConfigOptionValue(config agentservice.ComposerConfigOption) map[string]any {
	options := make([]any, 0, len(config.Options))
	for _, option := range config.Options {
		options = append(options, map[string]any{
			"id":          option.ID,
			"value":       option.Value,
			"label":       option.Label,
			"description": option.Description,
		})
	}
	return map[string]any{
		"configurable": config.Configurable,
		"currentValue": config.CurrentValue,
		"defaultValue": config.DefaultValue,
		"options":      options,
	}
}
