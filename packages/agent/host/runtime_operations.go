package agenthost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

const (
	runtimeOperationLeaseDuration     = 30 * time.Second
	runtimeOperationWorkerInterval    = time.Second
	runtimeOperationBatchSize         = 64
	runtimeOperationLogPrefix         = "[agent-runtime-operation]"
	interactiveFollowUpStartTimeout   = 30 * time.Second
	interactiveFollowUpPollInterval   = 25 * time.Millisecond
	interactiveFollowUpDispositionKey = "followUpDisposition"
)

const interactiveFollowUpClientSubmitIDPrefix = "interactive-deny:"

// runtimeOperationID is stable across retries and process restarts.
func runtimeOperationID(workspaceID, agentSessionID, kind, subjectID string) string {
	name := strings.Join([]string{
		strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID),
		strings.TrimSpace(kind), strings.TrimSpace(subjectID),
	}, "\x00")
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(name)).String()
}

func runtimeOperationPayloadText(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return strings.TrimSpace(value)
}

func runtimeOperationPayloadInteractiveDisposition(payload map[string]any, key string) RuntimeInteractiveDisposition {
	switch RuntimeInteractiveDisposition(runtimeOperationPayloadText(payload, key)) {
	case RuntimeInteractiveDispositionAnswered,
		RuntimeInteractiveDispositionSuperseded,
		RuntimeInteractiveDispositionInterrupted:
		return RuntimeInteractiveDisposition(runtimeOperationPayloadText(payload, key))
	default:
		return RuntimeInteractiveDispositionUnknown
	}
}

func (h *Host) prepareInteractiveRuntimeOperation(
	ctx context.Context,
	ref InteractionRef,
	input SubmitInteractiveInput,
	rootAgentSessionID string,
) (storesqlite.RuntimeOperation, RuntimeInteractiveDisposition, bool, error) {
	if h.operations == nil || h.store == nil {
		return storesqlite.RuntimeOperation{}, RuntimeInteractiveDispositionUnknown, false, errors.New("agent runtime operation store is unavailable")
	}
	expectedTurnID := strings.TrimSpace(ref.TurnID)
	requestID := strings.TrimSpace(ref.RequestID)
	operationSubjectID := expectedTurnID + "\x00" + requestID
	operationID := runtimeOperationID(ref.WorkspaceID, ref.AgentSessionID, storesqlite.RuntimeOperationKindInteractiveResponse, operationSubjectID)
	payload := map[string]any{
		"rootAgentSessionId": strings.TrimSpace(rootAgentSessionID),
		"action":             value(input.Action), "optionId": value(input.OptionID),
		"payload": cloneMap(input.Payload), "turnId": expectedTurnID,
	}
	if existing, found, err := h.operations.GetRuntimeOperation(ctx, ref.WorkspaceID, operationID); err != nil {
		return storesqlite.RuntimeOperation{}, RuntimeInteractiveDispositionUnknown, false, err
	} else if found {
		if existing.WorkspaceID != ref.WorkspaceID || existing.AgentSessionID != ref.AgentSessionID ||
			existing.Kind != storesqlite.RuntimeOperationKindInteractiveResponse || existing.RequestID != requestID ||
			existing.TurnID != expectedTurnID {
			return storesqlite.RuntimeOperation{}, RuntimeInteractiveDispositionUnknown, false, interactiveIdentityMismatch(ref, operationID)
		}
		switch existing.Status {
		case storesqlite.RuntimeOperationStatusCompleted:
			disposition := RuntimeInteractiveDispositionSuperseded
			if existing.Result == storesqlite.RuntimeOperationResultAnswered && runtimeOperationPayloadEqual(existing.Payload, payload) {
				disposition = RuntimeInteractiveDispositionAnswered
			}
			return existing, disposition, false, nil
		case storesqlite.RuntimeOperationStatusFailed:
			if !runtimeOperationPayloadEqual(existing.Payload, payload) {
				return existing, RuntimeInteractiveDispositionSuperseded, false, nil
			}
			return existing, RuntimeInteractiveDispositionUnknown, true, nil
		}
	}
	operation, interaction, transition, err := h.operations.PrepareInteractiveRuntimeOperation(ctx, storesqlite.RuntimeOperationPrepare{
		OperationID: operationID, WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		Kind: storesqlite.RuntimeOperationKindInteractiveResponse, TurnID: expectedTurnID, RequestID: requestID,
		Payload: payload, OccurredAtMS: h.now().UnixMilli(),
	})
	if err != nil {
		if errors.Is(err, storesqlite.ErrRuntimeOperationIdentityMismatch) {
			return storesqlite.RuntimeOperation{}, RuntimeInteractiveDispositionUnknown, false, interactiveIdentityMismatch(ref, operationID)
		}
		if errors.Is(err, storesqlite.ErrRuntimeOperationSubjectState) {
			return storesqlite.RuntimeOperation{}, RuntimeInteractiveDispositionUnknown, false, ErrInteractionNotFound
		}
		return storesqlite.RuntimeOperation{}, RuntimeInteractiveDispositionUnknown, false, err
	}
	disposition := RuntimeInteractiveDispositionSuperseded
	if interaction.Status == storesqlite.InteractionStatusAnswered && interactiveClaimMatches(interaction, input) {
		disposition = RuntimeInteractiveDispositionAnswered
	}
	return operation, disposition, transition == storesqlite.InteractionTransitionApplied && disposition == RuntimeInteractiveDispositionAnswered, nil
}

