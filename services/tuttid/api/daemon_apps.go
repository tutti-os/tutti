package api

import (
	"context"
	"strings"
	"unicode/utf8"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	workspaceapi "github.com/tutti-os/tutti/services/tuttid/api/workspace"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

const (
	appReferenceListRequestTextMaxRunes    = 200
	appReferenceListRequestGroupIDMaxRunes = 2048
	appReferenceListRequestCursorMaxRunes  = 2048
	appReferenceListRequestLimitMin        = 1
	appReferenceListRequestLimitMax        = 50
)

func workspaceAppServiceUnavailableError() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(
		apierrors.WorkspaceAppServiceUnavailable(
			apierrors.WithDeveloperMessage("workspace app service is unavailable"),
		),
	)
}

func (api DaemonAPI) ListWorkspaceApps(ctx context.Context, request tuttigenerated.ListWorkspaceAppsRequestObject) (tuttigenerated.ListWorkspaceAppsResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.ListWorkspaceApps503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.ListWorkspaceApps400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}

	apps, err := api.AppCenterService.List(ctx, workspaceID)
	if err != nil {
		return writeListWorkspaceAppsError(err), nil
	}

	return tuttigenerated.ListWorkspaceApps200JSONResponse{
		WorkspaceId:   workspaceID,
		CatalogStatus: workspaceapi.GeneratedAppCatalogLoadStateFromBiz(api.AppCenterService.CatalogLoadState()),
		Apps:          workspaceapi.GeneratedAppsFromBiz(apps),
	}, nil
}

func (api DaemonAPI) RefreshWorkspaceAppCatalog(ctx context.Context, request tuttigenerated.RefreshWorkspaceAppCatalogRequestObject) (tuttigenerated.RefreshWorkspaceAppCatalogResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.RefreshWorkspaceAppCatalog503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.RefreshWorkspaceAppCatalog400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}

	apps, err := api.AppCenterService.RefreshCatalog(ctx, workspaceID)
	if err != nil {
		return writeRefreshWorkspaceAppCatalogError(err), nil
	}

	return tuttigenerated.RefreshWorkspaceAppCatalog200JSONResponse{
		WorkspaceId:   workspaceID,
		CatalogStatus: workspaceapi.GeneratedAppCatalogLoadStateFromBiz(api.AppCenterService.CatalogLoadState()),
		Apps:          workspaceapi.GeneratedAppsFromBiz(apps),
	}, nil
}

func (api DaemonAPI) InstallWorkspaceApp(ctx context.Context, request tuttigenerated.InstallWorkspaceAppRequestObject) (tuttigenerated.InstallWorkspaceAppResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.InstallWorkspaceApp503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}

	workspaceID, appID, errResponse := validateWorkspaceAppPath(request.WorkspaceID, request.AppID)
	if errResponse != nil {
		return tuttigenerated.InstallWorkspaceApp400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}

	options := workspaceservice.InstallOptions{}
	if request.Body != nil && request.Body.RestartRunning != nil {
		options.RestartRunning = *request.Body.RestartRunning
	}
	app, err := api.AppCenterService.InstallWithOptions(ctx, workspaceID, appID, options)
	if err != nil {
		return writeInstallWorkspaceAppError(err), nil
	}

	return tuttigenerated.InstallWorkspaceApp200JSONResponse{
		WorkspaceId: workspaceID,
		App:         workspaceapi.GeneratedAppFromBiz(app),
	}, nil
}

