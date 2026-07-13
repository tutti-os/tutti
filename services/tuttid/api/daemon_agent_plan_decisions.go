package api

import (
	"context"
	"errors"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type agentPlanDecisionService interface {
	SubmitPlanDecision(context.Context, string, string, string, string, agentservice.SubmitPlanDecisionInput) (agentactivitybiz.RuntimeOperation, error)
}

func (api DaemonAPI) SubmitWorkspaceAgentPlanDecision(
	ctx context.Context,
	request tuttigenerated.SubmitWorkspaceAgentPlanDecisionRequestObject,
) (tuttigenerated.SubmitWorkspaceAgentPlanDecisionResponseObject, error) {
	service, ok := api.AgentSessionService.(agentPlanDecisionService)
	if !ok {
		return tuttigenerated.SubmitWorkspaceAgentPlanDecision503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.SubmitWorkspaceAgentPlanDecision400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	operation, err := service.SubmitPlanDecision(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		string(request.TurnID),
		string(request.RequestID),
		agentservice.SubmitPlanDecisionInput{
			PromptKind:     string(request.Body.PromptKind),
			Action:         string(request.Body.Action),
			IdempotencyKey: request.Body.IdempotencyKey,
		},
	)
	if err != nil {
		return writeSubmitWorkspaceAgentPlanDecisionError(err), nil
	}
	return tuttigenerated.SubmitWorkspaceAgentPlanDecision200JSONResponse{
		Operation: generatedPlanDecisionOperation(operation),
	}, nil
}

func generatedPlanDecisionOperation(operation agentactivitybiz.RuntimeOperation) tuttigenerated.WorkspaceAgentPlanDecisionOperation {
	result := tuttigenerated.WorkspaceAgentPlanDecisionOperation{
		OperationId:    operation.OperationID,
		WorkspaceId:    operation.WorkspaceID,
		AgentSessionId: operation.AgentSessionID,
		TurnId:         operation.TurnID,
		RequestId:      operation.RequestID,
		IdempotencyKey: payloadStringValue(operation.Payload, "idempotencyKey"),
		Status:         tuttigenerated.WorkspaceAgentPlanDecisionOperationStatus(operation.Status),
	}
	if value := strings.TrimSpace(operation.Result); value != "" {
		result.Result = &value
	}
	if value := strings.TrimSpace(operation.LastError); value != "" {
		result.Error = &value
	}
	return result
}

func writeSubmitWorkspaceAgentPlanDecisionError(err error) tuttigenerated.SubmitWorkspaceAgentPlanDecisionResponseObject {
	protocolErr := apierrors.Classify(err)
	if errors.Is(err, agentactivitybiz.ErrRuntimeOperationConflict) || errors.Is(err, agentactivitybiz.ErrRuntimeOperationSubjectState) {
		return tuttigenerated.SubmitWorkspaceAgentPlanDecision409JSONResponse(protocolErrorResponse(protocolErr))
	}
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.SubmitWorkspaceAgentPlanDecision400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.SubmitWorkspaceAgentPlanDecision404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	default:
		return tuttigenerated.SubmitWorkspaceAgentPlanDecision502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func payloadStringValue(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return strings.TrimSpace(value)
}
