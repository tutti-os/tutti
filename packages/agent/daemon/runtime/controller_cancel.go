package agentruntime

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (c *Controller) Cancel(ctx context.Context, input CancelInput) (CancelResult, error) {
	releaseLifecycleLock := c.acquireLifecycleLock(input.RoomID, input.AgentSessionID)
	defer releaseLifecycleLock()

	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return CancelResult{}, err
	}
	reason := strings.TrimSpace(input.Reason)
	requestedTurnID := strings.TrimSpace(input.TurnID)
	slog.Info("agent session cancel requested",
		"event", "agent_session.cancel.requested",
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider", session.Provider,
		"status", session.Status,
		"reason", reason,
	)
	active, ok := c.activeTurn(session.RoomID, session.AgentSessionID)
	if requestedTurnID != "" && ok && active.turnID != requestedTurnID {
		slog.Info("agent session exact turn cancel found a different active turn",
			"event", "agent_session.cancel.turn_mismatch",
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider", session.Provider,
			"requested_turn_id", requestedTurnID,
			"active_turn_id", func() string {
				if ok {
					return active.turnID
				}
				return ""
			}(),
		)
		return CancelResult{AgentSessionID: session.AgentSessionID, Canceled: false}, nil
	}
	if !ok {
		// No controller turn record - but the runtime may own cancellable
		// work the registry does not know about (linked child agents that
		// outlive their parent turn, or a desynced turn record). Reconcile
		// with the adapter instead of skipping: the turn machine answers
		// no-op cancels safely, and anything it actually stopped surfaces
		// as events.
		events, err := adapter.Cancel(ctx, session, reason)
		if err != nil && errors.Is(err, ErrSessionNoActiveTurn) {
			// The adapter's way of answering "nothing was running" - the
			// reconcile found no runtime work either.
			err = nil
		}
		if err != nil {
			slog.Warn("agent session cancel adapter failed without active turn",
				"event", "agent_session.cancel.reconcile_failed",
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider", session.Provider,
				"reason", reason,
				"error", err.Error(),
			)
			return CancelResult{}, err
		}
		if len(events) > 0 {
			// Apply to the CURRENT stored session (atomic read-apply-store):
			// the turn may have settled and stored a newer session while
			// adapter.Cancel blocked; applying to this call's pre-cancel
			// snapshot would resurrect the working/running state and wedge
			// the GUI in a permanent spinner.
			c.applySessionEventsByAgentSessionID(session.AgentSessionID, events)
			slog.Info("agent session cancel reconciled runtime work without a turn record",
				"event", "agent_session.cancel.reconciled",
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider", session.Provider,
				"reason", reason,
				"event_count", len(events),
			)
			return CancelResult{AgentSessionID: session.AgentSessionID, Canceled: true}, nil
		}
		slog.Info("agent session cancel found nothing to stop",
			"event", "agent_session.cancel.nothing_to_stop",
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider", session.Provider,
			"status", session.Status,
			"reason", reason,
		)
		// The runtime holds no active turn, yet the GUI-facing view may still
		// show a blocked composer / running turn if a prior turn-completed
		// update failed to reach the persisted session state. Pressing stop is
		// the user's recovery gesture, so reconcile the stale view by force
		// settling the turn here instead of leaving it stuck forever.
		if requestedTurnID == "" {
			c.reconcileStuckTurnView(ctx, session, reason)
		}
		return CancelResult{
			AgentSessionID: session.AgentSessionID,
			Canceled:       false,
			TargetAbsent:   requestedTurnID != "",
		}, nil
	}
	if active.cancel != nil {
		active.cancel()
	}
	events, err := adapter.Cancel(ctx, session, reason)
	if err != nil {
		if errors.Is(err, ErrSessionNoActiveTurn) {
			c.clearActiveTurnIfMatches(session.RoomID, session.AgentSessionID, active.turnID)
			current, ok := c.get(session.RoomID, session.AgentSessionID)
			if !ok {
				current = session
			}
			reconciled := c.reconcileStuckTurnView(ctx, current, reason)
			canceled := sessionCancelAlreadySettledCanceled(current)
			slog.Info("agent session cancel raced with settled turn",
				"event", "agent_session.cancel.settle_race",
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider", session.Provider,
				"turn_id", active.turnID,
				"reason", reason,
				"reconciled", reconciled,
				"canceled", canceled,
			)
			return CancelResult{AgentSessionID: session.AgentSessionID, Canceled: canceled}, nil
		}
		slog.Warn("agent session cancel adapter failed",
			"event", "agent_session.cancel.adapter_failed",
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider", session.Provider,
			"turn_id", active.turnID,
			"reason", reason,
			"error", err.Error(),
		)
		return CancelResult{}, err
	}
	if len(events) > 0 {
		// interruptActiveTurn returns only after the turn actually settled,
		// so the turn's terminal store always lands during adapter.Cancel;
		// apply these events to the CURRENT stored session instead of this
		// call's pre-cancel snapshot (which would resurrect working state).
		c.applySessionEventsByAgentSessionID(session.AgentSessionID, events)
	}
	slog.Info("agent session cancel accepted",
		"event", "agent_session.cancel.accepted",
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider", session.Provider,
		"turn_id", active.turnID,
		"reason", reason,
	)
	return CancelResult{AgentSessionID: session.AgentSessionID, Canceled: true}, nil
}

