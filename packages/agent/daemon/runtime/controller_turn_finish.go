package agentruntime

import (
	"context"
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (c *Controller) finishTurn(session Session, turnID string) {
	if c == nil {
		return
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	if active, ok := c.turns[key]; ok && active.turnID == turnID {
		delete(c.turns, key)
	}
	if current, ok := c.sessions[key]; ok && sessionHasDifferentLiveTurn(current, turnID) {
		c.mu.Unlock()
		return
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
		return
	}
	session = settleFinishedTurnLifecycle(session, turnID)
	session = c.reconcileSessionStatusLocked(key, session)
	c.sessions[key] = session
	c.mu.Unlock()
}

// sessionViewHasUnsettledTurn reports whether the GUI-facing session view still
// presents an active or blocked turn. It is used to detect a desync where the
// runtime has already finished a turn but the persisted/streamed view never
// settled (composer stays blocked, stop button stays inert).
func sessionViewHasUnsettledTurn(session Session) bool {
	if sa := session.SubmitAvailability; sa != nil && strings.TrimSpace(sa.State) == "blocked" {
		return true
	}
	if tl := session.TurnLifecycle; tl != nil {
		if tl.ActiveTurnID != nil && strings.TrimSpace(*tl.ActiveTurnID) != "" {
			return true
		}
		if phase := strings.TrimSpace(tl.Phase); phase != "" && phase != "settled" {
			return true
		}
	}
	return false
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

// reconcileStuckTurnView force settles a session whose GUI-facing view still
// shows an active/blocked turn even though the runtime holds no active turn for
// it. It synthesizes a settle event and pushes it through the same atomic
// apply -> store -> publish -> report pipeline as every other reconciliation
// path (applySessionEventsByAgentSessionID), so:
//   - a snapshot-authority session (ADR 0008, session.LifecycleAuthority) is
//     settled via the same controller-origin stamped snapshot finishTurn's
//     fallback uses, honoring "copy, never merge" instead of hand-writing
//     TurnLifecycle directly; and
//   - the settle is applied to whatever session is CURRENT at the time of the
//     atomic read, not the possibly-stale snapshot captured earlier in Cancel
//     (a direct c.store of the stale snapshot could otherwise resurrect state
//     a concurrent event already moved past).
//
// Returns true when a reconciliation was performed.
func (c *Controller) reconcileStuckTurnView(_ context.Context, session Session, reason string) bool {
	if c == nil || !sessionViewHasUnsettledTurn(session) {
		return false
	}
	turnID := ""
	if tl := session.TurnLifecycle; tl != nil && tl.ActiveTurnID != nil {
		turnID = strings.TrimSpace(*tl.ActiveTurnID)
	}
	if turnID == "" {
		return false
	}
	var events []activityshared.Event
	if session.LifecycleAuthority {
		events = settledFallbackTurnEvents(session, turnID)
	} else {
		event := newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", map[string]any{
			"reconciled": "cancel-no-active-turn",
		})
		if event.Type != "" {
			events = []activityshared.Event{event}
		}
	}
	if len(events) == 0 {
		return false
	}
	c.applySessionEventsByAgentSessionID(session.AgentSessionID, events)
	slog.Info("agent session cancel reconciled stuck turn view",
		"event", "agent_session.cancel.reconciled_stuck_turn",
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider", session.Provider,
		"turn_id", turnID,
		"lifecycle_authority", session.LifecycleAuthority,
		"reason", reason,
	)
	return true
}
