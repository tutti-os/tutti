package api

import (
	"context"
	"errors"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type agentEditRetryService interface {
	EditRetry(context.Context, string, string, string, agentservice.EditRetryInput) (agentservice.EditRetryResult, error)
	RecoverEditRetryCommand(context.Context, string, string, string, agentservice.RecoverEditRetryInput) (agentservice.EditRetryResult, error)
}

func (api DaemonAPI) EditRetryWorkspaceAgentTurn(
	ctx context.Context,
	request tuttigenerated.EditRetryWorkspaceAgentTurnRequestObject,
) (tuttigenerated.EditRetryWorkspaceAgentTurnResponseObject, error) {
	service, ok := api.AgentSessionService.(agentEditRetryService)
	if !ok {
		return tuttigenerated.EditRetryWorkspaceAgentTurn503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.EditRetryWorkspaceAgentTurn400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	result, err := service.EditRetry(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		string(request.TurnID),
		agentservice.EditRetryInput{
			EditedText:              request.Body.EditedText,
			ClientOperationID:       request.Body.ClientOperationId,
			ExpectedHistoryRevision: uint64(request.Body.ExpectedHistoryRevision),
		},
	)
	response := generatedAgentEditRetryResult(result, err)
	if editRetryResultIsDurablyPending(result) {
		return tuttigenerated.EditRetryWorkspaceAgentTurn202JSONResponse(response), nil
	}
	if err != nil {
		return writeEditRetryWorkspaceAgentTurnError(err), nil
	}
	return tuttigenerated.EditRetryWorkspaceAgentTurn200JSONResponse(response), nil
}

func (api DaemonAPI) RecoverWorkspaceAgentEditRetry(
	ctx context.Context,
	request tuttigenerated.RecoverWorkspaceAgentEditRetryRequestObject,
) (tuttigenerated.RecoverWorkspaceAgentEditRetryResponseObject, error) {
	service, ok := api.AgentSessionService.(agentEditRetryService)
	if !ok {
		return tuttigenerated.RecoverWorkspaceAgentEditRetry503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.RecoverWorkspaceAgentEditRetry400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	result, err := service.RecoverEditRetryCommand(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		request.OperationID, agentservice.RecoverEditRetryInput{Action: agentservice.EditRetryRecoveryAction(request.Body.Action), ClientActionID: request.Body.ClientActionId, ExpectedOperationVersion: request.Body.ExpectedOperationVersion, ExpectedHistoryRevision: uint64(request.Body.ExpectedHistoryRevision)},
	)
	response := generatedAgentEditRetryResult(result, err)
	if editRetryResultIsDurablyPending(result) {
		return tuttigenerated.RecoverWorkspaceAgentEditRetry202JSONResponse(response), nil
	}
	if err != nil {
		return writeRecoverWorkspaceAgentEditRetryError(err), nil
	}
	return tuttigenerated.RecoverWorkspaceAgentEditRetry200JSONResponse(response), nil
}

func generatedAgentEditRetryAvailability(
	availability agenthost.EditRetryAvailability,
) tuttigenerated.WorkspaceAgentEditRetryAvailability {
	recoveryState := availability.RecoveryState
	if recoveryState == "" {
		recoveryState = agenthost.EditRetryStatePrepared
	}
	result := tuttigenerated.WorkspaceAgentEditRetryAvailability{
		Supported:        availability.Supported,
		Eligible:         availability.Eligible,
		HistoryRevision:  int64(availability.HistoryRevision),
		RecoveryState:    tuttigenerated.WorkspaceAgentEditRetryAvailabilityRecoveryState(recoveryState),
		AvailableActions: make([]tuttigenerated.WorkspaceAgentEditRetryRecoveryAction, 0, len(availability.AvailableActions)),
	}
	impactScope := tuttigenerated.WorkspaceAgentEditRetryImpactScope(availability.ImpactScope())
	result.ImpactScope = &impactScope
	if value := strings.TrimSpace(availability.TurnID); value != "" {
		result.TurnId = &value
	}
	if value := strings.TrimSpace(availability.OperationID); value != "" {
		result.OperationId = &value
		operationVersion, automatic, attempt := availability.OperationVersion, availability.Automatic, availability.Attempt
		result.OperationVersion = &operationVersion
		result.Automatic = &automatic
		if availability.NextAttemptAtMS > 0 {
			nextAttemptAtUnixMs := availability.NextAttemptAtMS
			result.NextAttemptAtUnixMs = &nextAttemptAtUnixMs
			result.NextAttemptAt = &nextAttemptAtUnixMs
		}
		result.Attempt = &attempt
	}
	for _, action := range availability.AvailableActions {
		result.AvailableActions = append(result.AvailableActions, tuttigenerated.WorkspaceAgentEditRetryRecoveryAction(action))
	}
	if reason := generatedAgentEditRetryReasonCode(availability.ReasonCode); reason != nil {
		result.ReasonCode = reason
	}
	return result
}

func generatedAgentEditRetryResult(
	result agentservice.EditRetryResult,
	err error,
) tuttigenerated.WorkspaceAgentEditRetryResponse {
	response := tuttigenerated.WorkspaceAgentEditRetryResponse{
		OperationId:     strings.TrimSpace(result.OperationID),
		State:           tuttigenerated.WorkspaceAgentEditRetryResponseState(result.State),
		RetractedTurnId: strings.TrimSpace(result.RetractedTurnID),
		HistoryRevision: int64(result.HistoryRevision),
	}
	impactScope := tuttigenerated.WorkspaceAgentEditRetryImpactScope(result.ImpactScope())
	response.ImpactScope = &impactScope
	if value := strings.TrimSpace(result.ReplacementTurnID); value != "" {
		response.ReplacementTurnId = &value
	}
	if response.OperationId != "" {
		operationVersion, automatic, attempt := result.OperationVersion, result.Automatic, result.Attempt
		response.OperationVersion = &operationVersion
		response.Automatic = &automatic
		if result.NextAttemptAtMS > 0 {
			nextAttemptAtUnixMs := result.NextAttemptAtMS
			response.NextAttemptAtUnixMs = &nextAttemptAtUnixMs
			response.NextAttemptAt = &nextAttemptAtUnixMs
		}
		response.Attempt = &attempt
		actions := make([]tuttigenerated.WorkspaceAgentEditRetryRecoveryAction, 0, len(result.AvailableActions))
		for _, action := range result.AvailableActions {
			actions = append(actions, tuttigenerated.WorkspaceAgentEditRetryRecoveryAction(action))
		}
		response.AvailableActions = &actions
	}
	reason := agentEditRetryReasonCode(result, err)
	if generated := generatedAgentEditRetryReasonCode(reason); generated != nil {
		response.ReasonCode = generated
	}
	return response
}

func editRetryResultIsDurablyPending(result agentservice.EditRetryResult) bool {
	if strings.TrimSpace(result.OperationID) == "" {
		return false
	}
	switch result.State {
	case agenthost.EditRetryStateRollingBack,
		agenthost.EditRetryStateResendPending,
		agenthost.EditRetryStateRecoveryRequired:
		return true
	default:
		return false
	}
}

func agentEditRetryReasonCode(
	result agentservice.EditRetryResult,
	err error,
) agenthost.EditRetryReasonCode {
	if result.ReasonCode != "" {
		return result.ReasonCode
	}
	switch {
	case errors.Is(err, agenthost.ErrEditRetryHistoryConflict):
		return agenthost.EditRetryReasonCodeHistoryRevisionConflict
	case errors.Is(err, agenthost.ErrRuntimeOperationIdentityMismatch):
		return agenthost.EditRetryReasonCodeOperationConflict
	case errors.Is(err, storesqlite.ErrRuntimeOperationActionConflict):
		return agenthost.EditRetryReasonCodeOperationConflict
	case errors.Is(err, agenthost.ErrRuntimeHistoryUnsupported):
		return agenthost.EditRetryReasonCodeProviderUnsupported
	case errors.Is(err, agenthost.ErrEditRetryRecoveryRequired):
		return agenthost.EditRetryReasonCodeRecoveryRequired
	default:
		return ""
	}
}

func generatedAgentEditRetryReasonCode(
	reason agenthost.EditRetryReasonCode,
) *tuttigenerated.WorkspaceAgentEditRetryReasonCode {
	if reason == "" {
		return nil
	}
	value := tuttigenerated.WorkspaceAgentEditRetryReasonCode(reason)
	return &value
}

func editRetryConflictProtocolError(err error) *apierrors.ProtocolError {
	reason := agentEditRetryReasonCode(agentservice.EditRetryResult{}, err)
	if reason == "" {
		reason = agenthost.EditRetryReasonCodeOperationConflict
	}
	return apierrors.New(
		apierrors.StatusConflict,
		tuttigenerated.InvalidRequest,
		string(reason),
	)
}

func writeEditRetryWorkspaceAgentTurnError(
	err error,
) tuttigenerated.EditRetryWorkspaceAgentTurnResponseObject {
	switch {
	case isEditRetryConflict(err):
		return tuttigenerated.EditRetryWorkspaceAgentTurn409JSONResponse(
			protocolErrorResponse(editRetryConflictProtocolError(err)),
		)
	case errors.Is(err, agenthost.ErrInvalidArgument):
		return tuttigenerated.EditRetryWorkspaceAgentTurn400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.Classify(err)),
		}
	case errors.Is(err, agenthost.ErrSessionNotFound):
		return tuttigenerated.EditRetryWorkspaceAgentTurn404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(apierrors.Classify(err)),
		}
	default:
		return tuttigenerated.EditRetryWorkspaceAgentTurn502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed()),
		}
	}
}

