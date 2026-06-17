package api

import (
	"context"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	preferencesapi "github.com/tutti-os/tutti/services/tuttid/api/preferences"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	preferencesservice "github.com/tutti-os/tutti/services/tuttid/service/preferences"
)

func (api DaemonAPI) GetDesktopPreferences(ctx context.Context, _ tuttigenerated.GetDesktopPreferencesRequestObject) (tuttigenerated.GetDesktopPreferencesResponseObject, error) {
	if api.PreferencesService == nil {
		return tuttigenerated.GetDesktopPreferences503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.PreferencesServiceUnavailable(
					apierrors.WithDeveloperMessage("desktop preferences service is unavailable"),
				),
			),
		}, nil
	}

	preferences, err := api.PreferencesService.Get(ctx)
	if err != nil {
		return tuttigenerated.GetDesktopPreferences502JSONResponse{
			PreferencesOperationErrorJSONResponse: preferencesOperationError(
				apierrors.PreferencesOperationFailed(apierrors.WithCause(err)),
			),
		}, nil
	}

	return tuttigenerated.GetDesktopPreferences200JSONResponse(
		preferencesapi.GeneratedDesktopPreferencesStateResponseFromBiz(preferences),
	), nil
}

func (api DaemonAPI) PutDesktopPreferences(ctx context.Context, request tuttigenerated.PutDesktopPreferencesRequestObject) (tuttigenerated.PutDesktopPreferencesResponseObject, error) {
	if api.PreferencesService == nil {
		return tuttigenerated.PutDesktopPreferences503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.PreferencesServiceUnavailable(
					apierrors.WithDeveloperMessage("desktop preferences service is unavailable"),
				),
			),
		}, nil
	}

	if request.Body == nil {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")),
			),
		}, nil
	}

	defaultAgentProvider := agentproviderbiz.Normalize(string(request.Body.Preferences.DefaultAgentProvider))
	if defaultAgentProvider == "" {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					apierrors.ReasonUnsupportedDesktopDefaultAgentProvider,
					apierrors.WithDeveloperMessage("desktop default agent provider is unsupported"),
					apierrors.WithParams(map[string]any{"field": "preferences.defaultAgentProvider"}),
				),
			),
		}, nil
	}

	dockIconStyle := strings.TrimSpace(string(request.Body.Preferences.DockIconStyle))
	if dockIconStyle == "" {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					apierrors.ReasonMissingDesktopDockIconStyle,
					apierrors.WithDeveloperMessage("desktop dock icon style is required"),
					apierrors.WithParams(map[string]any{"field": "preferences.dockIconStyle"}),
				),
			),
		}, nil
	}
	if !preferencesbiz.IsDesktopDockIconStyle(dockIconStyle) {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					apierrors.ReasonUnsupportedDesktopDockIconStyle,
					apierrors.WithDeveloperMessage("desktop dock icon style is unsupported"),
					apierrors.WithParams(map[string]any{"field": "preferences.dockIconStyle"}),
				),
			),
		}, nil
	}

	dockPlacement := strings.TrimSpace(string(request.Body.Preferences.DockPlacement))
	if dockPlacement == "" {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					apierrors.ReasonMissingDesktopDockPlacement,
					apierrors.WithDeveloperMessage("desktop dock placement is required"),
					apierrors.WithParams(map[string]any{"field": "preferences.dockPlacement"}),
				),
			),
		}, nil
	}
	if !preferencesbiz.IsDesktopDockPlacement(dockPlacement) {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					apierrors.ReasonUnsupportedDesktopDockPlacement,
					apierrors.WithDeveloperMessage("desktop dock placement is unsupported"),
					apierrors.WithParams(map[string]any{"field": "preferences.dockPlacement"}),
				),
			),
		}, nil
	}

	browserUseConnectionMode := preferencesbiz.DefaultDesktopBrowserUseConnectionMode
	if request.Body.Preferences.BrowserUseConnectionMode != nil {
		browserUseConnectionMode = strings.TrimSpace(string(*request.Body.Preferences.BrowserUseConnectionMode))
		if browserUseConnectionMode == "" {
			return tuttigenerated.PutDesktopPreferences400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(
					apierrors.InvalidRequest(
						apierrors.ReasonMissingDesktopBrowserUseConnectionMode,
						apierrors.WithDeveloperMessage("desktop browser use connection mode is required when provided"),
						apierrors.WithParams(map[string]any{"field": "preferences.browserUseConnectionMode"}),
					),
				),
			}, nil
		}
		if !preferencesbiz.IsDesktopBrowserUseConnectionMode(browserUseConnectionMode) {
			return tuttigenerated.PutDesktopPreferences400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(
					apierrors.InvalidRequest(
						apierrors.ReasonUnsupportedDesktopBrowserUseConnectionMode,
						apierrors.WithDeveloperMessage("desktop browser use connection mode is unsupported"),
						apierrors.WithParams(map[string]any{"field": "preferences.browserUseConnectionMode"}),
					),
				),
			}, nil
		}
	}

	locale := strings.TrimSpace(string(request.Body.Preferences.Locale))
	if locale == "" {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					apierrors.ReasonMissingDesktopLocale,
					apierrors.WithDeveloperMessage("desktop locale is required"),
					apierrors.WithParams(map[string]any{"field": "preferences.locale"}),
				),
			),
		}, nil
	}
	if !preferencesbiz.IsDesktopLocale(locale) {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					apierrors.ReasonUnsupportedDesktopLocale,
					apierrors.WithDeveloperMessage("desktop locale is unsupported"),
					apierrors.WithParams(map[string]any{"field": "preferences.locale"}),
				),
			),
		}, nil
	}

	sleepPreventionMode := strings.TrimSpace(string(request.Body.Preferences.SleepPreventionMode))
	if sleepPreventionMode == "" {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					apierrors.ReasonMissingDesktopSleepPreventionMode,
					apierrors.WithDeveloperMessage("desktop sleep prevention mode is required"),
					apierrors.WithParams(map[string]any{"field": "preferences.sleepPreventionMode"}),
				),
			),
		}, nil
	}
	if !preferencesbiz.IsDesktopSleepPreventionMode(sleepPreventionMode) {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					apierrors.ReasonUnsupportedDesktopSleepPreventionMode,
					apierrors.WithDeveloperMessage("desktop sleep prevention mode is unsupported"),
					apierrors.WithParams(map[string]any{"field": "preferences.sleepPreventionMode"}),
				),
			),
		}, nil
	}

	themeSource := strings.TrimSpace(string(request.Body.Preferences.ThemeSource))
	if themeSource == "" {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					apierrors.ReasonMissingDesktopThemeSource,
					apierrors.WithDeveloperMessage("desktop theme source is required"),
					apierrors.WithParams(map[string]any{"field": "preferences.themeSource"}),
				),
			),
		}, nil
	}
	if !preferencesbiz.IsDesktopThemeSource(themeSource) {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					apierrors.ReasonUnsupportedDesktopThemeSource,
					apierrors.WithDeveloperMessage("desktop theme source is unsupported"),
					apierrors.WithParams(map[string]any{"field": "preferences.themeSource"}),
				),
			),
		}, nil
	}

	updateChannel := strings.TrimSpace(string(request.Body.Preferences.UpdateChannel))
	if updateChannel == "" {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					apierrors.ReasonMissingDesktopUpdateChannel,
					apierrors.WithDeveloperMessage("desktop update channel is required"),
					apierrors.WithParams(map[string]any{"field": "preferences.updateChannel"}),
				),
			),
		}, nil
	}
	if !preferencesbiz.IsDesktopUpdateChannel(updateChannel) {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					apierrors.ReasonUnsupportedDesktopUpdateChannel,
					apierrors.WithDeveloperMessage("desktop update channel is unsupported"),
					apierrors.WithParams(map[string]any{"field": "preferences.updateChannel"}),
				),
			),
		}, nil
	}

	updatePolicy := strings.TrimSpace(string(request.Body.Preferences.UpdatePolicy))
	if updatePolicy == "" {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					apierrors.ReasonMissingDesktopUpdatePolicy,
					apierrors.WithDeveloperMessage("desktop update policy is required"),
					apierrors.WithParams(map[string]any{"field": "preferences.updatePolicy"}),
				),
			),
		}, nil
	}
	if !preferencesbiz.IsDesktopUpdatePolicy(updatePolicy) {
		return tuttigenerated.PutDesktopPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(
					apierrors.ReasonUnsupportedDesktopUpdatePolicy,
					apierrors.WithDeveloperMessage("desktop update policy is unsupported"),
					apierrors.WithParams(map[string]any{"field": "preferences.updatePolicy"}),
				),
			),
		}, nil
	}

	preferences, err := api.PreferencesService.Put(ctx, preferencesservice.PutInput{
		AgentComposerDefaultsByProvider: agentComposerDefaultsByProviderFromGenerated(
			request.Body.Preferences.AgentComposerDefaultsByProvider,
		),
		BrowserUseConnectionMode: browserUseConnectionMode,
		DefaultAgentProvider:     defaultAgentProvider,
		DockIconStyle:            dockIconStyle,
		DockPlacement:            dockPlacement,
		Locale:                   locale,
		SleepPreventionMode:      sleepPreventionMode,
		ThemeSource:              themeSource,
		UpdateChannel:            updateChannel,
		UpdatePolicy:             updatePolicy,
	})
	if err != nil {
		return tuttigenerated.PutDesktopPreferences502JSONResponse{
			PreferencesOperationErrorJSONResponse: preferencesOperationError(
				apierrors.PreferencesOperationFailed(apierrors.WithCause(err)),
			),
		}, nil
	}

	return tuttigenerated.PutDesktopPreferences200JSONResponse(
		preferencesapi.GeneratedDesktopPreferencesStateResponseFromBiz(preferences),
	), nil
}