func interactiveIdentityMismatch(ref InteractionRef, operationID string) error {
	slog.Error(runtimeOperationLogPrefix+" interactive identity mismatch",
		"workspace_id", ref.WorkspaceID,
		"agent_session_id", ref.AgentSessionID,
		"turn_id", ref.TurnID,
		"request_id", ref.RequestID,
		"operation_id", operationID,
	)
	return ErrRuntimeOperationIdentityMismatch
}

func interactiveClaimOutput(input SubmitInteractiveInput) map[string]any {
	return map[string]any{
		"action": value(input.Action), "optionId": value(input.OptionID), "payload": cloneMap(input.Payload),
	}
}

func interactiveClaimMatches(interaction storesqlite.Interaction, input SubmitInteractiveInput) bool {
	return runtimeOperationPayloadEqual(interaction.Output, interactiveClaimOutput(input))
}

func (h *Host) prepareCancelRuntimeOperation(
	ctx context.Context,
	input CancelTurnInput,
	rootAgentSessionID string,
	targets []RuntimeCancelTarget,
) (storesqlite.RuntimeOperation, error) {
	if h.operations == nil {
		return storesqlite.RuntimeOperation{}, errors.New("agent runtime operation store is unavailable")
	}
	reason := strings.TrimSpace(input.Reason)
	if reason == "" {
		reason = "user requested turn cancellation"
	}
	operation, _, err := h.operations.PrepareRuntimeOperation(ctx, storesqlite.RuntimeOperationPrepare{
		OperationID: runtimeOperationID(input.WorkspaceID, input.AgentSessionID, storesqlite.RuntimeOperationKindCancelTurn, input.TurnID),
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		Kind: storesqlite.RuntimeOperationKindCancelTurn, TurnID: input.TurnID,
		Payload:      map[string]any{"reason": reason, "rootAgentSessionId": strings.TrimSpace(rootAgentSessionID), "targets": runtimeCancelTargetsPayload(targets)},
		OccurredAtMS: h.now().UnixMilli(),
	})
	return operation, err
}

func (h *Host) processRuntimeOperation(ctx context.Context, operation storesqlite.RuntimeOperation, recovering bool) (storesqlite.RuntimeOperation, error) {
	if operation.Kind == storesqlite.RuntimeOperationKindPlanDecision {
		var result storesqlite.RuntimeOperation
		var processErr error
		err := h.withWorkspaceRuntimeOperation(ctx, operation.WorkspaceID, func(operationCtx context.Context) error {
			result, processErr = h.processRuntimeOperationAdmitted(operationCtx, operation, recovering)
			return processErr
		})
		if err != nil {
			return result, err
		}
		return result, processErr
	}
	return h.processRuntimeOperationAdmitted(ctx, operation, recovering)
}

