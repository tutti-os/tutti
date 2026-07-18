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

type AgentComposerDefaultsPatcher interface {
	PatchAgentComposerDefaultsForTarget(context.Context, preferencesservice.PatchAgentComposerDefaultsForTargetInput) (preferencesbiz.AgentComposerDefaults, error)
}

func preferencesTopicDefinitions() []TopicDefinition {
	return []TopicDefinition{
		{
			Name:               TopicPreferencesAgentComposerDefaultsChanged,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateAgentComposerDefaultsChangedPayload,
			},
		},
		{
			Name:               TopicPreferencesAgentComposerDefaultsPatchRequested,
			ClientCanPublish:   true,
			ClientCanSubscribe: false,
			Version:            1,
			directions:         []Direction{DirectionClientToServer},
			validators: map[Direction]PayloadValidator{
				DirectionClientToServer: validateAgentComposerDefaultsPatchRequestedPayload,
			},
		},
		{
			Name:               TopicPreferencesDesktopUpdateRequested,
			ClientCanPublish:   true,
			ClientCanSubscribe: false,
			Version:            1,
			directions:         []Direction{DirectionClientToServer},
			validators: map[Direction]PayloadValidator{
				DirectionClientToServer: validateDesktopPreferencesUpdateRequestedPayload,
			},
		},
		{
			Name:               TopicPreferencesDesktopUpdated,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateDesktopPreferencesUpdatedPayload,
			},
		},
	}
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
			AgentConversationDetailMode:           preferencesbiz.NormalizeDesktopAgentConversationDetailMode(preferences.AgentConversationDetailMode),
			AgentDockLayout:                       preferencesbiz.NormalizeDesktopAgentDockLayout(preferences.AgentDockLayout),
			AppCatalogChannel:                     preferences.AppCatalogChannel,
			BrowserUseConnectionMode:              preferences.BrowserUseConnectionMode,
			DefaultAgentProvider:                  preferences.DefaultAgentProvider,
			DockIconStyle:                         preferences.DockIconStyle,
			DockPlacement:                         preferences.DockPlacement,
			DeletedAgentConversationRetentionDays: preferencesbiz.NormalizeDeletedAgentConversationRetentionDays(preferences.DeletedAgentConversationRetentionDays),
			FileDefaultOpenersByExtension: fileDefaultOpenersByExtensionPayloadFromBiz(
				preferences.FileDefaultOpenersByExtension,
			),
			FeatureFlags: preferences.FeatureFlags,
			WorkbenchShortcuts: desktopWorkbenchShortcutsPayload{
				NewAgentConversation: shortcutPointerFromBiz(preferences.WorkbenchShortcuts.NewAgentConversation),
				NewSameTypeWindow:    shortcutPointerFromBiz(preferences.WorkbenchShortcuts.NewSameTypeWindow),
			},
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

func (p DesktopPreferencesPublisher) PublishAgentComposerDefaultsChanged(ctx context.Context, agentTargetID string) error {
	if p.Service == nil {
		return nil
	}
	payload, err := json.Marshal(agentComposerDefaultsChangedPayload{
		AgentTargetID: agentTargetID,
	})
	if err != nil {
		return fmt.Errorf("marshal agent composer defaults changed payload: %w", err)
	}
	return p.Service.PublishFromServer(ctx, TopicPreferencesAgentComposerDefaultsChanged, payload)
}

func NewPreferencesAgentComposerDefaultsPatchRequestedHandler(
	patcher AgentComposerDefaultsPatcher,
) IntentHandler {
	return func(ctx context.Context, event ClientEvent) error {
		if patcher == nil {
			return fmt.Errorf("agent composer defaults patcher is not configured")
		}
		var decoded agentComposerDefaultsPatchRequestedPayload
		if err := json.Unmarshal(event.Payload, &decoded); err != nil {
			return fmt.Errorf("decode payload: %w", err)
		}
		if _, err := patcher.PatchAgentComposerDefaultsForTarget(ctx, preferencesservice.PatchAgentComposerDefaultsForTargetInput{
			AgentTargetID: decoded.AgentTargetID,
			Patch:         decoded.Patch,
		}); err != nil {
			return fmt.Errorf("patch agent composer defaults: %w", err)
		}
		return nil
	}
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
			DeletedAgentConversationRetentionDays:       decoded.DeletedAgentConversationRetentionDays,
			FileDefaultOpenersByExtension:               decoded.FileDefaultOpenersByExtension,
			FeatureFlags:                                decoded.FeatureFlags,
			WorkbenchShortcuts:                          decoded.WorkbenchShortcuts,
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
	DeletedAgentConversationRetentionDays       int
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
	deletedAgentConversationRetentionDays := decoded.Preferences.DeletedAgentConversationRetentionDays
	if deletedAgentConversationRetentionDays == 0 {
		deletedAgentConversationRetentionDays = preferencesbiz.DefaultDeletedAgentConversationRetentionDays
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
		AgentConversationDetailMode:           decoded.Preferences.AgentConversationDetailMode,
		AgentDockLayout:                       decoded.Preferences.AgentDockLayout,
		AppCatalogChannel:                     decoded.Preferences.AppCatalogChannel,
		BrowserUseConnectionMode:              decoded.Preferences.BrowserUseConnectionMode,
		DefaultAgentProvider:                  decoded.Preferences.DefaultAgentProvider,
		DockIconStyle:                         decoded.Preferences.DockIconStyle,
		DockPlacement:                         decoded.Preferences.DockPlacement,
		DeletedAgentConversationRetentionDays: deletedAgentConversationRetentionDays,
		FileDefaultOpenersByExtension: fileDefaultOpenersByExtensionFromPayload(
			decoded.Preferences.FileDefaultOpenersByExtension,
		),
		FeatureFlags: preferencesbiz.NormalizeDesktopFeatureFlags(decoded.Preferences.FeatureFlags),
		WorkbenchShortcuts: preferencesbiz.DesktopWorkbenchShortcuts{
			NewAgentConversation: shortcutStringFromPayload(decoded.Preferences.WorkbenchShortcuts.NewAgentConversation),
			NewSameTypeWindow:    shortcutStringFromPayload(decoded.Preferences.WorkbenchShortcuts.NewSameTypeWindow),
		},
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

func shortcutPointerFromBiz(value string) *string {
	normalized := preferencesbiz.NormalizeDesktopShortcutBinding(value)
	if normalized == "" {
		return nil
	}
	return &normalized
}

func shortcutStringFromPayload(value *string) string {
	if value == nil {
		return ""
	}
	return preferencesbiz.NormalizeDesktopShortcutBinding(*value)
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
