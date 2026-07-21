package api

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	tuttimodeactivationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
	tuttimodeactivationservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeactivation"
)

type TuttiModeActivationService interface {
	Get(context.Context, string, string) (*tuttimodeactivationbiz.Activation, error)
	Set(context.Context, tuttimodeactivationservice.SetInput) (tuttimodeactivationservice.SetResult, error)
}

func (api DaemonAPI) GetWorkspaceAgentSessionTuttiModeActivation(ctx context.Context, request tuttigenerated.GetWorkspaceAgentSessionTuttiModeActivationRequestObject) (tuttigenerated.GetWorkspaceAgentSessionTuttiModeActivationResponseObject, error) {
	if api.AgentSessionService == nil || api.TuttiModeActivationService == nil {
		return tuttigenerated.GetWorkspaceAgentSessionTuttiModeActivation503JSONResponse{
			ServiceUnavailableErrorJSONResponse: tuttiModeActivationServiceUnavailableError(),
		}, nil
	}
	workspaceID := string(request.WorkspaceID)
	agentSessionID := string(request.AgentSessionID)
	if _, err := api.AgentSessionService.Get(ctx, workspaceID, agentSessionID); err != nil {
		return writeGetTuttiModeActivationError(err), nil
	}
	activation, err := api.TuttiModeActivationService.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return writeGetTuttiModeActivationError(err), nil
	}
	generatedActivation, err := generatedTuttiModeActivation(activation)
	if err != nil {
		return writeGetTuttiModeActivationError(err), nil
	}
	return tuttigenerated.GetWorkspaceAgentSessionTuttiModeActivation200JSONResponse{
		Activation: generatedActivation,
	}, nil
}

func (api DaemonAPI) UpdateWorkspaceAgentSessionTuttiModeActivation(ctx context.Context, request tuttigenerated.UpdateWorkspaceAgentSessionTuttiModeActivationRequestObject) (tuttigenerated.UpdateWorkspaceAgentSessionTuttiModeActivationResponseObject, error) {
	if request.Body == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionTuttiModeActivation400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	if activationErr := validateTuttiModeActivationEnums(request.Body.Status, request.Body.Source); activationErr != nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionTuttiModeActivation400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(activationErr),
		}, nil
	}
	if request.Body.ExpectedRevision != nil && *request.Body.ExpectedRevision < 0 {
		return tuttigenerated.UpdateWorkspaceAgentSessionTuttiModeActivation400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(apierrors.WithDeveloperMessage("expectedRevision must be non-negative")),
			),
		}, nil
	}
	if api.AgentSessionService == nil || api.TuttiModeActivationService == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionTuttiModeActivation503JSONResponse{
			ServiceUnavailableErrorJSONResponse: tuttiModeActivationServiceUnavailableError(),
		}, nil
	}
	workspaceID := string(request.WorkspaceID)
	agentSessionID := string(request.AgentSessionID)
	if _, err := api.AgentSessionService.Get(ctx, workspaceID, agentSessionID); err != nil {
		return writeUpdateTuttiModeActivationError(err), nil
	}
	result, err := api.TuttiModeActivationService.Set(ctx, tuttimodeactivationservice.SetInput{
		WorkspaceID:            workspaceID,
		AgentSessionID:         agentSessionID,
		State:                  tuttimodeactivationbiz.State(request.Body.Status),
		Source:                 tuttimodeactivationbiz.Source(request.Body.Source),
		OrchestrationIntensity: request.Body.OrchestrationIntensity,
		ExpectedRevision:       request.Body.ExpectedRevision,
	})
	if err != nil {
		return writeUpdateTuttiModeActivationError(err), nil
	}
	generatedActivation, err := generatedTuttiModeActivation(result.Activation)
	if err != nil {
		return writeUpdateTuttiModeActivationError(err), nil
	}
	return tuttigenerated.UpdateWorkspaceAgentSessionTuttiModeActivation200JSONResponse{
		Activation: generatedActivation,
		Changed:    result.Changed,
	}, nil
}

