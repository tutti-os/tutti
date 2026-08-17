package api

import (
	"context"
	"errors"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	agentmaintenance "github.com/tutti-os/tutti/services/tuttid/service/agentmaintenance"
)

type workspaceDeletedAgentSessionService interface {
	ListDeletedSessions(context.Context, string, agentservice.ListDeletedSessionsInput) (agentservice.DeletedSessionPage, error)
	RestoreDeletedSession(context.Context, string, string) (agentservice.RestoreDeletedSessionResult, error)
}

func (api DaemonAPI) ListWorkspaceDeletedAgentSessions(
	ctx context.Context,
	request tuttigenerated.ListWorkspaceDeletedAgentSessionsRequestObject,
) (tuttigenerated.ListWorkspaceDeletedAgentSessionsResponseObject, error) {
	service, ok := api.AgentSessionService.(workspaceDeletedAgentSessionService)
	if !ok {
		return tuttigenerated.ListWorkspaceDeletedAgentSessions503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	input := agentservice.ListDeletedSessionsInput{}
	sectionFilterCount := 0
	if request.Params.RailSectionKey != nil {
		sectionFilterCount++
		railSectionKey := strings.TrimSpace(*request.Params.RailSectionKey)
		if railSectionKey == "" {
			return writeListWorkspaceDeletedAgentSessionsError(agentservice.ErrInvalidArgument), nil
		}
		input.RailSectionKey = &railSectionKey
	}
	if request.Params.ProjectScope != nil {
		sectionFilterCount++
		if !request.Params.ProjectScope.Valid() {
			return writeListWorkspaceDeletedAgentSessionsError(agentservice.ErrInvalidArgument), nil
		}
		conversations := "conversations"
		input.RailSectionKey = &conversations
	}
	if request.Params.ProjectPath != nil {
		sectionFilterCount++
		projectPath := strings.TrimSpace(*request.Params.ProjectPath)
		if projectPath == "" {
			return writeListWorkspaceDeletedAgentSessionsError(agentservice.ErrInvalidArgument), nil
		}
		railSectionKey := userprojectbiz.SectionKeyFromPath(projectPath)
		input.RailSectionKey = &railSectionKey
	}
	if sectionFilterCount > 1 {
		return writeListWorkspaceDeletedAgentSessionsError(agentservice.ErrInvalidArgument), nil
	}
	if request.Params.SearchQuery != nil {
		input.SearchQuery = strings.TrimSpace(*request.Params.SearchQuery)
	}
	if request.Params.Cursor != nil {
		input.Cursor = strings.TrimSpace(*request.Params.Cursor)
		if input.Cursor == "" {
			return writeListWorkspaceDeletedAgentSessionsError(agentservice.ErrInvalidArgument), nil
		}
	}
	if request.Params.Limit != nil {
		if *request.Params.Limit <= 0 || *request.Params.Limit > listWorkspaceAgentSessionsLimitMax {
			return writeListWorkspaceDeletedAgentSessionsError(agentservice.ErrInvalidArgument), nil
		}
		input.Limit = *request.Params.Limit
	}

	page, err := service.ListDeletedSessions(ctx, string(request.WorkspaceID), input)
	if err != nil {
		return writeListWorkspaceDeletedAgentSessionsError(err), nil
	}
	sessions := make([]tuttigenerated.WorkspaceDeletedAgentSession, 0, len(page.Sessions))
	for _, session := range page.Sessions {
		var projectPath *string
		if value := strings.TrimSpace(session.ProjectPath); value != "" {
			projectPath = &value
		}
		var unavailableReason *tuttigenerated.WorkspaceDeletedAgentSessionUnavailableReason
		if value := strings.TrimSpace(session.UnavailableReason); value != "" {
			reason := tuttigenerated.WorkspaceDeletedAgentSessionUnavailableReason(value)
			unavailableReason = &reason
		}
		sessions = append(sessions, tuttigenerated.WorkspaceDeletedAgentSession{
			AgentSessionId:    strings.TrimSpace(session.AgentSessionID),
			Title:             session.Title,
			RailSectionKey:    strings.TrimSpace(session.RailSectionKey),
			ProjectPath:       projectPath,
			UpdatedAtUnixMs:   session.UpdatedAtUnixMS,
			DeletedAtUnixMs:   session.DeletedAtUnixMS,
			Restorable:        session.Restorable,
			UnavailableReason: unavailableReason,
		})
	}
	projectOptions := make([]tuttigenerated.WorkspaceDeletedAgentSessionProjectOption, 0, len(page.ProjectOptions))
	for _, option := range page.ProjectOptions {
		var projectPath *string
		if value := strings.TrimSpace(option.ProjectPath); value != "" {
			projectPath = &value
		}
		projectOptions = append(projectOptions, tuttigenerated.WorkspaceDeletedAgentSessionProjectOption{
			RailSectionKey:   strings.TrimSpace(option.RailSectionKey),
			ProjectPath:      projectPath,
			ProjectLabel:     option.ProjectLabel,
			ProjectAvailable: option.ProjectAvailable,
		})
	}
	response := tuttigenerated.ListWorkspaceDeletedAgentSessions200JSONResponse{
		WorkspaceId:         string(request.WorkspaceID),
		Sessions:            sessions,
		ProjectOptions:      projectOptions,
		TotalCount:          page.TotalCount,
		WorkspaceTotalCount: page.WorkspaceTotalCount,
		HasMore:             page.HasMore,
	}
	if nextCursor := strings.TrimSpace(page.NextCursor); nextCursor != "" {
		response.NextCursor = &nextCursor
	}
	return response, nil
}

func (api DaemonAPI) RestoreWorkspaceDeletedAgentSession(
	ctx context.Context,
	request tuttigenerated.RestoreWorkspaceDeletedAgentSessionRequestObject,
) (tuttigenerated.RestoreWorkspaceDeletedAgentSessionResponseObject, error) {
	service, ok := api.AgentSessionService.(workspaceDeletedAgentSessionService)
	if !ok {
		return tuttigenerated.RestoreWorkspaceDeletedAgentSession503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	result, err := service.RestoreDeletedSession(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
	)
	if err != nil {
		return writeRestoreWorkspaceDeletedAgentSessionError(err), nil
	}
	return tuttigenerated.RestoreWorkspaceDeletedAgentSession200JSONResponse{
		AgentSessionId: string(request.AgentSessionID),
		Restored:       result.Restored,
	}, nil
}

func (api DaemonAPI) PurgeWorkspaceDeletedAgentSessions(
	ctx context.Context,
	request tuttigenerated.PurgeWorkspaceDeletedAgentSessionsRequestObject,
) (tuttigenerated.PurgeWorkspaceDeletedAgentSessionsResponseObject, error) {
	if api.AgentMaintenanceService == nil {
		return tuttigenerated.PurgeWorkspaceDeletedAgentSessions503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentMaintenanceServiceUnavailableError(),
		}, nil
	}
	result, err := api.AgentMaintenanceService.PurgeWorkspace(ctx, string(request.WorkspaceID))
	if err != nil {
		return writePurgeWorkspaceDeletedAgentSessionsError(err), nil
	}
	return tuttigenerated.PurgeWorkspaceDeletedAgentSessions200JSONResponse(generatedDeletedAgentConversationPurgeResult(result)), nil
}

func (api DaemonAPI) PurgeWorkspaceDeletedAgentSession(
	ctx context.Context,
	request tuttigenerated.PurgeWorkspaceDeletedAgentSessionRequestObject,
) (tuttigenerated.PurgeWorkspaceDeletedAgentSessionResponseObject, error) {
	if api.AgentMaintenanceService == nil {
		return tuttigenerated.PurgeWorkspaceDeletedAgentSession503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentMaintenanceServiceUnavailableError(),
		}, nil
	}
	result, err := api.AgentMaintenanceService.PurgeSession(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
	)
	if err != nil {
		return writePurgeWorkspaceDeletedAgentSessionError(err), nil
	}
	return tuttigenerated.PurgeWorkspaceDeletedAgentSession200JSONResponse(generatedDeletedAgentConversationPurgeResult(result)), nil
}

