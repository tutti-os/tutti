package agentruntime

import (
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// storeTurnSession commits a mid-turn lifecycle snapshot produced by a turn
// execution goroutine through the unified commit boundary. The controller's
// current session is the only accepted state, so a concurrent user mutation
// (SetTitle/SetVisible/UpdateSettings) is never overwritten by the stale exec
// copy. It returns the accepted session; callers must publish and report with
// that value, never the exec-path snapshot.
func (c *Controller) storeTurnSession(session Session, turnID string) (Session, bool) {
	if c == nil {
		return Session{}, false
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.commitTurnExecSessionLocked(key, turnID, session, false)
}

// finishTurn settles the turn owned by an execution goroutine through the
// unified commit boundary and returns the accepted session. Like
// storeTurnSession it merges only turn-execution-owned fields, so settlement
// never reverts a concurrent user title, visibility, or settings change.
func (c *Controller) finishTurn(session Session, turnID string) (Session, bool) {
	if c == nil {
		return Session{}, false
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	needsFallback := session.LifecycleAuthority &&
		lifecycleStillActiveForTurn(session.TurnLifecycle, turnID)
	c.mu.Lock()
	accepted, ok := c.commitTurnExecSessionLocked(key, turnID, session, true)
	c.mu.Unlock()
	if !ok {
		return Session{}, false
	}
	if needsFallback {
		c.applySessionEventsByAgentSessionID(accepted.AgentSessionID, settledFallbackTurnEvents(accepted, turnID))
	}
	return accepted, true
}

// lifecycleStillActiveForTurn reports that the exec-path lifecycle still marks
// the given turn live after Exec returned. For snapshot-authority sessions that
// means the adapter never settled the turn it owns (for example a submission
// absorbed by steering), so the controller publishes its own settled snapshot
// to reach reporter/GUI.
func lifecycleStillActiveForTurn(lifecycle *TurnLifecycle, turnID string) bool {
	if lifecycle == nil || lifecycle.ActiveTurnID == nil {
		return false
	}
	return strings.TrimSpace(*lifecycle.ActiveTurnID) == strings.TrimSpace(turnID) &&
		runtimeTurnLifecyclePhaseIsLive(lifecycle.Phase)
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
