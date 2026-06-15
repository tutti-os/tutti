package preferences

import (
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

func GeneratedDesktopPreferencesFromBiz(value preferencesbiz.DesktopPreferences) tuttigenerated.DesktopPreferences {
	return tuttigenerated.DesktopPreferences{
		AgentComposerDefaultsByProvider: generatedAgentComposerDefaultsByProvider(value.AgentComposerDefaultsByProvider),
		DefaultAgentProvider:            tuttigenerated.WorkspaceAgentProvider(value.DefaultAgentProvider),
		DockIconStyle:                   tuttigenerated.DesktopDockIconStyle(value.DockIconStyle),
		DockPlacement:                   tuttigenerated.DesktopDockPlacement(value.DockPlacement),
		Locale:                          tuttigenerated.DesktopLocale(value.Locale),
		SleepPreventionMode:             tuttigenerated.DesktopSleepPreventionMode(value.SleepPreventionMode),
		ThemeSource:                     tuttigenerated.DesktopThemeSource(value.ThemeSource),
		UpdateChannel:                   tuttigenerated.DesktopUpdateChannel(value.UpdateChannel),
		UpdatePolicy:                    tuttigenerated.DesktopUpdatePolicy(value.UpdatePolicy),
	}
}

func GeneratedDesktopPreferencesStateResponseFromBiz(value preferencesbiz.DesktopPreferences) tuttigenerated.DesktopPreferencesStateResponse {
	return tuttigenerated.DesktopPreferencesStateResponse{
		Initialized: value.Initialized,
		Preferences: GeneratedDesktopPreferencesFromBiz(value),
	}
}

func generatedAgentComposerDefaultsByProvider(value map[string]preferencesbiz.AgentComposerDefaults) tuttigenerated.DesktopAgentComposerDefaultsByProvider {
	return tuttigenerated.DesktopAgentComposerDefaultsByProvider{
		ClaudeCode: generatedAgentComposerDefaultsPointer(value["claude-code"]),
		Codex:      generatedAgentComposerDefaultsPointer(value["codex"]),
		Gemini:     generatedAgentComposerDefaultsPointer(value["gemini"]),
		Hermes:     generatedAgentComposerDefaultsPointer(value["hermes"]),
		Nexight:    generatedAgentComposerDefaultsPointer(value["nexight"]),
		Openclaw:   generatedAgentComposerDefaultsPointer(value["openclaw"]),
	}
}

func generatedAgentComposerDefaultsPointer(value preferencesbiz.AgentComposerDefaults) *tuttigenerated.DesktopAgentComposerDefaults {
	generated := tuttigenerated.DesktopAgentComposerDefaults{
		Model:            optionalStringPointer(value.Model),
		PermissionModeId: optionalStringPointer(value.PermissionModeID),
		ReasoningEffort:  optionalStringPointer(value.ReasoningEffort),
	}
	if generated.Model == nil && generated.PermissionModeId == nil && generated.ReasoningEffort == nil {
		return nil
	}
	return &generated
}

func optionalStringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
