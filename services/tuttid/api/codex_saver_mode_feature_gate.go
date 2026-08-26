package api

import (
	"context"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

func (api DaemonAPI) codexSaverModeEnabled(ctx context.Context) bool {
	if api.PreferencesService == nil {
		return false
	}
	preferences, err := api.PreferencesService.Get(ctx)
	if err != nil {
		return false
	}
	return preferencesbiz.IsLabFlagEnabled(
		preferences.FeatureFlags,
		preferencesbiz.LabFlagCodexSaverMode,
	)
}

func (api DaemonAPI) rtkSaverModeEnabled(ctx context.Context) bool {
	if api.PreferencesService == nil {
		return false
	}
	preferences, err := api.PreferencesService.Get(ctx)
	if err != nil {
		return false
	}
	return preferencesbiz.IsLabFlagEnabled(
		preferences.FeatureFlags,
		preferencesbiz.LabFlagRTKSaverMode,
	)
}
