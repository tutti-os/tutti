package agentruntime

import (
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
)

type controllerGoalGenerationTransition struct {
	roomID           string
	agentSessionID   string
	operationID      string
	revision         int64
	repairEpoch      int64
	goal             map[string]any
	occurredAtUnixMS int64
}

func (c *Controller) applyGoalControlGeneration(
	session Session,
	observation GoalControlAppliedObservation,
) {
	if c == nil || !providerUsesHostGoalProjection(session.Provider) {
		return
	}
	operationID := strings.TrimSpace(observation.OperationID)
	if operationID == "" || observation.Revision <= 0 || observation.RepairEpoch < 0 {
		return
	}
	goal := clonePayload(observation.Observed)
	action := strings.TrimSpace(observation.Action)
	if action == "set" && !activeGoalRuntimeProjection(goal) {
		return
	}
	if action != "set" && action != "clear" {
		return
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	defer c.mu.Unlock()
	current, ok := c.sessions[key]
	if !ok || !providerUsesHostGoalProjection(current.Provider) {
		return
	}
	if generation := current.GoalGeneration; generation != nil {
		if generation.Revision > observation.Revision ||
			(generation.Revision == observation.Revision && generation.RepairEpoch > observation.RepairEpoch) ||
			(generation.Revision == observation.Revision && generation.RepairEpoch == observation.RepairEpoch &&
				strings.TrimSpace(generation.OperationID) != operationID) {
			return
		}
	}
	if action == "clear" {
		current.GoalGeneration = nil
	} else {
		activatedAt := observation.OccurredAtUnixMS
		if activatedAt <= 0 {
			activatedAt = unixMS(now())
		}
		current.GoalGeneration = &GoalRuntimeGeneration{
			OperationID:       operationID,
			Revision:          observation.Revision,
			RepairEpoch:       observation.RepairEpoch,
			ActivatedAtUnixMS: activatedAt,
			Goal:              goal,
		}
	}
	c.sessions[key] = current
}

func goalGenerationTransitionFromProviderObservations(
	session Session,
	requests []agentsessionstore.WorkspaceAgentGoalReconcileRequest,
) *controllerGoalGenerationTransition {
	if !providerUsesHostGoalProjection(session.Provider) {
		return nil
	}
	for index := len(requests) - 1; index >= 0; index-- {
		request := requests[index]
		if strings.TrimSpace(request.Phase) != "provider_observed" ||
			strings.TrimSpace(request.ExpectedOperationID) == "" ||
			request.ExpectedRevision <= 0 || request.ExpectedRepairEpoch < 0 {
			continue
		}
		return &controllerGoalGenerationTransition{
			roomID:           strings.TrimSpace(session.RoomID),
			agentSessionID:   strings.TrimSpace(session.AgentSessionID),
			operationID:      strings.TrimSpace(request.ExpectedOperationID),
			revision:         request.ExpectedRevision,
			repairEpoch:      request.ExpectedRepairEpoch,
			goal:             clonePayload(request.Observed),
			occurredAtUnixMS: request.OccurredAtUnixMS,
		}
	}
	return nil
}

func (c *Controller) applyGoalProviderGenerationTransition(
	transition *controllerGoalGenerationTransition,
) {
	if c == nil || transition == nil || transition.roomID == "" || transition.agentSessionID == "" {
		return
	}
	key := sessionKey(transition.roomID, transition.agentSessionID)
	c.mu.Lock()
	defer c.mu.Unlock()
	session, ok := c.sessions[key]
	if !ok || !providerUsesHostGoalProjection(session.Provider) || session.GoalGeneration == nil {
		return
	}
	generation := session.GoalGeneration
	if strings.TrimSpace(generation.OperationID) != transition.operationID ||
		generation.Revision != transition.revision || generation.RepairEpoch != transition.repairEpoch ||
		strings.TrimSpace(asString(generation.Goal["objective"])) != strings.TrimSpace(asString(transition.goal["objective"])) {
		return
	}
	if activeGoalRuntimeProjection(transition.goal) {
		generation.Goal = clonePayload(transition.goal)
		session.GoalGeneration = generation
	} else {
		session.GoalGeneration = nil
	}
	c.sessions[key] = session
}

func activeGoalRuntimeProjection(goal map[string]any) bool {
	return strings.TrimSpace(asString(goal["objective"])) != "" &&
		strings.TrimSpace(asString(goal["status"])) == "active"
}
