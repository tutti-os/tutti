package agenthost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

const (
	runtimeOperationLeaseDuration         = 30 * time.Second
	runtimeOperationWorkerInterval        = time.Second
	runtimeOperationBatchSize             = 64
	runtimeOperationAttemptTimeoutDefault = 15 * time.Second
	runtimeOperationLogPrefix             = "[agent-runtime-operation]"
)

// operationStepDisposition is returned only after a durable transition has
// committed. It prevents a provider/runtime error from being mistaken for a
// daemon-startup error once the item has been safely deferred, blocked, or
// quarantined.
type operationStepDisposition string

const (
	operationStepCompleted      operationStepDisposition = "completed"
	operationStepDeferred       operationStepDisposition = "deferred"
	operationStepBlocked        operationStepDisposition = "blocked"
	operationStepQuarantined    operationStepDisposition = "quarantined"
	operationStepTerminalFailed operationStepDisposition = "terminal_failed"
)

type operationStepResult struct {
	Disposition operationStepDisposition
	Operation   storesqlite.RuntimeOperation
}

func durableOperationStepResult(operation storesqlite.RuntimeOperation) (operationStepResult, bool) {
	switch operation.Status {
	case storesqlite.RuntimeOperationStatusCompleted:
		return operationStepResult{Disposition: operationStepCompleted, Operation: operation}, true
	case storesqlite.RuntimeOperationStatusBlocked:
		return operationStepResult{Disposition: operationStepBlocked, Operation: operation}, true
	case storesqlite.RuntimeOperationStatusPrepared:
		return operationStepResult{Disposition: operationStepDeferred, Operation: operation}, true
	case storesqlite.RuntimeOperationStatusFailed:
		if operation.Kind == storesqlite.RuntimeOperationKindEditRetry && strings.HasPrefix(strings.TrimSpace(operation.LastError), "edit_retry disabled;") {
			return operationStepResult{Disposition: operationStepQuarantined, Operation: operation}, true
		}
		return operationStepResult{Disposition: operationStepTerminalFailed, Operation: operation}, true
	default:
		return operationStepResult{}, false
	}
}

func (h *Host) stepRuntimeOperation(ctx context.Context, operation storesqlite.RuntimeOperation, recovering bool) (operationStepResult, error) {
	processed, err := h.processRuntimeOperationSerialized(ctx, operation, recovering)
	if result, durable := durableOperationStepResult(processed); durable {
		return result, nil
	}
	return operationStepResult{}, err
}

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

// processRuntimeOperation always acquires the exact session actor. Only Host
// internals already executing in that actor may call the serialized variant.
func (h *Host) processRuntimeOperation(ctx context.Context, operation storesqlite.RuntimeOperation, recovering bool) (storesqlite.RuntimeOperation, error) {
	var result storesqlite.RuntimeOperation
	var processErr error
	actorErr := h.withSessionMutationActor(ctx, operation.WorkspaceID, operation.AgentSessionID, func(actorCtx context.Context) error {
		result, processErr = h.processRuntimeOperationSerialized(actorCtx, operation, recovering)
		return processErr
	})
	if actorErr != nil {
		return result, actorErr
	}
	return result, processErr
}

