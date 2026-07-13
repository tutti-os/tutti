package api

import (
	"context"
	"strings"
	"time"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
)

func (api DaemonAPI) GetWorkspaceAppAgentPreferences(
	ctx context.Context,
	request tuttigenerated.GetWorkspaceAppAgentPreferencesRequestObject,
) (tuttigenerated.GetWorkspaceAppAgentPreferencesResponseObject, error) {
	workspaceID, appID, errResponse := validateWorkspaceAppPath(request.WorkspaceID, request.AppID)
	if errResponse != nil {
		return tuttigenerated.GetWorkspaceAppAgentPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: *errResponse,
		}, nil
	}
	workspaceAppVersion, err := api.ensureWorkspaceAppInstalled(ctx, workspaceID, appID)
	if err != nil {
		return writeGetWorkspaceAppAgentPreferencesError(err), nil
	}
	api.trackDeprecatedWorkspaceAppAgentAPI(ctx, "preferences/agent", appID, workspaceAppVersion)
	if api.PreferencesService == nil {
		return tuttigenerated.GetWorkspaceAppAgentPreferences503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.PreferencesServiceUnavailable(
					apierrors.WithDeveloperMessage("desktop preferences service is unavailable"),
				),
			),
		}, nil
	}

	preferences, err := api.PreferencesService.Get(ctx)
	if err != nil {
		return tuttigenerated.GetWorkspaceAppAgentPreferences502JSONResponse{
			PreferencesOperationErrorJSONResponse: preferencesOperationError(
				apierrors.PreferencesOperationFailed(apierrors.WithCause(err)),
			),
		}, nil
	}

	return tuttigenerated.GetWorkspaceAppAgentPreferences200JSONResponse{
		DefaultAgentProvider: tuttigenerated.DesktopDefaultAgentProvider(preferences.DefaultAgentProvider),
		EnableCursorAgent:    preferences.EnableCursorAgent,
		EnableOpenCodeAgent:  preferences.EnableOpenCodeAgent,
	}, nil
}

func (api DaemonAPI) GetWorkspaceAppAgentProviderStatuses(
	ctx context.Context,
	request tuttigenerated.GetWorkspaceAppAgentProviderStatusesRequestObject,
) (tuttigenerated.GetWorkspaceAppAgentProviderStatusesResponseObject, error) {
	workspaceID, appID, errResponse := validateWorkspaceAppPath(request.WorkspaceID, request.AppID)
	if errResponse != nil {
		return tuttigenerated.GetWorkspaceAppAgentProviderStatuses400JSONResponse{
			InvalidRequestErrorJSONResponse: *errResponse,
		}, nil
	}
	workspaceAppVersion, err := api.ensureWorkspaceAppInstalled(ctx, workspaceID, appID)
	if err != nil {
		return writeGetWorkspaceAppAgentProviderStatusesError(err), nil
	}
	api.trackDeprecatedWorkspaceAppAgentAPI(ctx, "agent-providers/status", appID, workspaceAppVersion)

	providers, err := api.workspaceAppAgentStatusProviders(ctx, request.Params.Providers)
	if err != nil {
		return writeGetWorkspaceAppAgentProviderStatusesError(err), nil
	}
	if providers != nil && len(*providers) == 0 {
		return tuttigenerated.GetWorkspaceAppAgentProviderStatuses200JSONResponse(
			generatedAgentProviderStatusList(agentstatusEmptySnapshot(), api.defaultAgentProvider(ctx)),
		), nil
	}

	response, err := api.GetAgentProviderStatuses(ctx, tuttigenerated.GetAgentProviderStatusesRequestObject{
		Params: tuttigenerated.GetAgentProviderStatusesParams{
			Providers:      providers,
			IncludeNetwork: request.Params.IncludeNetwork,
		},
	})
	if err != nil {
		return nil, err
	}
	return mapGetAgentProviderStatusesToWorkspaceApp(response), nil
}

