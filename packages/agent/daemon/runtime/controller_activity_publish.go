package agentruntime

import (
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (c *Controller) publish(session Session, events []activityshared.Event) {
	if len(events) == 0 {
		return
	}
	projectedBatches := projectActivityEventsByOwner(session, events)
	projected := make([]StreamEvent, 0)
	for _, batch := range projectedBatches {
		projected = append(projected, batch.events...)
	}
	slog.Debug(
		"agent session publish events",
		"event", "agent_session.publish",
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider", session.Provider,
		"provider_session_id", session.ProviderSessionID,
		"activity_event_count", len(events),
		"projected_event_count", len(projected),
		"projected_event_type_counts", streamEventTypeCounts(projected),
	)
	for _, batch := range projectedBatches {
		// Runtime snapshots belong to the Controller's registered root session.
		// Child sessions are provider-created projections and must not inherit
		// root-only state while their event stream is being routed.
		if batch.session.AgentSessionID == strings.TrimSpace(session.AgentSessionID) {
			c.enrichStreamStateEventsWithSessionSnapshot(batch.session, batch.events)
		}
		c.publishStreamEvents(batch.session.RoomID, batch.session.AgentSessionID, batch.events)
	}
}
