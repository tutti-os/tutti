package api

import (
	"context"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	workspaceapi "github.com/tutti-os/tutti/services/tuttid/api/workspace"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
)

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

func (api DaemonAPI) StopWorkspaceApp(ctx context.Context, request tuttigenerated.StopWorkspaceAppRequestObject) (tuttigenerated.StopWorkspaceAppResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.StopWorkspaceApp503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}

	workspaceID, appID, errResponse := validateWorkspaceAppPath(request.WorkspaceID, request.AppID)
	if errResponse != nil {
		return tuttigenerated.StopWorkspaceApp400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}

	app, err := api.AppCenterService.Stop(ctx, workspaceID, appID)
	if err != nil {
		return writeStopWorkspaceAppError(err), nil
	}

	return tuttigenerated.StopWorkspaceApp200JSONResponse{
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

func writeStopWorkspaceAppError(err error) tuttigenerated.StopWorkspaceAppResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.StopWorkspaceApp404JSONResponse{
			WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.StopWorkspaceApp400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.StopWorkspaceApp502JSONResponse{
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