func (api DaemonAPI) workspaceAppAgentStatusProviders(
	ctx context.Context,
	requestedProviders *[]tuttigenerated.WorkspaceAgentProvider,
) (*[]tuttigenerated.WorkspaceAgentProvider, error) {
	if api.AgentTargetService == nil {
		return nil, apierrors.ServiceUnavailable(
			"agent_target_service_unavailable",
			apierrors.WithDeveloperMessage("agent target service is unavailable"),
		)
	}
	targets, err := api.AgentTargetService.List(ctx)
	if err != nil {
		return nil, err
	}
	visibleTargets := agenttargetbiz.EnabledTargetsByProvider(targets)
	visible := map[string]struct{}{}
	ordered := make([]string, 0, len(visibleTargets))
	for _, target := range visibleTargets {
		visible[target.Provider] = struct{}{}
		ordered = append(ordered, target.Provider)
	}
	providers := make([]tuttigenerated.WorkspaceAgentProvider, 0, len(targets))
	seen := map[string]struct{}{}
	if requestedProviders != nil && len(*requestedProviders) > 0 {
		for _, provider := range *requestedProviders {
			normalized := strings.TrimSpace(string(provider))
			if _, ok := visible[normalized]; !ok {
				continue
			}
			if _, ok := seen[normalized]; ok {
				continue
			}
			seen[normalized] = struct{}{}
			providers = append(providers, tuttigenerated.WorkspaceAgentProvider(normalized))
		}
		return &providers, nil
	}
	for _, provider := range ordered {
		if _, ok := seen[provider]; ok {
			continue
		}
		seen[provider] = struct{}{}
		providers = append(providers, tuttigenerated.WorkspaceAgentProvider(provider))
	}
	return &providers, nil
}

func agentstatusEmptySnapshot() agentstatusservice.Snapshot {
	return agentstatusservice.Snapshot{
		CapturedAt: time.Now().UTC(),
		Providers:  []agentstatusservice.ProviderStatus{},
	}
}

func (api DaemonAPI) GetWorkspaceAppAgentProviderComposerOptions(
	ctx context.Context,
	request tuttigenerated.GetWorkspaceAppAgentProviderComposerOptionsRequestObject,
) (tuttigenerated.GetWorkspaceAppAgentProviderComposerOptionsResponseObject, error) {
	workspaceID, appID, errResponse := validateWorkspaceAppPath(request.WorkspaceID, request.AppID)
	if errResponse != nil {
		return tuttigenerated.GetWorkspaceAppAgentProviderComposerOptions400JSONResponse{
			InvalidRequestErrorJSONResponse: *errResponse,
		}, nil
	}
	workspaceAppVersion, err := api.ensureWorkspaceAppInstalled(ctx, workspaceID, appID)
	if err != nil {
		return writeGetWorkspaceAppAgentProviderComposerOptionsError(err), nil
	}
	api.trackDeprecatedWorkspaceAppAgentAPI(ctx, "agent-providers/{provider}/composer-options", appID, workspaceAppVersion)
	requestedProviders := []tuttigenerated.WorkspaceAgentProvider{request.Provider}
	visibleProviders, err := api.workspaceAppAgentStatusProviders(ctx, &requestedProviders)
	if err != nil {
		return writeGetWorkspaceAppAgentProviderComposerOptionsError(err), nil
	}
	if len(*visibleProviders) == 0 {
		return writeGetWorkspaceAppAgentProviderComposerOptionsError(
			apierrors.InvalidRequest(
				apierrors.ReasonAgentProviderUnavailable,
				apierrors.WithDeveloperMessage("agent provider is not visible to this workspace app"),
				apierrors.WithParams(map[string]any{"provider": request.Provider}),
			),
		), nil
	}

	body := request.Body
	if body == nil {
		body = &tuttigenerated.GetWorkspaceAppAgentProviderComposerOptionsJSONRequestBody{}
	}
	workspaceIDCopy := workspaceID
	body.WorkspaceId = &workspaceIDCopy

	response, err := api.GetAgentProviderComposerOptions(ctx, tuttigenerated.GetAgentProviderComposerOptionsRequestObject{
		Provider: request.Provider,
		Body:     body,
	})
	if err != nil {
		return nil, err
	}
	return mapGetAgentProviderComposerOptionsToWorkspaceApp(response), nil
}

