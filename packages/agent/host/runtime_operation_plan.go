package agenthost

import (
	"context"
	"errors"
	"fmt"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

const planImplementationPrompt = "Implement the plan."

func (h *Host) SubmitPlanDecision(
	ctx context.Context,
	ref SessionRef,
	turnID string,
	requestID string,
	input SubmitPlanDecisionInput,
) (storesqlite.RuntimeOperation, error) {
	ref.WorkspaceID = strings.TrimSpace(ref.WorkspaceID)
	ref.AgentSessionID = strings.TrimSpace(ref.AgentSessionID)
	turnID, requestID = strings.TrimSpace(turnID), strings.TrimSpace(requestID)
	if h == nil || h.store == nil || h.operations == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" || turnID == "" || requestID == "" || requestID != turnID {
		return storesqlite.RuntimeOperation{}, ErrInvalidArgument
	}
	session, found, err := h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return storesqlite.RuntimeOperation{}, err
	}
	if !found {
		return storesqlite.RuntimeOperation{}, ErrSessionNotFound
	}
	if err := ValidatePlanDecisionStrategy(session.Provider, input); err != nil {
		return storesqlite.RuntimeOperation{}, err
	}
	operation, err := h.preparePlanDecisionRuntimeOperation(ctx, ref, turnID, requestID, input)
	if err != nil {
		return storesqlite.RuntimeOperation{}, err
	}
	if operation.Status == storesqlite.RuntimeOperationStatusCompleted || operation.Status == storesqlite.RuntimeOperationStatusFailed {
		return operation, nil
	}
	processed, err := h.processRuntimeOperation(ctx, operation, false)
	if errors.Is(err, ErrRuntimeOperationInProgress) {
		return processed, nil
	}
	return processed, err
}

func ValidatePlanDecisionStrategy(provider string, input SubmitPlanDecisionInput) error {
	strategy, ok := canonical.ProviderPlanDecisionStrategy(provider)
	if !ok || strings.TrimSpace(input.IdempotencyKey) == "" {
		return ErrInvalidArgument
	}
	switch strings.TrimSpace(input.PromptKind) {
	case "plan-implementation":
		if strings.TrimSpace(input.Action) != "implement" || strategy != canonical.PlanDecisionStrategyImplementPrompt {
			return ErrInvalidArgument
		}
	default:
		return ErrInvalidArgument
	}
	return nil
}

func (h *Host) preparePlanDecisionRuntimeOperation(ctx context.Context, ref SessionRef, turnID, requestID string, input SubmitPlanDecisionInput) (storesqlite.RuntimeOperation, error) {
	idempotencyKey := strings.TrimSpace(input.IdempotencyKey)
	operationID := runtimeOperationID(ref.WorkspaceID, ref.AgentSessionID, storesqlite.RuntimeOperationKindPlanDecision, turnID)
	payload := map[string]any{
		"promptKind": strings.TrimSpace(input.PromptKind), "action": strings.TrimSpace(input.Action),
		"idempotencyKey": idempotencyKey, "step": "prepared", "clientSubmitId": "plan-decision:" + operationID,
	}
	if existing, found, err := h.operations.GetRuntimeOperation(ctx, ref.WorkspaceID, operationID); err != nil {
		return storesqlite.RuntimeOperation{}, err
	} else if found {
		if existing.AgentSessionID != ref.AgentSessionID || existing.TurnID != turnID || existing.RequestID != requestID ||
			existing.Kind != storesqlite.RuntimeOperationKindPlanDecision || !planDecisionPayloadIdentityEqual(existing.Payload, payload) {
			return storesqlite.RuntimeOperation{}, storesqlite.ErrRuntimeOperationConflict
		}
		return existing, nil
	}
	operation, _, err := h.operations.PrepareRuntimeOperation(ctx, storesqlite.RuntimeOperationPrepare{
		OperationID: operationID, WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		Kind: storesqlite.RuntimeOperationKindPlanDecision, TurnID: turnID, RequestID: requestID,
		Payload: payload, OccurredAtMS: h.now().UnixMilli(),
	})
	return operation, err
}

func planDecisionPayloadIdentityEqual(existing, expected map[string]any) bool {
	for _, key := range []string{"promptKind", "action", "idempotencyKey", "clientSubmitId"} {
		if runtimeOperationPayloadText(existing, key) != runtimeOperationPayloadText(expected, key) {
			return false
		}
	}
	return true
}

func (h *Host) executePlanDecisionRuntimeOperation(ctx context.Context, operation storesqlite.RuntimeOperation, owner string) (storesqlite.RuntimeOperation, error) {
	if err := validateExecutablePlanDecisionOperation(operation); err != nil {
		return h.releaseRuntimeOperation(ctx, operation, owner, err, true)
	}
	if runtimeOperationPayloadText(operation.Payload, "promptKind") != "plan-implementation" {
		return h.releaseRuntimeOperation(ctx, operation, owner, ErrInvalidArgument, true)
	}
	return h.executePlanImplementationRuntimeOperation(ctx, operation, owner)
}

func validateExecutablePlanDecisionOperation(operation storesqlite.RuntimeOperation) error {
	if runtimeOperationPayloadText(operation.Payload, "promptKind") != "plan-implementation" ||
		runtimeOperationPayloadText(operation.Payload, "action") != "implement" ||
		runtimeOperationPayloadText(operation.Payload, "idempotencyKey") == "" ||
		runtimeOperationPayloadText(operation.Payload, "clientSubmitId") != "plan-decision:"+operation.OperationID {
		return ErrInvalidArgument
	}
	switch runtimeOperationPayloadText(operation.Payload, "step") {
	case "prepared", "settings_applied", "send_dispatched", "send_confirmed":
		return nil
	default:
		return ErrInvalidArgument
	}
}

