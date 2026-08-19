package api

import (
	"context"
	"errors"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type SideConversationService interface {
	ResolveSideConversation(context.Context, string, string) (agenthost.SideConversationCapabilities, error)
	OpenSideConversation(context.Context, string, string, agentservice.OpenSideConversationInput) (agentservice.SideConversation, error)
	SendSideConversation(context.Context, string, string, agentservice.SendSideConversationInput) (agenthost.RuntimeExecResult, error)
	CancelSideConversation(context.Context, string, string, string) (agenthost.RuntimeCancelResult, error)
	SubmitSideConversationInteractive(context.Context, agenthost.RuntimeSubmitInteractiveInput) (agenthost.RuntimeSubmitInteractiveResult, error)
	CloseSideConversation(context.Context, string, string) error
}

func generatedSideCapabilities(
	input agenthost.SideConversationCapabilities,
) tuttigenerated.WorkspaceAgentSideCapabilities {
	return tuttigenerated.WorkspaceAgentSideCapabilities{
		Supported: input.Supported, ActiveSourceTurn: input.ActiveSourceTurn,
		Ephemeral: input.Ephemeral, HideInheritedTurns: input.HideInheritedTurns,
		ModelBoundaryInjected: input.ModelBoundaryInjected,
	}
}

func generatedSideConversation(
	input agentservice.SideConversation,
) tuttigenerated.WorkspaceAgentSideConversation {
	status := input.Status
	if status == "" {
		status = "idle"
	}
	return tuttigenerated.WorkspaceAgentSideConversation{
		WorkspaceId: input.WorkspaceID, SourceAgentSessionId: input.SourceAgentSessionID,
		SideAgentSessionId: input.SideAgentSessionID, Provider: input.Provider,
		Status: status, Capabilities: generatedSideCapabilities(input.Capabilities),
	}
}

func sideConflictError(err error) tuttigenerated.ApiErrorResponse {
	reason := "agent_side_conversation_conflict"
	switch {
	case errors.Is(err, agentservice.ErrSideConversationUnsupported):
		reason = "agent_side_conversation_unsupported"
	case errors.Is(err, agentservice.ErrSideConversationInProgress):
		reason = "agent_side_conversation_in_progress"
	case errors.Is(err, agentservice.ErrSideConversationExpired):
		reason = "agent_side_conversation_expired"
	case errors.Is(err, agentservice.ErrRuntimeSessionDisconnected):
		reason = "agent_side_conversation_expired"
	case errors.Is(err, agenthost.ErrInteractiveRequestNotLive):
		reason = "agent_side_interaction_not_live"
	case errors.Is(err, agenthost.ErrInteractiveAlreadyAnswered):
		reason = "agent_side_interaction_already_answered"
	}
	return protocolErrorResponse(apierrors.New(
		apierrors.StatusWorkspaceIssueExists,
		tuttigenerated.WorkspaceOperationFailed,
		reason,
		apierrors.WithCause(err),
	))
}

func isSideConflict(err error) bool {
	return errors.Is(err, agentservice.ErrSideConversationUnsupported) ||
		errors.Is(err, agentservice.ErrSideConversationInProgress) ||
		errors.Is(err, agentservice.ErrSideConversationConflict) ||
		errors.Is(err, agentservice.ErrSideConversationExpired) ||
		errors.Is(err, agentservice.ErrRuntimeSessionDisconnected) ||
		errors.Is(err, agenthost.ErrInteractiveRequestNotLive) ||
		errors.Is(err, agenthost.ErrInteractiveAlreadyAnswered)
}

func (api DaemonAPI) ResolveWorkspaceAgentSideCapabilities(
	ctx context.Context,
	request tuttigenerated.ResolveWorkspaceAgentSideCapabilitiesRequestObject,
) (tuttigenerated.ResolveWorkspaceAgentSideCapabilitiesResponseObject, error) {
	if api.SideConversationService == nil {
		return tuttigenerated.ResolveWorkspaceAgentSideCapabilities503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if !api.agentSideConversationEnabled(ctx) {
		return tuttigenerated.ResolveWorkspaceAgentSideCapabilities200JSONResponse{
			Capabilities: generatedSideCapabilities(agenthost.SideConversationCapabilities{}),
		}, nil
	}
	capabilities, err := api.SideConversationService.ResolveSideConversation(
		ctx, string(request.WorkspaceID), string(request.AgentSessionID),
	)
	if err != nil {
		if isSideConflict(err) {
			return tuttigenerated.ResolveWorkspaceAgentSideCapabilities409JSONResponse(
				sideConflictError(err),
			), nil
		}
		protocolErr := apierrors.Classify(err)
		if protocolErr.Code == tuttigenerated.InvalidRequest {
			return tuttigenerated.ResolveWorkspaceAgentSideCapabilities400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
			}, nil
		}
		if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
			return tuttigenerated.ResolveWorkspaceAgentSideCapabilities404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
			}, nil
		}
		return tuttigenerated.ResolveWorkspaceAgentSideCapabilities502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}, nil
	}
	return tuttigenerated.ResolveWorkspaceAgentSideCapabilities200JSONResponse{
		Capabilities: generatedSideCapabilities(capabilities),
	}, nil
}