func generatedDeletedAgentConversationPurgeResult(result agentmaintenance.PurgeResult) tuttigenerated.DeletedAgentConversationPurgeResult {
	return tuttigenerated.DeletedAgentConversationPurgeResult{
		RemovedSessions: result.RemovedSessions,
		RemovedMessages: result.RemovedMessages,
		PayloadBytes:    result.PayloadBytes,
	}
}

func agentMaintenanceServiceUnavailableError() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(
		apierrors.WorkspaceServiceUnavailable(
			apierrors.WithDeveloperMessage("agent data maintenance service is unavailable"),
		),
	)
}

func deletedAgentSessionBusyError() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(
		apierrors.WorkspaceServiceUnavailable(
			apierrors.WithDeveloperMessage("agent data maintenance is waiting for active work to finish"),
		),
	)
}

func writeListWorkspaceDeletedAgentSessionsError(err error) tuttigenerated.ListWorkspaceDeletedAgentSessionsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ListWorkspaceDeletedAgentSessions404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceDeletedAgentSessions400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ListWorkspaceDeletedAgentSessions502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeRestoreWorkspaceDeletedAgentSessionError(err error) tuttigenerated.RestoreWorkspaceDeletedAgentSessionResponseObject {
	switch {
	case errors.Is(err, agenthost.ErrDeletedSessionNotRestorable):
		return tuttigenerated.RestoreWorkspaceDeletedAgentSession409JSONResponse(
			protocolErrorResponse(apierrors.New(
				apierrors.StatusConflict,
				tuttigenerated.WorkspaceOperationFailed,
				apierrors.ReasonWorkspaceAgentSessionNotRestorable,
				apierrors.WithCause(err),
			)),
		)
	case errors.Is(err, agenthost.ErrDeletedSessionNotFound):
		return tuttigenerated.RestoreWorkspaceDeletedAgentSession404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(
				apierrors.WorkspaceNotFound(
					apierrors.ReasonWorkspaceAgentSessionNotFound,
					apierrors.WithCause(err),
				),
			),
		}
	}
	protocolErr := apierrors.Classify(err)
	if protocolErr.Code == tuttigenerated.InvalidRequest {
		return tuttigenerated.RestoreWorkspaceDeletedAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	}
	return tuttigenerated.RestoreWorkspaceDeletedAgentSession502JSONResponse{
		WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
	}
}

