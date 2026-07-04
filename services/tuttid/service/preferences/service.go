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
	AgentComposerDefaultsByProvider             map[string]preferencesbiz.AgentComposerDefaults
	AgentGUIConversationRailCollapsedByProvider map[string]bool
	AgentConversationDetailMode                 string
	AgentDockLayout                             string
	AppCatalogChannel                           string
	BrowserUseConnectionMode                    string
	DefaultAgentProvider                        string
	DockIconStyle                               string
	DockPlacement                               string
	FileDefaultOpenersByExtension               map[string]string
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

	windowSnapping, err := s.resolveWindowSnapping(ctx, input.WindowSnapping)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, err
	}

	preferences, err := s.Store.PutDesktopPreferences(ctx, preferencesbiz.DesktopPreferences{
		AgentComposerDefaultsByProvider:             normalizeAgentComposerDefaultsByProvider(input.AgentComposerDefaultsByProvider),
		AgentGUIConversationRailCollapsedByProvider: normalizeAgentGUIConversationRailCollapsedByProvider(input.AgentGUIConversationRailCollapsedByProvider),
		AgentConversationDetailMode:                 preferencesbiz.NormalizeDesktopAgentConversationDetailMode(input.AgentConversationDetailMode),
		AgentDockLayout:                             normalizeAgentDockLayout(input.AgentDockLayout),
		AppCatalogChannel:                           normalizeAppCatalogChannel(input.AppCatalogChannel),
		BrowserUseConnectionMode:                    normalizeBrowserUseConnectionMode(input.BrowserUseConnectionMode),
		DefaultAgentProvider:                        agentproviderbiz.Normalize(input.DefaultAgentProvider),
		DockIconStyle:                               strings.TrimSpace(input.DockIconStyle),
		DockPlacement:                               strings.TrimSpace(input.DockPlacement),
		FileDefaultOpenersByExtension:               normalizeFileDefaultOpenersByExtension(input.FileDefaultOpenersByExtension),
		Initialized:                                 true,
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

func (s Service) resolveWindowSnapping(ctx context.Context, input *DesktopWindowSnappingInput) (DesktopWindowSnappingInput, error) {
	if input != nil {
		return DesktopWindowSnappingInput{
			Enabled:        input.Enabled,
			ShortcutPreset: normalizeWindowSnappingShortcutPreset(input.ShortcutPreset),
		}, nil
	}

	preferences, err := s.Store.GetDesktopPreferences(ctx)
	if err != nil {
		return DesktopWindowSnappingInput{}, err
	}
	return DesktopWindowSnappingInput{
		Enabled:        preferences.WindowSnappingEnabled,
		ShortcutPreset: normalizeWindowSnappingShortcutPreset(preferences.WindowSnappingShortcutPreset),
	}, nil
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

func normalizeAgentComposerDefaultsByProvider(input map[string]preferencesbiz.AgentComposerDefaults) map[string]preferencesbiz.AgentComposerDefaults {
	result := map[string]preferencesbiz.AgentComposerDefaults{}
	for provider, defaults := range input {
		normalizedProvider := agentproviderbiz.Normalize(provider)
		if normalizedProvider == "" {
			continue
		}
		normalizedDefaults := preferencesbiz.AgentComposerDefaults{
			Model:            strings.TrimSpace(defaults.Model),
			PermissionModeID: strings.TrimSpace(defaults.PermissionModeID),
			ReasoningEffort:  strings.TrimSpace(defaults.ReasoningEffort),
		}
		if normalizedDefaults.Model == "" &&
			normalizedDefaults.PermissionModeID == "" &&
			normalizedDefaults.ReasoningEffort == "" {
			continue
		}
		result[normalizedProvider] = normalizedDefaults
	}
	return result
}