func (api DaemonAPI) OpenWorkspaceAgentSideConversation(
	ctx context.Context,
	request tuttigenerated.OpenWorkspaceAgentSideConversationRequestObject,
) (tuttigenerated.OpenWorkspaceAgentSideConversationResponseObject, error) {
	if api.SideConversationService == nil {
		return tuttigenerated.OpenWorkspaceAgentSideConversation503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if !api.agentSideConversationEnabled(ctx) {
		return tuttigenerated.OpenWorkspaceAgentSideConversation400JSONResponse{
			InvalidRequestErrorJSONResponse: agentSideConversationDisabledError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.OpenWorkspaceAgentSideConversation400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")),
			),
		}, nil
	}
	side, err := api.SideConversationService.OpenSideConversation(
		ctx, string(request.WorkspaceID), string(request.AgentSessionID),
		agentservice.OpenSideConversationInput{
			SideAgentSessionID: request.Body.SideAgentSessionId,
			RequestID:          request.Body.RequestId,
		},
	)
	if err != nil {
		if isSideConflict(err) {
			return tuttigenerated.OpenWorkspaceAgentSideConversation409JSONResponse(
				sideConflictError(err),
			), nil
		}
		protocolErr := apierrors.Classify(err)
		if protocolErr.Code == tuttigenerated.InvalidRequest {
			return tuttigenerated.OpenWorkspaceAgentSideConversation400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
			}, nil
		}
		if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
			return tuttigenerated.OpenWorkspaceAgentSideConversation404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
			}, nil
		}
		return tuttigenerated.OpenWorkspaceAgentSideConversation502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}, nil
	}
	return tuttigenerated.OpenWorkspaceAgentSideConversation200JSONResponse{
		Side: generatedSideConversation(side),
	}, nil
}

func (api DaemonAPI) SendWorkspaceAgentSideConversationInput(
	ctx context.Context,
	request tuttigenerated.SendWorkspaceAgentSideConversationInputRequestObject,
) (tuttigenerated.SendWorkspaceAgentSideConversationInputResponseObject, error) {
	if api.SideConversationService == nil {
		return tuttigenerated.SendWorkspaceAgentSideConversationInput503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.SendWorkspaceAgentSideConversationInput400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")),
			),
		}, nil
	}
	result, err := api.SideConversationService.SendSideConversation(
		ctx, string(request.WorkspaceID), request.SideAgentSessionID,
		agentservice.SendSideConversationInput{
			TurnID: request.Body.TurnId, ClientSubmitID: request.Body.ClientSubmitId,
			Content:       agentPromptContentFromGenerated(request.Body.Content),
			DisplayPrompt: stringPtrValue(request.Body.DisplayPrompt),
		},
	)
	if err != nil {
		if isSideConflict(err) {
			return tuttigenerated.SendWorkspaceAgentSideConversationInput409JSONResponse(
				sideConflictError(err),
			), nil
		}
		protocolErr := apierrors.Classify(err)
		if protocolErr.Code == tuttigenerated.InvalidRequest {
			return tuttigenerated.SendWorkspaceAgentSideConversationInput400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
			}, nil
		}
		if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
			return tuttigenerated.SendWorkspaceAgentSideConversationInput404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
			}, nil
		}
		return tuttigenerated.SendWorkspaceAgentSideConversationInput502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}, nil
	}
	return tuttigenerated.SendWorkspaceAgentSideConversationInput200JSONResponse{
		SideAgentSessionId: result.AgentSessionID, TurnId: result.TurnID,
		Accepted: result.Accepted, Status: result.Status,
	}, nil
}

