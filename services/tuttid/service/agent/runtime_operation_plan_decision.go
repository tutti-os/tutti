package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

const planImplementationPrompt = "Implement the plan."

type planDecisionRuntimeOperationStore interface {
	RuntimeOperationStore
	CheckpointRuntimeOperation(context.Context, agentactivitybiz.CheckpointRuntimeOperationInput) (agentactivitybiz.RuntimeOperation, bool, error)
	CompletePlanDecisionRuntimeOperation(context.Context, agentactivitybiz.CompletePlanDecisionRuntimeOperationInput) (agentactivitybiz.RuntimeOperationCompletion, bool, error)
	FindTurnByClientSubmitID(context.Context, string, string, string) (string, bool, error)
}

func (s *Service) planDecisionStore() (planDecisionRuntimeOperationStore, error) {
	store, ok := s.RuntimeOperationStore.(planDecisionRuntimeOperationStore)
	if !ok {
		return nil, errors.New("plan decision runtime operation store is unavailable")
	}
	return store, nil
}

func (s *Service) SubmitPlanDecision(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turnID string,
	requestID string,
	input SubmitPlanDecisionInput,
) (agentactivitybiz.RuntimeOperation, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	turnID = strings.TrimSpace(turnID)
	requestID = strings.TrimSpace(requestID)
	if workspaceID == "" || agentSessionID == "" || turnID == "" || requestID == "" || requestID != turnID {
		return agentactivitybiz.RuntimeOperation{}, ErrInvalidArgument
	}
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return agentactivitybiz.RuntimeOperation{}, err
	}
	if err := validatePlanDecisionStrategy(session.Provider, input); err != nil {
		return agentactivitybiz.RuntimeOperation{}, err
	}
	operation, err := s.preparePlanDecisionRuntimeOperation(
		ctx, workspaceID, agentSessionID, turnID, requestID, input,
	)
	if err != nil {
		return agentactivitybiz.RuntimeOperation{}, err
	}
	if operation.Status == agentactivitybiz.RuntimeOperationStatusCompleted || operation.Status == agentactivitybiz.RuntimeOperationStatusFailed {
		return operation, nil
	}
	processed, err := s.processRuntimeOperation(ctx, operation, false)
	if errors.Is(err, ErrRuntimeOperationInProgress) {
		return processed, nil
	}
	return processed, normalizeRuntimeError(err)
}

func validatePlanDecisionStrategy(provider string, input SubmitPlanDecisionInput) error {
	descriptor, ok := providerregistry.Find(provider)
	if !ok {
		return ErrInvalidArgument
	}
	promptKind := strings.TrimSpace(input.PromptKind)
	action := strings.TrimSpace(input.Action)
	if strings.TrimSpace(input.IdempotencyKey) == "" {
		return ErrInvalidArgument
	}
	switch promptKind {
	case "plan-implementation":
		if action != "implement" || descriptor.ComposerProfile.PlanDecisionStrategy != providerregistry.PlanDecisionStrategyImplementPrompt {
			return ErrInvalidArgument
		}
	default:
		return ErrInvalidArgument
	}
	return nil
}

