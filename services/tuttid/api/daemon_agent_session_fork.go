package api

import (
	"context"
	"errors"
	"fmt"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func (api DaemonAPI) ForkWorkspaceAgentSession(
	ctx context.Context,
	request tuttigenerated.ForkWorkspaceAgentSessionRequestObject,
) (tuttigenerated.ForkWorkspaceAgentSessionResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ForkWorkspaceAgentSession503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return writeForkWorkspaceAgentSessionError(agentservice.ErrInvalidArgument), nil
	}
	point, err := request.Body.Point.AsWorkspaceAgentSessionForkThroughTurnPoint()
	if err != nil || point.Type != tuttigenerated.ThroughTurn ||
		strings.TrimSpace(point.TurnId) == "" ||
		strings.TrimSpace(request.Body.RequestId) == "" {
		return writeForkWorkspaceAgentSessionError(agentservice.ErrInvalidArgument), nil
	}
	operation, err := api.AgentSessionService.Fork(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		agentservice.ForkSessionInput{
			TargetAgentSessionID: request.Body.TargetAgentSessionId.String(),
			RequestID:            request.Body.RequestId,
			ThroughTurnID:        point.TurnId,
		},
	)
	if err != nil {
		return writeForkWorkspaceAgentSessionError(err), nil
	}
	generatedOperation, err := generatedAgentSessionForkOperation(operation)
	if err != nil {
		return writeForkWorkspaceAgentSessionError(err), nil
	}
	response := tuttigenerated.WorkspaceAgentSessionForkOperationResponse{
		Operation: generatedOperation,
	}
	if operation.Status == agentservice.SessionForkOperationAccepted {
		return tuttigenerated.ForkWorkspaceAgentSession202JSONResponse(response), nil
	}
	return tuttigenerated.ForkWorkspaceAgentSession200JSONResponse(response), nil
}

func (api DaemonAPI) GetWorkspaceAgentSessionForkOperation(
	ctx context.Context,
	request tuttigenerated.GetWorkspaceAgentSessionForkOperationRequestObject,
) (tuttigenerated.GetWorkspaceAgentSessionForkOperationResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.GetWorkspaceAgentSessionForkOperation503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	operation, err := api.AgentSessionService.GetSessionForkOperation(
		ctx,
		string(request.WorkspaceID),
		string(request.OperationID),
	)
	if err != nil {
		return writeGetWorkspaceAgentSessionForkOperationError(err), nil
	}
	generatedOperation, err := generatedAgentSessionForkOperation(operation)
	if err != nil {
		return writeGetWorkspaceAgentSessionForkOperationError(err), nil
	}
	return tuttigenerated.GetWorkspaceAgentSessionForkOperation200JSONResponse{
		Operation: generatedOperation,
	}, nil
}

func (api DaemonAPI) AcknowledgeWorkspaceAgentSessionForkOperation(
	ctx context.Context,
	request tuttigenerated.AcknowledgeWorkspaceAgentSessionForkOperationRequestObject,
) (tuttigenerated.AcknowledgeWorkspaceAgentSessionForkOperationResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.AcknowledgeWorkspaceAgentSessionForkOperation503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	operation, err := api.AgentSessionService.AcknowledgeSessionForkOperation(
		ctx,
		string(request.WorkspaceID),
		string(request.OperationID),
	)
	if err != nil {
		return writeAcknowledgeWorkspaceAgentSessionForkOperationError(err), nil
	}
	generatedOperation, err := generatedAgentSessionForkOperation(operation)
	if err != nil {
		return writeAcknowledgeWorkspaceAgentSessionForkOperationError(err), nil
	}
	return tuttigenerated.AcknowledgeWorkspaceAgentSessionForkOperation200JSONResponse{
		Operation: generatedOperation,
	}, nil
}

func generatedAgentSessionForkOperation(
	operation agentservice.SessionForkOperation,
) (tuttigenerated.WorkspaceAgentSessionForkOperation, error) {
	var point tuttigenerated.WorkspaceAgentSessionForkPoint
	if operation.Point.Type != "throughTurn" ||
		strings.TrimSpace(operation.Point.TurnID) == "" {
		return tuttigenerated.WorkspaceAgentSessionForkOperation{},
			fmt.Errorf("unsupported agent session fork point %q", operation.Point.Type)
	}
	if err := point.FromWorkspaceAgentSessionForkThroughTurnPoint(
		tuttigenerated.WorkspaceAgentSessionForkThroughTurnPoint{
			Type:   tuttigenerated.ThroughTurn,
			TurnId: strings.TrimSpace(operation.Point.TurnID),
		},
	); err != nil {
		return tuttigenerated.WorkspaceAgentSessionForkOperation{}, err
	}
	var session *tuttigenerated.WorkspaceAgentSession
	if operation.Session != nil {
		value, err := generatedAgentSession(*operation.Session)
		if err != nil {
			return tuttigenerated.WorkspaceAgentSessionForkOperation{}, err
		}
		session = &value
	}
	var lineage *tuttigenerated.WorkspaceAgentSessionForkLineage
	if operation.Lineage != nil {
		lineage = &tuttigenerated.WorkspaceAgentSessionForkLineage{
			ForkedAtUnixMs:       operation.Lineage.ForkedAtUnixMS,
			OperationId:          strings.TrimSpace(operation.Lineage.OperationID),
			SourceAgentSessionId: strings.TrimSpace(operation.Lineage.SourceAgentSessionID),
			SourceTurnId:         strings.TrimSpace(operation.Lineage.SourceTurnID),
			TargetTurnId:         strings.TrimSpace(operation.Lineage.TargetTurnID),
		}
	}
	var operationError *string
	if operation.Error != nil {
		value := strings.TrimSpace(*operation.Error)
		operationError = &value
	}
	return tuttigenerated.WorkspaceAgentSessionForkOperation{
		Error:       operationError,
		Lineage:     lineage,
		OperationId: strings.TrimSpace(operation.OperationID),
		Point:       point,
		Phase: tuttigenerated.WorkspaceAgentSessionForkOperationPhase(
			operation.Phase,
		),
		RequestId:            strings.TrimSpace(operation.RequestID),
		Session:              session,
		SourceAgentSessionId: strings.TrimSpace(operation.SourceAgentSessionID),
		Status: tuttigenerated.WorkspaceAgentSessionForkOperationStatus(
			operation.Status,
		),
		TargetAgentSessionId: strings.TrimSpace(operation.TargetAgentSessionID),
	}, nil
}