func (api DaemonAPI) ListWorkspaceAppReferences(ctx context.Context, request tuttigenerated.ListWorkspaceAppReferencesRequestObject) (tuttigenerated.ListWorkspaceAppReferencesResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.ListWorkspaceAppReferences503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}

	workspaceID, appID, errResponse := validateWorkspaceAppPath(request.WorkspaceID, request.AppID)
	if errResponse != nil {
		return tuttigenerated.ListWorkspaceAppReferences400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}
	if request.Body == nil {
		return tuttigenerated.ListWorkspaceAppReferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference list request body is required"),
					apierrors.WithParams(map[string]any{"field": "body"}),
				),
			),
		}, nil
	}

	input, validationErr := validateAppReferenceListRequest(*request.Body)
	if validationErr != nil {
		return tuttigenerated.ListWorkspaceAppReferences400JSONResponse{InvalidRequestErrorJSONResponse: *validationErr}, nil
	}

	result, err := api.AppCenterService.ListReferences(ctx, workspaceID, appID, input)
	if err != nil {
		return writeListWorkspaceAppReferencesError(err), nil
	}

	return tuttigenerated.ListWorkspaceAppReferences200JSONResponse(
		workspaceapi.GeneratedAppReferenceListResultFromBiz(workspaceID, appID, result),
	), nil
}

func (api DaemonAPI) ImportWorkspaceApp(ctx context.Context, request tuttigenerated.ImportWorkspaceAppRequestObject) (tuttigenerated.ImportWorkspaceAppResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.ImportWorkspaceApp503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}
	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.ImportWorkspaceApp400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}
	if request.Body == nil || strings.TrimSpace(request.Body.ArchivePath) == "" {
		return tuttigenerated.ImportWorkspaceApp400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app archive path is required"),
					apierrors.WithParams(map[string]any{"field": "archivePath"}),
				),
			),
		}, nil
	}
	if _, err := api.WorkspaceService.Get(ctx, workspaceID); err != nil {
		return writeImportWorkspaceAppError(err), nil
	}

	app, err := api.AppCenterService.ImportPackage(ctx, request.Body.ArchivePath)
	if err != nil {
		return writeImportWorkspaceAppError(err), nil
	}
	return tuttigenerated.ImportWorkspaceApp200JSONResponse{
		WorkspaceId: workspaceID,
		App:         workspaceapi.GeneratedAppFromBiz(app),
	}, nil
}

func (api DaemonAPI) ExportWorkspaceApp(ctx context.Context, request tuttigenerated.ExportWorkspaceAppRequestObject) (tuttigenerated.ExportWorkspaceAppResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.ExportWorkspaceApp503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}
	workspaceID, appID, errResponse := validateWorkspaceAppPath(request.WorkspaceID, request.AppID)
	if errResponse != nil {
		return tuttigenerated.ExportWorkspaceApp400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}
	if request.Body == nil || strings.TrimSpace(request.Body.DestinationPath) == "" {
		return tuttigenerated.ExportWorkspaceApp400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app export destination path is required"),
					apierrors.WithParams(map[string]any{"field": "destinationPath"}),
				),
			),
		}, nil
	}
	if _, err := api.WorkspaceService.Get(ctx, workspaceID); err != nil {
		return writeExportWorkspaceAppError(err), nil
	}

	version := ""
	if request.Body.Version != nil {
		version = *request.Body.Version
	}
	result, err := api.AppCenterService.ExportPackage(ctx, appID, version, request.Body.DestinationPath)
	if err != nil {
		return writeExportWorkspaceAppError(err), nil
	}
	return tuttigenerated.ExportWorkspaceApp200JSONResponse{
		WorkspaceId:       workspaceID,
		AppId:             result.AppID,
		Version:           result.Version,
		ArchivePath:       result.Path,
		ArtifactSha256:    result.ArtifactSHA256,
		ArtifactSizeBytes: result.ArtifactSizeBytes,
	}, nil
}