func (h *Host) processRuntimeOperationAdmitted(ctx context.Context, operation storesqlite.RuntimeOperation, recovering bool) (storesqlite.RuntimeOperation, error) {
	if operation.Status == storesqlite.RuntimeOperationStatusCompleted {
		return operation, nil
	}
	if operation.Status == storesqlite.RuntimeOperationStatusFailed {
		return operation, fmt.Errorf("%w: %s", ErrRuntimeOperationFailed, strings.TrimSpace(operation.LastError))
	}
	if h.operations == nil {
		return storesqlite.RuntimeOperation{}, errors.New("agent runtime operation store is unavailable")
	}
	now := h.now()
	owner := strings.TrimSpace(h.owner)
	if owner == "" {
		owner = uuid.NewString()
	}
	leased, claimed, err := h.operations.ClaimRuntimeOperationLease(ctx, storesqlite.ClaimRuntimeOperationLeaseInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
		LeaseOwner: owner, NowUnixMS: now.UnixMilli(), LeaseExpiresAtMS: now.Add(runtimeOperationLeaseDuration).UnixMilli(),
	})
	if err != nil {
		return storesqlite.RuntimeOperation{}, err
	}
	if !claimed {
		current, ok, err := h.operations.GetRuntimeOperation(ctx, operation.WorkspaceID, operation.OperationID)
		if err != nil {
			return storesqlite.RuntimeOperation{}, err
		}
		if ok && current.Status == storesqlite.RuntimeOperationStatusCompleted {
			return current, nil
		}
		return current, ErrRuntimeOperationInProgress
	}
	switch leased.Kind {
	case storesqlite.RuntimeOperationKindInteractiveResponse:
		return h.executeInteractiveRuntimeOperation(ctx, leased, owner, recovering)
	case storesqlite.RuntimeOperationKindCancelTurn:
		return h.executeCancelRuntimeOperation(ctx, leased, owner, recovering)
	case storesqlite.RuntimeOperationKindPlanDecision:
		return h.executePlanDecisionRuntimeOperation(ctx, leased, owner)
	case storesqlite.RuntimeOperationKindEditRetry:
		if h.editRetryDisabled {
			// Feature neutralized (PR #1681). Quarantine any leftover edit-retry
			// operation so it can neither crash cold recovery nor hot-spin the
			// live worker. See quarantineDisabledEditRetryOperation.
			return h.quarantineDisabledEditRetryOperation(ctx, leased, owner)
		}
		if !editRetryActorHeld(ctx) {
			var result storesqlite.RuntimeOperation
			var executeErr error
			actorErr := h.withSessionMutationActor(
				ctx, leased.WorkspaceID, leased.AgentSessionID,
				func(actorCtx context.Context) error {
					result, executeErr = h.executeEditRetryRuntimeOperation(
						withEditRetryActorHeld(actorCtx), leased, owner, recovering,
					)
					return executeErr
				},
			)
			if actorErr != nil {
				return result, actorErr
			}
			return result, executeErr
		}
		return h.executeEditRetryRuntimeOperation(ctx, leased, owner, recovering)
	default:
		return h.releaseRuntimeOperation(ctx, leased, owner, fmt.Errorf("unsupported runtime operation kind %q", leased.Kind), true)
	}
}