func sessionCancelAlreadySettledCanceled(session Session) bool {
	if strings.TrimSpace(session.Status) == SessionStatusCanceled {
		return true
	}
	if session.TurnLifecycle != nil && session.TurnLifecycle.Outcome != nil {
		outcome := strings.ToLower(strings.TrimSpace(*session.TurnLifecycle.Outcome))
		return outcome == "canceled" || outcome == "cancelled" || outcome == string(activityshared.TurnOutcomeInterrupted)
	}
	return false
}

func (c *Controller) cancelActiveTurn(roomID, agentSessionID string) {
	if c == nil {
		return
	}
	key := sessionKey(strings.TrimSpace(roomID), strings.TrimSpace(agentSessionID))
	c.mu.Lock()
	active, ok := c.turns[key]
	c.mu.Unlock()
	if ok && active.cancel != nil {
		active.cancel()
	}
}

func (c *Controller) clearActiveTurnIfMatches(roomID, agentSessionID, turnID string) {
	if c == nil {
		return
	}
	key := sessionKey(strings.TrimSpace(roomID), strings.TrimSpace(agentSessionID))
	turnID = strings.TrimSpace(turnID)
	c.mu.Lock()
	defer c.mu.Unlock()
	if active, ok := c.turns[key]; ok && strings.TrimSpace(active.turnID) == turnID {
		delete(c.turns, key)
	}
}

func (c *Controller) activeTurn(roomID, agentSessionID string) (activeTurn, bool) {
	if c == nil {
		return activeTurn{}, false
	}
	key := sessionKey(strings.TrimSpace(roomID), strings.TrimSpace(agentSessionID))
	c.mu.Lock()
	defer c.mu.Unlock()
	active, ok := c.turns[key]
	return active, ok
}

func (c *Controller) reconcileSessionStatusLocked(key string, session Session) Session {
	if c == nil {
		return session
	}
	if _, hasActiveTurn := c.turns[key]; hasActiveTurn {
		return session
	}
	if sessionHasLiveTurnLifecycle(session) {
		return session
	}
	return reconcileFinishedTurnStatus(session)
}

func reconcileFinishedTurnStatus(session Session) Session {
	if sessionHasLiveTurnLifecycle(session) {
		return session
	}
	if sessionHasLiveBackgroundAgents(session) {
		session.Status = SessionStatusWorking
		session.SubmitAvailability = blockedSubmitAvailability("background_agent")
		return session
	}
	if sessionStatusShouldReconcileToReady(session.Status) {
		session.Status = SessionStatusReady
	}
	return session
}

func sessionStatusShouldReconcileToReady(status string) bool {
	switch strings.TrimSpace(strings.ToLower(status)) {
	case "", "created", "submitted", "running", "streaming", SessionStatusWorking:
		return true
	default:
		return false
	}
}

func turnEventsAreTerminal(events []activityshared.Event) bool {
	for _, event := range events {
		switch event.Type {
		case activityshared.EventTurnCompleted, activityshared.EventTurnFailed:
			return true
		}
	}
	return false
}