func (api DaemonAPI) ReplaceWorkspaceAppIcon(ctx context.Context, request tuttigenerated.ReplaceWorkspaceAppIconRequestObject) (tuttigenerated.ReplaceWorkspaceAppIconResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.ReplaceWorkspaceAppIcon503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}
	workspaceID, appID, errResponse := validateWorkspaceAppPath(request.WorkspaceID, request.AppID)
	if errResponse != nil {
		return tuttigenerated.ReplaceWorkspaceAppIcon400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}
	if request.Body == nil || strings.TrimSpace(request.Body.SourcePath) == "" {
		return tuttigenerated.ReplaceWorkspaceAppIcon400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app icon source path is required"),
					apierrors.WithParams(map[string]any{"field": "sourcePath"}),
				),
			),
		}, nil
	}

	app, err := api.AppCenterService.ReplaceIcon(ctx, workspaceID, appID, request.Body.SourcePath)
	if err != nil {
		return writeReplaceWorkspaceAppIconError(err), nil
	}
	return tuttigenerated.ReplaceWorkspaceAppIcon200JSONResponse{
		WorkspaceId: workspaceID,
		App:         workspaceapi.GeneratedAppFromBiz(app),
	}, nil
}

func (api DaemonAPI) UninstallWorkspaceApp(ctx context.Context, request tuttigenerated.UninstallWorkspaceAppRequestObject) (tuttigenerated.UninstallWorkspaceAppResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.UninstallWorkspaceApp503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}

	workspaceID, appID, errResponse := validateWorkspaceAppPath(request.WorkspaceID, request.AppID)
	if errResponse != nil {
		return tuttigenerated.UninstallWorkspaceApp400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}

	app, err := api.AppCenterService.Uninstall(ctx, workspaceID, appID)
	if err != nil {
		return writeUninstallWorkspaceAppError(err), nil
	}

	return tuttigenerated.UninstallWorkspaceApp200JSONResponse{
		WorkspaceId: workspaceID,
		App:         workspaceapi.GeneratedAppFromBiz(app),
	}, nil
}

func (api DaemonAPI) DeleteWorkspaceApp(ctx context.Context, request tuttigenerated.DeleteWorkspaceAppRequestObject) (tuttigenerated.DeleteWorkspaceAppResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.DeleteWorkspaceApp503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}

	workspaceID, appID, errResponse := validateWorkspaceAppPath(request.WorkspaceID, request.AppID)
	if errResponse != nil {
		return tuttigenerated.DeleteWorkspaceApp400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}

	if err := api.AppCenterService.DeletePackage(ctx, workspaceID, appID); err != nil {
		return writeDeleteWorkspaceAppError(err), nil
	}

	return tuttigenerated.DeleteWorkspaceApp200JSONResponse{
		WorkspaceId: workspaceID,
		AppId:       appID,
		Deleted:     true,
	}, nil
}

func (api DaemonAPI) LaunchWorkspaceApp(ctx context.Context, request tuttigenerated.LaunchWorkspaceAppRequestObject) (tuttigenerated.LaunchWorkspaceAppResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.LaunchWorkspaceApp503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}

	workspaceID, appID, errResponse := validateWorkspaceAppPath(request.WorkspaceID, request.AppID)
	if errResponse != nil {
		return tuttigenerated.LaunchWorkspaceApp400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}

	app, err := api.AppCenterService.Launch(ctx, workspaceID, appID)
	if err != nil {
		return writeLaunchWorkspaceAppError(err), nil
	}

	return tuttigenerated.LaunchWorkspaceApp200JSONResponse{
		WorkspaceId: workspaceID,
		App:         workspaceapi.GeneratedAppFromBiz(app),
	}, nil
}

func (api DaemonAPI) RetryWorkspaceApp(ctx context.Context, request tuttigenerated.RetryWorkspaceAppRequestObject) (tuttigenerated.RetryWorkspaceAppResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.RetryWorkspaceApp503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}

	workspaceID, appID, errResponse := validateWorkspaceAppPath(request.WorkspaceID, request.AppID)
	if errResponse != nil {
		return tuttigenerated.RetryWorkspaceApp400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}

	app, err := api.AppCenterService.Retry(ctx, workspaceID, appID)
	if err != nil {
		return writeRetryWorkspaceAppError(err), nil
	}

	return tuttigenerated.RetryWorkspaceApp200JSONResponse{
		WorkspaceId: workspaceID,
		App:         workspaceapi.GeneratedAppFromBiz(app),
	}, nil
}