func (h *Host) processRuntimeOperationSerialized(ctx context.Context, operation storesqlite.RuntimeOperation, recovering bool) (storesqlite.RuntimeOperation, error) {
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
	case storesqlite.RuntimeOperationKindEditRetry:
		if !h.editRetryRecovery.AllowsMutation() {
			// Emergency policy changes only automatic handling. Preserve this
			// operation's exact fence and durable evidence, then let the control
			// plane perform a CAS-bound read-only reconcile when appropriate.
			return h.blockEditRetryBudget(ctx, leased, owner, ErrEditRetryRecoveryRequired)
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
		h.recordRuntimeOperationWorkerFailure("store")
		return err
	}
	var attempts sync.WaitGroup
	for _, operation := range operations {
		if !h.runtimeOperationExecutor.reserve(operation) {
			// A current attempt for this session or operation already owns the
			// local lane, or every bounded provider slot is occupied. Leave the
			// durable lease untouched for a later scheduled tick.
			continue
		}
		attempts.Add(1)
		go func(operation storesqlite.RuntimeOperation) {
			defer attempts.Done()
			defer h.runtimeOperationExecutor.release(operation)
			attemptCtx, cancel := context.WithTimeout(ctx, h.runtimeOperationAttemptTimeout)
			defer cancel()
			result, stepErr := h.stepRuntimeOperationSerialized(attemptCtx, operation, recovering)
			if stepErr != nil && !errors.Is(stepErr, ErrRuntimeOperationInProgress) {
				h.recordRuntimeOperationWorkerFailure("item")
				logRuntimeOperationFailure(operation, stepErr)
				return
			}
			// Deferred/blocked work is durably safe but still represents an
			// operational degradation. Record only the aggregate; never expose a
			// raw provider error through the worker health projection.
			if result.Disposition == operationStepDeferred || result.Disposition == operationStepBlocked {
				h.recordRuntimeOperationWorkerFailure("item")
			}
		}(operation)
	}
	// Respecting providers return by their per-attempt deadline. A provider
	// that ignores context is intentionally not waited on past that deadline:
	// its reservation remains held until it returns, so repeated ticks cannot
	// create more calls while the remaining bounded slots still serve other
	// sessions and kinds.
	done := make(chan struct{})
	go func() {
		attempts.Wait()
		close(done)
	}()
	timer := time.NewTimer(h.runtimeOperationAttemptTimeout)
	defer timer.Stop()
	select {
	case <-done:
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
	}
	if err := h.publishRuntimeOperationEvents(ctx, ""); err != nil {
		// The canonical transition has already committed. Publishing is an
		// outbox concern: retain the pending event for a later worker step and
		// never turn a successful operation into a worker/startup failure.
		logRuntimeOperationFailure(storesqlite.RuntimeOperation{}, fmt.Errorf("publish runtime operation outbox: %w", err))
	}
	return nil
}

// stepRuntimeOperationSerialized makes runtime-operation execution single
// writer per session for every operation kind.
func (h *Host) stepRuntimeOperationSerialized(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	recovering bool,
) (operationStepResult, error) {
	var result operationStepResult
	var stepErr error
	actorErr := h.withSessionMutationActor(ctx, operation.WorkspaceID, operation.AgentSessionID, func(actorCtx context.Context) error {
		result, stepErr = h.stepRuntimeOperation(actorCtx, operation, recovering)
		return stepErr
	})
	if actorErr != nil {
		return result, actorErr
	}
	return result, stepErr
}

// RecoverCore performs only startup-safe, local durable repair. In particular
// it does not claim or drain an operation and cannot invoke a provider. The
// steady-state workers are deliberately started after the daemon has published
// its listener, so an operation belonging to one session can never be a boot
// poison pill for the whole daemon.
func (h *Host) RecoverCore(ctx context.Context) error {
	if h == nil {
		return nil
	}
	if err := h.validateRecoveryConfiguration(); err != nil {
		return err
	}
	if h.operations != nil {
		if _, err := h.operations.RequeueLeasedRuntimeOperationsOnStartup(ctx, h.now().UnixMilli()); err != nil {
			return fmt.Errorf("requeue leased runtime operations on startup: %w", err)
		}
	}
	// These transitions touch only canonical SQLite rows. They intentionally
	// requeue work without processing it; provider-capable workers start after
	// listener publication in Run.
	if h.goals != nil {
		if _, err := h.goals.RequeueLeasedGoalControlOperationsOnStartup(ctx, h.goalOperationNow().UnixMilli()); err != nil {
			return fmt.Errorf("requeue leased goal operations on startup: %w", err)
		}
	}
	if h.goalFences != nil {
		if _, err := h.goalFences.RequeueLeasedGoalGenerationFencesOnStartup(ctx, h.goalOperationNow().UnixMilli()); err != nil {
			return fmt.Errorf("requeue leased goal generation fences on startup: %w", err)
		}
	}
	if h.goalInbox != nil {
		if _, err := h.goalInbox.RequeueLeasedGoalReconcileInboxOnStartup(ctx, h.goalOperationNow().UnixMilli()); err != nil {
			return fmt.Errorf("requeue leased goal reconcile inbox on startup: %w", err)
		}
	}
	return nil
}

