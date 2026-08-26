package api

import (
	"context"
	"errors"
	"net/http"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	globalagentactivityservice "github.com/tutti-os/tutti/services/tuttid/service/globalagentactivity"
)

type GlobalAgentActivityService interface {
	FilterOptions(context.Context) (*agentsessionstore.GlobalAgentActivityFilterOptions, error)
	ListSessions(context.Context, agentsessionstore.ListGlobalAgentActivitySessionsInput) (*agentsessionstore.ListGlobalAgentActivitySessionsReply, error)
}

func (api DaemonAPI) GetGlobalAgentActivityFilterOptions(ctx context.Context, _ tuttigenerated.GetGlobalAgentActivityFilterOptionsRequestObject) (tuttigenerated.GetGlobalAgentActivityFilterOptionsResponseObject, error) {
	if api.GlobalAgentActivityService == nil {
		return tuttigenerated.GetGlobalAgentActivityFilterOptions503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(apierrors.ServiceUnavailable("global_agent_activity_service_unavailable")),
		}, nil
	}
	options, err := api.GlobalAgentActivityService.FilterOptions(ctx)
	if err != nil {
		return getGlobalAgentActivityFilterOptionsError(err), nil
	}
	return tuttigenerated.GetGlobalAgentActivityFilterOptions200JSONResponse{
		Rooms:         generatedGlobalAgentActivityRooms(options.Rooms),
		SessionOwners: generatedGlobalAgentActivitySessionOwners(options.SessionOwners),
		Agents:        generatedGlobalAgentActivityAgents(options.Agents),
		TimeBounds:    generatedGlobalAgentActivityTimeBounds(options.TimeBounds),
	}, nil
}

func (api DaemonAPI) ListGlobalAgentActivitySessions(ctx context.Context, request tuttigenerated.ListGlobalAgentActivitySessionsRequestObject) (tuttigenerated.ListGlobalAgentActivitySessionsResponseObject, error) {
	if api.GlobalAgentActivityService == nil {
		return tuttigenerated.ListGlobalAgentActivitySessions503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(apierrors.ServiceUnavailable("global_agent_activity_service_unavailable")),
		}, nil
	}
	input := agentsessionstore.ListGlobalAgentActivitySessionsInput{
		RoomIDs:             dereferenceStrings(request.Params.RoomIds),
		SessionOwnerUserIDs: dereferenceStrings(request.Params.SessionOwnerUserIds),
		AgentKeys:           dereferenceStrings(request.Params.AgentKeys),
		ActivityFromUnixMS:  dereferenceInt64(request.Params.ActivityFromUnixMs),
		ActivityToUnixMS:    dereferenceInt64(request.Params.ActivityToUnixMs),
	}
	if !hasGlobalAgentActivityFilter(input) {
		return tuttigenerated.ListGlobalAgentActivitySessions400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("global_agent_activity_filter_required")),
		}, nil
	}
	reply, err := api.GlobalAgentActivityService.ListSessions(ctx, input)
	if err != nil {
		return listGlobalAgentActivitySessionsError(err), nil
	}
	items := make([]tuttigenerated.GlobalAgentActivitySession, 0, len(reply.Items))
	for _, item := range reply.Items {
		items = append(items, generatedGlobalAgentActivitySession(item))
	}
	return tuttigenerated.ListGlobalAgentActivitySessions200JSONResponse{
		Items:     items,
		Truncated: reply.Truncated,
	}, nil
}

func getGlobalAgentActivityFilterOptionsError(err error) tuttigenerated.GetGlobalAgentActivityFilterOptionsResponseObject {
	if isGlobalAgentActivityUnauthorized(err) {
		return tuttigenerated.GetGlobalAgentActivityFilterOptions401JSONResponse{
			UnauthorizedErrorJSONResponse: globalAgentActivityUnauthorizedError(),
		}
	}
	return tuttigenerated.GetGlobalAgentActivityFilterOptions502JSONResponse{
		WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
	}
}

func listGlobalAgentActivitySessionsError(err error) tuttigenerated.ListGlobalAgentActivitySessionsResponseObject {
	if isGlobalAgentActivityUnauthorized(err) {
		return tuttigenerated.ListGlobalAgentActivitySessions401JSONResponse{
			UnauthorizedErrorJSONResponse: globalAgentActivityUnauthorizedError(),
		}
	}
	var httpErr agentsessionstore.HTTPError
	if errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusBadRequest {
		return tuttigenerated.ListGlobalAgentActivitySessions400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("global_agent_activity_filter_invalid")),
		}
	}
	return tuttigenerated.ListGlobalAgentActivitySessions502JSONResponse{
		WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
	}
}

func isGlobalAgentActivityUnauthorized(err error) bool {
	if errors.Is(err, globalagentactivityservice.ErrUnauthenticated) {
		return true
	}
	var httpErr agentsessionstore.HTTPError
	return errors.As(err, &httpErr) && (httpErr.StatusCode == http.StatusUnauthorized || httpErr.StatusCode == http.StatusForbidden)
}