func (api DaemonAPI) RollbackWorkspaceApp(ctx context.Context, request tuttigenerated.RollbackWorkspaceAppRequestObject) (tuttigenerated.RollbackWorkspaceAppResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.RollbackWorkspaceApp503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}
	workspaceID, appID, errResponse := validateWorkspaceAppPath(request.WorkspaceID, request.AppID)
	if errResponse != nil {
		return tuttigenerated.RollbackWorkspaceApp400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}
	if request.Body == nil || strings.TrimSpace(request.Body.Version) == "" {
		return tuttigenerated.RollbackWorkspaceApp400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app rollback version is required"),
					apierrors.WithParams(map[string]any{"field": "version"}),
				),
			),
		}, nil
	}

	app, err := api.AppCenterService.Rollback(ctx, workspaceID, appID, request.Body.Version)
	if err != nil {
		return writeRollbackWorkspaceAppError(err), nil
	}
	return tuttigenerated.RollbackWorkspaceApp200JSONResponse{
		WorkspaceId: workspaceID,
		App:         workspaceapi.GeneratedAppFromBiz(app),
	}, nil
}

func (api DaemonAPI) StartEnabledWorkspaceApps(ctx context.Context, request tuttigenerated.StartEnabledWorkspaceAppsRequestObject) (tuttigenerated.StartEnabledWorkspaceAppsResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.StartEnabledWorkspaceApps503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.StartEnabledWorkspaceApps400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}

	apps, err := api.AppCenterService.StartEnabled(ctx, workspaceID)
	if err != nil {
		return writeStartEnabledWorkspaceAppsError(err), nil
	}

	return tuttigenerated.StartEnabledWorkspaceApps200JSONResponse{
		WorkspaceId:   workspaceID,
		CatalogStatus: workspaceapi.GeneratedAppCatalogLoadStateFromBiz(api.AppCenterService.CatalogLoadState()),
		Apps:          workspaceapi.GeneratedAppsFromBiz(apps),
	}, nil
}

func (api DaemonAPI) StopAllWorkspaceApps(ctx context.Context, request tuttigenerated.StopAllWorkspaceAppsRequestObject) (tuttigenerated.StopAllWorkspaceAppsResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.StopAllWorkspaceApps503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.StopAllWorkspaceApps400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}

	apps, err := api.AppCenterService.StopAll(ctx, workspaceID)
	if err != nil {
		return writeStopAllWorkspaceAppsError(err), nil
	}

	return tuttigenerated.StopAllWorkspaceApps200JSONResponse{
		WorkspaceId:   workspaceID,
		CatalogStatus: workspaceapi.GeneratedAppCatalogLoadStateFromBiz(api.AppCenterService.CatalogLoadState()),
		Apps:          workspaceapi.GeneratedAppsFromBiz(apps),
	}, nil
}

func validateWorkspaceAppPath(workspaceIDValue tuttigenerated.WorkspaceID, appIDValue tuttigenerated.WorkspaceAppID) (string, string, *tuttigenerated.InvalidRequestErrorJSONResponse) {
	workspaceID := strings.TrimSpace(string(workspaceIDValue))
	if workspaceID == "" {
		response := invalidRequestError(
			apierrors.MissingWorkspaceID(
				apierrors.WithDeveloperMessage("workspace id is required"),
				apierrors.WithParams(map[string]any{"field": "workspaceId"}),
			),
		)
		return "", "", &response
	}

	appID := strings.TrimSpace(string(appIDValue))
	if appID == "" {
		response := invalidRequestError(
			apierrors.MalformedRequest(
				apierrors.WithDeveloperMessage("workspace app id is required"),
				apierrors.WithParams(map[string]any{"field": "appId"}),
			),
		)
		return "", "", &response
	}

	return workspaceID, appID, nil
}

