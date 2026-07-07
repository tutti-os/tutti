package eventstream

import (
	"context"
	"encoding/json"
	"fmt"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	preferencesservice "github.com/tutti-os/tutti/services/tuttid/service/preferences"
)

type PreferencesMutator interface {
	Put(context.Context, preferencesservice.PutInput) (preferencesbiz.DesktopPreferences, error)
}

type DesktopPreferencesPublisher struct {
	Service *Service
}

func (p DesktopPreferencesPublisher) PublishDesktopPreferencesUpdated(ctx context.Context, preferences preferencesbiz.DesktopPreferences) error {
	if p.Service == nil {
		return nil
	}
	payload, err := json.Marshal(desktopPreferencesUpdatedPayload{
		Initialized: preferences.Initialized,
		Preferences: desktopPreferencesSettingsPayload{
			AgentComposerDefaultsByProvider: desktopAgentComposerDefaultsByProviderPayloadFromBiz(
				preferences.AgentComposerDefaultsByProvider,
			),
			AgentComposerDefaultsByAgentTarget: desktopAgentComposerDefaultsByAgentTargetPayloadFromBiz(
				preferences.AgentComposerDefaultsByAgentTarget,
			),
			AgentGUIConversationRailCollapsedByProvider: agentGUIConversationRailCollapsedByProviderPayloadFromBiz(
				preferences.AgentGUIConversationRailCollapsedByProvider,
			),
			AgentConversationDetailMode: preferencesbiz.NormalizeDesktopAgentConversationDetailMode(preferences.AgentConversationDetailMode),
			AgentDockLayout:             preferencesbiz.NormalizeDesktopAgentDockLayout(preferences.AgentDockLayout),
			AppCatalogChannel:           preferences.AppCatalogChannel,
			BrowserUseConnectionMode:    preferences.BrowserUseConnectionMode,
			DefaultAgentProvider:        preferences.DefaultAgentProvider,
			DockIconStyle:               preferences.DockIconStyle,
			DockPlacement:               preferences.DockPlacement,
			EnableCursorAgent:           preferences.EnableCursorAgent,
			EnableOpenCodeAgent:         preferences.EnableOpenCodeAgent,
			FileDefaultOpenersByExtension: fileDefaultOpenersByExtensionPayloadFromBiz(
				preferences.FileDefaultOpenersByExtension,
			),
			Locale:                  preferences.Locale,
			MinimizeAnimation:       preferences.MinimizeAnimation,
			SleepPreventionMode:     preferences.SleepPreventionMode,
			ShowAppDeveloperSources: preferences.ShowAppDeveloperSources,
			ThemeSource:             preferences.ThemeSource,
			UpdateChannel:           preferences.UpdateChannel,
			UpdatePolicy:            preferences.UpdatePolicy,
			WorkbenchWindowSnapping: &desktopWorkbenchWindowSnappingPayload{
				Enabled:        preferences.WindowSnappingEnabled,
				ShortcutPreset: preferences.WindowSnappingShortcutPreset,
			},
		},
	})
	if err != nil {
		return fmt.Errorf("marshal desktop preferences updated payload: %w", err)
	}
	return p.Service.PublishFromServer(ctx, TopicPreferencesDesktopUpdated, payload)
}

func NewPreferencesDesktopUpdateRequestedHandler(mutator PreferencesMutator) IntentHandler {
	return func(ctx context.Context, event ClientEvent) error {
		if mutator == nil {
			return fmt.Errorf("preferences mutator is not configured")
		}

		decoded, err := decodeDesktopPreferencesMutationPayload(event.Payload)
		if err != nil {
			return err
		}

		_, err = mutator.Put(ctx, preferencesservice.PutInput{
			AgentComposerDefaultsByProvider:             decoded.AgentComposerDefaultsByProvider,
			AgentComposerDefaultsByAgentTarget:          decoded.AgentComposerDefaultsByAgentTarget,
			AgentGUIConversationRailCollapsedByProvider: decoded.AgentGUIConversationRailCollapsedByProvider,
			AgentConversationDetailMode:                 decoded.AgentConversationDetailMode,
			AgentDockLayout:                             decoded.AgentDockLayout,
			AppCatalogChannel:                           decoded.AppCatalogChannel,
			BrowserUseConnectionMode:                    decoded.BrowserUseConnectionMode,
			DefaultAgentProvider:                        decoded.DefaultAgentProvider,
			DockIconStyle:                               decoded.DockIconStyle,
			DockPlacement:                               decoded.DockPlacement,
			EnableCursorAgent:                           decoded.EnableCursorAgent,
			EnableOpenCodeAgent:                         decoded.EnableOpenCodeAgent,
			FileDefaultOpenersByExtension:               decoded.FileDefaultOpenersByExtension,
			Locale:                                      decoded.Locale,
			MinimizeAnimation:                           decoded.MinimizeAnimation,
			SleepPreventionMode:                         decoded.SleepPreventionMode,
			ShowAppDeveloperSources:                     decoded.ShowAppDeveloperSources,
			ThemeSource:                                 decoded.ThemeSource,
			UpdateChannel:                               decoded.UpdateChannel,
			UpdatePolicy:                                decoded.UpdatePolicy,
			WindowSnapping:                              decoded.WindowSnapping,
		})
		if err != nil {
			return fmt.Errorf("put desktop preferences: %w", err)
		}
		return nil
	}
}

