package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
)

type GoalGenerationFenceRequest struct {
	RoomID         string
	AgentSessionID string
	OperationID    string
	Revision       int64
	RepairEpoch    int64
	Reason         string
	RequireLive    bool
}

type controllerGoalGenerationFenceRegistry struct {
	fences         map[goalOperationIdentity]GoalGenerationFenceInput
	version        uint64
	appliedVersion uint64
	appliedLive    bool
}

// FenceGoalGeneration retains the exact admission rule at Controller scope as
// well as installing it into the current adapter connection. Idle provider
// release discards adapter memory, but not this registry; the next connection
// must reinstall the registry before it accepts a user operation.
func (c *Controller) FenceGoalGeneration(ctx context.Context, input GoalGenerationFenceRequest) error {
	releaseLifecycleLock, err := c.acquireLifecycleLockContext(ctx, input.RoomID, input.AgentSessionID)
	if err != nil {
		return err
	}
	defer releaseLifecycleLock()
	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return err
	}
	if _, ok := adapter.(GoalGenerationFencer); !ok {
		return fmt.Errorf("agent provider does not support Goal generation fencing")
	}
	fence, err := normalizeGoalGenerationFenceInput(input)
	if err != nil {
		return err
	}
	c.retainGoalGenerationFence(session, fence)
	if input.RequireLive {
		if probe, ok := adapter.(LiveSessionProbeAdapter); ok && !probe.HasLiveSession(session) {
			return ErrSessionDisconnected
		}
	} else if err := c.ensureLiveAdapterSession(ctx, session, adapter); err != nil {
		return err
	}
	return c.applyRetainedGoalGenerationFencesOrClose(ctx, session, adapter)
}

func normalizeGoalGenerationFenceInput(input GoalGenerationFenceRequest) (GoalGenerationFenceInput, error) {
	fence := GoalGenerationFenceInput{
		OperationID: strings.TrimSpace(input.OperationID),
		Revision:    input.Revision,
		RepairEpoch: input.RepairEpoch,
		Reason:      strings.TrimSpace(input.Reason),
	}
	identity := goalOperationIdentity{
		operationID: fence.OperationID,
		revision:    fence.Revision,
		repairEpoch: fence.RepairEpoch,
	}
	if !identity.valid() {
		return GoalGenerationFenceInput{}, errors.New("valid Goal generation fence identity is required")
	}
	return fence, nil
}

func (c *Controller) retainGoalGenerationFence(session Session, fence GoalGenerationFenceInput) {
	key := sessionKey(session.RoomID, session.AgentSessionID)
	identity := goalOperationIdentity{
		operationID: fence.OperationID,
		revision:    fence.Revision,
		repairEpoch: fence.RepairEpoch,
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.goalGenerationFences == nil {
		c.goalGenerationFences = make(map[string]*controllerGoalGenerationFenceRegistry)
	}
	registry := c.goalGenerationFences[key]
	if registry == nil {
		registry = &controllerGoalGenerationFenceRegistry{
			fences: make(map[goalOperationIdentity]GoalGenerationFenceInput),
		}
		c.goalGenerationFences[key] = registry
	}
	if existing, found := registry.fences[identity]; found && existing.Reason == fence.Reason {
		return
	}
	registry.fences[identity] = fence
	registry.version++
}

func (c *Controller) applyRetainedGoalGenerationFences(ctx context.Context, session Session, adapter Adapter) error {
	fencer, ok := adapter.(GoalGenerationFencer)
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	registry := c.goalGenerationFences[key]
	if registry == nil || len(registry.fences) == 0 {
		c.mu.Unlock()
		return nil
	}
	if !ok {
		c.mu.Unlock()
		return fmt.Errorf("agent provider does not support Goal generation fencing")
	}
	if registry.appliedLive && registry.appliedVersion == registry.version {
		c.mu.Unlock()
		return nil
	}
	version := registry.version
	fences := make([]GoalGenerationFenceInput, 0, len(registry.fences))
	for _, fence := range registry.fences {
		fences = append(fences, fence)
	}
	c.mu.Unlock()
	sort.Slice(fences, func(left, right int) bool {
		if fences[left].Revision != fences[right].Revision {
			return fences[left].Revision < fences[right].Revision
		}
		if fences[left].RepairEpoch != fences[right].RepairEpoch {
			return fences[left].RepairEpoch < fences[right].RepairEpoch
		}
		return fences[left].OperationID < fences[right].OperationID
	})

	for _, fence := range fences {
		if err := fencer.FenceGoalGeneration(ctx, session, fence); err != nil {
			return err
		}
	}
	c.mu.Lock()
	if current := c.goalGenerationFences[key]; current != nil && current.version == version {
		current.appliedVersion = version
		current.appliedLive = true
	}
	c.mu.Unlock()
	return nil
}

func (c *Controller) applyRetainedGoalGenerationFencesOrClose(
	ctx context.Context,
	session Session,
	adapter Adapter,
) error {
	if err := c.applyRetainedGoalGenerationFences(ctx, session, adapter); err != nil {
		c.invalidateAppliedGoalGenerationFences(session)
		return errors.Join(err, adapter.Close(context.WithoutCancel(ctx), session))
	}
	return nil
}

func (c *Controller) invalidateAppliedGoalGenerationFences(session Session) {
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	if registry := c.goalGenerationFences[key]; registry != nil {
		registry.appliedLive = false
	}
	c.mu.Unlock()
}

func (c *Controller) deleteRetainedGoalGenerationFences(roomID, agentSessionID string) {
	key := sessionKey(roomID, agentSessionID)
	c.mu.Lock()
	delete(c.goalGenerationFences, key)
	c.mu.Unlock()
}