func validateAppReferenceListRequest(body tuttigenerated.AppReferenceListRequest) (workspacebiz.AppReferenceListInput, *tuttigenerated.InvalidRequestErrorJSONResponse) {
	input := workspacebiz.AppReferenceListInput{}
	if body.ParentGroupId != nil {
		parentGroupID := strings.TrimSpace(*body.ParentGroupId)
		if parentGroupID == "" || utf8.RuneCountInString(parentGroupID) > appReferenceListRequestGroupIDMaxRunes {
			response := invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference list parentGroupId is invalid"),
					apierrors.WithParams(map[string]any{"field": "parentGroupId"}),
				),
			)
			return workspacebiz.AppReferenceListInput{}, &response
		}
		input.ParentGroupID = parentGroupID
	}
	if body.FilterText != nil {
		filterText := strings.TrimSpace(*body.FilterText)
		if utf8.RuneCountInString(filterText) > appReferenceListRequestTextMaxRunes {
			response := invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference list filterText is too long"),
					apierrors.WithParams(map[string]any{"field": "filterText"}),
				),
			)
			return workspacebiz.AppReferenceListInput{}, &response
		}
		input.FilterText = filterText
	}
	if body.Limit != nil {
		if *body.Limit < appReferenceListRequestLimitMin || *body.Limit > appReferenceListRequestLimitMax {
			response := invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference list limit is out of range"),
					apierrors.WithParams(map[string]any{"field": "limit"}),
				),
			)
			return workspacebiz.AppReferenceListInput{}, &response
		}
		input.Limit = *body.Limit
	}
	if body.Cursor != nil {
		cursor := strings.TrimSpace(*body.Cursor)
		if utf8.RuneCountInString(cursor) > appReferenceListRequestCursorMaxRunes {
			response := invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference list cursor is too long"),
					apierrors.WithParams(map[string]any{"field": "cursor"}),
				),
			)
			return workspacebiz.AppReferenceListInput{}, &response
		}
		input.Cursor = cursor
	}
	if body.Kinds != nil {
		kinds, ok := generatedAppReferenceKindsToBiz(*body.Kinds)
		if !ok {
			response := invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference list kind is unsupported"),
					apierrors.WithParams(map[string]any{"field": "kinds"}),
				),
			)
			return workspacebiz.AppReferenceListInput{}, &response
		}
		input.Kinds = kinds
	}
	if body.TimeRange != nil {
		timeRange, response := validateAppReferenceListTimeRange(*body.TimeRange)
		if response != nil {
			return workspacebiz.AppReferenceListInput{}, response
		}
		input.TimeRange = timeRange
	}
	return input, nil
}

func validateAppReferenceListTimeRange(body tuttigenerated.AppReferenceListTimeRange) (*workspacebiz.AppReferenceListTimeRange, *tuttigenerated.InvalidRequestErrorJSONResponse) {
	if body.FromMs != nil && *body.FromMs < 0 {
		response := invalidRequestError(
			apierrors.MalformedRequest(
				apierrors.WithDeveloperMessage("workspace app reference list timeRange.fromMs is out of range"),
				apierrors.WithParams(map[string]any{"field": "timeRange.fromMs"}),
			),
		)
		return nil, &response
	}
	if body.ToMs != nil && *body.ToMs < 0 {
		response := invalidRequestError(
			apierrors.MalformedRequest(
				apierrors.WithDeveloperMessage("workspace app reference list timeRange.toMs is out of range"),
				apierrors.WithParams(map[string]any{"field": "timeRange.toMs"}),
			),
		)
		return nil, &response
	}
	if body.FromMs != nil && body.ToMs != nil && *body.FromMs > *body.ToMs {
		response := invalidRequestError(
			apierrors.MalformedRequest(
				apierrors.WithDeveloperMessage("workspace app reference list timeRange.fromMs must be less than or equal to timeRange.toMs"),
				apierrors.WithParams(map[string]any{"field": "timeRange"}),
			),
		)
		return nil, &response
	}
	if body.FromMs == nil && body.ToMs == nil {
		return nil, nil
	}
	return &workspacebiz.AppReferenceListTimeRange{
		FromMs: body.FromMs,
		ToMs:   body.ToMs,
	}, nil
}

