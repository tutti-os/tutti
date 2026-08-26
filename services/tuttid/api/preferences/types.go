package preferences

import (
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

func GeneratedDesktopPreferencesFromBiz(value preferencesbiz.DesktopPreferences) tuttigenerated.DesktopPreferences {
	windowSnapping := tuttigenerated.DesktopWorkbenchWindowSnapping{
		Enabled:        value.WindowSnappingEnabled,
		ShortcutPreset: tuttigenerated.DesktopWorkbenchWindowSnappingShortcutPreset(value.WindowSnappingShortcutPreset),
	}
	workbenchShortcuts := tuttigenerated.DesktopWorkbenchShortcuts{
		NewAgentConversation: optionalStringPointer(value.WorkbenchShortcuts.NewAgentConversation),
		NewSameTypeWindow:    optionalStringPointer(value.WorkbenchShortcuts.NewSameTypeWindow),
		CaptureScreenshot:    optionalStringPointer(value.WorkbenchShortcuts.CaptureScreenshot),
	}
	return tuttigenerated.DesktopPreferences{
		AgentCliUpdateCheckEnabled:                  value.AgentCLIUpdateCheckEnabled,
		AgentComposerDefaultsByProvider:             generatedAgentComposerDefaultsByProvider(value.AgentComposerDefaultsByProvider),
		AgentComposerDefaultsByAgentTarget:          generatedAgentComposerDefaultsByAgentTarget(value.AgentComposerDefaultsByAgentTarget),
		AgentGuiConversationRailCollapsedByProvider: generatedAgentGUIConversationRailCollapsedByProvider(value.AgentGUIConversationRailCollapsedByProvider),
		AgentSessionLaunchModesByWorkspace:          generatedAgentSessionLaunchModesByWorkspace(value.AgentSessionLaunchModesByWorkspace),
		AgentConversationDetailMode:                 tuttigenerated.DesktopAgentConversationDetailMode(preferencesbiz.NormalizeDesktopAgentConversationDetailMode(value.AgentConversationDetailMode)),
		AgentDockLayout:                             tuttigenerated.DesktopAgentDockLayout(preferencesbiz.NormalizeDesktopAgentDockLayout(value.AgentDockLayout)),
		AppCatalogChannel:                           tuttigenerated.DesktopAppCatalogChannel(value.AppCatalogChannel),
		BrowserUseConnectionMode:                    generatedBrowserUseConnectionModePointer(value.BrowserUseConnectionMode),
		DefaultAgentProvider:                        tuttigenerated.DesktopDefaultAgentProvider(value.DefaultAgentProvider),
		DockIconStyle:                               tuttigenerated.DesktopDockIconStyle(value.DockIconStyle),
		DockPlacement:                               tuttigenerated.DesktopDockPlacement(value.DockPlacement),
		DeletedAgentConversationRetentionDays:       tuttigenerated.DeletedAgentConversationRetentionDays(preferencesbiz.NormalizeDeletedAgentConversationRetentionDays(value.DeletedAgentConversationRetentionDays)),
		FileDefaultOpenersByExtension:               generatedFileDefaultOpenersByExtension(value.FileDefaultOpenersByExtension),
		FeatureFlags:                                tuttigenerated.DesktopFeatureFlags(value.FeatureFlags),
		WorkbenchShortcuts:                          workbenchShortcuts,
		Locale:                                      tuttigenerated.DesktopLocale(value.Locale),
		MinimizeAnimation:                           tuttigenerated.DesktopMinimizeAnimation(value.MinimizeAnimation),
		SleepPreventionMode:                         tuttigenerated.DesktopSleepPreventionMode(value.SleepPreventionMode),
		ShowAppDeveloperSources:                     value.ShowAppDeveloperSources,
		ThemeSource:                                 tuttigenerated.DesktopThemeSource(value.ThemeSource),
		UpdateChannel:                               tuttigenerated.DesktopUpdateChannel(value.UpdateChannel),
		UpdatePolicy:                                tuttigenerated.DesktopUpdatePolicy(value.UpdatePolicy),
		WorkbenchWindowSnapping:                     &windowSnapping,
	}
}

func generatedAgentSessionLaunchModesByWorkspace(value map[string]map[string]string) *tuttigenerated.DesktopAgentSessionLaunchModesByWorkspace {
	result := tuttigenerated.DesktopAgentSessionLaunchModesByWorkspace{}
	for workspaceID, byProject := range value {
		projects := tuttigenerated.DesktopAgentSessionLaunchModesByProject{}
		for sectionKey, mode := range byProject {
			projects[sectionKey] = tuttigenerated.DesktopAgentSessionLaunchMode(mode)
		}
		result[workspaceID] = projects
	}
	return &result
}

func generatedFileDefaultOpenersByExtension(value map[string]string) tuttigenerated.DesktopFileDefaultOpenersByExtension {
	result := tuttigenerated.DesktopFileDefaultOpenersByExtension{}
	for extension, opener := range value {
		normalizedExtension := preferencesbiz.NormalizeDesktopFileExtension(extension)
		if normalizedExtension == "" || !preferencesbiz.IsDesktopFileDefaultOpener(opener) {
			continue
		}
		result[normalizedExtension] = tuttigenerated.DesktopFileDefaultOpener(opener)
	}
	return result
}

func generatedAgentGUIConversationRailCollapsedByProvider(value map[string]bool) tuttigenerated.DesktopAgentGuiConversationRailCollapsedByProvider {
	return tuttigenerated.DesktopAgentGuiConversationRailCollapsedByProvider{
		ClaudeCode: optionalBoolPointerFromMap(value, "claude-code"),
		Codex:      optionalBoolPointerFromMap(value, "codex"),
		TuttiAgent: optionalBoolPointerFromMap(value, "tutti-agent"),
		Cursor:     optionalBoolPointerFromMap(value, "cursor"),
		Openclaw:   optionalBoolPointerFromMap(value, "openclaw"),
		Opencode:   optionalBoolPointerFromMap(value, "opencode"),
	}
}

func generatedBrowserUseConnectionModePointer(value string) *tuttigenerated.DesktopBrowserUseConnectionMode {
	if value == "" {
		return nil
	}
	mode := tuttigenerated.DesktopBrowserUseConnectionMode(value)
	return &mode
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
		TuttiAgent: generatedAgentComposerDefaultsPointer(value["tutti-agent"]),
		Cursor:     generatedAgentComposerDefaultsPointer(value["cursor"]),
		Openclaw:   generatedAgentComposerDefaultsPointer(value["openclaw"]),
		Opencode:   generatedAgentComposerDefaultsPointer(value["opencode"]),
	}
}

