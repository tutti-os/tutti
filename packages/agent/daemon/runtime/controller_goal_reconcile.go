package agentruntime

import (
	"context"
	"fmt"
)

type GoalReconcileInput struct {
	RoomID         string
	AgentSessionID string
}

type GoalReconcileResult struct {
	AgentSessionID string
	Goal           map[string]any
	Evidence       map[string]any
	Capabilities   GoalAdapterCapabilities
}

func (c *Controller) GoalCapabilities(ctx context.Context, input GoalReconcileInput) (GoalAdapterCapabilities, error) {
	release, err := c.acquireLifecycleLockContext(ctx, input.RoomID, input.AgentSessionID)
	if err != nil {
		return GoalAdapterCapabilities{}, err
	}
	defer release()
	_, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return GoalAdapterCapabilities{}, err
	}
	goalAdapter, ok := adapter.(GoalAdapter)
	if !ok {
		return GoalAdapterCapabilities{}, fmt.Errorf("agent provider does not support goals")
	}
	return goalAdapter.GoalCapabilities(), nil
}

// ReconcileGoal queries or inspects the provider through the GoalAdapter and
// returns normalized evidence. It never mutates durable desired state and
// never creates a Turn.
func (c *Controller) ReconcileGoal(ctx context.Context, input GoalReconcileInput) (GoalReconcileResult, error) {
	releaseLifecycleLock, err := c.acquireLifecycleLockContext(ctx, input.RoomID, input.AgentSessionID)
	if err != nil {
		return GoalReconcileResult{}, err
	}
	defer releaseLifecycleLock()
	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return GoalReconcileResult{}, err
	}
	goalAdapter, ok := adapter.(GoalAdapter)
	if !ok {
		return GoalReconcileResult{}, fmt.Errorf("agent provider does not support goals")
	}
	if err := c.ensureLiveAdapterSession(ctx, session, adapter); err != nil {
		return GoalReconcileResult{}, err
	}
	result, err := goalAdapter.ReconcileGoal(ctx, session)
	if err != nil {
		return GoalReconcileResult{}, err
	}
	c.applySessionEventsByAgentSessionID(session.AgentSessionID, result.Events)
	return GoalReconcileResult{
		AgentSessionID: session.AgentSessionID,
		Goal:           goalAdapter.NormalizeGoalObservation(result.Observation),
		Evidence:       clonePayload(result.Evidence),
		Capabilities:   goalAdapter.GoalCapabilities(),
	}, nil
}
