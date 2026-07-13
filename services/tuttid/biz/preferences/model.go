package preferences

import (
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const (
	DesktopAgentDockLayoutLegacySplit = "legacySplit"
	DesktopAgentDockLayoutUnified     = "unified"

	DesktopAgentConversationDetailModeCoding  = "coding"
	DesktopAgentConversationDetailModeGeneral = "general"

	DefaultDesktopAppCatalogChannel           = "production"
	DefaultDesktopAgentDockLayout             = DesktopAgentDockLayoutUnified
	DefaultDesktopAgentConversationDetailMode = DesktopAgentConversationDetailModeCoding
	DefaultDesktopDockIconStyle               = "default"
	DefaultDesktopDockPlacement               = "bottom"
	DefaultDesktopBrowserUseConnectionMode    = "isolated"
	DefaultDesktopLocale                      = "en"
	DefaultDesktopMinimizeAnimation           = "scale"
	DefaultDesktopSleepPreventionMode         = "never"
	DefaultDesktopShowAppDeveloperSources     = false
	DefaultDesktopEnableCursorAgent           = false
	DefaultDesktopEnableOpenCodeAgent         = false
	DefaultDesktopThemeSource                 = "dark"
	DefaultDesktopUpdateChannel               = "rc"
	DefaultDesktopUpdatePolicy                = "prompt"
	DefaultDesktopWindowSnappingEnabled       = false
	DefaultDesktopWindowSnappingShortcut      = "commandArrows"
)

var DefaultDesktopDefaultAgentProvider = defaultDesktopAgentProvider()

func defaultDesktopAgentProvider() string {
	selected := ""
	selectedPriority := int(^uint(0) >> 1)
	for _, descriptor := range providerregistry.Migrated() {
		priority := descriptor.Desktop.DefaultProviderPriority
		if priority > 0 && priority < selectedPriority {
			selected = descriptor.Identity.ID
			selectedPriority = priority
		}
	}
	if selected == "" {
		panic("provider registry has no desktop default agent provider")
	}
	return selected
}

type DesktopPreferences struct {
	AgentComposerDefaultsByProvider             map[string]AgentComposerDefaults
	AgentComposerDefaultsByAgentTarget          map[string]AgentComposerDefaults
	AgentGUIConversationRailCollapsedByProvider map[string]bool
	AgentConversationDetailMode                 string
	AgentDockLayout                             string
	AppCatalogChannel                           string
	BrowserUseConnectionMode                    string
	DefaultAgentProvider                        string
	DockIconStyle                               string
	DockPlacement                               string
	EnableCursorAgent                           bool
	EnableOpenCodeAgent                         bool
	FeatureFlags                                map[string]bool
	FileDefaultOpenersByExtension               map[string]string
	Initialized                                 bool
	Locale                                      string
	MinimizeAnimation                           string
	SleepPreventionMode                         string
	ShowAppDeveloperSources                     bool
	ThemeSource                                 string
	UpdateChannel                               string
	UpdatePolicy                                string
	WindowSnappingEnabled                       bool
	WindowSnappingShortcutPreset                string
	WorkbenchShortcuts                          DesktopWorkbenchShortcuts
}

type AgentComposerDefaults struct {
	Model            string
	PermissionModeID string
	ReasoningEffort  string
	Speed            string
}

func (d AgentComposerDefaults) IsZero() bool {
	return d.Model == "" && d.PermissionModeID == "" && d.ReasoningEffort == "" && d.Speed == ""
}

// LocalAgentTargetIDForProvider maps a provider to the id of its built-in
// local agent target (see biz/agenttarget.IDLocalCodex and friends).
func LocalAgentTargetIDForProvider(provider string) string {
	normalized := agentproviderbiz.Normalize(provider)
	if normalized == "" {
		return ""
	}
	return "local:" + normalized
}

type DesktopWorkbenchShortcuts struct {
	NewAgentConversation string
	NewSameTypeWindow    string
}

func DefaultDesktopPreferences() DesktopPreferences {
	return DesktopPreferences{
		AgentComposerDefaultsByProvider:             map[string]AgentComposerDefaults{},
		AgentComposerDefaultsByAgentTarget:          map[string]AgentComposerDefaults{},
		AgentGUIConversationRailCollapsedByProvider: map[string]bool{},
		AgentConversationDetailMode:                 DefaultDesktopAgentConversationDetailMode,
		AgentDockLayout:                             DefaultDesktopAgentDockLayout,
		AppCatalogChannel:                           DefaultDesktopAppCatalogChannel,
		BrowserUseConnectionMode:                    DefaultDesktopBrowserUseConnectionMode,
		DefaultAgentProvider:                        DefaultDesktopDefaultAgentProvider,
		DockIconStyle:                               DefaultDesktopDockIconStyle,
		DockPlacement:                               DefaultDesktopDockPlacement,
		EnableCursorAgent:                           DefaultDesktopEnableCursorAgent,
		EnableOpenCodeAgent:                         DefaultDesktopEnableOpenCodeAgent,
		FeatureFlags:                                map[string]bool{},
		FileDefaultOpenersByExtension: map[string]string{
			"htm":   "appBrowser",
			"html":  "appBrowser",
			"shtml": "appBrowser",
			"xhtml": "appBrowser",
		},
		Initialized:                  false,
		Locale:                       DefaultDesktopLocale,
		MinimizeAnimation:            DefaultDesktopMinimizeAnimation,
		SleepPreventionMode:          DefaultDesktopSleepPreventionMode,
		ShowAppDeveloperSources:      DefaultDesktopShowAppDeveloperSources,
		ThemeSource:                  DefaultDesktopThemeSource,
		UpdateChannel:                DefaultDesktopUpdateChannel,
		UpdatePolicy:                 DefaultDesktopUpdatePolicy,
		WindowSnappingEnabled:        DefaultDesktopWindowSnappingEnabled,
		WindowSnappingShortcutPreset: DefaultDesktopWindowSnappingShortcut,
		WorkbenchShortcuts:           DesktopWorkbenchShortcuts{},
	}
}

func NormalizeDesktopAgentDockLayout(value string) string {
	normalized := strings.TrimSpace(value)
	if IsDesktopAgentDockLayout(normalized) {
		return normalized
	}
	return DefaultDesktopAgentDockLayout
}

func IsDesktopAgentDockLayout(value string) bool {
	switch value {
	case DesktopAgentDockLayoutLegacySplit, DesktopAgentDockLayoutUnified:
		return true
	default:
		return false
	}
}

func NormalizeDesktopAgentConversationDetailMode(value string) string {
	normalized := strings.TrimSpace(value)
	if IsDesktopAgentConversationDetailMode(normalized) {
		return normalized
	}
	return DefaultDesktopAgentConversationDetailMode
}

func IsDesktopAgentConversationDetailMode(value string) bool {
	switch value {
	case "coding", "general":
		return true
	default:
		return false
	}
}

func IsDesktopDefaultAgentProvider(value string) bool {
	descriptor, ok := providerregistry.Find(value)
	return ok && descriptor.Desktop.DefaultProviderEligible
}

func IsDesktopAppCatalogChannel(value string) bool {
	switch value {
	case "production", "staging":
		return true
	default:
		return false
	}
}

func IsDesktopFileDefaultOpener(value string) bool {
	switch value {
	case "appBrowser", "defaultBrowser", "fileViewer", "system":
		return true
	default:
		return false
	}
}

func NormalizeDesktopFileExtension(value string) string {
	normalized := strings.TrimLeft(strings.ToLower(strings.TrimSpace(value)), ".")
	if normalized == "" || len(normalized) > 32 {
		return ""
	}
	for index, char := range normalized {
		if (char >= 'a' && char <= 'z') ||
			(char >= '0' && char <= '9') {
			continue
		}
		if index > 0 && (char == '_' || char == '-') {
			continue
		}
		return ""
	}
	return normalized
}

func IsDesktopDockIconStyle(value string) bool {
	switch value {
	case "default", "flat":
		return true
	default:
		return false
	}
}

func IsDesktopDockPlacement(value string) bool {
	switch value {
	case "bottom", "left":
		return true
	default:
		return false
	}
}

func IsDesktopMinimizeAnimation(value string) bool {
	switch value {
	case "scale", "genie", "off":
		return true
	default:
		return false
	}
}

func IsDesktopWindowSnappingShortcutPreset(value string) bool {
	switch value {
	case "commandArrows", "commandShiftArrows":
		return true
	default:
		return false
	}
}

func IsDesktopLocale(value string) bool {
	switch value {
	case "en", "zh-CN":
		return true
	default:
		return false
	}
}

func IsDesktopThemeSource(value string) bool {
	switch value {
	case "system", "dark", "light":
		return true
	default:
		return false
	}
}

func IsDesktopSleepPreventionMode(value string) bool {
	switch value {
	case "never", "whileAgentRunning", "always":
		return true
	default:
		return false
	}
}

func IsDesktopBrowserUseConnectionMode(value string) bool {
	switch value {
	case "isolated", "autoConnect":
		return true
	default:
		return false
	}
}

func IsDesktopUpdateChannel(value string) bool {
	switch value {
	case "stable", "rc":
		return true
	default:
		return false
	}
}

func IsDesktopUpdatePolicy(value string) bool {
	switch value {
	case "off", "prompt", "auto":
		return true
	default:
		return false
	}
}

func NormalizeDesktopShortcutBinding(value string) string {
	normalized := strings.TrimSpace(value)
	if len(normalized) > 80 {
		return ""
	}
	return normalized
}

func NormalizeDesktopFeatureFlags(value map[string]bool) map[string]bool {
	result := make(map[string]bool, len(value))
	for key, enabled := range value {
		trimmed := strings.TrimSpace(key)
		if trimmed == "" || len(trimmed) > 128 {
			continue
		}
		result[trimmed] = enabled
	}
	return result
}

func NormalizeDesktopWorkbenchShortcuts(value DesktopWorkbenchShortcuts) DesktopWorkbenchShortcuts {
	return DesktopWorkbenchShortcuts{
		NewAgentConversation: NormalizeDesktopShortcutBinding(value.NewAgentConversation),
		NewSameTypeWindow:    NormalizeDesktopShortcutBinding(value.NewSameTypeWindow),
	}
}