func generatedAppReferenceKindsToBiz(kinds []tuttigenerated.AppReferenceKind) ([]workspacebiz.AppReferenceKind, bool) {
	result := make([]workspacebiz.AppReferenceKind, 0, len(kinds))
	for _, kind := range kinds {
		if kind == tuttigenerated.AppReferenceKindFile {
			result = append(result, workspacebiz.AppReferenceKindFile)
			continue
		}
		return nil, false
	}
	return result, true
}

func writeListWorkspaceAppsError(err error) tuttigenerated.ListWorkspaceAppsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ListWorkspaceApps404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceApps400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ListWorkspaceApps502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeListWorkspaceAppReferencesError(err error) tuttigenerated.ListWorkspaceAppReferencesResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.ListWorkspaceAppReferences404JSONResponse{
			WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceAppReferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ListWorkspaceAppReferences502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeRefreshWorkspaceAppCatalogError(err error) tuttigenerated.RefreshWorkspaceAppCatalogResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.RefreshWorkspaceAppCatalog404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.RefreshWorkspaceAppCatalog400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.RefreshWorkspaceAppCatalog502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeStartEnabledWorkspaceAppsError(err error) tuttigenerated.StartEnabledWorkspaceAppsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.StartEnabledWorkspaceApps404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.StartEnabledWorkspaceApps400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.StartEnabledWorkspaceApps502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeStopAllWorkspaceAppsError(err error) tuttigenerated.StopAllWorkspaceAppsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.StopAllWorkspaceApps404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.StopAllWorkspaceApps400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.StopAllWorkspaceApps502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeInstallWorkspaceAppError(err error) tuttigenerated.InstallWorkspaceAppResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.InstallWorkspaceApp404JSONResponse{
			WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.InstallWorkspaceApp400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.InstallWorkspaceApp502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeImportWorkspaceAppError(err error) tuttigenerated.ImportWorkspaceAppResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ImportWorkspaceApp404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ImportWorkspaceApp400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ImportWorkspaceApp502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeExportWorkspaceAppError(err error) tuttigenerated.ExportWorkspaceAppResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.ExportWorkspaceApp404JSONResponse{
			WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ExportWorkspaceApp400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ExportWorkspaceApp502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeReplaceWorkspaceAppIconError(err error) tuttigenerated.ReplaceWorkspaceAppIconResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.ReplaceWorkspaceAppIcon404JSONResponse{
			WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ReplaceWorkspaceAppIcon400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ReplaceWorkspaceAppIcon502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeUninstallWorkspaceAppError(err error) tuttigenerated.UninstallWorkspaceAppResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.UninstallWorkspaceApp404JSONResponse{
			WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.UninstallWorkspaceApp400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.UninstallWorkspaceApp502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeDeleteWorkspaceAppError(err error) tuttigenerated.DeleteWorkspaceAppResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.DeleteWorkspaceApp404JSONResponse{
			WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.DeleteWorkspaceApp400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.DeleteWorkspaceApp502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeLaunchWorkspaceAppError(err error) tuttigenerated.LaunchWorkspaceAppResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.LaunchWorkspaceApp404JSONResponse{
			WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.LaunchWorkspaceApp400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.LaunchWorkspaceApp502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeRetryWorkspaceAppError(err error) tuttigenerated.RetryWorkspaceAppResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.RetryWorkspaceApp404JSONResponse{
			WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.RetryWorkspaceApp400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.RetryWorkspaceApp502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeRollbackWorkspaceAppError(err error) tuttigenerated.RollbackWorkspaceAppResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.RollbackWorkspaceApp404JSONResponse{
			WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.RollbackWorkspaceApp400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.RollbackWorkspaceApp502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}