func writePurgeWorkspaceDeletedAgentSessionsError(err error) tuttigenerated.PurgeWorkspaceDeletedAgentSessionsResponseObject {
	switch {
	case errors.Is(err, agentmaintenance.ErrBusy):
		return tuttigenerated.PurgeWorkspaceDeletedAgentSessions503JSONResponse{
			ServiceUnavailableErrorJSONResponse: deletedAgentSessionBusyError(),
		}
	case errors.Is(err, agenthost.ErrDeletedSessionNotFound):
		return tuttigenerated.PurgeWorkspaceDeletedAgentSessions404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(
				apierrors.WorkspaceNotFound(apierrors.ReasonWorkspaceAgentSessionNotFound, apierrors.WithCause(err)),
			),
		}
	}
	protocolErr := apierrors.Classify(err)
	if protocolErr.Code == tuttigenerated.InvalidRequest {
		return tuttigenerated.PurgeWorkspaceDeletedAgentSessions400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	}
	return tuttigenerated.PurgeWorkspaceDeletedAgentSessions502JSONResponse{
		WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
	}
}

func writePurgeWorkspaceDeletedAgentSessionError(err error) tuttigenerated.PurgeWorkspaceDeletedAgentSessionResponseObject {
	switch {
	case errors.Is(err, agentmaintenance.ErrBusy):
		return tuttigenerated.PurgeWorkspaceDeletedAgentSession503JSONResponse{
			ServiceUnavailableErrorJSONResponse: deletedAgentSessionBusyError(),
		}
	case errors.Is(err, agenthost.ErrDeletedSessionNotFound):
		return tuttigenerated.PurgeWorkspaceDeletedAgentSession404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(
				apierrors.WorkspaceNotFound(apierrors.ReasonWorkspaceAgentSessionNotFound, apierrors.WithCause(err)),
			),
		}
	}
	protocolErr := apierrors.Classify(err)
	if protocolErr.Code == tuttigenerated.InvalidRequest {
		return tuttigenerated.PurgeWorkspaceDeletedAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	}
	return tuttigenerated.PurgeWorkspaceDeletedAgentSession502JSONResponse{
		WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
	}
}