func (h *Host) executeInteractiveRuntimeOperation(ctx context.Context, operation storesqlite.RuntimeOperation, owner string, recovering bool) (storesqlite.RuntimeOperation, error) {
	_, runtimeSessionFound := h.runtime.Session(operation.WorkspaceID, operation.AgentSessionID)
	runtimeDisposition := RuntimeInteractiveDispositionUnknown
	var submissionErr error
	followUpPrompt := runtimeOperationPayloadText(operation.Payload, "followUpPrompt")
	followUpClientSubmitID := runtimeOperationPayloadText(operation.Payload, "followUpClientSubmitId")
	persistedFollowUpDisposition := runtimeOperationPayloadInteractiveDisposition(operation.Payload, interactiveFollowUpDispositionKey)
	if recovering {
		if followUpPrompt != "" && persistedFollowUpDisposition != RuntimeInteractiveDispositionUnknown {
			// A checkpointed follow-up is durable evidence that the interactive
			// response already reached a terminal disposition. Do not consult the
			// Controller's in-memory disposition cache after a restart; it is not
			// part of the recovery contract.
			runtimeDisposition = persistedFollowUpDisposition
		} else {
			runtimeDisposition = h.runtime.InteractiveDisposition(operation.WorkspaceID, runtimeOperationPayloadText(operation.Payload, "rootAgentSessionId"), operation.AgentSessionID, operation.TurnID, operation.RequestID)
			if runtimeDisposition == RuntimeInteractiveDispositionUnknown && !runtimeSessionFound {
				return h.releaseRuntimeOperation(ctx, operation, owner, fmt.Errorf("interactive request %q has unknown runtime disposition after runtime session removal", operation.RequestID), true)
			}
		}
	}
	if runtimeDisposition != RuntimeInteractiveDispositionAnswered && runtimeDisposition != RuntimeInteractiveDispositionSuperseded && runtimeDisposition != RuntimeInteractiveDispositionInterrupted {
		result, err := h.runtime.SubmitInteractive(ctx, RuntimeSubmitInteractiveInput{
			WorkspaceID: operation.WorkspaceID, RootAgentSessionID: runtimeOperationPayloadText(operation.Payload, "rootAgentSessionId"),
			AgentSessionID: operation.AgentSessionID, TurnID: operation.TurnID, RequestID: operation.RequestID,
			Action: runtimeOperationPayloadText(operation.Payload, "action"), OptionID: runtimeOperationPayloadText(operation.Payload, "optionId"),
			Payload: runtimeOperationPayloadMap(operation.Payload, "payload"),
		})
		submissionErr = err
		runtimeDisposition = result.Disposition
		if runtimeDisposition == "" {
			runtimeDisposition = h.runtime.InteractiveDisposition(operation.WorkspaceID, runtimeOperationPayloadText(operation.Payload, "rootAgentSessionId"), operation.AgentSessionID, operation.TurnID, operation.RequestID)
		}
		if prompt := strings.TrimSpace(result.FollowUpPrompt); prompt != "" {
			checkpointFollowUp := false
			if followUpPrompt == "" {
				followUpPrompt = prompt
				checkpointFollowUp = true
			}
			if followUpClientSubmitID == "" {
				followUpClientSubmitID = interactiveFollowUpClientSubmitIDPrefix + operation.OperationID
				checkpointFollowUp = true
			}
			if persistedFollowUpDisposition == RuntimeInteractiveDispositionUnknown {
				persistedFollowUpDisposition = runtimeDisposition
				checkpointFollowUp = true
			}
			if checkpointFollowUp {
				payload := cloneMap(operation.Payload)
				payload["followUpPrompt"] = followUpPrompt
				payload["followUpClientSubmitId"] = followUpClientSubmitID
				payload[interactiveFollowUpDispositionKey] = string(persistedFollowUpDisposition)
				checkpointed, _, checkpointErr := h.operations.CheckpointRuntimeOperation(ctx, storesqlite.CheckpointRuntimeOperationInput{
					WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID, LeaseOwner: owner,
					Payload: payload, NowUnixMS: h.now().UnixMilli(),
				})
				if checkpointErr != nil {
					return operation, checkpointErr
				}
				operation = checkpointed
			}
		}
	}
	dispositionErr := submissionErr
	if dispositionErr == nil {
		dispositionErr = errors.New("runtime submission returned no terminal disposition")
	}
	var disposition string
	switch runtimeDisposition {
	case RuntimeInteractiveDispositionPending, RuntimeInteractiveDispositionResolving:
		if submissionErr == nil {
			submissionErr = ErrRuntimeOperationInProgress
		}
		return h.releaseRuntimeOperation(ctx, operation, owner, submissionErr, false)
	case RuntimeInteractiveDispositionAnswered:
		disposition = storesqlite.InteractionStatusAnswered
	case RuntimeInteractiveDispositionSuperseded, RuntimeInteractiveDispositionInterrupted:
		disposition = storesqlite.InteractionStatusSuperseded
	case RuntimeInteractiveDispositionUnknown:
		return h.releaseRuntimeOperation(ctx, operation, owner, fmt.Errorf("interactive request %q has unknown runtime disposition after submission: %w", operation.RequestID, dispositionErr), true)
	default:
		return h.releaseRuntimeOperation(ctx, operation, owner, fmt.Errorf("interactive request %q returned unsupported runtime disposition %q: %w", operation.RequestID, runtimeDisposition, dispositionErr), true)
	}
	if followUpPrompt != "" {
		if followUpClientSubmitID == "" {
			followUpClientSubmitID = interactiveFollowUpClientSubmitIDPrefix + operation.OperationID
		}
		if err := h.waitForInteractiveFollowUp(ctx, operation.WorkspaceID, operation.AgentSessionID); err != nil {
			return h.releaseRuntimeOperation(ctx, operation, owner, err, false)
		}
		_, err := h.SendInput(ctx, SessionRef{WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID}, SendInput{
			Content:        []PromptContentBlock{{Type: "text", Text: followUpPrompt}},
			ClientSubmitID: followUpClientSubmitID,
		})
		if err != nil {
			return h.releaseRuntimeOperation(ctx, operation, owner, err, !isRetryableInteractiveFollowUpError(err))
		}
	}
	completion, _, err := h.operations.CompleteInteractiveRuntimeOperation(ctx, storesqlite.CompleteInteractiveRuntimeOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID, LeaseOwner: owner,
		Disposition: disposition, Output: map[string]any{"action": runtimeOperationPayloadText(operation.Payload, "action"), "optionId": runtimeOperationPayloadText(operation.Payload, "optionId")},
		NowUnixMS: h.now().UnixMilli(),
	})
	if err != nil {
		return operation, err
	}
	if err := h.publishRuntimeOperationEvents(ctx, operation.WorkspaceID); err != nil {
		logRuntimeOperationFailure(completion.Operation, fmt.Errorf("publish completed interactive runtime operation: %w", err))
	}
	return completion.Operation, nil
}

