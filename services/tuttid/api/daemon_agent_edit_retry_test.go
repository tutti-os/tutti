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
	editFn           func(context.Context, string, string, string, agentservice.EditRetryInput) (agentservice.EditRetryResult, error)
	recoverCommandFn func(context.Context, string, string, string, agentservice.RecoverEditRetryInput) (agentservice.EditRetryResult, error)
}

func (s editRetryAPITestService) RecoverEditRetryCommand(ctx context.Context, workspaceID, agentSessionID, operationID string, input agentservice.RecoverEditRetryInput) (agentservice.EditRetryResult, error) {
	return s.recoverCommandFn(ctx, workspaceID, agentSessionID, operationID, input)
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
			_ context.Context,
			_ string,
			_ string,
			_ string,
			_ agentservice.EditRetryInput,
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
	var captured agentservice.RecoverEditRetryInput
	api := DaemonAPI{AgentSessionService: editRetryAPITestService{
		recoverCommandFn: func(
			_ context.Context,
			_ string,
			_ string,
			_ string,
			input agentservice.RecoverEditRetryInput,
		) (agentservice.EditRetryResult, error) {
			captured = input
			return agentservice.EditRetryResult{}, agenthost.ErrEditRetryNotEligible
		},
	}}
	response, err := api.RecoverWorkspaceAgentEditRetry(t.Context(), tuttigenerated.RecoverWorkspaceAgentEditRetryRequestObject{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", OperationID: "operation-1",
		Body: &tuttigenerated.RecoverWorkspaceAgentEditRetryRequest{
			Action:         tuttigenerated.WorkspaceAgentEditRetryRecoveryActionReconcile,
			ClientActionId: "client-recover-1", ExpectedOperationVersion: 7, ExpectedHistoryRevision: 3,
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
	if captured.ClientActionID != "client-recover-1" || captured.ExpectedOperationVersion != 7 || captured.ExpectedHistoryRevision != 3 || captured.Action != agenthost.EditRetryRecoveryActionReconcile {
		t.Fatalf("captured=%#v", captured)
	}
}

func TestRecoverWorkspaceAgentEditRetryMapsStaleCASToStableConflict(t *testing.T) {
	api := DaemonAPI{AgentSessionService: editRetryAPITestService{
		recoverCommandFn: func(_ context.Context, _, _, _ string, _ agentservice.RecoverEditRetryInput) (agentservice.EditRetryResult, error) {
			return agentservice.EditRetryResult{}, errors.Join(agenthost.ErrEditRetryHistoryConflict, errors.New("provider secret diagnostic"))
		},
	}}
	response, err := api.RecoverWorkspaceAgentEditRetry(t.Context(), recoverEditRetryRequest())
	if err != nil {
		t.Fatal(err)
	}
	conflict, ok := response.(tuttigenerated.RecoverWorkspaceAgentEditRetry409JSONResponse)
	if !ok || conflict.Error.Reason == nil || *conflict.Error.Reason != "history_revision_conflict" || conflict.Error.DeveloperMessage != nil {
		t.Fatalf("response=%#v", response)
	}
}

func TestRecoverWorkspaceAgentEditRetryForwardsEveryAdvertisedAction(t *testing.T) {
	for _, action := range []tuttigenerated.WorkspaceAgentEditRetryRecoveryAction{
		tuttigenerated.WorkspaceAgentEditRetryRecoveryActionReconcile,
		tuttigenerated.WorkspaceAgentEditRetryRecoveryActionRetryReplacement,
		tuttigenerated.WorkspaceAgentEditRetryRecoveryActionAbandon,
	} {
		t.Run(string(action), func(t *testing.T) {
			var captured agentservice.RecoverEditRetryInput
			api := DaemonAPI{AgentSessionService: editRetryAPITestService{
				recoverCommandFn: func(_ context.Context, _, _, _ string, input agentservice.RecoverEditRetryInput) (agentservice.EditRetryResult, error) {
					captured = input
					return agentservice.EditRetryResult{OperationID: "operation-1", State: agenthost.EditRetryStateCompleted, RetractedTurnID: "turn-1", HistoryRevision: 4}, nil
				},
			}}
			request := recoverEditRetryRequest()
			request.Body.Action = action
			response, err := api.RecoverWorkspaceAgentEditRetry(t.Context(), request)
			if err != nil {
				t.Fatal(err)
			}
			if _, ok := response.(tuttigenerated.RecoverWorkspaceAgentEditRetry200JSONResponse); !ok || captured.Action != agenthost.EditRetryRecoveryAction(action) {
				t.Fatalf("response=%#v captured=%#v", response, captured)
			}
		})
	}
}

func TestGeneratedAgentEditRetryResponseMapsRecoveryProjection(t *testing.T) {
	generated := generatedAgentEditRetryResult(agentservice.EditRetryResult{
		OperationID: "operation-1", OperationVersion: 9, State: agenthost.EditRetryStateResendPending,
		RetractedTurnID: "turn-1", HistoryRevision: 4, Automatic: true, NextAttemptAtMS: 1234, Attempt: 2,
		AvailableActions: []agenthost.EditRetryRecoveryAction{agenthost.EditRetryRecoveryActionReconcile},
	}, nil)
	if generated.OperationVersion == nil || *generated.OperationVersion != 9 || generated.Automatic == nil || !*generated.Automatic ||
		generated.ImpactScope == nil || *generated.ImpactScope != tuttigenerated.Session ||
		generated.NextAttemptAtUnixMs == nil || *generated.NextAttemptAtUnixMs != 1234 || generated.NextAttemptAt == nil || *generated.NextAttemptAt != 1234 || generated.Attempt == nil || *generated.Attempt != 2 ||
		generated.AvailableActions == nil || len(*generated.AvailableActions) != 1 || (*generated.AvailableActions)[0] != tuttigenerated.WorkspaceAgentEditRetryRecoveryActionReconcile {
		t.Fatalf("response=%#v", generated)
	}
}

func TestGeneratedAgentEditRetryAvailabilityMapsRolloutDisabledSeparately(t *testing.T) {
	availability := generatedAgentEditRetryAvailability(agenthost.EditRetryAvailability{
		HistoryRevision: 4,
		ReasonCode:      agenthost.EditRetryReasonCodeRolloutDisabled,
		RecoveryState:   agenthost.EditRetryStatePrepared,
	})
	if availability.Supported || availability.Eligible || availability.ReasonCode == nil ||
		*availability.ReasonCode != tuttigenerated.WorkspaceAgentEditRetryReasonCodeRolloutDisabled {
		t.Fatalf("availability=%#v, want rollout-disabled admission projection", availability)
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

func TestGeneratedAgentEditRetryAvailabilityMapsRecoveryProjection(t *testing.T) {
	generated := generatedAgentEditRetryAvailability(agenthost.EditRetryAvailability{
		OperationID: "operation-1", OperationVersion: 7, Automatic: true, NextAttemptAtMS: 987, Attempt: 3,
	})
	if generated.OperationVersion == nil || *generated.OperationVersion != 7 || generated.Automatic == nil || !*generated.Automatic ||
		generated.ImpactScope == nil || *generated.ImpactScope != tuttigenerated.Session ||
		generated.NextAttemptAtUnixMs == nil || *generated.NextAttemptAtUnixMs != 987 || generated.NextAttemptAt == nil || *generated.NextAttemptAt != 987 || generated.Attempt == nil || *generated.Attempt != 3 {
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

func recoverEditRetryRequest() tuttigenerated.RecoverWorkspaceAgentEditRetryRequestObject {
	return tuttigenerated.RecoverWorkspaceAgentEditRetryRequestObject{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", OperationID: "operation-1",
		Body: &tuttigenerated.RecoverWorkspaceAgentEditRetryRequest{
			Action: tuttigenerated.WorkspaceAgentEditRetryRecoveryActionReconcile, ClientActionId: "client-action-1",
			ExpectedOperationVersion: 7, ExpectedHistoryRevision: 3,
		},
	}
}
