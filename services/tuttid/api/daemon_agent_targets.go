package api

import (
	"context"
	"errors"
	"strings"

	agenttargetapi "github.com/tutti-os/tutti/services/tuttid/api/agenttarget"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agenttargetservice "github.com/tutti-os/tutti/services/tuttid/service/agenttarget"
)

type AgentTargetService interface {
	List(context.Context) ([]agenttargetbiz.Target, error)
	SetEnabled(context.Context, agenttargetservice.SetEnabledInput) (agenttargetbiz.Target, error)
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

func (api DaemonAPI) SetSystemAgentTargetEnabled(ctx context.Context, request tuttigenerated.SetSystemAgentTargetEnabledRequestObject) (tuttigenerated.SetSystemAgentTargetEnabledResponseObject, error) {
	if api.AgentTargetService == nil {
		return tuttigenerated.SetSystemAgentTargetEnabled503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable(
					"agent_target_service_unavailable",
					apierrors.WithDeveloperMessage("agent target service is unavailable"),
				),
			),
		}, nil
	}
	if request.Body == nil || strings.TrimSpace(request.AgentTargetID) == "" {
		return invalidSetSystemAgentTargetEnabledRequest("agent target id and body are required"), nil
	}
	target, err := api.AgentTargetService.SetEnabled(ctx, agenttargetservice.SetEnabledInput{
		ID:      request.AgentTargetID,
		Enabled: request.Body.Enabled,
	})
	if err != nil {
		if errors.Is(err, workspacedata.ErrAgentTargetNotFound) ||
			errors.Is(err, agenttargetservice.ErrSystemTargetImmutable) ||
			errors.Is(err, agenttargetbiz.ErrInvalidTarget) {
			return invalidSetSystemAgentTargetEnabledRequest(err.Error()), nil
		}
		return tuttigenerated.SetSystemAgentTargetEnabled502JSONResponse{
			PreferencesOperationErrorJSONResponse: preferencesOperationError(
				apierrors.PreferencesOperationFailed(apierrors.WithCause(err)),
			),
		}, nil
	}
	response, err := agenttargetapi.GeneratedAgentTargetFromBiz(target)
	if err != nil {
		return tuttigenerated.SetSystemAgentTargetEnabled502JSONResponse{
			PreferencesOperationErrorJSONResponse: preferencesOperationError(
				apierrors.PreferencesOperationFailed(apierrors.WithCause(err)),
			),
		}, nil
	}
	return tuttigenerated.SetSystemAgentTargetEnabled200JSONResponse(response), nil
}

func invalidSetSystemAgentTargetEnabledRequest(message string) tuttigenerated.SetSystemAgentTargetEnabled400JSONResponse {
	return tuttigenerated.SetSystemAgentTargetEnabled400JSONResponse{
		InvalidRequestErrorJSONResponse: invalidRequestError(
			apierrors.InvalidRequest(
				"invalid_agent_target_enabled_update",
				apierrors.WithDeveloperMessage(message),
			),
		),
	}
}
