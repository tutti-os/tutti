package agenthost

import (
	"context"
	"errors"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func (h *Host) prepareRuntimeContextRecovery(
	ctx context.Context,
	ref SessionRef,
	session ProviderRuntimeSession,
	guidance bool,
) (ProviderRuntimeSession, error) {
	if guidance {
		return session, nil
	}
	recoveryRuntime, ok := h.runtime.(RuntimeContextRecoveryController)
	if !ok {
		return session, nil
	}
	input := RuntimeContextRecoveryInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
	}
	required, err := recoveryRuntime.ContextRecoveryRequired(ctx, input)
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	if !required {
		return session, nil
	}
	input.ActiveGoal, err = h.runtimeContextRecoveryGoal(ctx, ref)
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	recovery, err := recoveryRuntime.PrepareContextRecovery(
		ctx,
		input,
	)
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	if recovery.Recovered {
		return recovery.Session, nil
	}
	return session, nil
}

func (h *Host) runtimeContextRecoveryGoal(
	ctx context.Context,
	ref SessionRef,
) (*RuntimeContextRecoveryGoal, error) {
	if h == nil || h.goals == nil {
		return nil, nil
	}
	state, found, err := h.goals.GetSessionGoalState(
		ctx,
		strings.TrimSpace(ref.WorkspaceID),
		strings.TrimSpace(ref.AgentSessionID),
	)
	if err != nil || !found || state.Tombstoned ||
		metadataString(state.Observed, "status") != "active" {
		return nil, err
	}
	if state.SyncStatus != storesqlite.GoalSyncStatusSynced ||
		strings.TrimSpace(state.PendingOperationID) != "" {
		return nil, errors.New(
			"context recovery cannot preserve an unconverged canonical active Goal",
		)
	}
	objective := metadataString(state.Desired, "objective")
	if objective == "" || metadataString(state.Desired, "status") != "active" ||
		metadataString(state.Observed, "objective") != objective {
		return nil, errors.New(
			"context recovery cannot preserve a mismatched canonical active Goal",
		)
	}
	operations, ok := h.goals.(GoalRevisionOperationStore)
	if !ok {
		return nil, errors.New(
			"context recovery cannot resolve the canonical active Goal operation store",
		)
	}
	operation, found, err := operations.GetCompletedGoalControlOperationForRevision(
		ctx,
		state.WorkspaceID,
		state.AgentSessionID,
		state.Revision,
	)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, errors.New(
			"context recovery cannot preserve the canonical active Goal without its durable identity",
		)
	}
	if operation.GoalRevision != state.Revision ||
		operation.Action != "set" || strings.TrimSpace(operation.Objective) != objective {
		return nil, errors.New(
			"context recovery canonical active Goal operation does not match its durable generation",
		)
	}
	return &RuntimeContextRecoveryGoal{
		Objective: objective, OperationID: operation.OperationID,
		Revision: operation.GoalRevision, RepairEpoch: operation.RepairEpoch,
	}, nil
}

func (h *Host) prepareRuntimeResumeContextRecovery(
	ctx context.Context,
	ref SessionRef,
	input RuntimeResumeInput,
) (RuntimeResumeInput, error) {
	recoveryRuntime, ok := h.runtime.(RuntimeContextRecoveryController)
	if !ok {
		return input, nil
	}
	required, err := recoveryRuntime.ResumeContextRecoveryRequired(ctx, input)
	if err != nil || !required {
		return input, err
	}
	input.ContextRecoveryGoal, err = h.runtimeContextRecoveryGoal(ctx, ref)
	return input, err
}
