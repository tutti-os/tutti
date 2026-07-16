package agentruntime

import (
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (c *Controller) storeTurnSession(session Session, turnID string) bool {
	if c == nil {
		return false
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	defer c.mu.Unlock()
	active, ok := c.turns[key]
	if !ok || strings.TrimSpace(active.turnID) != strings.TrimSpace(turnID) {
		return false
	}
	if _, ok := c.sessions[key]; !ok {
		return false
	}
	c.sessions[key] = session
	return true
}

func (c *Controller) finishTurn(session Session, turnID string) bool {
	if c == nil {
		return false
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	active, ok := c.turns[key]
	if !ok || strings.TrimSpace(active.turnID) != strings.TrimSpace(turnID) {
		c.mu.Unlock()
		return false
	}
	delete(c.turns, key)
	current, ok := c.sessions[key]
	if !ok {
		c.mu.Unlock()
		return false
	}
	if sessionHasDifferentLiveTurn(current, turnID) {
		c.mu.Unlock()
		return false
	}
	session = c.preserveCurrentSessionSettingsLocked(key, session)
	if session.LifecycleAuthority {
		// ADR 0008: no silent record mutation. If the adapter already settled
		// this turn via its snapshot, nothing is left to do; otherwise (steer
		// absorption, adapter death before settle) publish a controller-origin
		// settled snapshot so even the fallback flows through the single copy
		// pipeline — and reaches reporter/GUI, unlike the old silent write.
		needsFallback := session.TurnLifecycle != nil &&
			session.TurnLifecycle.ActiveTurnID != nil &&
			strings.TrimSpace(*session.TurnLifecycle.ActiveTurnID) == strings.TrimSpace(turnID) &&
			runtimeTurnLifecyclePhaseIsLive(session.TurnLifecycle.Phase)
		c.sessions[key] = session
		c.mu.Unlock()
		if needsFallback {
			c.applySessionEventsByAgentSessionID(session.AgentSessionID, settledFallbackTurnEvents(session, turnID))
		}
		return true
	}
	session = settleFinishedTurnLifecycle(session, turnID)
	session = c.reconcileSessionStatusLocked(key, session)
	c.sessions[key] = session
	c.mu.Unlock()
	return true
}

// settledFallbackTurnEvents builds the controller-origin settled snapshot the
// finishTurn fallback publishes when the adapter never settled the turn it
// owns (for example a submission absorbed by steering).
func settledFallbackTurnEvents(session Session, turnID string) []activityshared.Event {
	ctx, ok := activityEventContext(session, "turn-settled:"+turnID, turnID)
	if !ok {
		return nil
	}
	event := activityshared.NewTurnUpdated(ctx, turnID, activityshared.TurnPhaseIdle)
	activityshared.StampTurnLifecycleSnapshot(&event, activityshared.TurnLifecycleSnapshot{
		Origin:  activityshared.TurnLifecycleOriginController,
		Phase:   "settled",
		Outcome: string(activityshared.TurnOutcomeCompleted),
	})
	return []activityshared.Event{event}
}