func writeGetWorkspaceAgentSessionForkOperationError(
	err error,
) tuttigenerated.GetWorkspaceAgentSessionForkOperationResponseObject {
	protocolErr := apierrors.Classify(err)
	switch {
	case errors.Is(err, agentservice.ErrSessionForkOperationNotFound):
		protocolErr = apierrors.New(
			404,
			tuttigenerated.AgentSessionForkOperationNotFound,
			"agent_session_fork_operation_not_found",
			apierrors.WithCause(err),
		)
		return tuttigenerated.GetWorkspaceAgentSessionForkOperation404JSONResponse(
			protocolErrorResponse(protocolErr),
		)
	case protocolErr.Code == tuttigenerated.InvalidRequest:
		return tuttigenerated.GetWorkspaceAgentSessionForkOperation400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.GetWorkspaceAgentSessionForkOperation502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeAcknowledgeWorkspaceAgentSessionForkOperationError(
	err error,
) tuttigenerated.AcknowledgeWorkspaceAgentSessionForkOperationResponseObject {
	protocolErr := apierrors.Classify(err)
	switch {
	case errors.Is(err, agentservice.ErrSessionForkOperationNotFound):
		protocolErr = apierrors.New(
			404,
			tuttigenerated.AgentSessionForkOperationNotFound,
			"agent_session_fork_operation_not_found",
			apierrors.WithCause(err),
		)
		return tuttigenerated.AcknowledgeWorkspaceAgentSessionForkOperation404JSONResponse(
			protocolErrorResponse(protocolErr),
		)
	case errors.Is(err, agentservice.ErrSessionForkConflict):
		protocolErr = apierrors.New(
			409,
			tuttigenerated.WorkspaceOperationFailed,
			"agent_session_fork_acknowledge_conflict",
			apierrors.WithCause(err),
		)
		return tuttigenerated.AcknowledgeWorkspaceAgentSessionForkOperation409JSONResponse(
			protocolErrorResponse(protocolErr),
		)
	case protocolErr.Code == tuttigenerated.InvalidRequest:
		return tuttigenerated.AcknowledgeWorkspaceAgentSessionForkOperation400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.AcknowledgeWorkspaceAgentSessionForkOperation502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeForkWorkspaceAgentSessionError(
	err error,
) tuttigenerated.ForkWorkspaceAgentSessionResponseObject {
	protocolErr := apierrors.Classify(err)
	switch {
	case errors.Is(err, agentservice.ErrSessionForkUnsupported):
		protocolErr = apierrors.New(
			409,
			tuttigenerated.WorkspaceOperationFailed,
			"agent_session_fork_unsupported",
			apierrors.WithCause(err),
		)
		return tuttigenerated.ForkWorkspaceAgentSession409JSONResponse(
			protocolErrorResponse(protocolErr),
		)
	case errors.Is(err, agentservice.ErrSessionForkConflict):
		options := []apierrors.Option{apierrors.WithCause(err)}
		if boundaryReason := sessionForkBoundaryReason(err); boundaryReason != "" {
			options = append(options, apierrors.WithParams(map[string]any{
				"forkBoundaryReason": boundaryReason,
			}))
		}
		protocolErr = apierrors.New(
			409,
			tuttigenerated.WorkspaceOperationFailed,
			"agent_session_fork_conflict",
			options...,
		)
		return tuttigenerated.ForkWorkspaceAgentSession409JSONResponse(
			protocolErrorResponse(protocolErr),
		)
	case errors.Is(err, agentservice.ErrSessionForkInProgress):
		protocolErr = apierrors.New(
			409,
			tuttigenerated.WorkspaceOperationFailed,
			"agent_session_fork_in_progress",
			apierrors.WithCause(err),
		)
		protocolErr.Retryable = true
		return tuttigenerated.ForkWorkspaceAgentSession409JSONResponse(
			protocolErrorResponse(protocolErr),
		)
	case protocolErr.Code == tuttigenerated.InvalidRequest:
		return tuttigenerated.ForkWorkspaceAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	case protocolErr.Code == tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ForkWorkspaceAgentSession404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	default:
		if errors.Is(err, agentservice.ErrSessionForkDeliveryUnknown) {
			protocolErr.Retryable = true
			protocolErr.Reason = "agent_session_fork_delivery_unknown"
		} else if errors.Is(err, agentservice.ErrSessionForkFailed) {
			protocolErr.Reason = "agent_session_fork_failed"
		}
		return tuttigenerated.ForkWorkspaceAgentSession502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

type sessionForkBoundaryReasoner interface {
	ForkBoundaryReason() string
}

func sessionForkBoundaryReason(err error) string {
	var reasoner sessionForkBoundaryReasoner
	if !errors.As(err, &reasoner) {
		return ""
	}
	return strings.TrimSpace(reasoner.ForkBoundaryReason())
}