func (s *Service) preparePlanDecisionRuntimeOperation(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turnID string,
	requestID string,
	input SubmitPlanDecisionInput,
) (agentactivitybiz.RuntimeOperation, error) {
	store, err := s.planDecisionStore()
	if err != nil {
		return agentactivitybiz.RuntimeOperation{}, err
	}
	idempotencyKey := strings.TrimSpace(input.IdempotencyKey)
	operationID := runtimeOperationID(workspaceID, agentSessionID, agentactivitybiz.RuntimeOperationKindPlanDecision, turnID)
	payload := map[string]any{
		"promptKind":     strings.TrimSpace(input.PromptKind),
		"action":         strings.TrimSpace(input.Action),
		"idempotencyKey": idempotencyKey,
		"step":           "prepared",
		"clientSubmitId": "plan-decision:" + operationID,
	}
	if existing, found, err := store.GetRuntimeOperation(ctx, workspaceID, operationID); err != nil {
		return agentactivitybiz.RuntimeOperation{}, err
	} else if found {
		if existing.AgentSessionID != agentSessionID || existing.TurnID != turnID || existing.RequestID != requestID ||
			existing.Kind != agentactivitybiz.RuntimeOperationKindPlanDecision || !planDecisionPayloadIdentityEqual(existing.Payload, payload) {
			return agentactivitybiz.RuntimeOperation{}, agentactivitybiz.ErrRuntimeOperationConflict
		}
		return existing, nil
	}
	operation, _, err := store.PrepareRuntimeOperation(ctx, agentactivitybiz.RuntimeOperationPrepare{
		OperationID: operationID, WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
		Kind: agentactivitybiz.RuntimeOperationKindPlanDecision, TurnID: turnID, RequestID: requestID,
		Payload: payload, OccurredAtMS: s.runtimeOperationNow().UnixMilli(),
	})
	return operation, err
}

func planDecisionPayloadIdentityEqual(existing map[string]any, expected map[string]any) bool {
	for _, key := range []string{"promptKind", "action", "idempotencyKey", "clientSubmitId"} {
		if payloadText(existing, key) != payloadText(expected, key) {
			return false
		}
	}
	return true
}

func (s *Service) executePlanDecisionRuntimeOperation(
	ctx context.Context,
	operation agentactivitybiz.RuntimeOperation,
	owner string,
	_ bool,
) (agentactivitybiz.RuntimeOperation, error) {
	if err := validateExecutablePlanDecisionOperation(operation); err != nil {
		return s.releaseRuntimeOperation(ctx, operation, owner, err, true)
	}
	switch payloadText(operation.Payload, "promptKind") {
	case "plan-implementation":
		return s.executePlanImplementationRuntimeOperation(ctx, operation, owner)
	default:
		return s.releaseRuntimeOperation(ctx, operation, owner, ErrInvalidArgument, true)
	}
}

func validateExecutablePlanDecisionOperation(operation agentactivitybiz.RuntimeOperation) error {
	if payloadText(operation.Payload, "promptKind") != "plan-implementation" ||
		payloadText(operation.Payload, "action") != "implement" ||
		payloadText(operation.Payload, "idempotencyKey") == "" ||
		payloadText(operation.Payload, "clientSubmitId") != "plan-decision:"+operation.OperationID {
		return ErrInvalidArgument
	}
	switch payloadText(operation.Payload, "step") {
	case "prepared", "settings_applied", "send_dispatched", "send_confirmed":
		return nil
	default:
		return ErrInvalidArgument
	}
}

