package agentcontext

import (
	"context"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

type composerOptionsInput struct {
	Provider                 string `cli:"provider" validate:"required"`
	Locale                   string `cli:"locale"`
	Model                    string `cli:"model"`
	PermissionMode           string `cli:"permission-mode"`
	ReasoningEffort          string `cli:"reasoning-effort"`
	IncludeCapabilityCatalog *bool  `cli:"include-capability-catalog"`
}

func (p Provider) newComposerOptionsCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[composerOptionsInput]{
		ID:          appID + ".agent.composer-options",
		Path:        []string{"agent", "composer-options"},
		Summary:     "Get agent composer options",
		Description: "Get provider-specific model and reasoning options without starting an agent session.",
		Kind:        framework.KindGet,
		Workspace:   framework.WorkspaceOptional,
		Inputs:      framework.FromStruct[composerOptionsInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewDetail,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewDetail: func(result any) map[string]any {
					return composerOptionsValue(result.(agentservice.ComposerOptions))
				},
			},
		},
		Run: p.runComposerOptions,
	})
}

func (p Provider) runComposerOptions(ctx context.Context, _ framework.InvokeContext, input composerOptionsInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	defaults := p.composerDefaultsForProvider(ctx, input.Provider)
	locale := input.Locale
	if locale == "" {
		locale = p.composerDefaultLocale(ctx)
	}
	model := input.Model
	if model == "" {
		model = defaults.Model
	}
	permissionModeID := input.PermissionMode
	if permissionModeID == "" {
		permissionModeID = defaults.PermissionModeID
	}
	reasoningEffort := input.ReasoningEffort
	if reasoningEffort == "" {
		reasoningEffort = defaults.ReasoningEffort
	}
	return p.sessions.GetComposerOptions(ctx, agentservice.ComposerOptionsInput{
		Locale:                   locale,
		Provider:                 input.Provider,
		IncludeCapabilityCatalog: input.IncludeCapabilityCatalog,
		Settings: agentservice.ComposerSettings{
			Model:            model,
			PermissionModeID: permissionModeID,
			ReasoningEffort:  reasoningEffort,
		},
	})
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
