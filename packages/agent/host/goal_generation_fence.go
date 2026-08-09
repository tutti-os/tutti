package agenthost

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

const (
	goalGenerationFenceLeaseDuration = 2 * time.Minute
	goalGenerationFenceClearPrefix   = "goal-generation-fence:"
)

func goalGenerationFenceID(workspaceID, agentSessionID, targetOperationID, clientSubmitID string) string {
	stable := strings.TrimSpace(clientSubmitID)
	if stable == "" {
		stable = strings.TrimSpace(targetOperationID)
	}
	name := strings.Join([]string{
		strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID), stable,
	}, "\x00")
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("goal-generation-fence\x00"+name)).String()
}

// FindGoalControlOperationByClientSubmitID resolves the Host-owned operation
// identity after an accept-before-response crash without exposing or
// duplicating the deterministic ID algorithm in consumers.
func (h *Host) FindGoalControlOperationByClientSubmitID(
	ctx context.Context,
	ref SessionRef,
	clientSubmitID string,
) (storesqlite.GoalControlOperation, bool, error) {
	ref.WorkspaceID = strings.TrimSpace(ref.WorkspaceID)
	ref.AgentSessionID = strings.TrimSpace(ref.AgentSessionID)
	clientSubmitID = strings.TrimSpace(clientSubmitID)
	if h == nil || h.goals == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" || clientSubmitID == "" {
		return storesqlite.GoalControlOperation{}, false, ErrInvalidArgument
	}
	operationID := goalControlOperationID(ref.WorkspaceID, ref.AgentSessionID, clientSubmitID)
	operation, found, err := h.goals.GetGoalControlOperation(ctx, ref.WorkspaceID, operationID)
	if err != nil || !found {
		return operation, found, err
	}
	if operation.AgentSessionID != ref.AgentSessionID || operation.ClientSubmitID != clientSubmitID {
		return storesqlite.GoalControlOperation{}, false, storesqlite.ErrGoalOperationConflict
	}
	return operation, true, nil
}

// FenceGoalGeneration durably revokes one exact Goal operation generation.
// IntentAccepted means Host owns every remaining retry; it does not claim that
// provider quiescence or canonical settlement already completed.
func (h *Host) FenceGoalGeneration(ctx context.Context, input FenceGoalGenerationInput) (FenceGoalGenerationResult, error) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.TargetOperationID = strings.TrimSpace(input.TargetOperationID)
	input.ClientSubmitID = strings.TrimSpace(input.ClientSubmitID)
	input.Reason = strings.TrimSpace(input.Reason)
	if h == nil || h.goals == nil || h.goalFences == nil || input.WorkspaceID == "" || input.AgentSessionID == "" ||
		input.TargetOperationID == "" || input.ClientSubmitID == "" {
		return FenceGoalGenerationResult{}, ErrInvalidArgument
	}
	if _, ok := h.runtime.(RuntimeSessionLiveness); !ok {
		return FenceGoalGenerationResult{}, ErrRuntimeSessionLivenessUnavailable
	}
	fence, _, err := h.goalFences.PrepareGoalGenerationFence(ctx, storesqlite.GoalGenerationFencePrepare{
		FenceID:     goalGenerationFenceID(input.WorkspaceID, input.AgentSessionID, input.TargetOperationID, input.ClientSubmitID),
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		TargetOperationID: input.TargetOperationID, ClientSubmitID: input.ClientSubmitID,
		Reason: input.Reason, OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
	})
	if err != nil {
		return FenceGoalGenerationResult{}, err
	}
	result := FenceGoalGenerationResult{
		Fence: fence, IntentAccepted: true,
		Settled: fence.Status == storesqlite.GoalGenerationFenceStatusCompleted,
	}
	if result.Settled {
		return result, nil
	}
	processed, processErr := h.processGoalGenerationFenceSerialized(ctx, fence, false)
	if processed.FenceID != "" {
		result.Fence = processed
		result.Settled = processed.Status == storesqlite.GoalGenerationFenceStatusCompleted
	}
	return result, processErr
}