func (s *Service) executePlanImplementationRuntimeOperation(
	ctx context.Context,
	operation agentactivitybiz.RuntimeOperation,
	owner string,
) (agentactivitybiz.RuntimeOperation, error) {
	step := payloadText(operation.Payload, "step")
	if step == "prepared" {
		planMode := false
		if _, err := s.UpdateSettings(ctx, operation.WorkspaceID, operation.AgentSessionID, ComposerSettingsPatch{PlanMode: &planMode}); err != nil {
			return s.releaseRuntimeOperation(ctx, operation, owner, normalizeRuntimeError(err), !isRetryableRuntimeOperationError(err))
		}
		var err error
		operation, err = s.checkpointPlanDecision(ctx, operation, owner, "settings_applied", nil)
		if err != nil {
			return operation, err
		}
		step = "settings_applied"
	}
	clientSubmitID := payloadText(operation.Payload, "clientSubmitId")
	if confirmed, err := s.confirmPlanDecisionSubmit(ctx, operation, owner, clientSubmitID); err != nil || confirmed.Status == agentactivitybiz.RuntimeOperationStatusCompleted {
		return confirmed, err
	}
	if step == "send_dispatched" {
		return s.releaseRuntimeOperation(ctx, operation, owner, errors.New("plan decision send outcome remains unconfirmed"), false)
	}
	if step != "settings_applied" {
		return s.releaseRuntimeOperation(ctx, operation, owner, fmt.Errorf("invalid plan decision step %q", step), true)
	}
	var err error
	operation, err = s.checkpointPlanDecision(ctx, operation, owner, "send_dispatched", nil)
	if err != nil {
		return operation, err
	}
	_, sendErr := s.SendInput(ctx, operation.WorkspaceID, operation.AgentSessionID, SendInput{
		Content:  []PromptContentBlock{{Type: "text", Text: planImplementationPrompt}},
		Metadata: map[string]any{"clientSubmitId": clientSubmitID},
	})
	if sendErr != nil {
		// Once send_dispatched is durable, any returned error can race provider
		// acceptance or post-send persistence. Preserve the unknown outcome for
		// canonical clientSubmitId reconciliation; never retry the provider call.
		return s.releaseRuntimeOperation(ctx, operation, owner, sendErr, false)
	}
	confirmed, err := s.confirmPlanDecisionSubmit(ctx, operation, owner, clientSubmitID)
	if err != nil || confirmed.Status == agentactivitybiz.RuntimeOperationStatusCompleted {
		return confirmed, err
	}
	return s.releaseRuntimeOperation(ctx, operation, owner, errors.New("plan decision send accepted but durable turn is not visible yet"), false)
}

func (s *Service) confirmPlanDecisionSubmit(
	ctx context.Context,
	operation agentactivitybiz.RuntimeOperation,
	owner string,
	clientSubmitID string,
) (agentactivitybiz.RuntimeOperation, error) {
	store, storeErr := s.planDecisionStore()
	if storeErr != nil {
		return operation, storeErr
	}
	turnID, found, err := store.FindTurnByClientSubmitID(ctx, operation.WorkspaceID, operation.AgentSessionID, clientSubmitID)
	if err != nil || !found {
		return operation, err
	}
	operation, err = s.checkpointPlanDecision(ctx, operation, owner, "send_confirmed", map[string]any{"confirmedTurnId": turnID})
	if err != nil {
		return operation, err
	}
	return s.completePlanDecision(ctx, operation, owner)
}

func (s *Service) checkpointPlanDecision(
	ctx context.Context,
	operation agentactivitybiz.RuntimeOperation,
	owner string,
	step string,
	extra map[string]any,
) (agentactivitybiz.RuntimeOperation, error) {
	payload := clonePayload(operation.Payload)
	payload["step"] = step
	for key, value := range extra {
		payload[key] = value
	}
	store, storeErr := s.planDecisionStore()
	if storeErr != nil {
		return operation, storeErr
	}
	checkpointed, changed, err := store.CheckpointRuntimeOperation(ctx, agentactivitybiz.CheckpointRuntimeOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
		LeaseOwner: owner, Payload: payload, NowUnixMS: s.runtimeOperationNow().UnixMilli(),
	})
	if err != nil {
		return operation, err
	}
	if !changed {
		return operation, agentactivitybiz.ErrRuntimeOperationLeaseLost
	}
	return checkpointed, nil
}

func (s *Service) completePlanDecision(
	ctx context.Context,
	operation agentactivitybiz.RuntimeOperation,
	owner string,
) (agentactivitybiz.RuntimeOperation, error) {
	store, storeErr := s.planDecisionStore()
	if storeErr != nil {
		return operation, storeErr
	}
	completion, _, err := store.CompletePlanDecisionRuntimeOperation(ctx, agentactivitybiz.CompletePlanDecisionRuntimeOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
		LeaseOwner: owner, Output: map[string]any{"step": payloadText(operation.Payload, "step")},
		NowUnixMS: s.runtimeOperationNow().UnixMilli(),
	})
	if err != nil {
		return operation, err
	}
	if err := s.publishRuntimeOperationEvents(ctx, operation.WorkspaceID); err != nil {
		logRuntimeOperationFailure(completion.Operation, err)
	}
	return completion.Operation, nil
}
