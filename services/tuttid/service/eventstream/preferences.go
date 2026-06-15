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
			DefaultAgentProvider: preferences.DefaultAgentProvider,
			DockIconStyle:        preferences.DockIconStyle,
			DockPlacement:        preferences.DockPlacement,
			Locale:               preferences.Locale,
			SleepPreventionMode:  preferences.SleepPreventionMode,
			ThemeSource:          preferences.ThemeSource,
			UpdateChannel:        preferences.UpdateChannel,
			UpdatePolicy:         preferences.UpdatePolicy,
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
			AgentComposerDefaultsByProvider: decoded.AgentComposerDefaultsByProvider,
			DefaultAgentProvider:            decoded.DefaultAgentProvider,
			DockIconStyle:                   decoded.DockIconStyle,
			DockPlacement:                   decoded.DockPlacement,
			Locale:                          decoded.Locale,
			SleepPreventionMode:             decoded.SleepPreventionMode,
			ThemeSource:                     decoded.ThemeSource,
			UpdateChannel:                   decoded.UpdateChannel,
			UpdatePolicy:                    decoded.UpdatePolicy,
		})
		if err != nil {
			return fmt.Errorf("put desktop preferences: %w", err)
		}
		return nil
	}
}

type decodedDesktopPreferencesMutationPayload struct {
	AgentComposerDefaultsByProvider map[string]preferencesbiz.AgentComposerDefaults
	DefaultAgentProvider            string
	DockIconStyle                   string
	DockPlacement                   string
	Locale                          string
	SleepPreventionMode             string
	ThemeSource                     string
	UpdateChannel                   string
	UpdatePolicy                    string
}

func decodeDesktopPreferencesMutationPayload(payload []byte) (decodedDesktopPreferencesMutationPayload, error) {
	var decoded desktopPreferencesMutationPayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return decodedDesktopPreferencesMutationPayload{}, fmt.Errorf("decode payload: %w", err)
	}
	return decodedDesktopPreferencesMutationPayload{
		AgentComposerDefaultsByProvider: agentComposerDefaultsByProviderFromPayload(
			decoded.Preferences.AgentComposerDefaultsByProvider,
		),
		DefaultAgentProvider: decoded.Preferences.DefaultAgentProvider,
		DockIconStyle:        decoded.Preferences.DockIconStyle,
		DockPlacement:        decoded.Preferences.DockPlacement,
		Locale:               decoded.Preferences.Locale,
		SleepPreventionMode:  decoded.Preferences.SleepPreventionMode,
		ThemeSource:          decoded.Preferences.ThemeSource,
		UpdateChannel:        decoded.Preferences.UpdateChannel,
		UpdatePolicy:         decoded.Preferences.UpdatePolicy,
	}, nil
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
		normalizedDefaults := desktopAgentComposerDefaultsPayload{
			Model:            defaults.Model,
			PermissionModeID: defaults.PermissionModeID,
			ReasoningEffort:  defaults.ReasoningEffort,
		}
		if normalizedDefaults.Model == "" &&
			normalizedDefaults.PermissionModeID == "" &&
			normalizedDefaults.ReasoningEffort == "" {
			continue
		}
		payload[normalizedProvider] = normalizedDefaults
	}
	return payload
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
		defaultsByProvider[normalizedProvider] = preferencesbiz.AgentComposerDefaults{
			Model:            defaults.Model,
			PermissionModeID: defaults.PermissionModeID,
			ReasoningEffort:  defaults.ReasoningEffort,
		}
	}
	return defaultsByProvider
}
