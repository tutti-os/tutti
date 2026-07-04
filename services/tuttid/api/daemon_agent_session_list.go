package api

import (
	"context"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

const listWorkspaceAgentSessionsLimitMax = 100

func agentSessionServiceUnavailableError() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(
		apierrors.WorkspaceAgentSessionServiceUnavailable(
			apierrors.WithDeveloperMessage("workspace agent session service is unavailable"),
		),
	)
}

func (api DaemonAPI) ListWorkspaceAgentSessions(ctx context.Context, request tuttigenerated.ListWorkspaceAgentSessionsRequestObject) (tuttigenerated.ListWorkspaceAgentSessionsResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ListWorkspaceAgentSessions503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	input := agentservice.ListSessionsInput{}
	if request.Params.SearchQuery != nil {
		input.SearchQuery = strings.TrimSpace(*request.Params.SearchQuery)
	}
	if request.Params.Limit != nil {
		if *request.Params.Limit <= 0 || *request.Params.Limit > listWorkspaceAgentSessionsLimitMax {
			return writeListWorkspaceAgentSessionsError(agentservice.ErrInvalidArgument), nil
		}
		input.Limit = int(*request.Params.Limit)
	}
	sessions, err := api.AgentSessionService.ListFiltered(ctx, string(request.WorkspaceID), input)
	if err != nil {
		return writeListWorkspaceAgentSessionsError(err), nil
	}
	return tuttigenerated.ListWorkspaceAgentSessions200JSONResponse{
		Sessions:    generatedAgentSessions(sessions),
		WorkspaceId: string(request.WorkspaceID),
	}, nil
}

func (api DaemonAPI) ListWorkspaceAgentSessionSections(ctx context.Context, request tuttigenerated.ListWorkspaceAgentSessionSectionsRequestObject) (tuttigenerated.ListWorkspaceAgentSessionSectionsResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ListWorkspaceAgentSessionSections503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	input := agentservice.ListSessionSectionsInput{LimitPerSection: 5}
	if request.Params.AgentTargetId != nil {
		input.AgentTargetID = strings.TrimSpace(*request.Params.AgentTargetId)
	}
	if request.Params.LimitPerSection != nil {
		if *request.Params.LimitPerSection <= 0 || *request.Params.LimitPerSection > listWorkspaceAgentSessionsLimitMax {
			return writeListWorkspaceAgentSessionSectionsError(agentservice.ErrInvalidArgument), nil
		}
		input.LimitPerSection = int(*request.Params.LimitPerSection)
	}
	page, err := api.AgentSessionService.ListSessionSections(ctx, string(request.WorkspaceID), input)
	if err != nil {
		return writeListWorkspaceAgentSessionSectionsError(err), nil
	}
	return tuttigenerated.ListWorkspaceAgentSessionSections200JSONResponse{
		Sections:    generatedAgentSessionSections(page.Sections),
		WorkspaceId: page.WorkspaceID,
	}, nil
}

func (api DaemonAPI) ListWorkspaceAgentSessionSectionPage(ctx context.Context, request tuttigenerated.ListWorkspaceAgentSessionSectionPageRequestObject) (tuttigenerated.ListWorkspaceAgentSessionSectionPageResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ListWorkspaceAgentSessionSectionPage503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	input := agentservice.ListSessionSectionPageInput{
		Limit:      5,
		SectionKey: strings.TrimSpace(request.Params.SectionKey),
	}
	if request.Params.AgentTargetId != nil {
		input.AgentTargetID = strings.TrimSpace(*request.Params.AgentTargetId)
	}
	if request.Params.Cursor != nil {
		input.Cursor = strings.TrimSpace(*request.Params.Cursor)
	}
	if request.Params.Limit != nil {
		if *request.Params.Limit <= 0 || *request.Params.Limit > listWorkspaceAgentSessionsLimitMax {
			return writeListWorkspaceAgentSessionSectionPageError(agentservice.ErrInvalidArgument), nil
		}
		input.Limit = int(*request.Params.Limit)
	}
	section, err := api.AgentSessionService.ListSessionSectionPage(ctx, string(request.WorkspaceID), input)
	if err != nil {
		return writeListWorkspaceAgentSessionSectionPageError(err), nil
	}
	return tuttigenerated.ListWorkspaceAgentSessionSectionPage200JSONResponse{
		Section:     generatedAgentSessionSection(section),
		WorkspaceId: string(request.WorkspaceID),
	}, nil
}