type decodedDesktopPreferencesMutationPayload struct {
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
	Locale                                      string
	MinimizeAnimation                           string
	SleepPreventionMode                         string
	ShowAppDeveloperSources                     bool
	ThemeSource                                 string
	UpdateChannel                               string
	UpdatePolicy                                string
	WindowSnapping                              *preferencesservice.DesktopWindowSnappingInput
}

func decodeDesktopPreferencesMutationPayload(payload []byte) (decodedDesktopPreferencesMutationPayload, error) {
	var decoded desktopPreferencesMutationPayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return decodedDesktopPreferencesMutationPayload{}, fmt.Errorf("decode payload: %w", err)
	}
	var windowSnapping *preferencesservice.DesktopWindowSnappingInput
	if decoded.Preferences.WorkbenchWindowSnapping != nil {
		windowSnapping = &preferencesservice.DesktopWindowSnappingInput{
			Enabled:        decoded.Preferences.WorkbenchWindowSnapping.Enabled,
			ShortcutPreset: decoded.Preferences.WorkbenchWindowSnapping.ShortcutPreset,
		}
	}

	return decodedDesktopPreferencesMutationPayload{
		AgentComposerDefaultsByProvider: agentComposerDefaultsByProviderFromPayload(
			decoded.Preferences.AgentComposerDefaultsByProvider,
		),
		AgentComposerDefaultsByAgentTarget: agentComposerDefaultsByAgentTargetFromPayload(
			decoded.Preferences.AgentComposerDefaultsByAgentTarget,
		),
		AgentGUIConversationRailCollapsedByProvider: agentGUIConversationRailCollapsedByProviderFromPayload(
			decoded.Preferences.AgentGUIConversationRailCollapsedByProvider,
		),
		AgentConversationDetailMode: decoded.Preferences.AgentConversationDetailMode,
		AgentDockLayout:             decoded.Preferences.AgentDockLayout,
		AppCatalogChannel:           decoded.Preferences.AppCatalogChannel,
		BrowserUseConnectionMode:    decoded.Preferences.BrowserUseConnectionMode,
		DefaultAgentProvider:        decoded.Preferences.DefaultAgentProvider,
		DockIconStyle:               decoded.Preferences.DockIconStyle,
		DockPlacement:               decoded.Preferences.DockPlacement,
		EnableCursorAgent:           decoded.Preferences.EnableCursorAgent,
		EnableOpenCodeAgent:         decoded.Preferences.EnableOpenCodeAgent,
		FileDefaultOpenersByExtension: fileDefaultOpenersByExtensionFromPayload(
			decoded.Preferences.FileDefaultOpenersByExtension,
		),
		Locale:                  decoded.Preferences.Locale,
		MinimizeAnimation:       decoded.Preferences.MinimizeAnimation,
		SleepPreventionMode:     decoded.Preferences.SleepPreventionMode,
		ShowAppDeveloperSources: decoded.Preferences.ShowAppDeveloperSources,
		ThemeSource:             decoded.Preferences.ThemeSource,
		UpdateChannel:           decoded.Preferences.UpdateChannel,
		UpdatePolicy:            decoded.Preferences.UpdatePolicy,
		WindowSnapping:          windowSnapping,
	}, nil
}

func fileDefaultOpenersByExtensionPayloadFromBiz(
	openersByExtension map[string]string,
) desktopFileDefaultOpenersByExtensionPayload {
	payload := desktopFileDefaultOpenersByExtensionPayload{}
	for extension, opener := range openersByExtension {
		normalizedExtension := preferencesbiz.NormalizeDesktopFileExtension(extension)
		if normalizedExtension == "" || !preferencesbiz.IsDesktopFileDefaultOpener(opener) {
			continue
		}
		payload[normalizedExtension] = opener
	}
	return payload
}

func fileDefaultOpenersByExtensionFromPayload(
	payload desktopFileDefaultOpenersByExtensionPayload,
) map[string]string {
	if payload == nil {
		return nil
	}
	openersByExtension := map[string]string{}
	for extension, opener := range payload {
		normalizedExtension := preferencesbiz.NormalizeDesktopFileExtension(extension)
		if normalizedExtension == "" || !preferencesbiz.IsDesktopFileDefaultOpener(opener) {
			continue
		}
		openersByExtension[normalizedExtension] = opener
	}
	return openersByExtension
}

