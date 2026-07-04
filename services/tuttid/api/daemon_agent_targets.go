package api

import (
	"context"

	agenttargetapi "github.com/tutti-os/tutti/services/tuttid/api/agenttarget"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

type AgentTargetService interface {
	List(context.Context) ([]agenttargetbiz.Target, error)
}

func (api DaemonAPI) ListAgentTargets(ctx context.Context, _ tuttigenerated.ListAgentTargetsRequestObject) (tuttigenerated.ListAgentTargetsResponseObject, error) {
	if api.AgentTargetService == nil {
		return tuttigenerated.ListAgentTargets503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable(
					"agent_target_service_unavailable",
					apierrors.WithDeveloperMessage("agent target service is unavailable"),
				),
			),
		}, nil
	}
	targets, err := api.AgentTargetService.List(ctx)
	if err != nil {
		return tuttigenerated.ListAgentTargets502JSONResponse{
			PreferencesOperationErrorJSONResponse: preferencesOperationError(
				apierrors.PreferencesOperationFailed(apierrors.WithCause(err)),
			),
		}, nil
	}
	response, err := agenttargetapi.GeneratedListAgentTargetsResponseFromBiz(targets)
	if err != nil {
		return tuttigenerated.ListAgentTargets502JSONResponse{
			PreferencesOperationErrorJSONResponse: preferencesOperationError(
				apierrors.PreferencesOperationFailed(apierrors.WithCause(err)),
			),
		}, nil
	}
	return tuttigenerated.ListAgentTargets200JSONResponse(response), nil
}
