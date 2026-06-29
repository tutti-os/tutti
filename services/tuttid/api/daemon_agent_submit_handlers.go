package api

import (
	"context"

	"github.com/google/uuid"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func (api DaemonAPI) CreateWorkspaceAgentSession(ctx context.Context, request tuttigenerated.CreateWorkspaceAgentSessionRequestObject) (tuttigenerated.CreateWorkspaceAgentSessionResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.CreateWorkspaceAgentSession503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateWorkspaceAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	if request.Body.AgentSessionId == uuid.Nil {
		return tuttigenerated.CreateWorkspaceAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(apierrors.WithDeveloperMessage("agentSessionId must be a UUID")),
			),
		}, nil
	}
	agentSessionID := request.Body.AgentSessionId.String()
	metadata := mapValue(request.Body.Metadata)
	logCreateAgentSubmitTrace("api.create.received", string(request.WorkspaceID), agentSessionID, metadata, string(request.Body.Provider), "", nil)
	session, err := api.AgentSessionService.Create(ctx, string(request.WorkspaceID), agentservice.CreateSessionInput{
		AgentSessionID:       agentSessionID,
		Cwd:                  request.Body.Cwd,
		InitialContent:       agentPromptContentFromGenerated(request.Body.InitialContent),
		InitialDisplayPrompt: stringPtrValue(request.Body.InitialDisplayPrompt),
		Metadata:             metadata,
		Model:                request.Body.Model,
		PermissionModeID:     request.Body.PermissionModeId,
		PlanMode:             request.Body.PlanMode,
		BrowserUse:           request.Body.BrowserUse,
		ProviderTargetRef:    mapValue(request.Body.ProviderTargetRef),
		Provider:             string(request.Body.Provider),
		ReasoningEffort:      request.Body.ReasoningEffort,
		Speed:                request.Body.Speed,
		Title:                request.Body.Title,
		Visible:              request.Body.Visible,
	})
	if err != nil {
		logCreateAgentSubmitTrace("api.create.failed", string(request.WorkspaceID), agentSessionID, metadata, "", "", err)
		return writeCreateWorkspaceAgentSessionError(err), nil
	}
	logCreateAgentSubmitTrace("api.create.completed", string(request.WorkspaceID), agentSessionID, metadata, session.Provider, session.Status, nil)
	return tuttigenerated.CreateWorkspaceAgentSession201JSONResponse{
		Session: generatedAgentSession(session),
	}, nil
}

func (api DaemonAPI) SendWorkspaceAgentSessionInput(ctx context.Context, request tuttigenerated.SendWorkspaceAgentSessionInputRequestObject) (tuttigenerated.SendWorkspaceAgentSessionInputResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.SendWorkspaceAgentSessionInput503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.SendWorkspaceAgentSessionInput400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	metadata := mapValue(request.Body.Metadata)
	logSendAgentSubmitTrace("api.send.received", string(request.WorkspaceID), string(request.AgentSessionID), metadata, "", "", "", nil)
	result, err := api.AgentSessionService.SendInput(ctx, string(request.WorkspaceID), string(request.AgentSessionID), agentservice.SendInput{
		Content:       agentPromptContentFromGenerated(request.Body.Content),
		DisplayPrompt: stringPtrValue(request.Body.DisplayPrompt),
		Metadata:      metadata,
	})
	if err != nil {
		logSendAgentSubmitTrace("api.send.failed", string(request.WorkspaceID), string(request.AgentSessionID), metadata, "", "", "", err)
		return writeSendWorkspaceAgentSessionInputError(err), nil
	}
	logSendAgentSubmitTrace("api.send.completed", string(request.WorkspaceID), string(request.AgentSessionID), metadata, result.Session.Status, result.TurnID, result.TurnLifecycle.Phase, nil)
	return tuttigenerated.SendWorkspaceAgentSessionInput200JSONResponse{
		Session:            generatedAgentSession(result.Session),
		TurnId:             result.TurnID,
		TurnLifecycle:      generatedAgentTurnLifecycle(result.TurnLifecycle),
		SubmitAvailability: generatedAgentSubmitAvailability(result.SubmitAvailability),
	}, nil
}
