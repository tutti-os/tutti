package agenthost

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// ReconcileGoalFromEvidence closes the runtime-to-durable loop for an
// unproven provider Goal turn. The reporter does not acknowledge the internal
// request until this returns. Reconciliation runs through the same per-session
// GoalActor as user controls and reconcileGoalLocked adds its own observation
// CAS fence around the provider query.
func (h *Host) ReconcileGoalFromEvidence(ctx context.Context, input GoalReconcileRequiredInput) error {
	if h == nil || strings.TrimSpace(input.WorkspaceID) == "" || strings.TrimSpace(input.AgentSessionID) == "" {
		return ErrInvalidArgument
	}
	return h.withSessionMutationActor(ctx, input.WorkspaceID, input.AgentSessionID, func(actorCtx context.Context) error {
		return h.reconcileGoalFromEvidenceSerialized(actorCtx, input)
	})
}

func (h *Host) reconcileGoalFromEvidenceSerialized(ctx context.Context, input GoalReconcileRequiredInput) error {
	timeout := 2 * h.goalOperationAttemptTimeout()
	if timeout < 30*time.Second {
		timeout = 30 * time.Second
	}
	reconcileCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	err := h.withGoalActor(reconcileCtx, input.WorkspaceID, input.AgentSessionID, func(actorCtx context.Context) error {
		// A successful stale quiesce is harmless and may be dropped. A failed
		// quiesce means the provider turn can still mutate the thread, so it must
		// attach repair to whatever durable revision is current inside GoalActor.
		if input.QuiesceSucceeded {
			matches, fenceErr := h.goalReconcileEvidenceFenceMatches(actorCtx, input)
			if fenceErr != nil {
				return fenceErr
			}
			if matches {
				_, err := h.reconcileGoalLocked(actorCtx, input.WorkspaceID, input.AgentSessionID)
				return err
			}
			slog.Info("agent goal provenance reconcile evidence superseded",
				"event", "agent_session.goal.provenance_reconcile_superseded",
				"workspace_id", input.WorkspaceID,
				"agent_session_id", input.AgentSessionID,
				"request_id", input.RequestID,
				"expected_operation_id", input.ExpectedOperationID,
				"expected_revision", input.ExpectedRevision,
				"expected_repair_epoch", input.ExpectedRepairEpoch,
			)
			return nil
		}
		return h.attachGoalProvenanceQuiesceRepair(actorCtx, input)
	})
	if err != nil {
		slog.Warn("agent goal provenance reconcile failed",
			"event", "agent_session.goal.provenance_reconcile_failed",
			"workspace_id", input.WorkspaceID,
			"agent_session_id", input.AgentSessionID,
			"request_id", input.RequestID,
			"provider_turn_id", input.ProviderTurnID,
			"error", err.Error(),
		)
		return err
	}
	slog.Info("agent goal provenance reconcile completed",
		"event", "agent_session.goal.provenance_reconcile_completed",
		"workspace_id", input.WorkspaceID,
		"agent_session_id", input.AgentSessionID,
		"request_id", input.RequestID,
		"provider_turn_id", input.ProviderTurnID,
	)
	return nil
}

func (h *Host) attachGoalProvenanceQuiesceRepair(ctx context.Context, input GoalReconcileRequiredInput) error {
	if h.goals == nil {
		return errors.New("goal quiesce failed and durable repair is unavailable")
	}
	state, found, err := h.goals.GetSessionGoalState(ctx, input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return err
	}
	if !found {
		return errors.New("goal quiesce failed and durable goal state is unavailable")
	}
	originOperationID := firstNonEmpty(strings.TrimSpace(input.ExpectedOperationID), strings.TrimSpace(state.PendingOperationID))
	originRevision := input.ExpectedRevision
	if originRevision <= 0 {
		originRevision = state.Revision
	}
	if originOperationID == "" {
		var valid bool
		originOperationID, originRevision, valid, err = h.goalRepairSourceFromLastEvidence(ctx, state)
		if err != nil {
			return err
		}
		if !valid {
			originOperationID = ""
		}
	}
	evidence := map[string]any{
		"source":            "codex_goal_turn_provenance",
		"confidence":        "unknown",
		"providerTurnId":    input.ProviderTurnID,
		"quiesceSucceeded":  false,
		"quiesceError":      input.QuiesceError,
		"repairEpoch":       input.ExpectedRepairEpoch,
		"originOperationId": originOperationID,
		"originRevision":    originRevision,
		"missingSource":     originOperationID == "",
	}
	if originOperationID != "" {
		if _, _, err = h.goals.RecordGoalControlOperationEvidence(ctx, storesqlite.GoalControlOperationEvidence{WorkspaceID: state.WorkspaceID, OperationID: originOperationID, ProviderPhase: storesqlite.GoalProviderPhaseUnknown, Evidence: evidence, OccurredAtUnixMS: h.goalOperationNow().UnixMilli()}); err != nil {
			return err
		}
	}
	return h.attachGoalProvenanceRequestRepairWithEvidence(ctx, state, input, evidence)
}

