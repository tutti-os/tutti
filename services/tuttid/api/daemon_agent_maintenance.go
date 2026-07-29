package api

import (
	"context"
	"errors"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentmaintenance "github.com/tutti-os/tutti/services/tuttid/service/agentmaintenance"
)

func (api DaemonAPI) PurgeDeletedAgentConversations(
	ctx context.Context,
	_ tuttigenerated.PurgeDeletedAgentConversationsRequestObject,
) (tuttigenerated.PurgeDeletedAgentConversationsResponseObject, error) {
	if api.AgentMaintenanceService == nil {
		return tuttigenerated.PurgeDeletedAgentConversations503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceServiceUnavailable(apierrors.WithDeveloperMessage("agent data maintenance service is unavailable")),
			),
		}, nil
	}
	result, err := api.AgentMaintenanceService.PurgeNow(ctx)
	if errors.Is(err, agentmaintenance.ErrBusy) {
		return tuttigenerated.PurgeDeletedAgentConversations503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceServiceUnavailable(
					apierrors.WithDeveloperMessage("agent data maintenance is waiting for active work to finish"),
				),
			),
		}, nil
	}
	if err != nil {
		return tuttigenerated.PurgeDeletedAgentConversations502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(
				apierrors.WorkspaceOperationFailed(apierrors.WithCause(err)),
			),
		}, nil
	}
	return tuttigenerated.PurgeDeletedAgentConversations200JSONResponse{
		RemovedSessions: result.RemovedSessions,
		RemovedMessages: result.RemovedMessages,
		PayloadBytes:    result.PayloadBytes,
	}, nil
}
