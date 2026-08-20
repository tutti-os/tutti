package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (c *Controller) Cancel(ctx context.Context, input CancelInput) (CancelResult, error) {
	rootAgentSessionID := strings.TrimSpace(input.RootAgentSessionID)
	if rootAgentSessionID == "" {
		return CancelResult{}, fmt.Errorf("root agent session id is required")
	}
	targets, err := normalizeCancelTargets(input.Targets)
	if err != nil {
		return CancelResult{}, err
	}
	releaseLifecycleLock := c.acquireLifecycleLock(input.RoomID, rootAgentSessionID)
	defer releaseLifecycleLock()

	session, adapter, err := c.sessionAndAdapter(input.RoomID, rootAgentSessionID)
	if err != nil {
		return CancelResult{}, err
	}
	reason := strings.TrimSpace(input.Reason)
	requestedRootTurnID := cancelTargetTurnID(targets, rootAgentSessionID)
	slog.Info("agent session cancel requested",
		"event", "agent_session.cancel.requested",
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider", session.Provider,
		"status", session.Status,
		"reason", reason,
		"target_count", len(targets),
	)
	active, ok := c.activeTurn(session.RoomID, session.AgentSessionID)
	adapterTargets := targets
	if requestedRootTurnID != "" && ok && active.turnID != requestedRootTurnID {
		slog.Info("agent session exact turn cancel found a different active turn",
			"event", "agent_session.cancel.turn_mismatch",
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider", session.Provider,
			"requested_turn_id", requestedRootTurnID,
			"active_turn_id", func() string {
				if ok {
					return active.turnID
				}
				return ""
			}(),
		)
		adapterTargets = cancelTargetsWithoutSession(targets, rootAgentSessionID)
	}
	cancelLocalActiveTurn := ok && requestedRootTurnID != "" && active.turnID == requestedRootTurnID && active.cancel != nil
	if len(adapterTargets) == 0 {
		return CancelResult{
			AgentSessionID: session.AgentSessionID,
			TargetAbsent:   true,
		}, nil
	}
	adapterResult, err := cancelAdapterTargets(ctx, adapter, session, adapterTargets, reason)
	// Provider cancellation must run while the adapter still owns the live
	// root turn handle. Canceling the controller context first can make an
	// adapter settle and unregister its local turn before it sends the native
	// interrupt, leaving the provider turn running after the canonical turn is
	// canceled. Once the bounded provider call returns, cancel the local Exec
	// context as cleanup regardless of provider success.
	if cancelLocalActiveTurn {
		active.cancel()
	}
	if err != nil {
		if errors.Is(err, ErrSessionNoActiveTurn) {
			if ok {
				c.clearActiveTurnIfMatches(session.RoomID, session.AgentSessionID, active.turnID)
			}
			return CancelResult{AgentSessionID: session.AgentSessionID, TargetAbsent: true}, nil
		}
		if errors.Is(err, ErrCancelTargetMismatch) {
			slog.Info("agent session exact cancel delivery is unconfirmed",
				"event", "agent_session.cancel.delivery_unconfirmed",
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider", session.Provider,
				"turn_id", requestedRootTurnID,
				"reason", reason,
			)
			return CancelResult{}, err
		}
		slog.Warn("agent session cancel adapter failed",
			"event", "agent_session.cancel.adapter_failed",
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider", session.Provider,
			"turn_id", requestedRootTurnID,
			"reason", reason,
			"error", err.Error(),
		)
		return CancelResult{}, err
	}
	if len(adapterResult.Events) > 0 {
		c.applySessionEventsByAgentSessionID(session.AgentSessionID, adapterResult.Events)
	}
	confirmedTargets := confirmedCancelTargets(adapterTargets, adapterResult.ConfirmedTargets)
	slog.Info("agent session cancel accepted",
		"event", "agent_session.cancel.accepted",
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider", session.Provider,
		"turn_id", requestedRootTurnID,
		"confirmed_target_count", len(confirmedTargets),
		"reason", reason,
	)
	return CancelResult{
		AgentSessionID:   session.AgentSessionID,
		Canceled:         len(confirmedTargets) > 0,
		TargetAbsent:     len(confirmedTargets) == 0,
		ConfirmedTargets: confirmedTargets,
	}, nil
}

func normalizeCancelTargets(targets []CancelTarget) ([]CancelTarget, error) {
	result := make([]CancelTarget, 0, len(targets))
	seen := make(map[string]struct{}, len(targets))
	for _, target := range targets {
		target.AgentSessionID = strings.TrimSpace(target.AgentSessionID)
		target.TurnID = strings.TrimSpace(target.TurnID)
		if target.AgentSessionID == "" || target.TurnID == "" {
			return nil, fmt.Errorf("cancel target session and turn ids are required")
		}
		key := target.AgentSessionID + "\x00" + target.TurnID
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, target)
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("at least one cancel target is required")
	}
	return result, nil
}

func cancelTargetTurnID(targets []CancelTarget, agentSessionID string) string {
	for _, target := range targets {
		if target.AgentSessionID == agentSessionID {
			return target.TurnID
		}
	}
	return ""
}

func cancelTargetsWithoutSession(targets []CancelTarget, agentSessionID string) []CancelTarget {
	result := make([]CancelTarget, 0, len(targets))
	for _, target := range targets {
		if target.AgentSessionID != agentSessionID {
			result = append(result, target)
		}
	}
	return result
}

func cancelAdapterTargets(ctx context.Context, adapter Adapter, rootSession Session, targets []CancelTarget, reason string) (TargetedCancelResult, error) {
	if targeted, ok := adapter.(TargetedCancelAdapter); ok {
		return targeted.CancelTargets(ctx, rootSession, targets, reason)
	}
	if len(targets) != 1 || targets[0].AgentSessionID != rootSession.AgentSessionID {
		return TargetedCancelResult{}, fmt.Errorf("agent provider %q does not support child turn cancellation", rootSession.Provider)
	}
	events, err := adapter.Cancel(ctx, rootSession, reason)
	if err != nil {
		return TargetedCancelResult{}, err
	}
	return TargetedCancelResult{Events: events, ConfirmedTargets: append([]CancelTarget(nil), targets...)}, nil
}

func confirmedCancelTargets(requested []CancelTarget, confirmed []CancelTarget) []CancelTarget {
	confirmedSet := make(map[string]struct{}, len(confirmed))
	for _, target := range confirmed {
		key := strings.TrimSpace(target.AgentSessionID) + "\x00" + strings.TrimSpace(target.TurnID)
		confirmedSet[key] = struct{}{}
	}
	result := make([]CancelTarget, 0, len(requested))
	for _, target := range requested {
		key := target.AgentSessionID + "\x00" + target.TurnID
		if _, ok := confirmedSet[key]; ok {
			result = append(result, target)
		}
	}
	return result
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