func (h *Host) executePlanImplementationRuntimeOperation(ctx context.Context, operation storesqlite.RuntimeOperation, owner string) (storesqlite.RuntimeOperation, error) {
	step := runtimeOperationPayloadText(operation.Payload, "step")
	if step == "prepared" {
		ref := SessionRef{WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID}
		release, err := h.acquireSession(ctx, ref)
		if err != nil {
			return h.releaseRuntimeOperation(ctx, operation, owner, err, !isRetryableRuntimeOperationError(err))
		}
		_, ensureErr := h.ensureRuntimeSessionLocked(ctx, ref)
		if ensureErr != nil {
			release()
			return h.releaseRuntimeOperation(ctx, operation, owner, ensureErr, !isRetryableRuntimeOperationError(ensureErr))
		}
		planMode := false
		updateErr := h.runtime.UpdateSettings(ctx, RuntimeUpdateSettingsInput{
			WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID,
			Settings: ComposerSettingsPatch{PlanMode: &planMode},
		})
		release()
		if updateErr != nil {
			return h.releaseRuntimeOperation(ctx, operation, owner, updateErr, !isRetryableRuntimeOperationError(updateErr))
		}
		var checkpointErr error
		operation, checkpointErr = h.checkpointPlanDecision(ctx, operation, owner, "settings_applied", nil)
		if checkpointErr != nil {
			return operation, checkpointErr
		}
		step = "settings_applied"
	}
	clientSubmitID := runtimeOperationPayloadText(operation.Payload, "clientSubmitId")
	if confirmed, err := h.confirmPlanDecisionSubmit(ctx, operation, owner, clientSubmitID); err != nil || confirmed.Status == storesqlite.RuntimeOperationStatusCompleted {
		return confirmed, err
	}
	if step == "send_dispatched" {
		return h.releaseRuntimeOperation(ctx, operation, owner, errors.New("plan decision send outcome remains unconfirmed"), false)
	}
	if step != "settings_applied" {
		return h.releaseRuntimeOperation(ctx, operation, owner, fmt.Errorf("invalid plan decision step %q", step), true)
	}
	var err error
	operation, err = h.checkpointPlanDecision(ctx, operation, owner, "send_dispatched", nil)
	if err != nil {
		return operation, err
	}
	_, sendErr := h.SendInput(ctx, SessionRef{WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID}, SendInput{
		Content:  []PromptContentBlock{{Type: "text", Text: planImplementationPrompt}},
		Metadata: map[string]any{"clientSubmitId": clientSubmitID},
	})
	if sendErr != nil {
		return h.releaseRuntimeOperation(ctx, operation, owner, sendErr, false)
	}
	confirmed, err := h.confirmPlanDecisionSubmit(ctx, operation, owner, clientSubmitID)
	if err != nil || confirmed.Status == storesqlite.RuntimeOperationStatusCompleted {
		return confirmed, err
	}
	return h.releaseRuntimeOperation(ctx, operation, owner, errors.New("plan decision send accepted but durable turn is not visible yet"), false)
}

func (h *Host) confirmPlanDecisionSubmit(ctx context.Context, operation storesqlite.RuntimeOperation, owner, clientSubmitID string) (storesqlite.RuntimeOperation, error) {
	turnID, found, err := h.FindTurnByClientSubmitID(ctx, SessionRef{WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID}, clientSubmitID)
	if err != nil || !found {
		return operation, err
	}
	operation, err = h.checkpointPlanDecision(ctx, operation, owner, "send_confirmed", map[string]any{"confirmedTurnId": turnID})
	if err != nil {
		return operation, err
	}
	return h.completePlanDecision(ctx, operation, owner)
}

func (h *Host) checkpointPlanDecision(ctx context.Context, operation storesqlite.RuntimeOperation, owner, step string, extra map[string]any) (storesqlite.RuntimeOperation, error) {
	payload := cloneMap(operation.Payload)
	payload["step"] = step
	for key, value := range extra {
		payload[key] = value
	}
	checkpointed, changed, err := h.operations.CheckpointRuntimeOperation(ctx, storesqlite.CheckpointRuntimeOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID, LeaseOwner: owner,
		Payload: payload, NowUnixMS: h.now().UnixMilli(),
	})
	if err != nil {
		return operation, err
	}
	if !changed {
		return operation, storesqlite.ErrRuntimeOperationLeaseLost
	}
	return checkpointed, nil
}

func (h *Host) completePlanDecision(ctx context.Context, operation storesqlite.RuntimeOperation, owner string) (storesqlite.RuntimeOperation, error) {
	completion, _, err := h.operations.CompletePlanDecisionRuntimeOperation(ctx, storesqlite.CompletePlanDecisionRuntimeOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID, LeaseOwner: owner,
		Output: map[string]any{"step": runtimeOperationPayloadText(operation.Payload, "step")}, NowUnixMS: h.now().UnixMilli(),
	})
	if err != nil {
		return operation, err
	}
	if err := h.publishRuntimeOperationEvents(ctx, operation.WorkspaceID); err != nil {
		logRuntimeOperationFailure(completion.Operation, err)
	}
	return completion.Operation, nil
}
