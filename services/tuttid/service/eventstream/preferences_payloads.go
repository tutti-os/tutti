package eventstream

type desktopPreferencesMutationPayload struct {
	Preferences struct {
		AgentComposerDefaultsByProvider             desktopAgentComposerDefaultsByProviderPayload             `json:"agentComposerDefaultsByProvider"`
		AgentGUIConversationRailCollapsedByProvider desktopAgentGUIConversationRailCollapsedByProviderPayload `json:"agentGuiConversationRailCollapsedByProvider"`
		AgentConversationDetailMode                 string                                                    `json:"agentConversationDetailMode"`
		AgentDockLayout                             string                                                    `json:"agentDockLayout"`
		AppCatalogChannel                           string                                                    `json:"appCatalogChannel"`
		BrowserUseConnectionMode                    string                                                    `json:"browserUseConnectionMode,omitempty"`
		DefaultAgentProvider                        string                                                    `json:"defaultAgentProvider"`
		DockIconStyle                               string                                                    `json:"dockIconStyle"`
		DockPlacement                               string                                                    `json:"dockPlacement"`
		FileDefaultOpenersByExtension               desktopFileDefaultOpenersByExtensionPayload               `json:"fileDefaultOpenersByExtension"`
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
	AgentGUIConversationRailCollapsedByProvider desktopAgentGUIConversationRailCollapsedByProviderPayload `json:"agentGuiConversationRailCollapsedByProvider"`
	AgentConversationDetailMode                 string                                                    `json:"agentConversationDetailMode"`
	AgentDockLayout                             string                                                    `json:"agentDockLayout"`
	AppCatalogChannel                           string                                                    `json:"appCatalogChannel"`
	BrowserUseConnectionMode                    string                                                    `json:"browserUseConnectionMode,omitempty"`
	DefaultAgentProvider                        string                                                    `json:"defaultAgentProvider"`
	DockIconStyle                               string                                                    `json:"dockIconStyle"`
	DockPlacement                               string                                                    `json:"dockPlacement"`
	FileDefaultOpenersByExtension               desktopFileDefaultOpenersByExtensionPayload               `json:"fileDefaultOpenersByExtension"`
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

type desktopAgentComposerDefaultsByProviderPayload map[string]desktopAgentComposerDefaultsPayload

type desktopAgentGUIConversationRailCollapsedByProviderPayload map[string]bool

type desktopFileDefaultOpenersByExtensionPayload map[string]string

type desktopAgentComposerDefaultsPayload struct {
	Model            string `json:"model,omitempty"`
	PermissionModeID string `json:"permissionModeId,omitempty"`
	ReasoningEffort  string `json:"reasoningEffort,omitempty"`
}
