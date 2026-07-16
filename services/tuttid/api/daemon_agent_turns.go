package api

import (
	"context"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
)

// CancelWorkspaceAgentTurn is the protocol v2 turn-scoped cancel. Idempotent
// by contract: settled or unknown turns return canceled=false with an
// explanatory reason instead of an error.
func (api DaemonAPI) CancelWorkspaceAgentTurn(ctx context.Context, request tuttigenerated.CancelWorkspaceAgentTurnRequestObject) (tuttigenerated.CancelWorkspaceAgentTurnResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.CancelWorkspaceAgentTurn503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	result, err := api.AgentSessionService.CancelTurn(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		string(request.TurnID),
	)
	if err != nil {
		return writeCancelWorkspaceAgentTurnError(err), nil
	}
	response := tuttigenerated.CancelWorkspaceAgentTurn200JSONResponse{
		Cancel: tuttigenerated.WorkspaceAgentTurnCancelResult{
			Canceled: result.Canceled,
			Reason:   tuttigenerated.WorkspaceAgentTurnCancelResultReason(result.Reason),
		},
	}
	if result.Turn != nil {
		turn := generatedWorkspaceAgentTurn(*result.Turn)
		response.Turn = &turn
	}
	return response, nil
}

func writeCancelWorkspaceAgentTurnError(err error) tuttigenerated.CancelWorkspaceAgentTurnResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.CancelWorkspaceAgentTurn404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CancelWorkspaceAgentTurn400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.CancelWorkspaceAgentTurn502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}