func validateTuttiModeActivationEnums(status tuttigenerated.TuttiModeActivationStatus, source tuttigenerated.TuttiModeActivationSource) *apierrors.ProtocolError {
	if !status.Valid() {
		return apierrors.MalformedRequest(apierrors.WithDeveloperMessage("status must be active or inactive"))
	}
	if !source.Valid() {
		return apierrors.MalformedRequest(apierrors.WithDeveloperMessage("source must be slash_command or badge_remove"))
	}
	return nil
}

func generatedTuttiModeActivation(value *tuttimodeactivationbiz.Activation) (*tuttigenerated.TuttiModeActivation, error) {
	if value == nil {
		return nil, nil
	}
	activationID, err := parseTuttiModeUUID("activation id", value.ID)
	if err != nil {
		return nil, err
	}
	revisionID, err := parseTuttiModeUUID("activation revision id", value.CurrentRevision.ID)
	if err != nil {
		return nil, err
	}
	revisionActivationID, err := parseTuttiModeUUID("revision activation id", value.CurrentRevision.ActivationID)
	if err != nil {
		return nil, err
	}
	return &tuttigenerated.TuttiModeActivation{
		Id:              activationID,
		WorkspaceId:     value.WorkspaceID,
		AgentSessionId:  value.AgentSessionID,
		Status:          tuttigenerated.TuttiModeActivationStatus(value.CurrentRevision.State),
		CreatedAtUnixMs: value.CreatedAt.UnixMilli(),
		UpdatedAtUnixMs: value.UpdatedAt.UnixMilli(),
		CurrentRevision: tuttigenerated.TuttiModeActivationRevision{
			Id:                     revisionID,
			ActivationId:           revisionActivationID,
			Revision:               value.CurrentRevision.Revision,
			Status:                 tuttigenerated.TuttiModeActivationStatus(value.CurrentRevision.State),
			Source:                 tuttigenerated.TuttiModeActivationSource(value.CurrentRevision.Source),
			OrchestrationIntensity: value.CurrentRevision.OrchestrationIntensity,
			CreatedAtUnixMs:        value.CurrentRevision.CreatedAt.UnixMilli(),
		},
	}, nil
}

func parseTuttiModeUUID(field string, value string) (uuid.UUID, error) {
	parsed, err := uuid.Parse(value)
	if err != nil {
		return uuid.Nil, fmt.Errorf("project Tutti mode %s: %w", field, err)
	}
	if parsed == uuid.Nil {
		return uuid.Nil, fmt.Errorf("project Tutti mode %s: nil UUID is not a valid durable identity", field)
	}
	return parsed, nil
}

func writeGetTuttiModeActivationError(err error) tuttigenerated.GetWorkspaceAgentSessionTuttiModeActivationResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.GetWorkspaceAgentSessionTuttiModeActivation404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.GetWorkspaceAgentSessionTuttiModeActivation400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.GetWorkspaceAgentSessionTuttiModeActivation502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeUpdateTuttiModeActivationError(err error) tuttigenerated.UpdateWorkspaceAgentSessionTuttiModeActivationResponseObject {
	if errors.Is(err, tuttimodeactivationservice.ErrRevisionConflict) {
		return tuttigenerated.UpdateWorkspaceAgentSessionTuttiModeActivation409JSONResponse(
			protocolErrorResponse(apierrors.InvalidRequest("tutti_mode_activation_revision_conflict", apierrors.WithCause(err))),
		)
	}
	protocolErr := apierrors.Classify(err)
	if errors.Is(err, tuttimodeactivationservice.ErrInvalidInput) {
		protocolErr = apierrors.InvalidRequest("invalid_tutti_mode_activation", apierrors.WithCause(err))
	}
	if errors.Is(err, tuttimodeactivationservice.ErrTuttiModeDisabled) {
		protocolErr = apierrors.InvalidRequest("tutti_mode_disabled", apierrors.WithCause(err))
	}
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.UpdateWorkspaceAgentSessionTuttiModeActivation404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.UpdateWorkspaceAgentSessionTuttiModeActivation400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.UpdateWorkspaceAgentSessionTuttiModeActivation502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func tuttiModeActivationServiceUnavailableError() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(apierrors.ServiceUnavailable(
		"tutti_mode_activation_service_unavailable",
		apierrors.WithDeveloperMessage("Tutti mode activation service is unavailable"),
	))
}