func (h *Host) StepGoalGenerationFenceWorker(ctx context.Context) error {
	return h.stepGoalGenerationFenceWorker(ctx, false)
}

func (h *Host) stepGoalGenerationFenceWorker(ctx context.Context, recovering bool) error {
	if h == nil || h.goalFences == nil {
		return nil
	}
	fences, err := h.goalFences.ListClaimableGoalGenerationFences(ctx, storesqlite.ListClaimableGoalGenerationFencesInput{
		NowUnixMS: h.goalOperationNow().UnixMilli(), Limit: goalOperationBatchSize,
	})
	if err != nil {
		return err
	}
	var errs []error
	for _, fence := range fences {
		if ctx.Err() != nil {
			break
		}
		if _, processErr := h.processGoalGenerationFenceSerialized(ctx, fence, recovering); processErr != nil &&
			!errors.Is(processErr, ErrRuntimeOperationInProgress) {
			errs = append(errs, fmt.Errorf("process goal generation fence %s: %w", fence.FenceID, processErr))
		}
	}
	return errors.Join(errs...)
}

func (h *Host) processGoalGenerationFenceSerialized(
	ctx context.Context,
	fence storesqlite.GoalGenerationFence,
	recovering bool,
) (storesqlite.GoalGenerationFence, error) {
	var result storesqlite.GoalGenerationFence
	err := h.withSessionMutationActor(ctx, fence.WorkspaceID, fence.AgentSessionID, func(commandCtx context.Context) error {
		return h.withGoalActor(commandCtx, fence.WorkspaceID, fence.AgentSessionID, func(actorCtx context.Context) error {
			var processErr error
			result, processErr = h.processGoalGenerationFence(actorCtx, fence, recovering)
			return processErr
		})
	})
	return result, err
}

