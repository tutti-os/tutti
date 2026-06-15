package preferences

import agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"

const (
	DefaultDesktopDefaultAgentProvider = agentproviderbiz.Codex
	DefaultDesktopDockIconStyle        = "default"
	DefaultDesktopDockPlacement        = "bottom"
	DefaultDesktopLocale               = "en"
	DefaultDesktopSleepPreventionMode  = "never"
	DefaultDesktopThemeSource          = "dark"
	DefaultDesktopUpdateChannel        = "rc"
	DefaultDesktopUpdatePolicy         = "prompt"
)

type DesktopPreferences struct {
	AgentComposerDefaultsByProvider map[string]AgentComposerDefaults
	DefaultAgentProvider            string
	DockIconStyle                   string
	DockPlacement                   string
	Initialized                     bool
	Locale                          string
	SleepPreventionMode             string
	ThemeSource                     string
	UpdateChannel                   string
	UpdatePolicy                    string
}

type AgentComposerDefaults struct {
	Model            string
	PermissionModeID string
	ReasoningEffort  string
}

func DefaultDesktopPreferences() DesktopPreferences {
	return DesktopPreferences{
		AgentComposerDefaultsByProvider: map[string]AgentComposerDefaults{},
		DefaultAgentProvider:            DefaultDesktopDefaultAgentProvider,
		DockIconStyle:                   DefaultDesktopDockIconStyle,
		DockPlacement:                   DefaultDesktopDockPlacement,
		Initialized:                     false,
		Locale:                          DefaultDesktopLocale,
		SleepPreventionMode:             DefaultDesktopSleepPreventionMode,
		ThemeSource:                     DefaultDesktopThemeSource,
		UpdateChannel:                   DefaultDesktopUpdateChannel,
		UpdatePolicy:                    DefaultDesktopUpdatePolicy,
	}
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