func generatedAgentComposerDefaultsByAgentTarget(value map[string]preferencesbiz.AgentComposerDefaults) *tuttigenerated.DesktopAgentComposerDefaultsByAgentTarget {
	result := tuttigenerated.DesktopAgentComposerDefaultsByAgentTarget{}
	for agentTargetID, defaults := range value {
		generated := generatedAgentComposerDefaultsPointer(defaults)
		if agentTargetID == "" || generated == nil {
			continue
		}
		result[agentTargetID] = *generated
	}
	return &result
}

func generatedAgentComposerDefaultsPointer(value preferencesbiz.AgentComposerDefaults) *tuttigenerated.DesktopAgentComposerDefaults {
	generated := tuttigenerated.DesktopAgentComposerDefaults{
		CodexSaverMode:   optionalTruePointer(value.CodexSaverMode),
		RtkSaverMode:     optionalTruePointer(value.RTKSaverMode),
		Model:            optionalStringPointer(value.Model),
		PermissionModeId: optionalStringPointer(value.PermissionModeID),
		ReasoningEffort:  optionalStringPointer(value.ReasoningEffort),
		Speed:            optionalStringPointer(value.Speed),
	}
	if generated.CodexSaverMode == nil && generated.RtkSaverMode == nil && generated.Model == nil && generated.PermissionModeId == nil && generated.ReasoningEffort == nil && generated.Speed == nil {
		return nil
	}
	return &generated
}

func optionalTruePointer(value bool) *bool {
	if !value {
		return nil
	}
	return &value
}

func optionalStringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func optionalBoolPointerFromMap(value map[string]bool, key string) *bool {
	collapsed, ok := value[key]
	if !ok {
		return nil
	}
	return &collapsed
}