func agentGUIConversationRailCollapsedByProviderPayloadFromBiz(
	collapsedByProvider map[string]bool,
) desktopAgentGUIConversationRailCollapsedByProviderPayload {
	payload := desktopAgentGUIConversationRailCollapsedByProviderPayload{}
	for provider, collapsed := range collapsedByProvider {
		normalizedProvider := agentproviderbiz.Normalize(provider)
		if normalizedProvider == "" {
			continue
		}
		payload[normalizedProvider] = collapsed
	}
	return payload
}

func agentGUIConversationRailCollapsedByProviderFromPayload(
	payload desktopAgentGUIConversationRailCollapsedByProviderPayload,
) map[string]bool {
	collapsedByProvider := map[string]bool{}
	for provider, collapsed := range payload {
		normalizedProvider := agentproviderbiz.Normalize(provider)
		if normalizedProvider == "" {
			continue
		}
		collapsedByProvider[normalizedProvider] = collapsed
	}
	return collapsedByProvider
}

func desktopAgentComposerDefaultsByProviderPayloadFromBiz(
	defaultsByProvider map[string]preferencesbiz.AgentComposerDefaults,
) desktopAgentComposerDefaultsByProviderPayload {
	payload := desktopAgentComposerDefaultsByProviderPayload{}
	for provider, defaults := range defaultsByProvider {
		normalizedProvider := agentproviderbiz.Normalize(provider)
		if normalizedProvider == "" {
			continue
		}
		normalizedDefaults := desktopAgentComposerDefaultsPayloadFromBiz(defaults)
		if normalizedDefaults.isZero() {
			continue
		}
		payload[normalizedProvider] = normalizedDefaults
	}
	return payload
}

func desktopAgentComposerDefaultsByAgentTargetPayloadFromBiz(
	defaultsByAgentTarget map[string]preferencesbiz.AgentComposerDefaults,
) desktopAgentComposerDefaultsByAgentTargetPayload {
	payload := desktopAgentComposerDefaultsByAgentTargetPayload{}
	for agentTargetID, defaults := range defaultsByAgentTarget {
		if agentTargetID == "" {
			continue
		}
		normalizedDefaults := desktopAgentComposerDefaultsPayloadFromBiz(defaults)
		if normalizedDefaults.isZero() {
			continue
		}
		payload[agentTargetID] = normalizedDefaults
	}
	return payload
}

func desktopAgentComposerDefaultsPayloadFromBiz(
	defaults preferencesbiz.AgentComposerDefaults,
) desktopAgentComposerDefaultsPayload {
	return desktopAgentComposerDefaultsPayload{
		Model:            defaults.Model,
		PermissionModeID: defaults.PermissionModeID,
		ReasoningEffort:  defaults.ReasoningEffort,
		Speed:            defaults.Speed,
	}
}

func agentComposerDefaultsByProviderFromPayload(
	payload desktopAgentComposerDefaultsByProviderPayload,
) map[string]preferencesbiz.AgentComposerDefaults {
	defaultsByProvider := map[string]preferencesbiz.AgentComposerDefaults{}
	for provider, defaults := range payload {
		normalizedProvider := agentproviderbiz.Normalize(provider)
		if normalizedProvider == "" {
			continue
		}
		defaultsByProvider[normalizedProvider] = agentComposerDefaultsFromPayload(defaults)
	}
	return defaultsByProvider
}

func agentComposerDefaultsByAgentTargetFromPayload(
	payload desktopAgentComposerDefaultsByAgentTargetPayload,
) map[string]preferencesbiz.AgentComposerDefaults {
	// A missing field decodes to nil so the service keeps the stored
	// defaults; only an explicitly sent (possibly empty) map replaces them.
	if payload == nil {
		return nil
	}
	defaultsByAgentTarget := map[string]preferencesbiz.AgentComposerDefaults{}
	for agentTargetID, defaults := range payload {
		if agentTargetID == "" {
			continue
		}
		defaultsByAgentTarget[agentTargetID] = agentComposerDefaultsFromPayload(defaults)
	}
	return defaultsByAgentTarget
}

func agentComposerDefaultsFromPayload(
	defaults desktopAgentComposerDefaultsPayload,
) preferencesbiz.AgentComposerDefaults {
	return preferencesbiz.AgentComposerDefaults{
		Model:            defaults.Model,
		PermissionModeID: defaults.PermissionModeID,
		ReasoningEffort:  defaults.ReasoningEffort,
		Speed:            defaults.Speed,
	}
}