// RecoverPostListener restores the one-time recovery responsibilities
// that are not safe before listener publication. Failures remain local to the
// affected durable domain: the periodic workers and daemon must stay alive.
// Runtime operations are deliberately not drained here; their ordinary worker
// keeps session admission fences intact and processes bounded batches.
// Callers must publish their listener before invoking this method.
func (h *Host) RecoverPostListener(ctx context.Context) error {
	if h == nil {
		return nil
	}
	type recoveryStep struct {
		name string
		run  func(context.Context) error
	}
	// Keep this sequence explicit. Each one-time repair runs before its steady
	// worker starts in Run, and retries retain this same order rather than
	// inheriting Go map iteration order.
	pending := []recoveryStep{
		{name: "goal_operations", run: h.RecoverGoalOperations},
		{name: "goal_reconcile_inbox", run: h.RecoverGoalReconcileInbox},
		{name: "session_forks", run: h.RecoverSessionForks},
	}
	if h.staleTurns != nil {
		// Store-level settlement excludes every session/turn protected by a
		// prepared, leased, or blocked runtime-operation fence. It therefore
		// cannot race a deferred edit retry merely because startup order changed.
		pending = append(pending, recoveryStep{name: "stale_turns", run: h.staleTurns.SettleStaleTurnsOnStartup})
	}
	pending = append(pending, recoveryStep{name: "worktree_isolation", run: h.RecoverWorktreeIsolation})
	const attempts = 3
	for attempt := 1; len(pending) != 0 && attempt <= attempts; attempt++ {
		remaining := pending[:0]
		for _, step := range pending {
			if err := step.run(ctx); err != nil {
				h.recordRuntimeOperationWorkerFailure("post_listener_recovery")
				logRuntimeOperationFailure(storesqlite.RuntimeOperation{}, fmt.Errorf("post-listener recovery %s attempt %d/%d: %w", step.name, attempt, attempts, err))
				remaining = append(remaining, step)
				continue
			}
		}
		pending = remaining
		if len(pending) == 0 || attempt == attempts {
			break
		}
		timer := time.NewTimer(time.Second * time.Duration(attempt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	for _, step := range pending {
		h.recordRuntimeOperationWorkerFailure("post_listener_degraded")
		logRuntimeOperationFailure(storesqlite.RuntimeOperation{}, fmt.Errorf("post-listener recovery %s remains degraded after bounded retries", step.name))
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
	// Multiple session lanes may complete concurrently. Serializing the small
	// outbox drain prevents two in-process readers from publishing one pending
	// stable event before either can durably mark it sent.
	h.outboxMu.Lock()
	defer h.outboxMu.Unlock()
	events, err := h.operations.ListReadyRuntimeOperationEvents(ctx, workspaceID, h.now().UnixMilli(), runtimeOperationBatchSize)
	if err != nil {
		h.recordRuntimeOperationWorkerFailure("outbox")
		return err
	}
	for _, event := range events {
		if err := h.events.PublishRuntimeOperationEvent(ctx, event); err != nil {
			h.recordRuntimeOperationWorkerFailure("outbox")
			if deferErr := h.deferRuntimeOperationEventPublish(ctx, event); deferErr != nil {
				logRuntimeOperationFailure(storesqlite.RuntimeOperation{}, fmt.Errorf("defer failed outbox event %d: %w", event.ID, deferErr))
			}
			continue
		}
		if _, err := h.operations.MarkRuntimeOperationEventPublished(ctx, event.WorkspaceID, event.ID, h.now().UnixMilli()); err != nil {
			h.recordRuntimeOperationWorkerFailure("outbox")
			// The event may have reached its consumer. Preserve the stable ID and
			// retry it later under the consumer's idempotency contract, without
			// blocking the following pending event.
			if deferErr := h.deferRuntimeOperationEventPublish(ctx, event); deferErr != nil {
				logRuntimeOperationFailure(storesqlite.RuntimeOperation{}, fmt.Errorf("defer unmarked outbox event %d: %w", event.ID, deferErr))
			}
			continue
		}
	}
	return nil
}

func (h *Host) deferRuntimeOperationEventPublish(ctx context.Context, event storesqlite.RuntimeOperationEvent) error {
	now := h.now()
	attempt := int(event.PublishAttempt) + 1
	returnDeferAt := runtimeOperationEventNextAttemptAt(now, attempt)
	_, err := h.operations.DeferRuntimeOperationEventPublish(ctx, storesqlite.DeferRuntimeOperationEventPublishInput{
		WorkspaceID: event.WorkspaceID, EventID: event.ID, NowUnixMS: now.UnixMilli(),
		NextAttemptAtMS: returnDeferAt, ReasonCode: "publish_failed",
	})
	return err
}

func runtimeOperationEventNextAttemptAt(now time.Time, attempt int) int64 {
	if attempt < 1 {
		attempt = 1
	}
	shift := attempt - 1
	if shift > 8 {
		shift = 8
	}
	return now.Add(time.Second * time.Duration(1<<shift)).UnixMilli()
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
