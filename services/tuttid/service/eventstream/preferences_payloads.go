package eventstream

type desktopPreferencesMutationPayload struct {
	Preferences struct {
		AgentComposerDefaultsByProvider             desktopAgentComposerDefaultsByProviderPayload             `json:"agentComposerDefaultsByProvider"`
		AgentComposerDefaultsByAgentTarget          desktopAgentComposerDefaultsByAgentTargetPayload          `json:"agentComposerDefaultsByAgentTarget,omitempty"`
		AgentGUIConversationRailCollapsedByProvider desktopAgentGUIConversationRailCollapsedByProviderPayload `json:"agentGuiConversationRailCollapsedByProvider"`
		AgentConversationDetailMode                 string                                                    `json:"agentConversationDetailMode"`
		AgentDockLayout                             string                                                    `json:"agentDockLayout"`
		AppCatalogChannel                           string                                                    `json:"appCatalogChannel"`
		BrowserUseConnectionMode                    string                                                    `json:"browserUseConnectionMode,omitempty"`
		DefaultAgentProvider                        string                                                    `json:"defaultAgentProvider"`
		DockIconStyle                               string                                                    `json:"dockIconStyle"`
		DockPlacement                               string                                                    `json:"dockPlacement"`
		DeletedAgentConversationRetentionDays       int                                                       `json:"deletedAgentConversationRetentionDays"`
		FileDefaultOpenersByExtension               desktopFileDefaultOpenersByExtensionPayload               `json:"fileDefaultOpenersByExtension"`
		FeatureFlags                                map[string]bool                                           `json:"featureFlags"`
		WorkbenchShortcuts                          desktopWorkbenchShortcutsPayload                          `json:"workbenchShortcuts"`
		Locale                                      string                                                    `json:"locale"`
		MinimizeAnimation                           string                                                    `json:"minimizeAnimation"`
		SleepPreventionMode                         string                                                    `json:"sleepPreventionMode"`
		ShowAppDeveloperSources                     bool                                                      `json:"showAppDeveloperSources"`
		ThemeSource                                 string                                                    `json:"themeSource"`
		UpdateChannel                               string                                                    `json:"updateChannel"`
		UpdatePolicy                                string                                                    `json:"updatePolicy"`
		WorkbenchWindowSnapping                     *desktopWorkbenchWindowSnappingPayload                    `json:"workbenchWindowSnapping,omitempty"`
	} `json:"preferences"`
}

type desktopPreferencesUpdatedPayload struct {
	Initialized bool                              `json:"initialized"`
	Preferences desktopPreferencesSettingsPayload `json:"preferences"`
}

type desktopPreferencesSettingsPayload struct {
	AgentComposerDefaultsByProvider             desktopAgentComposerDefaultsByProviderPayload             `json:"agentComposerDefaultsByProvider"`
	AgentComposerDefaultsByAgentTarget          desktopAgentComposerDefaultsByAgentTargetPayload          `json:"agentComposerDefaultsByAgentTarget,omitempty"`
	AgentGUIConversationRailCollapsedByProvider desktopAgentGUIConversationRailCollapsedByProviderPayload `json:"agentGuiConversationRailCollapsedByProvider"`
	AgentConversationDetailMode                 string                                                    `json:"agentConversationDetailMode"`
	AgentDockLayout                             string                                                    `json:"agentDockLayout"`
	AppCatalogChannel                           string                                                    `json:"appCatalogChannel"`
	BrowserUseConnectionMode                    string                                                    `json:"browserUseConnectionMode,omitempty"`
	DefaultAgentProvider                        string                                                    `json:"defaultAgentProvider"`
	DockIconStyle                               string                                                    `json:"dockIconStyle"`
	DockPlacement                               string                                                    `json:"dockPlacement"`
	DeletedAgentConversationRetentionDays       int                                                       `json:"deletedAgentConversationRetentionDays"`
	FileDefaultOpenersByExtension               desktopFileDefaultOpenersByExtensionPayload               `json:"fileDefaultOpenersByExtension"`
	FeatureFlags                                map[string]bool                                           `json:"featureFlags"`
	WorkbenchShortcuts                          desktopWorkbenchShortcutsPayload                          `json:"workbenchShortcuts"`
	Locale                                      string                                                    `json:"locale"`
	MinimizeAnimation                           string                                                    `json:"minimizeAnimation"`
	SleepPreventionMode                         string                                                    `json:"sleepPreventionMode"`
	ShowAppDeveloperSources                     bool                                                      `json:"showAppDeveloperSources"`
	ThemeSource                                 string                                                    `json:"themeSource"`
	UpdateChannel                               string                                                    `json:"updateChannel"`
	UpdatePolicy                                string                                                    `json:"updatePolicy"`
	WorkbenchWindowSnapping                     *desktopWorkbenchWindowSnappingPayload                    `json:"workbenchWindowSnapping,omitempty"`
}

type desktopWorkbenchWindowSnappingPayload struct {
	Enabled        bool   `json:"enabled"`
	ShortcutPreset string `json:"shortcutPreset"`
}

type desktopWorkbenchShortcutsPayload struct {
	NewAgentConversation *string `json:"newAgentConversation"`
	NewSameTypeWindow    *string `json:"newSameTypeWindow"`
}

type desktopAgentComposerDefaultsByProviderPayload map[string]desktopAgentComposerDefaultsPayload

type desktopAgentComposerDefaultsByAgentTargetPayload map[string]desktopAgentComposerDefaultsPayload

type desktopAgentGUIConversationRailCollapsedByProviderPayload map[string]bool

type desktopFileDefaultOpenersByExtensionPayload map[string]string

type desktopAgentComposerDefaultsPayload struct {
	Model            string `json:"model,omitempty"`
	PermissionModeID string `json:"permissionModeId,omitempty"`
	ReasoningEffort  string `json:"reasoningEffort,omitempty"`
	Speed            string `json:"speed,omitempty"`
}

func (p desktopAgentComposerDefaultsPayload) isZero() bool {
	return p.Model == "" && p.PermissionModeID == "" && p.ReasoningEffort == "" && p.Speed == ""
}
