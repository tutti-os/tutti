package agentcontext

import (
	"context"

	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

type composerOptionsInput struct {
	AgentID         string `cli:"agent-id" advertise-required:"true" hint:"Use agent list --json to discover available agents."`
	Cwd             string `cli:"cwd"`
	Locale          string `cli:"locale"`
	Model           string `cli:"model"`
	PermissionMode  string `cli:"permission-mode"`
	Provider        string `cli:"provider" hidden:"true"`
	ReasoningEffort string `cli:"reasoning-effort"`
}

type composerOptionsResult struct {
	AgentTargetID string
	Legacy        bool
	Options       agentservice.ComposerOptions
}

func (p Provider) newComposerOptionsCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[composerOptionsInput]{
		ID:          appID + ".agent.composer-options",
		Path:        []string{"agent", "composer-options"},
		Summary:     "Get agent composer options",
		Description: "Get model, reasoning, and permission options for one agent without starting a session. Some runtimes may spin up a hidden discovery session.",
		Kind:        framework.KindGet,
		Workspace:   framework.WorkspaceOptional,
		Inputs:      framework.FromStruct[composerOptionsInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewDetail,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewDetail: func(result any) map[string]any {
					return composerOptionsValue(result.(composerOptionsResult))
				},
			},
		},
		Run: p.runComposerOptions,
	})
}

func (p Provider) runComposerOptions(ctx context.Context, invoke framework.InvokeContext, input composerOptionsInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	target, legacy, err := p.resolveAgentSelector(ctx, input.AgentID, input.Provider)
	if err != nil {
		return nil, err
	}
	canonicalProvider := target.Provider
	locale := input.Locale
	if locale == "" {
		locale = p.composerDefaultLocale(ctx)
	}
	// The app-facing composer facade does not return CapabilityCatalog. Keep
	// discovery off here so a catalog scan is never paid for and discarded.
	includeCapabilityCatalog := false
	options, err := p.sessions.GetComposerOptions(ctx, agentservice.ComposerOptionsInput{
		AgentTargetID:            target.ID,
		Cwd:                      input.Cwd,
		Locale:                   locale,
		Provider:                 canonicalProvider,
		WorkspaceID:              invoke.WorkspaceID,
		IncludeCapabilityCatalog: &includeCapabilityCatalog,
		Settings: agentservice.ComposerSettings{
			Model:            input.Model,
			PermissionModeID: input.PermissionMode,
			ReasoningEffort:  input.ReasoningEffort,
		},
	})
	if err != nil {
		return nil, err
	}
	return composerOptionsResult{AgentTargetID: target.ID, Legacy: legacy, Options: options}, nil
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

func composerOptionsValue(result composerOptionsResult) map[string]any {
	options := result.Options
	value := map[string]any{
		"schemaVersion":     2,
		"agentTargetId":     result.AgentTargetID,
		"provider":          options.Provider,
		"effectiveSettings": agentservice.ComposerSettingsToMap(options.EffectiveSettings),
		"modelConfig":       composerConfigOptionValue(options.ModelConfig),
		"permissionConfig":  permissionConfigValue(options.PermissionConfig),
		"reasoningConfig":   composerConfigOptionValue(options.ReasoningConfig),
		"speedConfig":       composerConfigOptionValue(options.SpeedConfig),
	}
	if result.Legacy {
		value["schemaVersion"] = 1
		delete(value, "agentTargetId")
	}
	return value
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
		value := map[string]any{
			"id":          option.ID,
			"value":       option.Value,
			"label":       option.Label,
			"description": option.Description,
		}
		if option.SupportsImageInput != nil {
			value["supportsImageInput"] = *option.SupportsImageInput
		}
		options = append(options, value)
	}
	return map[string]any{
		"configurable": config.Configurable,
		"currentValue": config.CurrentValue,
		"defaultValue": config.DefaultValue,
		"options":      options,
	}
}