func (h *Host) processGoalGenerationFence(
	ctx context.Context,
	candidate storesqlite.GoalGenerationFence,
	recovering bool,
) (storesqlite.GoalGenerationFence, error) {
	clearOperationID, err := h.ensureGoalGenerationFenceClear(ctx, candidate)
	if err != nil {
		return candidate, err
	}
	now := h.goalOperationNow()
	fence, claimed, err := h.goalFences.ClaimGoalGenerationFence(ctx, storesqlite.ClaimGoalGenerationFenceInput{
		FenceID: candidate.FenceID, LeaseOwner: h.goalOperationOwner(),
		NowUnixMS: now.UnixMilli(), LeaseExpiresAtMS: now.Add(goalGenerationFenceLeaseDuration).UnixMilli(),
	})
	if err != nil || !claimed {
		if err != nil {
			return candidate, err
		}
		return candidate, ErrRuntimeOperationInProgress
	}
	if clearOperationID == "" {
		clearOperationID = strings.TrimSpace(fence.ClearOperationID)
	}
	retry := func(cause error) (storesqlite.GoalGenerationFence, error) {
		retryNow := h.goalOperationNow()
		released, _, releaseErr := h.goalFences.ReleaseGoalGenerationFence(ctx, storesqlite.ReleaseGoalGenerationFenceInput{
			FenceID: fence.FenceID, LeaseOwner: h.goalOperationOwner(), LastError: cause.Error(),
			NowUnixMS: retryNow.UnixMilli(), NextAttemptAtMS: runtimeOperationNextAttemptAt(retryNow, fence.Attempt, false),
			ClearOperationID: clearOperationID,
		})
		return released, errors.Join(cause, releaseErr)
	}
	deferPending := func(reason string) (storesqlite.GoalGenerationFence, error) {
		retryNow := h.goalOperationNow()
		released, _, releaseErr := h.goalFences.ReleaseGoalGenerationFence(ctx, storesqlite.ReleaseGoalGenerationFenceInput{
			FenceID: fence.FenceID, LeaseOwner: h.goalOperationOwner(), LastError: reason,
			NowUnixMS: retryNow.UnixMilli(), NextAttemptAtMS: runtimeOperationNextAttemptAt(retryNow, fence.Attempt, false),
			ClearOperationID: clearOperationID,
		})
		return released, releaseErr
	}
	completeLocally := func() (storesqlite.GoalGenerationFence, error) {
		if err := h.completeGoalGenerationFenceClearLocally(ctx, fence, clearOperationID); err != nil {
			return retry(err)
		}
		return h.completeClaimedGoalGenerationFence(ctx, fence, clearOperationID)
	}

	// Startup recovery has no local provider process to quiesce. The durable
	// conditional clear above is the restart-time source of truth, so finish it
	// locally instead of reconnecting a provider merely to stop work that is no
	// longer running.
	if recovering && !h.runtimeSessionLive(fence.WorkspaceID, fence.AgentSessionID) {
		return completeLocally()
	}

	if err = h.applyGoalGenerationFence(ctx, fence); err != nil {
		if recovering && !h.runtimeSessionLive(fence.WorkspaceID, fence.AgentSessionID) &&
			(errors.Is(err, ErrRuntimeSessionDisconnected) || errors.Is(err, ErrSessionNotFound)) {
			return completeLocally()
		}
		if errors.Is(err, ErrRuntimeSessionDisconnected) {
			return deferPending("waiting for a live provider session")
		}
		return retry(err)
	}
	turnSettled, err := h.cancelActiveTurnForGoalFence(ctx, fence)
	if err != nil {
		if recovering && !h.runtimeSessionLive(fence.WorkspaceID, fence.AgentSessionID) &&
			(errors.Is(err, ErrRuntimeSessionDisconnected) || errors.Is(err, ErrSessionNotFound)) {
			return completeLocally()
		}
		return retry(err)
	}
	if !turnSettled {
		if recovering && !h.runtimeSessionLive(fence.WorkspaceID, fence.AgentSessionID) {
			return completeLocally()
		}
		return deferPending("waiting for the exact fenced Turn to settle")
	}
	if clearOperationID != "" {
		clearOperation, found, clearErr := h.goals.GetGoalControlOperation(ctx, fence.WorkspaceID, clearOperationID)
		if clearErr != nil {
			return retry(clearErr)
		}
		if !found {
			return retry(errors.New("goal generation fence clear operation is missing"))
		}
		switch clearOperation.Status {
		case storesqlite.GoalOperationStatusCompleted, storesqlite.GoalOperationStatusSuperseded:
		case storesqlite.GoalOperationStatusFailed:
			return retry(fmt.Errorf("goal generation fence clear failed: %s", strings.TrimSpace(clearOperation.LastError)))
		default:
			if recoverErr := h.recoverGoalOperation(ctx, clearOperation, false); recoverErr != nil &&
				!errors.Is(recoverErr, ErrRuntimeOperationInProgress) {
				return retry(recoverErr)
			}
			clearOperation, found, clearErr = h.goals.GetGoalControlOperation(ctx, fence.WorkspaceID, clearOperationID)
			if clearErr != nil {
				return retry(clearErr)
			}
			if !found || (clearOperation.Status != storesqlite.GoalOperationStatusCompleted &&
				clearOperation.Status != storesqlite.GoalOperationStatusSuperseded) {
				return deferPending("waiting for the conditional Goal clear to settle")
			}
		}
	}
	return h.completeClaimedGoalGenerationFence(ctx, fence, clearOperationID)
}

