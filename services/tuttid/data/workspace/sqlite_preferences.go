package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

const desktopPreferencesRowID = "desktop"

func (s *SQLiteStore) GetDesktopPreferences(ctx context.Context) (preferencesbiz.DesktopPreferences, error) {
	if s == nil || s.db == nil {
		return preferencesbiz.DesktopPreferences{}, errors.New("workspace database is not initialized")
	}

	row := s.db.QueryRowContext(ctx, `
SELECT default_agent_provider, dock_icon_style, dock_placement, locale, theme_source, sleep_prevention_mode, update_channel, update_policy, agent_composer_defaults_by_provider_json
FROM desktop_preferences
WHERE id = ?
`, desktopPreferencesRowID)

	var defaultAgentProvider string
	var dockIconStyle string
	var dockPlacement string
	var locale string
	var themeSource string
	var sleepPreventionMode string
	var updateChannel string
	var updatePolicy string
	var agentComposerDefaultsJSON string
	if err := row.Scan(&defaultAgentProvider, &dockIconStyle, &dockPlacement, &locale, &themeSource, &sleepPreventionMode, &updateChannel, &updatePolicy, &agentComposerDefaultsJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return preferencesbiz.DefaultDesktopPreferences(), nil
		}
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("get desktop preferences: %w", err)
	}
	agentComposerDefaults, err := decodeAgentComposerDefaultsByProvider(agentComposerDefaultsJSON)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("decode desktop preferences agent composer defaults: %w", err)
	}

	return preferencesbiz.DesktopPreferences{
		AgentComposerDefaultsByProvider: agentComposerDefaults,
		DefaultAgentProvider:            defaultAgentProvider,
		DockIconStyle:                   dockIconStyle,
		DockPlacement:                   dockPlacement,
		Initialized:                     true,
		Locale:                          locale,
		SleepPreventionMode:             sleepPreventionMode,
		ThemeSource:                     themeSource,
		UpdateChannel:                   updateChannel,
		UpdatePolicy:                    updatePolicy,
	}, nil
}

func (s *SQLiteStore) PutDesktopPreferences(ctx context.Context, preferences preferencesbiz.DesktopPreferences) (preferencesbiz.DesktopPreferences, error) {
	if s == nil || s.db == nil {
		return preferencesbiz.DesktopPreferences{}, errors.New("workspace database is not initialized")
	}

	now := unixMs(time.Now().UTC())
	agentComposerDefaultsJSON, err := encodeAgentComposerDefaultsByProvider(preferences.AgentComposerDefaultsByProvider)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("encode desktop preferences agent composer defaults: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO desktop_preferences (
  id,
  default_agent_provider,
  dock_icon_style,
  dock_placement,
  locale,
  theme_source,
  sleep_prevention_mode,
  update_channel,
  update_policy,
  agent_composer_defaults_by_provider_json,
  updated_at_unix_ms
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  default_agent_provider = excluded.default_agent_provider,
  dock_icon_style = excluded.dock_icon_style,
  dock_placement = excluded.dock_placement,
  locale = excluded.locale,
  theme_source = excluded.theme_source,
  sleep_prevention_mode = excluded.sleep_prevention_mode,
  update_channel = excluded.update_channel,
  update_policy = excluded.update_policy,
  agent_composer_defaults_by_provider_json = excluded.agent_composer_defaults_by_provider_json,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, desktopPreferencesRowID, preferences.DefaultAgentProvider, preferences.DockIconStyle, preferences.DockPlacement, preferences.Locale, preferences.ThemeSource, preferences.SleepPreventionMode, preferences.UpdateChannel, preferences.UpdatePolicy, agentComposerDefaultsJSON, now)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("put desktop preferences: %w", err)
	}

	return preferencesbiz.DesktopPreferences{
		AgentComposerDefaultsByProvider: preferences.AgentComposerDefaultsByProvider,
		DefaultAgentProvider:            preferences.DefaultAgentProvider,
		DockIconStyle:                   preferences.DockIconStyle,
		DockPlacement:                   preferences.DockPlacement,
		Initialized:                     true,
		Locale:                          preferences.Locale,
		SleepPreventionMode:             preferences.SleepPreventionMode,
		ThemeSource:                     preferences.ThemeSource,
		UpdateChannel:                   preferences.UpdateChannel,
		UpdatePolicy:                    preferences.UpdatePolicy,
	}, nil
}

func decodeAgentComposerDefaultsByProvider(raw string) (map[string]preferencesbiz.AgentComposerDefaults, error) {
	if raw == "" {
		return map[string]preferencesbiz.AgentComposerDefaults{}, nil
	}
	var decoded map[string]preferencesbiz.AgentComposerDefaults
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, err
	}
	if decoded == nil {
		return map[string]preferencesbiz.AgentComposerDefaults{}, nil
	}
	return decoded, nil
}

func encodeAgentComposerDefaultsByProvider(value map[string]preferencesbiz.AgentComposerDefaults) (string, error) {
	if value == nil {
		value = map[string]preferencesbiz.AgentComposerDefaults{}
	}
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(data), nil
}