func (h *Host) attachGoalProvenanceRequestRepairWithEvidence(ctx context.Context, state storesqlite.SessionGoalState, input GoalReconcileRequiredInput, evidence map[string]any) error {
	requestID, providerTurnID := strings.TrimSpace(input.RequestID), strings.TrimSpace(input.ProviderTurnID)
	if requestID == "" || providerTurnID == "" {
		return h.markGoalProvenanceUnknown(ctx, state, input)
	}
	sourceID := "goal-provenance-incident:" + requestID + ":" + providerTurnID
	if evidence == nil {
		evidence = map[string]any{}
	}
	evidence["source"] = "codex_goal_turn_provenance"
	evidence["confidence"] = "unknown"
	evidence["providerTurnId"] = providerTurnID
	evidence["reconcileRequestId"] = requestID
	evidence["quiesceSucceeded"] = false
	evidence["quiesceError"] = input.QuiesceError
	_, _, _, err := h.goals.EnsureOrWakeGoalRepairOperation(ctx, storesqlite.EnsureGoalRepairOperationInput{
		WorkspaceID: state.WorkspaceID, AgentSessionID: state.AgentSessionID,
		SourceOperationID: sourceID, SourceRevision: state.Revision, CurrentRevision: state.Revision,
		Evidence:         evidence,
		OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
	})
	return err
}

func (h *Host) goalRepairSourceFromLastEvidence(ctx context.Context, state storesqlite.SessionGoalState) (string, int64, bool, error) {
	operationID := metadataString(state.LastEvidence, "operationId")
	revision := metadataInt64(state.LastEvidence, "revision")
	repairEpoch := metadataInt64(state.LastEvidence, "repairEpoch")
	if operationID == "" || revision <= 0 || revision != state.Revision {
		return "", 0, false, nil
	}
	operation, found, err := h.goals.GetGoalControlOperation(ctx, state.WorkspaceID, operationID)
	if err != nil {
		return "", 0, false, err
	}
	if !found || operation.WorkspaceID != state.WorkspaceID || operation.AgentSessionID != state.AgentSessionID ||
		operation.GoalRevision != revision || operation.RepairEpoch != repairEpoch ||
		operation.Status != storesqlite.GoalOperationStatusCompleted || operation.RepairRequired {
		return "", 0, false, nil
	}
	return operationID, revision, true, nil
}

func (h *Host) markGoalProvenanceUnknown(ctx context.Context, state storesqlite.SessionGoalState, input GoalReconcileRequiredInput) error {
	_, err := h.goals.ReconcileSessionGoalObservation(ctx, storesqlite.GoalObservationReconcile{
		WorkspaceID: state.WorkspaceID, AgentSessionID: state.AgentSessionID,
		Observed: clonePayload(state.Observed),
		Evidence: map[string]any{
			"source":           "codex_goal_turn_provenance",
			"confidence":       "unknown",
			"providerTurnId":   input.ProviderTurnID,
			"quiesceSucceeded": false,
			"quiesceError":     input.QuiesceError,
		},
		OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
		Expected: &storesqlite.GoalObservationFence{
			Exists: true, Revision: state.Revision, PendingOperationID: state.PendingOperationID,
			ObservedAtUnixMS: state.ObservedAtUnixMS,
		},
		ForceSyncUnknown: true,
	})
	return err
}

func (h *Host) goalReconcileEvidenceFenceMatches(ctx context.Context, input GoalReconcileRequiredInput) (bool, error) {
	if h.goals == nil {
		return true, nil
	}
	switch strings.TrimSpace(input.FenceMode) {
	case "current_durable":
		// Restarted adapters intentionally have no operation identity. The
		// reconcile path reads current durable state inside GoalActor and CASes
		// the observation after the provider query, so a concurrent new command
		// wins rather than being overwritten by this evidence.
		return strings.TrimSpace(input.ExpectedOperationID) == "" && input.ExpectedRevision == 0, nil
	case "operation":
		operationID := strings.TrimSpace(input.ExpectedOperationID)
		if operationID == "" || input.ExpectedRevision <= 0 {
			return false, nil
		}
		state, found, err := h.goals.GetSessionGoalState(ctx, input.WorkspaceID, input.AgentSessionID)
		if err != nil {
			return false, err
		}
		if !found || state.Revision != input.ExpectedRevision {
			return false, nil
		}
		operation, found, err := h.goals.GetGoalControlOperation(ctx, input.WorkspaceID, operationID)
		if err != nil {
			return false, err
		}
		if !found || operation.AgentSessionID != input.AgentSessionID ||
			operation.GoalRevision != input.ExpectedRevision || operation.RepairEpoch != input.ExpectedRepairEpoch {
			return false, nil
		}
		if pendingOperationID := strings.TrimSpace(state.PendingOperationID); pendingOperationID != "" {
			return pendingOperationID == operationID &&
				(operation.Status == storesqlite.GoalOperationStatusPrepared || operation.Status == storesqlite.GoalOperationStatusDispatched), nil
		}
		return operation.Status == storesqlite.GoalOperationStatusCompleted && !operation.RepairRequired, nil
	default:
		return false, nil
	}
}
