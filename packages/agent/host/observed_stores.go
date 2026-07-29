package agenthost

import (
	"context"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type observedRuntimeOperationStore struct {
	RuntimeOperationStore
	host *Host
}

func (s *observedRuntimeOperationStore) PrepareRuntimeOperation(ctx context.Context, input storesqlite.RuntimeOperationPrepare) (storesqlite.RuntimeOperation, bool, error) {
	op, changed, err := s.RuntimeOperationStore.PrepareRuntimeOperation(ctx, input)
	if err == nil && changed {
		s.host.notifyCommitted(ctx, runtimeOperationDelta(RuntimeOperationPrepared, op, nil))
	}
	return op, changed, err
}

func (s *observedRuntimeOperationStore) PrepareInteractiveRuntimeOperation(
	ctx context.Context,
	input storesqlite.RuntimeOperationPrepare,
) (storesqlite.RuntimeOperation, storesqlite.Interaction, storesqlite.InteractionTransitionResult, error) {
	op, interaction, transition, err := s.RuntimeOperationStore.PrepareInteractiveRuntimeOperation(ctx, input)
	if err == nil && transition == storesqlite.InteractionTransitionApplied {
		s.host.notifyCommitted(ctx, runtimeOperationDelta(RuntimeOperationPrepared, op, nil))
	}
	return op, interaction, transition, err
}

func (s *observedRuntimeOperationStore) CheckpointRuntimeOperation(ctx context.Context, input storesqlite.CheckpointRuntimeOperationInput) (storesqlite.RuntimeOperation, bool, error) {
	op, changed, err := s.RuntimeOperationStore.CheckpointRuntimeOperation(ctx, input)
	if err == nil && changed {
		s.host.notifyCommitted(ctx, runtimeOperationDelta(RuntimeOperationCheckpoint, op, nil))
	}
	return op, changed, err
}

func (s *observedRuntimeOperationStore) ReleaseOrFailRuntimeOperation(ctx context.Context, input storesqlite.ReleaseOrFailRuntimeOperationInput) (storesqlite.RuntimeOperation, bool, error) {
	op, changed, err := s.RuntimeOperationStore.ReleaseOrFailRuntimeOperation(ctx, input)
	if err == nil && changed {
		stage := RuntimeOperationReleased
		if input.Fail {
			stage = RuntimeOperationFailed
		}
		s.host.notifyCommitted(ctx, runtimeOperationDelta(stage, op, nil))
	}
	return op, changed, err
}

func (s *observedRuntimeOperationStore) CompleteInteractiveRuntimeOperation(ctx context.Context, input storesqlite.CompleteInteractiveRuntimeOperationInput) (storesqlite.RuntimeOperationCompletion, bool, error) {
	completion, changed, err := s.RuntimeOperationStore.CompleteInteractiveRuntimeOperation(ctx, input)
	s.observeCompletion(ctx, completion, changed, err)
	return completion, changed, err
}

func (s *observedRuntimeOperationStore) CompleteCancelRuntimeOperation(ctx context.Context, input storesqlite.CompleteCancelRuntimeOperationInput) (storesqlite.RuntimeOperationCompletion, bool, error) {
	completion, changed, err := s.RuntimeOperationStore.CompleteCancelRuntimeOperation(ctx, input)
	s.observeCompletion(ctx, completion, changed, err)
	return completion, changed, err
}

func (s *observedRuntimeOperationStore) CompletePlanDecisionRuntimeOperation(ctx context.Context, input storesqlite.CompletePlanDecisionRuntimeOperationInput) (storesqlite.RuntimeOperationCompletion, bool, error) {
	completion, changed, err := s.RuntimeOperationStore.CompletePlanDecisionRuntimeOperation(ctx, input)
	s.observeCompletion(ctx, completion, changed, err)
	return completion, changed, err
}

func (s *observedRuntimeOperationStore) observeCompletion(ctx context.Context, completion storesqlite.RuntimeOperationCompletion, changed bool, err error) {
	if err != nil || !changed {
		return
	}
	event := completion.Event
	delta := runtimeOperationDelta(RuntimeOperationCompleted, completion.Operation, &event)
	if event.Kind == storesqlite.RuntimeOperationEventTurnCanceled {
		delta.RootTurnsSettled = append(delta.RootTurnsSettled, s.settledRootTurns(ctx, completion)...)
	}
	s.host.notifyCommitted(ctx, delta)
}

func (s *observedRuntimeOperationStore) settledRootTurns(ctx context.Context, completion storesqlite.RuntimeOperationCompletion) []RootTurnSettled {
	if s.host == nil || s.host.store == nil {
		return nil
	}
	rootSessionID := metadataString(completion.Event.Payload, "rootAgentSessionId")
	candidates := make([]map[string]any, 0)
	if targets, ok := completion.Event.Payload["targets"].([]any); ok {
		for _, raw := range targets {
			candidate, _ := raw.(map[string]any)
			if metadataString(candidate, "agentSessionId") == rootSessionID {
				candidates = append(candidates, candidate)
			}
		}
	}
	if candidate, ok := completion.Event.Payload["reconciledRoot"].(map[string]any); ok {
		candidates = append(candidates, candidate)
	}
	seen := map[string]struct{}{}
	result := make([]RootTurnSettled, 0, len(candidates))
	for _, candidate := range candidates {
		sessionID, turnID := metadataString(candidate, "agentSessionId"), metadataString(candidate, "turnId")
		key := sessionID + "\x00" + turnID
		if sessionID == "" || turnID == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		turn, found, err := s.host.store.GetTurn(ctx, completion.Operation.WorkspaceID, sessionID, turnID)
		if err != nil || !found || turn.Phase != storesqlite.TurnPhaseSettled {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, RootTurnSettled{WorkspaceID: completion.Operation.WorkspaceID, AgentSessionID: sessionID, Turn: turn})
	}
	return result
}

type observedGoalStateStore struct {
	GoalStateStore
	host *Host
}

func (s *observedGoalStateStore) PrepareGoalControlOperation(ctx context.Context, input storesqlite.GoalControlOperationPrepare) (storesqlite.GoalControlOperation, storesqlite.SessionGoalState, bool, error) {
	op, state, changed, err := s.GoalStateStore.PrepareGoalControlOperation(ctx, input)
	if err == nil && changed {
		var audit *storesqlite.Message
		if value, found, readErr := s.GetGoalControlAudit(ctx, input.WorkspaceID, input.AgentSessionID, input.OperationID); readErr == nil && found {
			audit = &value
		}
		s.host.notifyCommitted(ctx, goalOperationDelta(GoalOperationPrepared, op, state, audit))
	}
	return op, state, changed, err
}

func (s *observedGoalStateStore) MarkGoalControlOperationDispatched(ctx context.Context, workspaceID, operationID string, occurredAt int64) (storesqlite.GoalControlOperation, bool, error) {
	op, changed, err := s.GoalStateStore.MarkGoalControlOperationDispatched(ctx, workspaceID, operationID, occurredAt)
	if err == nil && changed {
		s.host.notifyCommitted(ctx, goalOperationDelta(GoalOperationDispatched, op, storesqlite.SessionGoalState{}, nil))
	}
	return op, changed, err
}

func (s *observedGoalStateStore) AcknowledgeGoalControlOperation(ctx context.Context, input storesqlite.GoalControlOperationAcknowledge) (storesqlite.GoalControlOperation, storesqlite.SessionGoalState, bool, error) {
	op, state, changed, err := s.GoalStateStore.AcknowledgeGoalControlOperation(ctx, input)
	if err == nil && changed {
		s.host.notifyCommitted(ctx, goalOperationDelta(GoalOperationAcknowledged, op, state, nil))
	}
	return op, state, changed, err
}

func (s *observedGoalStateStore) CompleteGoalControlOperation(ctx context.Context, input storesqlite.GoalControlOperationComplete) (storesqlite.GoalControlOperation, storesqlite.SessionGoalState, bool, error) {
	op, state, changed, err := s.GoalStateStore.CompleteGoalControlOperation(ctx, input)
	if err == nil && changed {
		s.host.notifyCommitted(ctx, goalOperationDelta(GoalOperationCompleted, op, state, nil))
	}
	return op, state, changed, err
}

func (s *observedGoalStateStore) ReleaseGoalControlOperation(ctx context.Context, input storesqlite.ReleaseGoalControlOperationInput) (storesqlite.GoalControlOperation, bool, error) {
	op, changed, err := s.GoalStateStore.ReleaseGoalControlOperation(ctx, input)
	if err == nil && changed {
		stage := GoalOperationReleased
		if input.Fail {
			stage = GoalOperationFailed
		}
		s.host.notifyCommitted(ctx, goalOperationDelta(stage, op, storesqlite.SessionGoalState{}, nil))
	}
	return op, changed, err
}

func (s *observedGoalStateStore) RecordGoalControlOperationEvidence(ctx context.Context, input storesqlite.GoalControlOperationEvidence) (storesqlite.GoalControlOperation, bool, error) {
	op, changed, err := s.GoalStateStore.RecordGoalControlOperationEvidence(ctx, input)
	if err == nil && changed {
		s.host.notifyCommitted(ctx, goalOperationDelta(GoalOperationEvidence, op, storesqlite.SessionGoalState{}, nil))
	}
	return op, changed, err
}

func (s *observedGoalStateStore) ReconcileSessionGoalObservation(ctx context.Context, input storesqlite.GoalObservationReconcile) (storesqlite.SessionGoalState, error) {
	state, err := s.GoalStateStore.ReconcileSessionGoalObservation(ctx, input)
	if err == nil && state.CommitTransactionID != "" {
		s.host.notifyCommitted(ctx, goalOperationDelta(GoalOperationReconciled, storesqlite.GoalControlOperation{}, state, nil))
	}
	return state, err
}

func (s *observedGoalStateStore) EnsureOrWakeGoalRepairOperation(ctx context.Context, input storesqlite.EnsureGoalRepairOperationInput) (storesqlite.GoalControlOperation, storesqlite.SessionGoalState, bool, error) {
	op, state, changed, err := s.GoalStateStore.EnsureOrWakeGoalRepairOperation(ctx, input)
	if err == nil && (op.CommitTransactionID != "" || state.CommitTransactionID != "") {
		stage := GoalOperationRepairPrepared
		if goalCommitContainsOperation(op, state, "terminal") {
			stage = GoalOperationTerminal
		}
		s.host.notifyCommitted(ctx, goalOperationDelta(stage, op, state, nil))
	}
	return op, state, changed, err
}

func goalCommitContainsOperation(op storesqlite.GoalControlOperation, state storesqlite.SessionGoalState, operation string) bool {
	for _, delta := range []storesqlite.TransactionDelta{op.CommitDelta, state.CommitDelta} {
		for _, mutation := range delta.Mutations {
			if mutation.Operation == operation {
				return true
			}
		}
	}
	return false
}

func (s *observedGoalStateStore) MarkGoalRevisionTerminalIncident(ctx context.Context, input storesqlite.GoalTerminalIncidentInput) (storesqlite.SessionGoalState, error) {
	state, err := s.GoalStateStore.MarkGoalRevisionTerminalIncident(ctx, input)
	if err == nil && state.CommitTransactionID != "" {
		s.host.notifyCommitted(ctx, goalOperationDelta(GoalOperationTerminal, storesqlite.GoalControlOperation{}, state, nil))
	}
	return state, err
}