func (h *Host) completeClaimedGoalGenerationFence(
	ctx context.Context,
	fence storesqlite.GoalGenerationFence,
	clearOperationID string,
) (storesqlite.GoalGenerationFence, error) {
	completed, changed, err := h.goalFences.CompleteGoalGenerationFence(ctx, storesqlite.CompleteGoalGenerationFenceInput{
		FenceID: fence.FenceID, LeaseOwner: h.goalOperationOwner(),
		ClearOperationID: clearOperationID, OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
	})
	if err != nil || changed {
		return completed, err
	}
	current, found, readErr := h.goalFences.GetGoalGenerationFence(ctx, fence.WorkspaceID, fence.FenceID)
	if readErr != nil {
		return current, readErr
	}
	if found && current.Status == storesqlite.GoalGenerationFenceStatusCompleted {
		return current, nil
	}
	return current, ErrRuntimeOperationInProgress
}

func (h *Host) completeGoalGenerationFenceClearLocally(
	ctx context.Context,
	fence storesqlite.GoalGenerationFence,
	clearOperationID string,
) error {
	if clearOperationID == "" {
		return nil
	}
	clearOperation, found, err := h.goals.GetGoalControlOperation(ctx, fence.WorkspaceID, clearOperationID)
	if err != nil {
		return err
	}
	if !found {
		return errors.New("goal generation fence clear operation is missing")
	}
	if clearOperation.Status == storesqlite.GoalOperationStatusCompleted ||
		clearOperation.Status == storesqlite.GoalOperationStatusSuperseded {
		return nil
	}
	completed, _, _, err := h.goals.CompleteGoalControlOperation(ctx, storesqlite.GoalControlOperationComplete{
		WorkspaceID: fence.WorkspaceID, OperationID: clearOperation.OperationID,
		Mode: storesqlite.GoalControlCompletionModeLocalStop, Succeeded: true,
		Evidence: map[string]any{
			"source":            "goal_generation_fence_recovery",
			"fenceId":           fence.FenceID,
			"targetOperationId": fence.TargetOperationID,
			"reason":            fence.Reason,
		},
		OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
	})
	if err != nil {
		return err
	}
	if completed.Status != storesqlite.GoalOperationStatusCompleted &&
		completed.Status != storesqlite.GoalOperationStatusSuperseded {
		return errors.New("goal generation fence clear did not complete locally")
	}
	return nil
}

func (h *Host) ensureGoalGenerationFenceClear(
	ctx context.Context,
	fence storesqlite.GoalGenerationFence,
) (string, error) {
	if strings.TrimSpace(fence.ClearOperationID) != "" {
		return strings.TrimSpace(fence.ClearOperationID), nil
	}
	clearClientSubmitID := goalGenerationFenceClearPrefix + fence.FenceID
	clearOperationID := goalControlOperationID(fence.WorkspaceID, fence.AgentSessionID, clearClientSubmitID)
	operation, _, _, err := h.goals.PrepareGoalControlOperation(ctx, storesqlite.GoalControlOperationPrepare{
		OperationID: clearOperationID, WorkspaceID: fence.WorkspaceID, AgentSessionID: fence.AgentSessionID,
		Action: "clear", ClientSubmitID: clearClientSubmitID, ExpectedRevision: fence.TargetRevision,
		OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
	})
	if errors.Is(err, storesqlite.ErrGoalGenerationSuperseded) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return operation.OperationID, nil
}

func goalGenerationFenceClearOperation(operation storesqlite.GoalControlOperation) bool {
	return strings.HasPrefix(strings.TrimSpace(operation.ClientSubmitID), goalGenerationFenceClearPrefix)
}

func (h *Host) runtimeSessionLive(workspaceID, agentSessionID string) bool {
	if h == nil || h.runtime == nil {
		return false
	}
	if liveness, ok := h.runtime.(RuntimeSessionLiveness); ok {
		return liveness.RuntimeSessionLive(strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID))
	}
	return false
}