func globalAgentActivityUnauthorizedError() tuttigenerated.UnauthorizedErrorJSONResponse {
	return tuttigenerated.UnauthorizedErrorJSONResponse{
		Error: tuttigenerated.ApiErrorDetails{
			Code:   tuttigenerated.Unauthorized,
			Reason: stringPointer("global_agent_activity_authentication_required"),
		},
	}
}

func generatedGlobalAgentActivityRooms(items []agentsessionstore.GlobalAgentActivityRoomOption) []tuttigenerated.GlobalAgentActivityRoom {
	result := make([]tuttigenerated.GlobalAgentActivityRoom, 0, len(items))
	for _, item := range items {
		result = append(result, generatedGlobalAgentActivityRoom(item))
	}
	return result
}

func generatedGlobalAgentActivityRoom(item agentsessionstore.GlobalAgentActivityRoomOption) tuttigenerated.GlobalAgentActivityRoom {
	return tuttigenerated.GlobalAgentActivityRoom{RoomId: item.RoomID, Name: item.Name, AvatarUri: item.AvatarURI}
}

func generatedGlobalAgentActivitySessionOwners(items []agentsessionstore.GlobalAgentActivitySessionOwnerOption) []tuttigenerated.GlobalAgentActivitySessionOwner {
	result := make([]tuttigenerated.GlobalAgentActivitySessionOwner, 0, len(items))
	for _, item := range items {
		result = append(result, generatedGlobalAgentActivitySessionOwner(item))
	}
	return result
}

func generatedGlobalAgentActivitySessionOwner(item agentsessionstore.GlobalAgentActivitySessionOwnerOption) tuttigenerated.GlobalAgentActivitySessionOwner {
	return tuttigenerated.GlobalAgentActivitySessionOwner{
		UserId: item.UserID, DisplayName: item.DisplayName, AvatarUrl: item.AvatarURL,
		AvatarFallbackUrl: item.AvatarFallbackURL, AvatarClientTransform: item.AvatarClientTransform,
	}
}

func generatedGlobalAgentActivityAgents(items []agentsessionstore.GlobalAgentActivityAgentOption) []tuttigenerated.GlobalAgentActivityAgent {
	result := make([]tuttigenerated.GlobalAgentActivityAgent, 0, len(items))
	for _, item := range items {
		result = append(result, generatedGlobalAgentActivityAgent(item))
	}
	return result
}

func generatedGlobalAgentActivityAgent(item agentsessionstore.GlobalAgentActivityAgentOption) tuttigenerated.GlobalAgentActivityAgent {
	return tuttigenerated.GlobalAgentActivityAgent{
		AgentKey: item.AgentKey, AgentTargetId: item.AgentTargetID, Provider: item.Provider,
		Name: item.Name, IconKey: item.IconKey,
	}
}

func generatedGlobalAgentActivityTimeBounds(item agentsessionstore.GlobalAgentActivityTimeBounds) tuttigenerated.GlobalAgentActivityTimeBounds {
	return tuttigenerated.GlobalAgentActivityTimeBounds{
		MinActivityAtUnixMs: item.MinActivityAtUnixMS,
		MaxActivityAtUnixMs: item.MaxActivityAtUnixMS,
		ServerNowUnixMs:     item.ServerNowUnixMS,
	}
}

func generatedGlobalAgentActivitySession(item agentsessionstore.GlobalAgentActivitySession) tuttigenerated.GlobalAgentActivitySession {
	return tuttigenerated.GlobalAgentActivitySession{
		Room: generatedGlobalAgentActivityRoom(item.Room), WorkspaceId: item.WorkspaceID,
		AgentSessionId: item.AgentSessionID, SessionOwner: generatedGlobalAgentActivitySessionOwner(item.SessionOwner),
		Agent: generatedGlobalAgentActivityAgent(item.Agent), Status: item.Status, Title: item.Title,
		Summary: item.Summary, LatestUserPrompt: item.LatestUserPrompt, NeedsAttention: item.NeedsAttention,
		ActivityAtUnixMs: item.ActivityAtUnixMS, LatestMessageAtUnixMs: item.LatestMessageAtUnixMS,
		StartedAtUnixMs: item.StartedAtUnixMS, EndedAtUnixMs: item.EndedAtUnixMS, LatestTurnId: item.LatestTurnID,
	}
}

func dereferenceStrings(value *[]string) []string {
	if value == nil {
		return nil
	}
	return *value
}

func dereferenceInt64(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func hasGlobalAgentActivityFilter(input agentsessionstore.ListGlobalAgentActivitySessionsInput) bool {
	return len(input.RoomIDs) > 0 || len(input.SessionOwnerUserIDs) > 0 || len(input.AgentKeys) > 0 || input.ActivityFromUnixMS > 0 || input.ActivityToUnixMS > 0
}
