package api

import (
	"context"
	"errors"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
)

func (api DaemonAPI) GetAgentTargetRuntimeUpdate(
	ctx context.Context,
	request tuttigenerated.GetAgentTargetRuntimeUpdateRequestObject,
) (tuttigenerated.GetAgentTargetRuntimeUpdateResponseObject, error) {
	if api.AgentTargetSetupService == nil {
		return tuttigenerated.GetAgentTargetRuntimeUpdate503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentTargetSetupUnavailable(),
		}, nil
	}
	input := agentextensionservice.RuntimeUpdateInput{
		WorkspaceID:   strings.TrimSpace(string(request.WorkspaceID)),
		AgentTargetID: strings.TrimSpace(request.AgentTargetID),
	}
	if input.WorkspaceID == "" || input.AgentTargetID == "" {
		return invalidGetAgentTargetRuntimeUpdateRequest("workspace id and agent target id are required"), nil
	}
	snapshot, err := api.AgentTargetSetupService.GetRuntimeUpdate(ctx, input)
	if err != nil {
		return getAgentTargetRuntimeUpdateError(err), nil
	}
	return tuttigenerated.GetAgentTargetRuntimeUpdate200JSONResponse(projectAgentTargetRuntimeUpdateSnapshot(snapshot)), nil
}

func (api DaemonAPI) UpdateAgentTargetRuntime(
	ctx context.Context,
	request tuttigenerated.UpdateAgentTargetRuntimeRequestObject,
) (tuttigenerated.UpdateAgentTargetRuntimeResponseObject, error) {
	if api.AgentTargetSetupService == nil {
		return tuttigenerated.UpdateAgentTargetRuntime503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentTargetSetupUnavailable(),
		}, nil
	}
	if request.Body == nil {
		return invalidUpdateAgentTargetRuntimeRequest("request body is required"), nil
	}
	input := agentextensionservice.ApplyRuntimeUpdateInput{
		WorkspaceID:    strings.TrimSpace(string(request.WorkspaceID)),
		AgentTargetID:  strings.TrimSpace(request.AgentTargetID),
		CurrentVersion: strings.TrimSpace(request.Body.CurrentVersion),
		LatestVersion:  strings.TrimSpace(request.Body.LatestVersion),
	}
	if input.WorkspaceID == "" || input.AgentTargetID == "" || input.CurrentVersion == "" || input.LatestVersion == "" {
		return invalidUpdateAgentTargetRuntimeRequest("workspace id, agent target id, current version, and latest version are required"), nil
	}
	snapshot, err := api.AgentTargetSetupService.ApplyRuntimeUpdate(ctx, input)
	if err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrWorkspaceNotFound):
			return tuttigenerated.UpdateAgentTargetRuntime404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(apierrors.WorkspaceNotFound("workspace_not_found", apierrors.WithCause(err))),
			}, nil
		case errors.Is(err, workspacedata.ErrAgentTargetNotFound),
			errors.Is(err, agentextensionservice.ErrInvalidInstallPlanRequest),
			errors.Is(err, agentextensionservice.ErrUnsupportedInstallTarget),
			errors.Is(err, agentextensionservice.ErrRuntimeUpdateUnavailable),
			errors.Is(err, agentextensionservice.ErrRuntimeUpdateChanged):
			return invalidUpdateAgentTargetRuntimeRequest(err.Error()), nil
		default:
			return tuttigenerated.UpdateAgentTargetRuntime502JSONResponse{
				WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
			}, nil
		}
	}
	return tuttigenerated.UpdateAgentTargetRuntime200JSONResponse(projectAgentTargetRuntimeUpdateSnapshot(snapshot)), nil
}

func projectAgentTargetRuntimeUpdateSnapshot(snapshot agentextensionservice.RuntimeUpdateSnapshot) tuttigenerated.AgentTargetRuntimeUpdateSnapshot {
	result := tuttigenerated.AgentTargetRuntimeUpdateSnapshot{
		WorkspaceId: snapshot.WorkspaceID, AgentTargetId: snapshot.AgentTargetID, Available: snapshot.Available,
	}
	if snapshot.CurrentVersion != "" {
		result.CurrentVersion = &snapshot.CurrentVersion
	}
	if snapshot.LatestVersion != "" {
		result.LatestVersion = &snapshot.LatestVersion
	}
	return result
}

func getAgentTargetRuntimeUpdateError(err error) tuttigenerated.GetAgentTargetRuntimeUpdateResponseObject {
	switch {
	case errors.Is(err, workspacedata.ErrWorkspaceNotFound):
		return tuttigenerated.GetAgentTargetRuntimeUpdate404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(apierrors.WorkspaceNotFound("workspace_not_found", apierrors.WithCause(err))),
		}
	case errors.Is(err, workspacedata.ErrAgentTargetNotFound),
		errors.Is(err, agentextensionservice.ErrInvalidInstallPlanRequest),
		errors.Is(err, agentextensionservice.ErrUnsupportedInstallTarget):
		return invalidGetAgentTargetRuntimeUpdateRequest(err.Error())
	default:
		return tuttigenerated.GetAgentTargetRuntimeUpdate502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}
	}
}

func invalidGetAgentTargetRuntimeUpdateRequest(message string) tuttigenerated.GetAgentTargetRuntimeUpdate400JSONResponse {
	return tuttigenerated.GetAgentTargetRuntimeUpdate400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(
		apierrors.InvalidRequest("invalid_agent_target_runtime_update", apierrors.WithDeveloperMessage(message)),
	)}
}

func invalidUpdateAgentTargetRuntimeRequest(message string) tuttigenerated.UpdateAgentTargetRuntime400JSONResponse {
	return tuttigenerated.UpdateAgentTargetRuntime400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(
		apierrors.InvalidRequest("invalid_agent_target_runtime_update", apierrors.WithDeveloperMessage(message)),
	)}
}