func (h *Host) waitForInteractiveFollowUp(ctx context.Context, workspaceID, agentSessionID string) error {
	deadline := time.NewTimer(interactiveFollowUpStartTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(interactiveFollowUpPollInterval)
	defer ticker.Stop()
	for {
		session, found := h.runtime.Session(workspaceID, agentSessionID)
		if !found {
			return ErrSessionNotFound
		}
		if session.TurnLifecycle == nil || session.TurnLifecycle.ActiveTurnID == nil || strings.TrimSpace(*session.TurnLifecycle.ActiveTurnID) == "" {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return ErrRuntimeSessionActive
		case <-ticker.C:
		}
	}
}

func isRetryableInteractiveFollowUpError(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, ErrSubmitDeliveryUnknown) || errors.Is(err, ErrSessionNotFound) ||
		errors.Is(err, ErrRuntimeSessionActive) || errors.Is(err, ErrRuntimeSessionDisconnected) ||
		errors.Is(err, ErrRuntimeOperationInProgress)
}

func (h *Host) executeCancelRuntimeOperation(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
	recovering bool,
) (storesqlite.RuntimeOperation, error) {
	if recovering {
		locallyStopped, err := h.goalGenerationFenceStopsRuntimeCancel(ctx, operation)
		if err != nil {
			return h.releaseRuntimeOperation(ctx, operation, owner, err, false)
		}
		if locallyStopped {
			return h.completeInterruptedCancelRuntimeOperation(ctx, operation, owner)
		}
	}
	targets := runtimeCancelTargetsFromPayload(operation.Payload)
	result, err := h.runtime.Cancel(ctx, RuntimeCancelInput{
		WorkspaceID: operation.WorkspaceID, RootAgentSessionID: runtimeOperationPayloadText(operation.Payload, "rootAgentSessionId"),
		Targets: targets, Reason: runtimeOperationPayloadText(operation.Payload, "reason"),
	})
	if err != nil {
		return h.releaseRuntimeOperation(ctx, operation, owner, err, !isRetryableRuntimeOperationError(err))
	}
	completion, _, err := h.operations.CompleteCancelRuntimeOperation(ctx, storesqlite.CompleteCancelRuntimeOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID, LeaseOwner: owner,
		TargetOutcomes: runtimeCancelTargetOutcomes(runtimeOperationPayloadText(operation.Payload, "rootAgentSessionId"), targets, result.ConfirmedTargets),
		NowUnixMS:      h.now().UnixMilli(),
	})
	if err != nil {
		return operation, err
	}
	completion.Operation.Payload = cloneMap(completion.Operation.Payload)
	completion.Operation.Payload["providerConfirmed"] = len(result.ConfirmedTargets) > 0
	if err := h.publishRuntimeOperationEvents(ctx, operation.WorkspaceID); err != nil {
		logRuntimeOperationFailure(completion.Operation, fmt.Errorf("publish completed cancel runtime operation: %w", err))
	}
	return completion.Operation, nil
}