func (api DaemonAPI) ensureWorkspaceAppInstalled(ctx context.Context, workspaceID string, appID string) (string, error) {
	if api.AppCenterService == nil {
		return "", apierrors.ServiceUnavailable(
			"workspace_app_service_unavailable",
			apierrors.WithDeveloperMessage("workspace app service is unavailable"),
		)
	}
	apps, err := api.AppCenterService.List(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	for _, app := range apps {
		if app.Package.AppID == appID && app.Installation != nil {
			return app.Package.Version, nil
		}
	}
	return "", workspacedata.ErrWorkspaceAppNotFound
}

func writeGetWorkspaceAppAgentPreferencesError(err error) tuttigenerated.GetWorkspaceAppAgentPreferencesResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.GetWorkspaceAppAgentPreferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.GetWorkspaceAppAgentPreferences404JSONResponse{
			WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr),
		}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.GetWorkspaceAppAgentPreferences503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr),
		}
	default:
		return tuttigenerated.GetWorkspaceAppAgentPreferences502JSONResponse{
			PreferencesOperationErrorJSONResponse: preferencesOperationError(protocolErr),
		}
	}
}

func writeGetWorkspaceAppAgentProviderStatusesError(err error) tuttigenerated.GetWorkspaceAppAgentProviderStatusesResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.GetWorkspaceAppAgentProviderStatuses404JSONResponse{
			WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr),
		}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.GetWorkspaceAppAgentProviderStatuses503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr),
		}
	default:
		return tuttigenerated.GetWorkspaceAppAgentProviderStatuses502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeGetWorkspaceAppAgentProviderComposerOptionsError(err error) tuttigenerated.GetWorkspaceAppAgentProviderComposerOptionsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.GetWorkspaceAppAgentProviderComposerOptions400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.GetWorkspaceAppAgentProviderComposerOptions404JSONResponse{
			WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr),
		}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.GetWorkspaceAppAgentProviderComposerOptions503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr),
		}
	default:
		return tuttigenerated.GetWorkspaceAppAgentProviderComposerOptions502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func mapGetAgentProviderStatusesToWorkspaceApp(
	response tuttigenerated.GetAgentProviderStatusesResponseObject,
) tuttigenerated.GetWorkspaceAppAgentProviderStatusesResponseObject {
	switch typed := response.(type) {
	case tuttigenerated.GetAgentProviderStatuses200JSONResponse:
		return tuttigenerated.GetWorkspaceAppAgentProviderStatuses200JSONResponse(typed)
	case tuttigenerated.GetAgentProviderStatuses400JSONResponse:
		return tuttigenerated.GetWorkspaceAppAgentProviderStatuses400JSONResponse(typed)
	case tuttigenerated.GetAgentProviderStatuses502JSONResponse:
		return tuttigenerated.GetWorkspaceAppAgentProviderStatuses502JSONResponse(typed)
	case tuttigenerated.GetAgentProviderStatuses503JSONResponse:
		return tuttigenerated.GetWorkspaceAppAgentProviderStatuses503JSONResponse(typed)
	default:
		return tuttigenerated.GetWorkspaceAppAgentProviderStatuses502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(
				apierrors.WorkspaceOperationFailed(
					apierrors.WithDeveloperMessage("unexpected agent provider status response"),
				),
			),
		}
	}
}

func mapGetAgentProviderComposerOptionsToWorkspaceApp(
	response tuttigenerated.GetAgentProviderComposerOptionsResponseObject,
) tuttigenerated.GetWorkspaceAppAgentProviderComposerOptionsResponseObject {
	switch typed := response.(type) {
	case tuttigenerated.GetAgentProviderComposerOptions200JSONResponse:
		return tuttigenerated.GetWorkspaceAppAgentProviderComposerOptions200JSONResponse(typed)
	case tuttigenerated.GetAgentProviderComposerOptions400JSONResponse:
		return tuttigenerated.GetWorkspaceAppAgentProviderComposerOptions400JSONResponse(typed)
	case tuttigenerated.GetAgentProviderComposerOptions502JSONResponse:
		return tuttigenerated.GetWorkspaceAppAgentProviderComposerOptions502JSONResponse(typed)
	case tuttigenerated.GetAgentProviderComposerOptions503JSONResponse:
		return tuttigenerated.GetWorkspaceAppAgentProviderComposerOptions503JSONResponse(typed)
	default:
		return tuttigenerated.GetWorkspaceAppAgentProviderComposerOptions502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(
				apierrors.WorkspaceOperationFailed(
					apierrors.WithDeveloperMessage("unexpected agent provider composer options response"),
				),
			),
		}
	}
}