func agentComposerDefaultsByProviderFromGenerated(
	value tuttigenerated.DesktopAgentComposerDefaultsByProvider,
) map[string]preferencesbiz.AgentComposerDefaults {
	result := map[string]preferencesbiz.AgentComposerDefaults{}
	setAgentComposerDefaultsFromGenerated(result, "claude-code", value.ClaudeCode)
	setAgentComposerDefaultsFromGenerated(result, "codex", value.Codex)
	setAgentComposerDefaultsFromGenerated(result, "gemini", value.Gemini)
	setAgentComposerDefaultsFromGenerated(result, "hermes", value.Hermes)
	setAgentComposerDefaultsFromGenerated(result, "nexight", value.Nexight)
	setAgentComposerDefaultsFromGenerated(result, "openclaw", value.Openclaw)
	return result
}

func setAgentComposerDefaultsFromGenerated(
	result map[string]preferencesbiz.AgentComposerDefaults,
	provider string,
	value *tuttigenerated.DesktopAgentComposerDefaults,
) {
	if value == nil {
		return
	}
	result[provider] = preferencesbiz.AgentComposerDefaults{
		Model:            optionalStringValue(value.Model),
		PermissionModeID: optionalStringValue(value.PermissionModeId),
		ReasoningEffort:  optionalStringValue(value.ReasoningEffort),
	}
}