func (api DaemonAPI) CancelWorkspaceAgentSideConversationTurn(
	ctx context.Context,
	request tuttigenerated.CancelWorkspaceAgentSideConversationTurnRequestObject,
) (tuttigenerated.CancelWorkspaceAgentSideConversationTurnResponseObject, error) {
	if api.SideConversationService == nil {
		return tuttigenerated.CancelWorkspaceAgentSideConversationTurn503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	result, err := api.SideConversationService.CancelSideConversation(
		ctx, string(request.WorkspaceID), request.SideAgentSessionID, string(request.TurnID),
	)
	if err != nil {
		if isSideConflict(err) {
			return tuttigenerated.CancelWorkspaceAgentSideConversationTurn409JSONResponse(
				sideConflictError(err),
			), nil
		}
		protocolErr := apierrors.Classify(err)
		if protocolErr.Code == tuttigenerated.InvalidRequest {
			return tuttigenerated.CancelWorkspaceAgentSideConversationTurn400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
			}, nil
		}
		if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
			return tuttigenerated.CancelWorkspaceAgentSideConversationTurn404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
			}, nil
		}
		return tuttigenerated.CancelWorkspaceAgentSideConversationTurn502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}, nil
	}
	return tuttigenerated.CancelWorkspaceAgentSideConversationTurn200JSONResponse{
		Canceled: result.Canceled, TargetAbsent: result.TargetAbsent,
	}, nil
}

func (api DaemonAPI) SubmitWorkspaceAgentSideConversationInteractive(
	ctx context.Context,
	request tuttigenerated.SubmitWorkspaceAgentSideConversationInteractiveRequestObject,
) (tuttigenerated.SubmitWorkspaceAgentSideConversationInteractiveResponseObject, error) {
	if api.SideConversationService == nil {
		return tuttigenerated.SubmitWorkspaceAgentSideConversationInteractive503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.SubmitWorkspaceAgentSideConversationInteractive400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")),
			),
		}, nil
	}
	result, err := api.SideConversationService.SubmitSideConversationInteractive(
		ctx,
		agenthost.RuntimeSubmitInteractiveInput{
			WorkspaceID: string(request.WorkspaceID), RootAgentSessionID: request.SideAgentSessionID,
			AgentSessionID: request.SideAgentSessionID, TurnID: string(request.TurnID),
			RequestID: string(request.RequestID), Action: stringPtrValue(request.Body.Action),
			OptionID: stringPtrValue(request.Body.OptionId), Payload: optionalPayloadMap(request.Body.Payload),
		},
	)
	if err != nil {
		if isSideConflict(err) {
			return tuttigenerated.SubmitWorkspaceAgentSideConversationInteractive409JSONResponse(
				sideConflictError(err),
			), nil
		}
		if errors.Is(err, agenthost.ErrInteractiveResponseInvalid) {
			return tuttigenerated.SubmitWorkspaceAgentSideConversationInteractive400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(
					apierrors.InvalidRequest(
						"agent_side_interaction_invalid_response",
						apierrors.WithCause(err),
					),
				),
			}, nil
		}
		protocolErr := apierrors.Classify(err)
		if protocolErr.Code == tuttigenerated.InvalidRequest {
			return tuttigenerated.SubmitWorkspaceAgentSideConversationInteractive400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
			}, nil
		}
		if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
			return tuttigenerated.SubmitWorkspaceAgentSideConversationInteractive404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
			}, nil
		}
		return tuttigenerated.SubmitWorkspaceAgentSideConversationInteractive502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}, nil
	}
	return tuttigenerated.SubmitWorkspaceAgentSideConversationInteractive200JSONResponse{
		Disposition: string(result.Disposition),
	}, nil
}

func (api DaemonAPI) CloseWorkspaceAgentSideConversation(
	ctx context.Context,
	request tuttigenerated.CloseWorkspaceAgentSideConversationRequestObject,
) (tuttigenerated.CloseWorkspaceAgentSideConversationResponseObject, error) {
	if api.SideConversationService == nil {
		return tuttigenerated.CloseWorkspaceAgentSideConversation503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	err := api.SideConversationService.CloseSideConversation(
		ctx, string(request.WorkspaceID), request.SideAgentSessionID,
	)
	if err != nil && !errors.Is(err, agentservice.ErrSideConversationExpired) {
		protocolErr := apierrors.Classify(err)
		if protocolErr.Code == tuttigenerated.InvalidRequest {
			return tuttigenerated.CloseWorkspaceAgentSideConversation400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
			}, nil
		}
		if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
			return tuttigenerated.CloseWorkspaceAgentSideConversation404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
			}, nil
		}
		return tuttigenerated.CloseWorkspaceAgentSideConversation502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}, nil
	}
	return tuttigenerated.CloseWorkspaceAgentSideConversation204Response{}, nil
}