func writeRecoverWorkspaceAgentEditRetryError(
	err error,
) tuttigenerated.RecoverWorkspaceAgentEditRetryResponseObject {
	switch {
	case isEditRetryConflict(err):
		return tuttigenerated.RecoverWorkspaceAgentEditRetry409JSONResponse(
			protocolErrorResponse(editRetryConflictProtocolError(err)),
		)
	case errors.Is(err, agenthost.ErrInvalidArgument):
		return tuttigenerated.RecoverWorkspaceAgentEditRetry400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.Classify(err)),
		}
	case errors.Is(err, agenthost.ErrSessionNotFound):
		return tuttigenerated.RecoverWorkspaceAgentEditRetry404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(apierrors.Classify(err)),
		}
	default:
		return tuttigenerated.RecoverWorkspaceAgentEditRetry502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed()),
		}
	}
}

func isEditRetryConflict(err error) bool {
	return errors.Is(err, agenthost.ErrEditRetryNotEligible) ||
		errors.Is(err, agenthost.ErrEditRetryHistoryConflict) ||
		errors.Is(err, agenthost.ErrRuntimeHistoryUnsupported) ||
		errors.Is(err, agenthost.ErrRuntimeOperationIdentityMismatch) ||
		errors.Is(err, storesqlite.ErrRuntimeOperationActionConflict)
}
