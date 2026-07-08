package preferences

import (
	"context"
	"errors"
	"strings"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

type DesktopPreferencesPublisher interface {
	PublishDesktopPreferencesUpdated(context.Context, preferencesbiz.DesktopPreferences) error
}

type Service struct {
	Store     workspacedata.PreferencesStore
	Publisher DesktopPreferencesPublisher
}

type PutInput struct {
	// AgentComposerDefaultsByProvider is accepted for wire compatibility but
	// ignored on write: the legacy provider-keyed defaults are frozen after
	// the one-time migration onto AgentComposerDefaultsByAgentTarget.
	AgentComposerDefaultsByProvider             map[string]preferencesbiz.AgentComposerDefaults
	AgentComposerDefaultsByAgentTarget          map[string]preferencesbiz.AgentComposerDefaults
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
	FileDefaultOpenersByExtension               map[string]string
	FeatureFlags                                map[string]bool
	WorkbenchShortcuts                          preferencesbiz.DesktopWorkbenchShortcuts
	Locale                                      string
	MinimizeAnimation                           string
	SleepPreventionMode                         string
	ShowAppDeveloperSources                     bool
	ThemeSource                                 string
	UpdateChannel                               string
	UpdatePolicy                                string
	WindowSnapping                              *DesktopWindowSnappingInput
}

type DesktopWindowSnappingInput struct {
	Enabled        bool
	ShortcutPreset string
}

func (s Service) Get(ctx context.Context) (preferencesbiz.DesktopPreferences, error) {
	if s.Store == nil {
		return preferencesbiz.DesktopPreferences{}, errors.New("desktop preferences store is not configured")
	}

	return s.Store.GetDesktopPreferences(ctx)
}

func (s Service) Put(ctx context.Context, input PutInput) (preferencesbiz.DesktopPreferences, error) {
	if s.Store == nil {
		return preferencesbiz.DesktopPreferences{}, errors.New("desktop preferences store is not configured")
	}

	stored, err := s.Store.GetDesktopPreferences(ctx)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, err
	}

	windowSnapping := resolveWindowSnapping(stored, input.WindowSnapping)

	// A nil agent-target map means the client did not send the field (e.g. an
	// older build) — keep the stored defaults instead of wiping them. An
	// explicit empty map still clears everything.
	agentComposerDefaultsByAgentTarget := input.AgentComposerDefaultsByAgentTarget
	if agentComposerDefaultsByAgentTarget == nil {
		agentComposerDefaultsByAgentTarget = stored.AgentComposerDefaultsByAgentTarget
	}

	preferences, err := s.Store.PutDesktopPreferences(ctx, preferencesbiz.DesktopPreferences{
		// The legacy provider-keyed defaults are frozen: client input is
		// ignored so nothing writes the old field anymore; the stored value
		// is only kept for downgrade compatibility and should pass through
		// unchanged.
		AgentComposerDefaultsByProvider:             stored.AgentComposerDefaultsByProvider,
		AgentComposerDefaultsByAgentTarget:          normalizeAgentComposerDefaultsByAgentTarget(agentComposerDefaultsByAgentTarget),
		AgentGUIConversationRailCollapsedByProvider: normalizeAgentGUIConversationRailCollapsedByProvider(input.AgentGUIConversationRailCollapsedByProvider),
		AgentConversationDetailMode:                 preferencesbiz.NormalizeDesktopAgentConversationDetailMode(input.AgentConversationDetailMode),
		AgentDockLayout:                             normalizeAgentDockLayout(input.AgentDockLayout),
		AppCatalogChannel:                           normalizeAppCatalogChannel(input.AppCatalogChannel),
		BrowserUseConnectionMode:                    normalizeBrowserUseConnectionMode(input.BrowserUseConnectionMode),
		DefaultAgentProvider:                        normalizeDefaultAgentProvider(input.DefaultAgentProvider),
		DockIconStyle:                               strings.TrimSpace(input.DockIconStyle),
		DockPlacement:                               strings.TrimSpace(input.DockPlacement),
		EnableCursorAgent:                           input.EnableCursorAgent,
		EnableOpenCodeAgent:                         input.EnableOpenCodeAgent,
		FileDefaultOpenersByExtension:               normalizeFileDefaultOpenersByExtension(input.FileDefaultOpenersByExtension),
		Initialized:                                 true,
		FeatureFlags:                                preferencesbiz.NormalizeDesktopFeatureFlags(input.FeatureFlags),
		WorkbenchShortcuts:                          preferencesbiz.NormalizeDesktopWorkbenchShortcuts(input.WorkbenchShortcuts),
		Locale:                                      strings.TrimSpace(input.Locale),
		MinimizeAnimation:                           normalizeMinimizeAnimation(input.MinimizeAnimation),
		SleepPreventionMode:                         strings.TrimSpace(input.SleepPreventionMode),
		ShowAppDeveloperSources:                     input.ShowAppDeveloperSources,
		ThemeSource:                                 strings.TrimSpace(input.ThemeSource),
		UpdateChannel:                               strings.TrimSpace(input.UpdateChannel),
		UpdatePolicy:                                strings.TrimSpace(input.UpdatePolicy),
		WindowSnappingEnabled:                       windowSnapping.Enabled,
		WindowSnappingShortcutPreset:                windowSnapping.ShortcutPreset,
	})
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, err
	}
	if s.Publisher != nil {
		_ = s.Publisher.PublishDesktopPreferencesUpdated(ctx, preferences)
	}
	return preferences, nil
}

