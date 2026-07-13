package api

import (
	"context"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
)

func (api DaemonAPI) GoalControlWorkspaceAgentSession(ctx context.Context, request tuttigenerated.GoalControlWorkspaceAgentSessionRequestObject) (tuttigenerated.GoalControlWorkspaceAgentSessionResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.GoalControlWorkspaceAgentSession503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return writeGoalControlWorkspaceAgentSessionError(
			apierrors.EmptyBody(
				apierrors.WithDeveloperMessage("goal control request body is required"),
			),
		), nil
	}
	objective := ""
	if request.Body.Objective != nil {
		objective = *request.Body.Objective
	}
	result, err := api.AgentSessionService.GoalControl(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		string(request.Body.Action),
		objective,
	)
	if err != nil {
		return writeGoalControlWorkspaceAgentSessionError(err), nil
	}
	response := tuttigenerated.GoalControlWorkspaceAgentSession200JSONResponse{
		Session: generatedAgentSession(result.Session),
	}
	if len(result.Goal) > 0 {
		var goal tuttigenerated.WorkspaceAgentSessionGoal
		if decodeTypedAgentSessionField(result.Goal, &goal) {
			response.Goal = &goal
		}
	}
	return response, nil
}