// A live Goal revocation may crash after preparing its exact-Turn cancel but
// before that runtime operation settles. On restart the durable Goal fence is
// already the admission fact and no provider process exists to cancel. Finish
// the orphaned cancel locally as interrupted so it cannot protect the stale
// Turn from startup settlement or retry a missing Runtime forever.
func (h *Host) goalGenerationFenceStopsRuntimeCancel(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
) (bool, error) {
	if h == nil || h.goalFences == nil || h.store == nil {
		return false, nil
	}
	if _, ok := h.runtime.(RuntimeSessionLiveness); !ok {
		return false, ErrRuntimeSessionLivenessUnavailable
	}
	if h.runtimeSessionLive(operation.WorkspaceID, operation.AgentSessionID) {
		return false, nil
	}
	turn, found, err := h.store.GetTurn(ctx, operation.WorkspaceID, operation.AgentSessionID, operation.TurnID)
	if err != nil || !found {
		return false, err
	}
	fences, err := h.goalFences.ListGoalGenerationFencesForSession(ctx, operation.WorkspaceID, operation.AgentSessionID)
	if err != nil {
		return false, err
	}
	for _, fence := range fences {
		if turn.SourceGoalOperationID == fence.TargetOperationID &&
			turn.SourceGoalRevision == fence.TargetRevision &&
			turn.SourceGoalRepairEpoch == fence.TargetRepairEpoch {
			return true, nil
		}
	}
	return false, nil
}

func (h *Host) completeInterruptedCancelRuntimeOperation(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
) (storesqlite.RuntimeOperation, error) {
	targets := runtimeCancelTargetsFromPayload(operation.Payload)
	outcomes := make([]storesqlite.CancelRuntimeOperationTargetOutcome, 0, len(targets))
	for _, target := range targets {
		outcomes = append(outcomes, storesqlite.CancelRuntimeOperationTargetOutcome{
			AgentSessionID: target.AgentSessionID,
			TurnID:         target.TurnID,
			Outcome:        storesqlite.TurnOutcomeInterrupted,
		})
	}
	completion, _, err := h.operations.CompleteCancelRuntimeOperation(ctx, storesqlite.CompleteCancelRuntimeOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID, LeaseOwner: owner,
		TargetOutcomes: outcomes, NowUnixMS: h.now().UnixMilli(),
	})
	if err != nil {
		return operation, err
	}
	if err := h.publishRuntimeOperationEvents(ctx, operation.WorkspaceID); err != nil {
		logRuntimeOperationFailure(completion.Operation, fmt.Errorf("publish locally stopped cancel runtime operation: %w", err))
	}
	return completion.Operation, nil
}

func runtimeCancelTargetOutcomes(rootAgentSessionID string, targets, confirmed []RuntimeCancelTarget) []storesqlite.CancelRuntimeOperationTargetOutcome {
	confirmedSet := make(map[string]struct{}, len(confirmed))
	for _, target := range confirmed {
		confirmedSet[runtimeCancelTargetKey(target)] = struct{}{}
	}
	rootAgentSessionID = strings.TrimSpace(rootAgentSessionID)
	result := make([]storesqlite.CancelRuntimeOperationTargetOutcome, 0, len(targets))
	for _, target := range targets {
		outcome := storesqlite.TurnOutcomeInterrupted
		if strings.TrimSpace(target.AgentSessionID) == rootAgentSessionID {
			outcome = storesqlite.TurnOutcomeCanceled
		} else if _, ok := confirmedSet[runtimeCancelTargetKey(target)]; ok {
			outcome = storesqlite.TurnOutcomeCanceled
		}
		result = append(result, storesqlite.CancelRuntimeOperationTargetOutcome{AgentSessionID: strings.TrimSpace(target.AgentSessionID), TurnID: strings.TrimSpace(target.TurnID), Outcome: outcome})
	}
	return result
}

func runtimeCancelTargetKey(target RuntimeCancelTarget) string {
	return strings.TrimSpace(target.AgentSessionID) + "\x00" + strings.TrimSpace(target.TurnID)
}

func runtimeCancelTargetsPayload(targets []RuntimeCancelTarget) []any {
	result := make([]any, 0, len(targets))
	for _, target := range targets {
		result = append(result, map[string]any{"agentSessionId": strings.TrimSpace(target.AgentSessionID), "turnId": strings.TrimSpace(target.TurnID)})
	}
	return result
}

func runtimeCancelTargetsFromPayload(payload map[string]any) []RuntimeCancelTarget {
	raw, _ := payload["targets"].([]any)
	result := make([]RuntimeCancelTarget, 0, len(raw))
	for _, item := range raw {
		value, _ := item.(map[string]any)
		target := RuntimeCancelTarget{AgentSessionID: runtimeOperationPayloadText(value, "agentSessionId"), TurnID: runtimeOperationPayloadText(value, "turnId")}
		if target.AgentSessionID != "" && target.TurnID != "" {
			result = append(result, target)
		}
	}
	return result
}