func resolveWindowSnapping(stored preferencesbiz.DesktopPreferences, input *DesktopWindowSnappingInput) DesktopWindowSnappingInput {
	if input != nil {
		return DesktopWindowSnappingInput{
			Enabled:        input.Enabled,
			ShortcutPreset: normalizeWindowSnappingShortcutPreset(input.ShortcutPreset),
		}
	}

	return DesktopWindowSnappingInput{
		Enabled:        stored.WindowSnappingEnabled,
		ShortcutPreset: normalizeWindowSnappingShortcutPreset(stored.WindowSnappingShortcutPreset),
	}
}

func normalizeDefaultAgentProvider(value string) string {
	normalized := agentproviderbiz.Normalize(value)
	if preferencesbiz.IsDesktopDefaultAgentProvider(normalized) {
		return normalized
	}
	return preferencesbiz.DefaultDesktopDefaultAgentProvider
}

func normalizeAgentDockLayout(value string) string {
	normalized := strings.TrimSpace(value)
	if preferencesbiz.IsDesktopAgentDockLayout(normalized) {
		return normalized
	}
	return preferencesbiz.DefaultDesktopAgentDockLayout
}

func normalizeAppCatalogChannel(value string) string {
	normalized := strings.TrimSpace(value)
	if preferencesbiz.IsDesktopAppCatalogChannel(normalized) {
		return normalized
	}
	return preferencesbiz.DefaultDesktopAppCatalogChannel
}

func normalizeFileDefaultOpenersByExtension(input map[string]string) map[string]string {
	if input == nil {
		return preferencesbiz.DefaultDesktopPreferences().FileDefaultOpenersByExtension
	}
	result := map[string]string{}
	for extension, opener := range input {
		normalizedExtension := preferencesbiz.NormalizeDesktopFileExtension(extension)
		if normalizedExtension == "" {
			continue
		}
		normalizedOpener := strings.TrimSpace(opener)
		if !preferencesbiz.IsDesktopFileDefaultOpener(normalizedOpener) {
			continue
		}
		result[normalizedExtension] = normalizedOpener
	}
	return result
}

func normalizeBrowserUseConnectionMode(value string) string {
	normalized := strings.TrimSpace(value)
	if preferencesbiz.IsDesktopBrowserUseConnectionMode(normalized) {
		return normalized
	}
	return preferencesbiz.DefaultDesktopBrowserUseConnectionMode
}

func normalizeMinimizeAnimation(value string) string {
	normalized := strings.TrimSpace(value)
	if preferencesbiz.IsDesktopMinimizeAnimation(normalized) {
		return normalized
	}
	return preferencesbiz.DefaultDesktopMinimizeAnimation
}

func normalizeWindowSnappingShortcutPreset(value string) string {
	normalized := strings.TrimSpace(value)
	if preferencesbiz.IsDesktopWindowSnappingShortcutPreset(normalized) {
		return normalized
	}
	return preferencesbiz.DefaultDesktopWindowSnappingShortcut
}

func normalizeAgentGUIConversationRailCollapsedByProvider(input map[string]bool) map[string]bool {
	result := map[string]bool{}
	for provider, collapsed := range input {
		normalizedProvider := agentproviderbiz.Normalize(provider)
		if normalizedProvider == "" {
			continue
		}
		result[normalizedProvider] = collapsed
	}
	return result
}

func normalizeAgentComposerDefaultsByAgentTarget(input map[string]preferencesbiz.AgentComposerDefaults) map[string]preferencesbiz.AgentComposerDefaults {
	result := map[string]preferencesbiz.AgentComposerDefaults{}
	for agentTargetID, defaults := range input {
		normalizedAgentTargetID := strings.TrimSpace(agentTargetID)
		if normalizedAgentTargetID == "" {
			continue
		}
		normalizedDefaults := normalizeAgentComposerDefaults(defaults)
		if normalizedDefaults.IsZero() {
			continue
		}
		result[normalizedAgentTargetID] = normalizedDefaults
	}
	return result
}

func normalizeAgentComposerDefaults(defaults preferencesbiz.AgentComposerDefaults) preferencesbiz.AgentComposerDefaults {
	return preferencesbiz.AgentComposerDefaults{
		Model:            strings.TrimSpace(defaults.Model),
		PermissionModeID: strings.TrimSpace(defaults.PermissionModeID),
		ReasoningEffort:  strings.TrimSpace(defaults.ReasoningEffort),
		Speed:            strings.TrimSpace(defaults.Speed),
	}
}
