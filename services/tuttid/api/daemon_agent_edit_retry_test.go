package api

import (
	"context"
	"errors"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type editRetryAPITestService struct {
	stubAgentSessionService
	editFn    func(context.Context, string, string, string, agentservice.EditRetryInput) (agentservice.EditRetryResult, error)
	recoverFn func(context.Context, string, string, string, agentservice.EditRetryRecoveryAction) (agentservice.EditRetryResult, error)
}

func (s editRetryAPITestService) EditRetry(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turnID string,
	input agentservice.EditRetryInput,
) (agentservice.EditRetryResult, error) {
	return s.editFn(ctx, workspaceID, agentSessionID, turnID, input)
}

func (s editRetryAPITestService) RecoverEditRetry(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	operationID string,
	action agentservice.EditRetryRecoveryAction,
) (agentservice.EditRetryResult, error) {
	return s.recoverFn(ctx, workspaceID, agentSessionID, operationID, action)
}

func TestEditRetryWorkspaceAgentTurnReturnsCompletedAndCapturesFence(t *testing.T) {
	var captured agentservice.EditRetryInput
	api := DaemonAPI{AgentSessionService: editRetryAPITestService{
		editFn: func(
			_ context.Context,
			workspaceID string,
			sessionID string,
			turnID string,
			input agentservice.EditRetryInput,
		) (agentservice.EditRetryResult, error) {
			captured = input
			if workspaceID != "ws-1" || sessionID != "session-1" || turnID != "turn-1" {
				t.Fatalf("scope=%q/%q/%q", workspaceID, sessionID, turnID)
			}
			return agentservice.EditRetryResult{
				OperationID:       "operation-1",
				State:             agenthost.EditRetryStateCompleted,
				RetractedTurnID:   "turn-1",
				ReplacementTurnID: "turn-2",
				HistoryRevision:   9,
			}, nil
		},
	}}
	response, err := api.EditRetryWorkspaceAgentTurn(t.Context(), editRetryRequest())
	if err != nil {
		t.Fatal(err)
	}
	completed, ok := response.(tuttigenerated.EditRetryWorkspaceAgentTurn200JSONResponse)
	if !ok || completed.OperationId != "operation-1" ||
		completed.RetractedTurnId != "turn-1" ||
		completed.ReplacementTurnId == nil ||
		*completed.ReplacementTurnId != "turn-2" ||
		completed.HistoryRevision != 9 {
		t.Fatalf("response=%#v", response)
	}
	if captured.EditedText != "edited" ||
		captured.ClientOperationID != "client-operation-1" ||
		captured.ExpectedHistoryRevision != 7 {
		t.Fatalf("input=%#v", captured)
	}
}

func TestEditRetryWorkspaceAgentTurnReturnsDurablePendingWithoutRawError(t *testing.T) {
	api := DaemonAPI{AgentSessionService: editRetryAPITestService{
		editFn: func(
			context.Context,
			string,
			string,
			string,
			agentservice.EditRetryInput,
		) (agentservice.EditRetryResult, error) {
			return agentservice.EditRetryResult{
				OperationID:     "operation-1",
				ReasonCode:      agenthost.EditRetryReasonCodeProviderOutcomeUnknown,
				State:           agenthost.EditRetryStateRollingBack,
				RetractedTurnID: "turn-1",
				HistoryRevision: 7,
			}, errors.Join(agenthost.ErrEditRetryInProgress, errors.New("provider secret diagnostic"))
		},
	}}
	response, err := api.EditRetryWorkspaceAgentTurn(t.Context(), editRetryRequest())
	if err != nil {
		t.Fatal(err)
	}
	pending, ok := response.(tuttigenerated.EditRetryWorkspaceAgentTurn202JSONResponse)
	if !ok || pending.ReasonCode == nil ||
		*pending.ReasonCode != tuttigenerated.WorkspaceAgentEditRetryReasonCodeProviderOutcomeUnknown {
		t.Fatalf("response=%#v", response)
	}
}

func TestRecoverWorkspaceAgentEditRetryReturnsScopedConflict(t *testing.T) {
	api := DaemonAPI{AgentSessionService: editRetryAPITestService{
		recoverFn: func(
			context.Context,
			string,
			string,
			string,
			agentservice.EditRetryRecoveryAction,
		) (agentservice.EditRetryResult, error) {
			return agentservice.EditRetryResult{}, agenthost.ErrEditRetryNotEligible
		},
	}}
	response, err := api.RecoverWorkspaceAgentEditRetry(t.Context(), tuttigenerated.RecoverWorkspaceAgentEditRetryRequestObject{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", OperationID: "operation-1",
		Body: &tuttigenerated.RecoverWorkspaceAgentEditRetryRequest{
			Action: tuttigenerated.WorkspaceAgentEditRetryRecoveryActionReconcile,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	conflict, ok := response.(tuttigenerated.RecoverWorkspaceAgentEditRetry409JSONResponse)
	if !ok || conflict.Error.Reason == nil || *conflict.Error.Reason != "operation_conflict" ||
		conflict.Error.DeveloperMessage != nil {
		t.Fatalf("response=%#v", response)
	}
}

func TestGeneratedAgentEditRetryAvailabilityKeepsStableOptionalShape(t *testing.T) {
	generated := generatedAgentEditRetryAvailability(agenthost.EditRetryAvailability{
		ReasonCode: agenthost.EditRetryReasonCodeProviderUnsupported,
	})
	if generated.Supported || generated.Eligible ||
		generated.RecoveryState != tuttigenerated.WorkspaceAgentEditRetryAvailabilityRecoveryStatePrepared ||
		generated.AvailableActions == nil || len(generated.AvailableActions) != 0 ||
		generated.ReasonCode == nil ||
		*generated.ReasonCode != tuttigenerated.WorkspaceAgentEditRetryReasonCodeProviderUnsupported {
		t.Fatalf("availability=%#v", generated)
	}
}

func editRetryRequest() tuttigenerated.EditRetryWorkspaceAgentTurnRequestObject {
	return tuttigenerated.EditRetryWorkspaceAgentTurnRequestObject{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Body: &tuttigenerated.EditRetryWorkspaceAgentTurnRequest{
			EditedText:              "edited",
			ClientOperationId:       "client-operation-1",
			ExpectedHistoryRevision: 7,
		},
	}
}