func (h *Host) releaseRuntimeOperation(ctx context.Context, operation storesqlite.RuntimeOperation, owner string, cause error, fail bool) (storesqlite.RuntimeOperation, error) {
	released, _, releaseErr := h.operations.ReleaseOrFailRuntimeOperation(ctx, storesqlite.ReleaseOrFailRuntimeOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID, LeaseOwner: owner,
		LastError: cause.Error(), NowUnixMS: h.now().UnixMilli(), Fail: fail,
		NextAttemptAtMS: runtimeOperationNextAttemptAt(h.now(), operation.Attempt, fail),
	})
	if releaseErr != nil {
		return operation, releaseErr
	}
	if !fail {
		return released, fmt.Errorf("%w: %v", ErrRuntimeOperationInProgress, cause)
	}
	return released, cause
}

// quarantineDisabledEditRetryOperation dead-letters an edit-retry operation left
// over from before the feature was neutralized (see Config.EditRetryDisabled).
// It both marks the operation failed — dropping it from the claimable set
// (ListClaimableRuntimeOperations only returns prepared/leased rows), so it can
// neither fail cold recovery nor hot-spin the live worker — AND clears the
// session's effective-history fence back to ready. The fence clear is essential:
// a stuck operation leaves the session at resend_pending/rollback_pending/
// recovery_required, and with the feature disabled no recovery path can move it
// back to ready, so requireSendAllowedByEffectiveHistory would otherwise reject
// every subsequent send for that conversation forever. It returns a nil error on
// success: a completed quarantine is a terminal, non-fatal outcome for the worker,
// so it must never abort daemon boot.
func (h *Host) quarantineDisabledEditRetryOperation(ctx context.Context, operation storesqlite.RuntimeOperation, owner string) (storesqlite.RuntimeOperation, error) {
	if h.effectiveHistory == nil {
		return operation, errors.New("effective history store is unavailable")
	}
	failed, _, err := h.effectiveHistory.QuarantineEditRetryOperation(ctx, storesqlite.QuarantineEditRetryOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID, LeaseOwner: owner,
		NowUnixMS: h.now().UnixMilli(),
	})
	if err != nil {
		return operation, err
	}
	logRuntimeOperationFailure(failed, errors.New("edit_retry disabled: quarantined orphaned runtime operation and cleared session history fence"))
	if publishErr := h.publishRuntimeOperationEvents(ctx, operation.WorkspaceID); publishErr != nil {
		logRuntimeOperationFailure(failed, publishErr)
	}
	return failed, nil
}

func (h *Host) StepRuntimeOperationWorker(ctx context.Context, recovering bool) error {
	if h == nil || h.operations == nil {
		return nil
	}
	operations, err := h.operations.ListClaimableRuntimeOperations(ctx, storesqlite.ListClaimableRuntimeOperationsInput{NowUnixMS: h.now().UnixMilli(), Limit: runtimeOperationBatchSize})
	if err != nil {
		return err
	}
	var processErrors []error
	for _, operation := range operations {
		if _, err := h.processRuntimeOperation(ctx, operation, recovering); err != nil && !errors.Is(err, ErrRuntimeOperationInProgress) {
			logRuntimeOperationFailure(operation, err)
			processErrors = append(processErrors, fmt.Errorf("process runtime operation %s: %w", operation.OperationID, err))
		}
	}
	if err := h.publishRuntimeOperationEvents(ctx, ""); err != nil {
		processErrors = append(processErrors, fmt.Errorf("publish runtime operation outbox: %w", err))
	}
	return errors.Join(processErrors...)
}

func (h *Host) RecoverRuntimeOperations(ctx context.Context) error {
	if h == nil || h.operations == nil {
		return nil
	}
	if _, err := h.operations.RequeueLeasedRuntimeOperationsOnStartup(ctx, h.now().UnixMilli()); err != nil {
		return fmt.Errorf("requeue leased runtime operations on startup: %w", err)
	}
	for {
		if err := h.StepRuntimeOperationWorker(ctx, true); err != nil {
			return err
		}
		remaining, err := h.operations.ListClaimableRuntimeOperations(ctx, storesqlite.ListClaimableRuntimeOperationsInput{NowUnixMS: h.now().UnixMilli(), Limit: 1})
		if err != nil {
			return err
		}
		if len(remaining) == 0 {
			return nil
		}
	}
}

