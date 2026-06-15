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

	preferences, err := s.Store.PutDesktopPreferences(ctx, preferencesbiz.DesktopPreferences{
		AgentComposerDefaultsByProvider: normalizeAgentComposerDefaultsByProvider(input.AgentComposerDefaultsByProvider),
		DefaultAgentProvider:            agentproviderbiz.Normalize(input.DefaultAgentProvider),
		DockIconStyle:                   strings.TrimSpace(input.DockIconStyle),
		DockPlacement:                   strings.TrimSpace(input.DockPlacement),
		Initialized:                     true,
		Locale:                          strings.TrimSpace(input.Locale),
		SleepPreventionMode:             strings.TrimSpace(input.SleepPreventionMode),
		ThemeSource:                     strings.TrimSpace(input.ThemeSource),
		UpdateChannel:                   strings.TrimSpace(input.UpdateChannel),
		UpdatePolicy:                    strings.TrimSpace(input.UpdatePolicy),
	})
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, err
	}
	if s.Publisher != nil {
		_ = s.Publisher.PublishDesktopPreferencesUpdated(ctx, preferences)
	}
	return preferences, nil
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
