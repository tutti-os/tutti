package api

import (
	"context"
	"errors"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestSubmitWorkspaceAgentPlanDecisionHandlerReturnsScopedOperationForEveryState(t *testing.T) {
	for _, status := range []string{
		agentactivitybiz.RuntimeOperationStatusPrepared,
		agentactivitybiz.RuntimeOperationStatusLeased,
		agentactivitybiz.RuntimeOperationStatusCompleted,
		agentactivitybiz.RuntimeOperationStatusFailed,
	} {
		t.Run(status, func(t *testing.T) {
			var captured agentservice.SubmitPlanDecisionInput
			api := DaemonAPI{AgentSessionService: stubAgentSessionService{planDecisionFn: func(
				_ context.Context, workspaceID, sessionID, turnID, requestID string, input agentservice.SubmitPlanDecisionInput,
			) (agentactivitybiz.RuntimeOperation, error) {
				captured = input
				return agentactivitybiz.RuntimeOperation{
					OperationID: "operation-1", WorkspaceID: workspaceID, AgentSessionID: sessionID,
					TurnID: turnID, RequestID: requestID, Status: status,
					Payload: map[string]any{"idempotencyKey": input.IdempotencyKey},
				}, nil
			}}}
			response, err := api.SubmitWorkspaceAgentPlanDecision(context.Background(), planDecisionRequest())
			if err != nil {
				t.Fatal(err)
			}
			okResponse, ok := response.(tuttigenerated.SubmitWorkspaceAgentPlanDecision200JSONResponse)
			if !ok || okResponse.Operation.OperationId != "operation-1" ||
				okResponse.Operation.WorkspaceId != "ws-1" || okResponse.Operation.AgentSessionId != "session-1" ||
				okResponse.Operation.TurnId != "turn-1" || okResponse.Operation.RequestId != "turn-1" ||
				okResponse.Operation.IdempotencyKey != "decision-1" || string(okResponse.Operation.Status) != status {
				t.Fatalf("response=%#v", response)
			}
			if captured.PromptKind != "plan-implementation" || captured.Action != "implement" || captured.IdempotencyKey != "decision-1" {
				t.Fatalf("captured=%#v", captured)
			}
		})
	}
}

func TestSubmitWorkspaceAgentPlanDecisionHandlerRejectsMissingBody(t *testing.T) {
	api := DaemonAPI{AgentSessionService: stubAgentSessionService{}}
	request := planDecisionRequest()
	request.Body = nil
	response, err := api.SubmitWorkspaceAgentPlanDecision(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := response.(tuttigenerated.SubmitWorkspaceAgentPlanDecision400JSONResponse); !ok {
		t.Fatalf("response=%T", response)
	}
}

func TestSubmitWorkspaceAgentPlanDecisionHandlerReturnsUnavailableAndScopedConflict(t *testing.T) {
	response, err := (DaemonAPI{}).SubmitWorkspaceAgentPlanDecision(context.Background(), planDecisionRequest())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := response.(tuttigenerated.SubmitWorkspaceAgentPlanDecision503JSONResponse); !ok {
		t.Fatalf("unavailable response=%T", response)
	}
	api := DaemonAPI{AgentSessionService: stubAgentSessionService{planDecisionFn: func(
		context.Context, string, string, string, string, agentservice.SubmitPlanDecisionInput,
	) (agentactivitybiz.RuntimeOperation, error) {
		return agentactivitybiz.RuntimeOperation{}, agentactivitybiz.ErrRuntimeOperationSubjectState
	}}}
	response, err = api.SubmitWorkspaceAgentPlanDecision(context.Background(), planDecisionRequest())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := response.(tuttigenerated.SubmitWorkspaceAgentPlanDecision409JSONResponse); !ok {
		t.Fatalf("conflict response=%T", response)
	}
}

func planDecisionRequest() tuttigenerated.SubmitWorkspaceAgentPlanDecisionRequestObject {
	return tuttigenerated.SubmitWorkspaceAgentPlanDecisionRequestObject{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1", RequestID: "turn-1",
		Body: &tuttigenerated.SubmitWorkspaceAgentPlanDecisionRequest{
			PromptKind:     tuttigenerated.PlanImplementation,
			Action:         tuttigenerated.Implement,
			IdempotencyKey: "decision-1",
		},
	}
}

func TestGeneratedPlanDecisionOperationPreservesScopeAndTerminalFailure(t *testing.T) {
	operation := generatedPlanDecisionOperation(agentactivitybiz.RuntimeOperation{
		OperationID: "operation-1", WorkspaceID: "ws-1", AgentSessionID: "session-1",
		TurnID: "turn-1", RequestID: "request-1", Status: agentactivitybiz.RuntimeOperationStatusFailed,
		Result: agentactivitybiz.RuntimeOperationResultFailed, LastError: "provider rejected setting",
		Payload: map[string]any{"idempotencyKey": "decision-1"},
	})
	if operation.OperationId != "operation-1" || operation.WorkspaceId != "ws-1" ||
		operation.AgentSessionId != "session-1" || operation.TurnId != "turn-1" ||
		operation.RequestId != "request-1" || operation.IdempotencyKey != "decision-1" ||
		operation.Status != tuttigenerated.WorkspaceAgentPlanDecisionOperationStatus(agentactivitybiz.RuntimeOperationStatusFailed) ||
		operation.Result == nil || *operation.Result != agentactivitybiz.RuntimeOperationResultFailed ||
		operation.Error == nil || *operation.Error == "" {
		t.Fatalf("operation=%#v", operation)
	}
}

func TestPlanDecisionConflictMapsTo409(t *testing.T) {
	response := writeSubmitWorkspaceAgentPlanDecisionError(agentactivitybiz.ErrRuntimeOperationConflict)
	if _, ok := response.(tuttigenerated.SubmitWorkspaceAgentPlanDecision409JSONResponse); !ok {
		t.Fatalf("response=%T", response)
	}
}

func TestPlanDecisionSubjectStateFailureMapsToOperationError(t *testing.T) {
	response := writeSubmitWorkspaceAgentPlanDecisionError(errors.Join(agentactivitybiz.ErrRuntimeOperationSubjectState))
	if _, ok := response.(tuttigenerated.SubmitWorkspaceAgentPlanDecision409JSONResponse); !ok {
		t.Fatalf("subject persistence response=%T", response)
	}
}