// Recover fixes startup order as durable runtime operations, goal operations,
// the durable goal reconcile inbox, session Forks, and unrecoverable stale turns.
func (h *Host) Recover(ctx context.Context) error {
	if err := h.validateRecoveryConfiguration(); err != nil {
		return err
	}
	if err := h.RecoverRuntimeOperations(ctx); err != nil {
		return err
	}
	if err := h.RecoverGoalOperations(ctx); err != nil {
		return err
	}
	if err := h.RecoverGoalReconcileInbox(ctx); err != nil {
		return err
	}
	if err := h.RecoverSessionForks(ctx); err != nil {
		return err
	}
	if h != nil && h.staleTurns != nil {
		if err := h.staleTurns.SettleStaleTurnsOnStartup(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (h *Host) validateRecoveryConfiguration() error {
	if h == nil {
		return nil
	}
	if h.goals == nil {
		if h.goalInbox != nil || h.goalFences != nil {
			return ErrGoalConsumerUnavailable
		}
		return nil
	}
	if h.goalRuntime == nil || h.goalInbox == nil {
		return ErrGoalConsumerUnavailable
	}
	if h.goalFences != nil {
		if _, ok := h.goalRuntime.(GoalRuntimeGenerationFencer); !ok {
			return ErrGoalGenerationFenceUnavailable
		}
		if _, ok := h.runtime.(RuntimeSessionLiveness); !ok {
			return ErrRuntimeSessionLivenessUnavailable
		}
	}
	return nil
}

func (h *Host) RunRuntimeOperationWorker(ctx context.Context) {
	_ = h.runRuntimeOperationWorker(ctx)
}

func (h *Host) runRuntimeOperationWorker(ctx context.Context) error {
	if h == nil {
		return nil
	}
	if h.scheduler == nil {
		ticker := time.NewTicker(runtimeOperationWorkerInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-ticker.C:
				if err := h.StepRuntimeOperationWorker(ctx, false); err != nil {
					logRuntimeOperationFailure(storesqlite.RuntimeOperation{}, err)
				}
			}
		}
	}
	for {
		if err := h.scheduler.Sleep(ctx, runtimeOperationWorkerInterval); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("runtime operation worker scheduler: %w", err)
		}
		if err := h.StepRuntimeOperationWorker(ctx, false); err != nil {
			logRuntimeOperationFailure(storesqlite.RuntimeOperation{}, err)
		}
	}
}

func (h *Host) publishRuntimeOperationEvents(ctx context.Context, workspaceID string) error {
	if h.operations == nil || h.events == nil {
		return nil
	}
	events, err := h.operations.ListPendingRuntimeOperationEvents(ctx, workspaceID, runtimeOperationBatchSize)
	if err != nil {
		return err
	}
	for _, event := range events {
		if err := h.events.PublishRuntimeOperationEvent(ctx, event); err != nil {
			return err
		}
		if _, err := h.operations.MarkRuntimeOperationEventPublished(ctx, event.WorkspaceID, event.ID, h.now().UnixMilli()); err != nil {
			return err
		}
	}
	return nil
}

func logRuntimeOperationFailure(operation storesqlite.RuntimeOperation, err error) {
	payload, _ := json.Marshal(map[string]any{"event": "runtime_operation_failed", "operationId": operation.OperationID, "workspaceId": operation.WorkspaceID, "agentSessionId": operation.AgentSessionID, "kind": operation.Kind, "error": err.Error()})
	slog.Error(runtimeOperationLogPrefix + " " + string(payload))
}

func isRetryableRuntimeOperationError(err error) bool {
	return err != nil && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrSessionNotFound) || errors.Is(err, ErrRuntimeSessionDisconnected))
}

func runtimeOperationNextAttemptAt(now time.Time, attempt int, failed bool) int64 {
	if failed {
		return 0
	}
	if attempt < 1 {
		attempt = 1
	}
	shift := attempt - 1
	if shift > 8 {
		shift = 8
	}
	return now.Add(time.Second * time.Duration(1<<shift)).UnixMilli()
}

func runtimeOperationPayloadEqual(left, right map[string]any) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftJSON, rightJSON)
}

func runtimeOperationPayloadMap(payload map[string]any, key string) map[string]any {
	value, _ := payload[key].(map[string]any)
	return cloneMap(value)
}
