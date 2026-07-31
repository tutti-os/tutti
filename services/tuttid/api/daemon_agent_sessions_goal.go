package api

import (
	"context"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
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
	clientSubmitID := ""
	if request.Body.ClientSubmitId != nil {
		clientSubmitID = *request.Body.ClientSubmitId
	}
	result, err := api.AgentSessionService.GoalControl(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		string(request.Body.Action),
		objective,
		clientSubmitID,
	)
	if err != nil {
		return writeGoalControlWorkspaceAgentSessionError(err), nil
	}
	generatedSession, err := generatedAgentSession(result.Session)
	if err != nil {
		return writeGoalControlWorkspaceAgentSessionError(err), nil
	}
	goal := generatedGoalControlProjection(&generatedSession, result.Goal)
	response := tuttigenerated.GoalControlWorkspaceAgentSession200JSONResponse{
		Goal:    goal,
		Session: generatedSession,
	}
	if result.OperationID != "" {
		response.OperationId = &result.OperationID
	}
	if result.GoalState != nil {
		state := generatedAgentSessionGoalState(*result.GoalState)
		response.State = &state
	}
	api.recordAgentStimulus(ctx, "goal.control", string(request.WorkspaceID), string(request.AgentSessionID), map[string]any{
		"action":         request.Body.Action,
		"clientSubmitId": request.Body.ClientSubmitId,
		"objective":      request.Body.Objective,
	})
	return response, nil
}

// generatedGoalControlProjection makes the Host-owned Goal result authoritative
// over the runtime Session snapshot returned by the adapter. In particular,
// clear must remain an explicit nil projection even if the runtime snapshot
// still carries the pre-clear Goal.
func generatedGoalControlProjection(
	session *tuttigenerated.WorkspaceAgentSession,
	raw map[string]any,
) *tuttigenerated.WorkspaceAgentSessionGoal {
	var goal *tuttigenerated.WorkspaceAgentSessionGoal
	if len(raw) > 0 {
		var value tuttigenerated.WorkspaceAgentSessionGoal
		if decodeTypedAgentSessionField(raw, &value) &&
			strings.TrimSpace(value.Objective) != "" &&
			value.Status.Valid() {
			goal = &value
		}
	}
	session.Goal = goal
	return goal
}

func (api DaemonAPI) GetWorkspaceAgentSessionGoal(ctx context.Context, request tuttigenerated.GetWorkspaceAgentSessionGoalRequestObject) (tuttigenerated.GetWorkspaceAgentSessionGoalResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.GetWorkspaceAgentSessionGoal503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	result, err := api.AgentSessionService.GetGoalState(ctx, string(request.WorkspaceID), string(request.AgentSessionID))
	if err != nil {
		protocolErr := apierrors.Classify(err)
		if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
			return tuttigenerated.GetWorkspaceAgentSessionGoal404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
			}, nil
		}
		return tuttigenerated.GetWorkspaceAgentSessionGoal502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}, nil
	}
	session, err := generatedAgentSession(result.Session)
	if err != nil {
		return tuttigenerated.GetWorkspaceAgentSessionGoal502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.Classify(err)),
		}, nil
	}
	return tuttigenerated.GetWorkspaceAgentSessionGoal200JSONResponse{
		Session: session,
		State:   generatedAgentSessionGoalState(result.State),
	}, nil
}

func (api DaemonAPI) ReconcileWorkspaceAgentSessionGoal(ctx context.Context, request tuttigenerated.ReconcileWorkspaceAgentSessionGoalRequestObject) (tuttigenerated.ReconcileWorkspaceAgentSessionGoalResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ReconcileWorkspaceAgentSessionGoal503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	result, err := api.AgentSessionService.ReconcileGoal(ctx, string(request.WorkspaceID), string(request.AgentSessionID))
	if err != nil {
		protocolErr := apierrors.Classify(err)
		if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
			return tuttigenerated.ReconcileWorkspaceAgentSessionGoal404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
			}, nil
		}
		return tuttigenerated.ReconcileWorkspaceAgentSessionGoal502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}, nil
	}
	session, err := generatedAgentSession(result.Session)
	if err != nil {
		return tuttigenerated.ReconcileWorkspaceAgentSessionGoal502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.Classify(err)),
		}, nil
	}
	return tuttigenerated.ReconcileWorkspaceAgentSessionGoal200JSONResponse{
		Session: session,
		State:   generatedAgentSessionGoalState(result.State),
	}, nil
}

func generatedAgentSessionGoalState(state agentactivitybiz.SessionGoalState) tuttigenerated.WorkspaceAgentSessionGoalState {
	syncStatus := tuttigenerated.WorkspaceAgentSessionGoalStateSyncStatus(state.SyncStatus)
	if !syncStatus.Valid() {
		syncStatus = tuttigenerated.WorkspaceAgentSessionGoalStateSyncStatusUnknown
	}
	result := tuttigenerated.WorkspaceAgentSessionGoalState{
		Revision: state.Revision, Tombstoned: state.Tombstoned,
		SyncStatus:   syncStatus,
		LastEvidence: map[string]any{}, UpdatedAtUnixMs: state.UpdatedAtUnixMS,
	}
	for key, value := range state.LastEvidence {
		result.LastEvidence[key] = value
	}
	if len(state.Desired) > 0 {
		var goal tuttigenerated.WorkspaceAgentSessionGoal
		if decodeTypedAgentSessionField(state.Desired, &goal) {
			result.Desired = &goal
		}
	}
	if len(state.Observed) > 0 {
		var goal tuttigenerated.WorkspaceAgentSessionGoal
		if decodeTypedAgentSessionField(state.Observed, &goal) && goal.Objective != "" && goal.Status.Valid() {
			result.Observed = &goal
		}
	}
	if state.PendingOperationID != "" {
		result.PendingOperationId = &state.PendingOperationID
	}
	if state.LastError != "" {
		result.LastError = &state.LastError
	}
	if state.ObservedAtUnixMS > 0 {
		result.ObservedAtUnixMs = &state.ObservedAtUnixMS
	}
	return result
}
