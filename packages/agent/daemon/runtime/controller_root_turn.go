package agentruntime

import (
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type RootTurnSettlement struct {
	RoomID         string
	AgentSessionID string
	TurnID         string
	Outcome        string
	ErrorMessage   string
}

// ReconcileRootTurnSettlement applies daemon-owned durable root completion to
// the runtime view. It does not report the event back to the daemon: the
// caller invokes it only after the atomic durable transition committed.
func (c *Controller) ReconcileRootTurnSettlement(settlement RootTurnSettlement) {
	if c == nil {
		return
	}
	roomID := strings.TrimSpace(settlement.RoomID)
	agentSessionID := strings.TrimSpace(settlement.AgentSessionID)
	turnID := strings.TrimSpace(settlement.TurnID)
	if roomID == "" || agentSessionID == "" || turnID == "" {
		return
	}
	key := sessionKey(roomID, agentSessionID)
	c.mu.Lock()
	session, ok := c.sessions[key]
	if !ok {
		c.mu.Unlock()
		return
	}
	if active, exists := c.turns[key]; exists && strings.TrimSpace(active.turnID) == turnID {
		delete(c.turns, key)
	}
	outcome := strings.TrimSpace(settlement.Outcome)
	session.TurnLifecycle = &TurnLifecycle{Phase: "settled", Outcome: stringPointer(outcome)}
	session.SubmitAvailability = availableSubmitAvailability()
	switch outcome {
	case "failed":
		session.Status = SessionStatusFailed
	case "canceled", "interrupted":
		session.Status = SessionStatusCanceled
	default:
		session.Status = SessionStatusReady
	}
	session.UpdatedAtUnixMS = unixMS(now())
	c.sessions[key] = session
	c.mu.Unlock()

	eventType := EventTurnCompleted
	switch outcome {
	case "failed":
		eventType = EventTurnFailed
	case "canceled", "interrupted":
		eventType = EventTurnCanceled
	}
	metadata := map[string]any{
		"daemonRootTurnSettlement": true,
	}
	if eventType == EventTurnFailed {
		// Carry the durable failure reason on the live event so the
		// visible-error projection can classify and render it; an empty
		// detail degrades to a generic card with no recoverable signal.
		if message := strings.TrimSpace(settlement.ErrorMessage); message != "" {
			metadata["error"] = message
			metadata["errorMessage"] = message
		}
	}
	event := newTurnActivityEvent(session, eventType, turnID, session.Status, "", "", metadata)
	if event.Type != "" {
		if event.Payload.TurnOutcome == "" {
			event.Payload.TurnOutcome = outcome
		}
		c.publish(session, []activityshared.Event{event})
	}
}

func stringPointer(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}
