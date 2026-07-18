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
	runtimeOperationLeaseDuration  = 30 * time.Second
	runtimeOperationWorkerInterval = time.Second
	runtimeOperationBatchSize      = 64
	runtimeOperationLogPrefix      = "[agent-runtime-operation]"
)

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

func (h *Host) prepareInteractiveRuntimeOperation(
	ctx context.Context,
	ref SessionRef,
	requestID string,
	input SubmitInteractiveInput,
	rootAgentSessionID string,
) (storesqlite.RuntimeOperation, RuntimeInteractiveDisposition, bool, error) {
	if h.operations == nil || h.store == nil {
		return storesqlite.RuntimeOperation{}, RuntimeInteractiveDispositionUnknown, false, errors.New("agent runtime operation store is unavailable")
	}
	expectedTurnID := strings.TrimSpace(input.TurnID)
	operationSubjectID := requestID
	if expectedTurnID != "" {
		operationSubjectID = expectedTurnID + "\x00" + requestID
	}
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
			(expectedTurnID != "" && existing.TurnID != expectedTurnID) {
			return storesqlite.RuntimeOperation{}, RuntimeInteractiveDispositionUnknown, false, storesqlite.ErrRuntimeOperationConflict
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
	interactions, err := h.store.ListSessionInteractions(ctx, storesqlite.ListSessionInteractionsInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
	})
	if err != nil {
		return storesqlite.RuntimeOperation{}, RuntimeInteractiveDispositionUnknown, false, err
	}
	var target storesqlite.Interaction
	for _, interaction := range interactions {
		if strings.TrimSpace(interaction.RequestID) == requestID && (expectedTurnID == "" || strings.TrimSpace(interaction.TurnID) == expectedTurnID) {
			target = interaction
			break
		}
	}
	turnID := strings.TrimSpace(target.TurnID)
	if turnID == "" {
		return storesqlite.RuntimeOperation{}, RuntimeInteractiveDispositionUnknown, false, fmt.Errorf("%w: interaction %q was not found", ErrInvalidArgument, requestID)
	}
	operation, interaction, transition, err := h.operations.PrepareInteractiveRuntimeOperation(ctx, storesqlite.RuntimeOperationPrepare{
		OperationID: operationID, WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		Kind: storesqlite.RuntimeOperationKindInteractiveResponse, TurnID: turnID, RequestID: requestID,
		Payload: payload, OccurredAtMS: h.now().UnixMilli(),
	})
	if err != nil {
		return storesqlite.RuntimeOperation{}, RuntimeInteractiveDispositionUnknown, false, err
	}
	disposition := RuntimeInteractiveDispositionSuperseded
	if interaction.Status == storesqlite.InteractionStatusAnswered && interactiveClaimMatches(interaction, input) {
		disposition = RuntimeInteractiveDispositionAnswered
	}
	return operation, disposition, transition == storesqlite.InteractionTransitionApplied && disposition == RuntimeInteractiveDispositionAnswered, nil
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
		return h.executeCancelRuntimeOperation(ctx, leased, owner)
	case storesqlite.RuntimeOperationKindPlanDecision:
		return h.executePlanDecisionRuntimeOperation(ctx, leased, owner)
	default:
		return h.releaseRuntimeOperation(ctx, leased, owner, fmt.Errorf("unsupported runtime operation kind %q", leased.Kind), true)
	}
}

func (h *Host) executeInteractiveRuntimeOperation(ctx context.Context, operation storesqlite.RuntimeOperation, owner string, recovering bool) (storesqlite.RuntimeOperation, error) {
	_, runtimeSessionFound := h.runtime.Session(operation.WorkspaceID, operation.AgentSessionID)
	runtimeDisposition := RuntimeInteractiveDispositionUnknown
	var submissionErr error
	if recovering {
		runtimeDisposition = h.runtime.InteractiveDisposition(operation.WorkspaceID, runtimeOperationPayloadText(operation.Payload, "rootAgentSessionId"), operation.AgentSessionID, operation.TurnID, operation.RequestID)
		if runtimeDisposition == RuntimeInteractiveDispositionUnknown && !runtimeSessionFound {
			return h.releaseRuntimeOperation(ctx, operation, owner, fmt.Errorf("interactive request %q has unknown runtime disposition after runtime session removal", operation.RequestID), true)
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

func (h *Host) executeCancelRuntimeOperation(ctx context.Context, operation storesqlite.RuntimeOperation, owner string) (storesqlite.RuntimeOperation, error) {
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
// the durable goal reconcile inbox, unrecoverable stale turns, and finally the
// adapter-specific worktree-isolation sweep.
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
	if h != nil && h.staleTurns != nil {
		if err := h.staleTurns.SettleStaleTurnsOnStartup(ctx); err != nil {
			return err
		}
	}
	return h.RecoverWorktreeIsolation(ctx)
}

func (h *Host) validateRecoveryConfiguration() error {
	if h == nil {
		return nil
	}
	if h.goals == nil {
		if h.goalInbox != nil {
			return ErrGoalConsumerUnavailable
		}
		return nil
	}
	if h.goalRuntime == nil || h.goalInbox == nil {
		return ErrGoalConsumerUnavailable
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
