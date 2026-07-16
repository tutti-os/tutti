package api

import (
	"context"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
)

func (api DaemonAPI) UpdateWorkspaceAgentSessionSettings(ctx context.Context, request tuttigenerated.UpdateWorkspaceAgentSessionSettingsRequestObject) (tuttigenerated.UpdateWorkspaceAgentSessionSettingsResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionSettings503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionSettings400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	session, err := api.AgentSessionService.UpdateSettings(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		composerSettingsPatchFromGenerated(*request.Body),
	)
	if err != nil {
		return writeUpdateWorkspaceAgentSessionSettingsError(err), nil
	}
	generatedSession, err := generatedAgentSession(session)
	if err != nil {
		return writeUpdateWorkspaceAgentSessionSettingsError(err), nil
	}
	return tuttigenerated.UpdateWorkspaceAgentSessionSettings200JSONResponse{
		Session: generatedSession,
	}, nil
}

func (api DaemonAPI) UpdateWorkspaceAgentSessionPin(ctx context.Context, request tuttigenerated.UpdateWorkspaceAgentSessionPinRequestObject) (tuttigenerated.UpdateWorkspaceAgentSessionPinResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionPin503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionPin400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	session, err := api.AgentSessionService.UpdatePin(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		request.Body.Pinned,
	)
	if err != nil {
		return writeUpdateWorkspaceAgentSessionPinError(err), nil
	}
	generatedSession, err := generatedAgentSession(session)
	if err != nil {
		return writeUpdateWorkspaceAgentSessionPinError(err), nil
	}
	return tuttigenerated.UpdateWorkspaceAgentSessionPin200JSONResponse{
		Session: generatedSession,
	}, nil
}

func (api DaemonAPI) UpdateWorkspaceAgentSessionTitle(ctx context.Context, request tuttigenerated.UpdateWorkspaceAgentSessionTitleRequestObject) (tuttigenerated.UpdateWorkspaceAgentSessionTitleResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionTitle503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionTitle400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	session, err := api.AgentSessionService.UpdateTitle(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		request.Body.Title,
	)
	if err != nil {
		return writeUpdateWorkspaceAgentSessionTitleError(err), nil
	}
	generatedSession, err := generatedAgentSession(session)
	if err != nil {
		return writeUpdateWorkspaceAgentSessionTitleError(err), nil
	}
	return tuttigenerated.UpdateWorkspaceAgentSessionTitle200JSONResponse{
		Session: generatedSession,
	}, nil
}

func (api DaemonAPI) UpdateWorkspaceAgentSessionVisibility(ctx context.Context, request tuttigenerated.UpdateWorkspaceAgentSessionVisibilityRequestObject) (tuttigenerated.UpdateWorkspaceAgentSessionVisibilityResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionVisibility503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionVisibility400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	session, err := api.AgentSessionService.UpdateVisible(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		request.Body.Visible,
	)
	if err != nil {
		return writeUpdateWorkspaceAgentSessionVisibilityError(err), nil
	}
	generatedSession, err := generatedAgentSession(session)
	if err != nil {
		return writeUpdateWorkspaceAgentSessionVisibilityError(err), nil
	}
	return tuttigenerated.UpdateWorkspaceAgentSessionVisibility200JSONResponse{
		Session: generatedSession,
	}, nil
}
