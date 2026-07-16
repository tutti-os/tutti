package api

import (
	"context"
	"log/slog"
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
	if request.Params.AgentTargetId != nil {
		input.AgentTargetID = strings.TrimSpace(*request.Params.AgentTargetId)
	}
	if request.Params.Cursor != nil {
		input.Cursor = strings.TrimSpace(*request.Params.Cursor)
	}
	if request.Params.SearchQuery != nil {
		input.SearchQuery = strings.TrimSpace(*request.Params.SearchQuery)
	}
	if request.Params.Limit != nil {
		if *request.Params.Limit <= 0 || *request.Params.Limit > listWorkspaceAgentSessionsLimitMax {
			return writeListWorkspaceAgentSessionsError(agentservice.ErrInvalidArgument), nil
		}
		input.Limit = int(*request.Params.Limit)
	}
	workspaceID := string(request.WorkspaceID)
	page, err := api.AgentSessionService.ListPage(ctx, workspaceID, input)
	if err != nil {
		return writeListWorkspaceAgentSessionsError(err), nil
	}
	generatedSessions, err := generatedAgentSessions(page.Sessions)
	if err != nil {
		return writeListWorkspaceAgentSessionsError(err), nil
	}
	slog.Info("workspace agent sessions list completed",
		"event", "workspace.agent_session.api.list_completed",
		"workspace_id", workspaceID,
		"session_count", len(page.Sessions),
	)
	response := tuttigenerated.ListWorkspaceAgentSessions200JSONResponse{
		HasMore:     page.HasMore,
		Sessions:    generatedSessions,
		WorkspaceId: workspaceID,
	}
	if page.NextCursor != "" {
		response.NextCursor = &page.NextCursor
	}
	return response, nil
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
	generatedPinned, err := generatedAgentSessionPage(page.Pinned)
	if err != nil {
		return writeListWorkspaceAgentSessionSectionsError(err), nil
	}
	generatedSections, err := generatedAgentSessionSections(page.Sections)
	if err != nil {
		return writeListWorkspaceAgentSessionSectionsError(err), nil
	}
	return tuttigenerated.ListWorkspaceAgentSessionSections200JSONResponse{
		Pinned:      generatedPinned,
		Sections:    generatedSections,
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
	generatedSection, err := generatedAgentSessionSection(section)
	if err != nil {
		return writeListWorkspaceAgentSessionSectionPageError(err), nil
	}
	return tuttigenerated.ListWorkspaceAgentSessionSectionPage200JSONResponse{
		Section:     generatedSection,
		WorkspaceId: string(request.WorkspaceID),
	}, nil
}

func (api DaemonAPI) ListWorkspaceAgentSessionSectionDeletionCandidates(ctx context.Context, request tuttigenerated.ListWorkspaceAgentSessionSectionDeletionCandidatesRequestObject) (tuttigenerated.ListWorkspaceAgentSessionSectionDeletionCandidatesResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ListWorkspaceAgentSessionSectionDeletionCandidates503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	input := agentservice.ListSessionSectionDeletionCandidatesInput{
		SectionKey: strings.TrimSpace(request.Params.SectionKey),
	}
	if request.Params.AgentTargetId != nil {
		input.AgentTargetID = strings.TrimSpace(*request.Params.AgentTargetId)
	}
	if request.Params.ExcludePinned != nil {
		input.ExcludePinned = *request.Params.ExcludePinned
	}
	candidates, err := api.AgentSessionService.ListSessionSectionDeletionCandidates(ctx, string(request.WorkspaceID), input)
	if err != nil {
		return writeListWorkspaceAgentSessionSectionDeletionCandidatesError(err), nil
	}
	response := tuttigenerated.ListWorkspaceAgentSessionSectionDeletionCandidates200JSONResponse{
		ExcludePinned: candidates.ExcludePinned,
		SectionKey:    candidates.SectionKey,
		SessionIds:    candidates.SessionIDs,
		WorkspaceId:   candidates.WorkspaceID,
	}
	if strings.TrimSpace(candidates.AgentTargetID) != "" {
		response.AgentTargetId = &candidates.AgentTargetID
	}
	return response, nil
}

func (api DaemonAPI) DeleteWorkspaceAgentSessionsBatch(ctx context.Context, request tuttigenerated.DeleteWorkspaceAgentSessionsBatchRequestObject) (tuttigenerated.DeleteWorkspaceAgentSessionsBatchResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.DeleteWorkspaceAgentSessionsBatch503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return writeDeleteWorkspaceAgentSessionsBatchError(agentservice.ErrInvalidArgument), nil
	}
	sessionIDs, ok := normalizeBatchDeleteSessionIDs(request.Body.SessionIds)
	if !ok {
		return writeDeleteWorkspaceAgentSessionsBatchError(agentservice.ErrInvalidArgument), nil
	}
	result, err := api.AgentSessionService.DeleteSessionsBatch(ctx, string(request.WorkspaceID), agentservice.DeleteSessionsBatchInput{
		SessionIDs: sessionIDs,
	})
	if err != nil {
		return writeDeleteWorkspaceAgentSessionsBatchError(err), nil
	}
	return tuttigenerated.DeleteWorkspaceAgentSessionsBatch200JSONResponse{
		RemovedMessages:         result.RemovedMessages,
		RemovedSessionIds:       result.RemovedSessionIDs,
		RemovedSessions:         result.RemovedSessions,
		CleanupFailedSessionIds: result.CleanupFailedSessionIDs,
	}, nil
}

func normalizeBatchDeleteSessionIDs(input []string) ([]string, bool) {
	if len(input) == 0 {
		return nil, false
	}
	result := make([]string, 0, len(input))
	seen := make(map[string]struct{}, len(input))
	for _, value := range input {
		sessionID := strings.TrimSpace(value)
		if sessionID == "" {
			return nil, false
		}
		if _, exists := seen[sessionID]; exists {
			return nil, false
		}
		seen[sessionID] = struct{}{}
		result = append(result, sessionID)
	}
	return result, true
}

func (api DaemonAPI) ListWorkspaceAgentPinnedSessionPage(ctx context.Context, request tuttigenerated.ListWorkspaceAgentPinnedSessionPageRequestObject) (tuttigenerated.ListWorkspaceAgentPinnedSessionPageResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ListWorkspaceAgentPinnedSessionPage503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	input := agentservice.ListPinnedSessionPageInput{Limit: 5}
	if request.Params.AgentTargetId != nil {
		input.AgentTargetID = strings.TrimSpace(*request.Params.AgentTargetId)
	}
	if request.Params.Cursor != nil {
		input.Cursor = strings.TrimSpace(*request.Params.Cursor)
	}
	if request.Params.Limit != nil {
		if *request.Params.Limit <= 0 || *request.Params.Limit > listWorkspaceAgentSessionsLimitMax {
			return writeListWorkspaceAgentPinnedSessionPageError(agentservice.ErrInvalidArgument), nil
		}
		input.Limit = int(*request.Params.Limit)
	}
	page, err := api.AgentSessionService.ListPinnedSessionPage(ctx, string(request.WorkspaceID), input)
	if err != nil {
		return writeListWorkspaceAgentPinnedSessionPageError(err), nil
	}
	generatedPage, err := generatedAgentSessionPage(page)
	if err != nil {
		return writeListWorkspaceAgentPinnedSessionPageError(err), nil
	}
	return tuttigenerated.ListWorkspaceAgentPinnedSessionPage200JSONResponse{
		Page:        generatedPage,
		WorkspaceId: string(request.WorkspaceID),
	}, nil
}