func (h *Host) cancelActiveTurnForGoalFence(ctx context.Context, fence storesqlite.GoalGenerationFence) (bool, error) {
	session, found, err := h.store.GetSession(ctx, fence.WorkspaceID, fence.AgentSessionID)
	if err != nil || !found || strings.TrimSpace(session.ActiveTurnID) == "" {
		return err == nil, err
	}
	turn, found, err := h.store.GetTurn(ctx, fence.WorkspaceID, fence.AgentSessionID, session.ActiveTurnID)
	if err != nil || !found || strings.TrimSpace(turn.SourceGoalOperationID) != fence.TargetOperationID ||
		turn.SourceGoalRevision != fence.TargetRevision || turn.SourceGoalRepairEpoch != fence.TargetRepairEpoch {
		return err == nil, err
	}
	result, cancelErr := h.CancelTurn(ctx, CancelTurnInput{
		WorkspaceID: fence.WorkspaceID, AgentSessionID: fence.AgentSessionID,
		TurnID: turn.TurnID, Reason: fence.Reason, RequireLive: true,
	})
	if result.Settled {
		return true, nil
	}
	if result.IntentAccepted {
		return false, nil
	}
	if errors.Is(cancelErr, ErrRuntimeSessionDisconnected) {
		return false, nil
	}
	return false, cancelErr
}

func (h *Host) restoreGoalGenerationFences(ctx context.Context, ref SessionRef) error {
	if h == nil || h.goalFences == nil {
		return nil
	}
	fencer, ok := h.goalRuntime.(GoalRuntimeGenerationFencer)
	if !ok {
		return ErrGoalGenerationFenceUnavailable
	}
	fences, err := h.listRuntimeGoalGenerationFences(ctx, ref)
	if err != nil {
		return err
	}
	for _, fence := range fences {
		if err := fencer.FenceGoalGeneration(ctx, fence); err != nil {
			return err
		}
	}
	return nil
}

func (h *Host) listRuntimeGoalGenerationFences(
	ctx context.Context,
	ref SessionRef,
) ([]RuntimeGoalGenerationFenceInput, error) {
	if h == nil || h.goalFences == nil {
		return nil, nil
	}
	fences, err := h.goalFences.ListGoalGenerationFencesForSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return nil, err
	}
	result := make([]RuntimeGoalGenerationFenceInput, 0, len(fences))
	for _, fence := range fences {
		result = append(result, runtimeGoalGenerationFenceInput(fence, false))
	}
	return result, nil
}

func (h *Host) restoreGoalGenerationFencesOnce(ctx context.Context, ref SessionRef) error {
	key := ref.WorkspaceID + "\x00" + ref.AgentSessionID
	if _, restored := h.goalFencesRestored.Load(key); restored {
		return nil
	}
	if err := h.restoreGoalGenerationFences(ctx, ref); err != nil {
		return err
	}
	h.goalFencesRestored.Store(key, struct{}{})
	return nil
}

func (h *Host) applyGoalGenerationFence(ctx context.Context, fence storesqlite.GoalGenerationFence) error {
	fencer, ok := h.goalRuntime.(GoalRuntimeGenerationFencer)
	if !ok {
		return ErrGoalGenerationFenceUnavailable
	}
	return applyGoalGenerationFenceWithRuntime(ctx, fencer, fence, true)
}

func applyGoalGenerationFenceWithRuntime(
	ctx context.Context,
	fencer GoalRuntimeGenerationFencer,
	fence storesqlite.GoalGenerationFence,
	requireLive bool,
) error {
	return fencer.FenceGoalGeneration(ctx, runtimeGoalGenerationFenceInput(fence, requireLive))
}

func runtimeGoalGenerationFenceInput(
	fence storesqlite.GoalGenerationFence,
	requireLive bool,
) RuntimeGoalGenerationFenceInput {
	return RuntimeGoalGenerationFenceInput{
		WorkspaceID: fence.WorkspaceID, AgentSessionID: fence.AgentSessionID,
		TargetOperationID: fence.TargetOperationID, TargetRevision: fence.TargetRevision,
		TargetRepairEpoch: fence.TargetRepairEpoch, Reason: fence.Reason, RequireLive: requireLive,
	}
}
