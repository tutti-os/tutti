package agentruntime

import (
	"context"
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type projectedActivityEventBatch struct {
	session Session
	events  []StreamEvent
}

type activityEventOwnerGroup struct {
	agentSessionID    string
	providerSessionID string
	events            []activityshared.Event
}

// projectActivityEventsByOwner preserves the provider event's canonical
// session owner through the live publication boundary. A root Controller turn
// can receive root and child Activity Events in the same callback, but each
// public stream must be scoped to the session that owns its payload.
func projectActivityEventsByOwner(
	session Session,
	events []activityshared.Event,
) []projectedActivityEventBatch {
	if len(events) == 0 {
		return nil
	}
	defaultAgentSessionID := strings.TrimSpace(session.AgentSessionID)
	groups := make([]activityEventOwnerGroup, 0, 1)
	groupIndexBySessionID := make(map[string]int, 1)
	for _, event := range events {
		agentSessionID := strings.TrimSpace(event.AgentSessionID)
		if agentSessionID == "" {
			agentSessionID = defaultAgentSessionID
		}
		if agentSessionID == "" {
			continue
		}
		providerSessionID := strings.TrimSpace(event.ProviderSessionID)
		groupKey := agentSessionID + "\x00" + providerSessionID
		groupIndex, ok := groupIndexBySessionID[groupKey]
		if !ok {
			groupIndex = len(groups)
			groupIndexBySessionID[groupKey] = groupIndex
			groups = append(groups, activityEventOwnerGroup{
				agentSessionID:    agentSessionID,
				providerSessionID: providerSessionID,
			})
		}
		event.AgentSessionID = agentSessionID
		groups[groupIndex].events = append(groups[groupIndex].events, event)
	}

	projected := make([]projectedActivityEventBatch, 0, len(groups))
	for _, group := range groups {
		projectionSession := session
		projectionSession.AgentSessionID = group.agentSessionID
		if group.providerSessionID != "" {
			projectionSession.ProviderSessionID = group.providerSessionID
		}
		streamEvents := ProjectActivityEventsToStreamEvents(projectionSession, group.events)
		if len(streamEvents) == 0 {
			continue
		}
		projected = append(projected, projectedActivityEventBatch{
			session: projectionSession,
			events:  streamEvents,
		})
	}
	return projected
}

// SetStreamEventObserver binds the daemon-local business-event projection.
// The observer is intentionally singular: one Controller has one ordered
// external fan-out boundary, while EventHub remains responsible for arbitrary
// per-session runtime subscribers.
func (c *Controller) SetStreamEventObserver(observer RuntimeStreamEventObserver) {
	if c == nil {
		return
	}
	c.streamObserverMu.Lock()
	c.streamObserver = observer
	c.streamObserverMu.Unlock()
}

// SetSideStreamEventObserver binds the transient-only side-conversation event
// projection. Side events never reach the canonical observer or durable
// reporter, even though both scopes reuse the same adapter event vocabulary.
func (c *Controller) SetSideStreamEventObserver(observer SideStreamEventObserver) {
	if c == nil {
		return
	}
	c.streamObserverMu.Lock()
	c.sideStreamObserver = observer
	c.streamObserverMu.Unlock()
}

func (c *Controller) publishStreamEvents(
	roomID string,
	agentSessionID string,
	events []StreamEvent,
) {
	if c == nil || len(events) == 0 {
		return
	}
	roomID = strings.TrimSpace(roomID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if roomID == "" || agentSessionID == "" {
		return
	}

	session, found := c.get(roomID, agentSessionID)
	side := found && session.IsSideConversation()
	c.streamObserverMu.RLock()
	observer := c.streamObserver
	if side {
		observer = c.sideStreamObserver
	}
	c.streamObserverMu.RUnlock()
	publishedEvents := events
	if observer != nil {
		if filter, ok := observer.(RuntimeStreamEventFilter); ok {
			publishedEvents = filter.FilterRuntimeStreamEvents(roomID, agentSessionID, events)
		}
		// The filter only protects local EventHub subscribers. The observer sees
		// the original batch so the business-event bridge can reject malformed
		// identities and publish a bounded reconcile hint.
		if err := observer.ObserveRuntimeStreamEvents(
			context.Background(),
			roomID,
			agentSessionID,
			events,
		); err != nil {
			slog.Warn(
				"publish agent runtime stream projection failed",
				"event", "agent_session.stream_projection.publish_failed",
				"room_id", roomID,
				"agent_session_id", agentSessionID,
				"error", err,
			)
		}
	}
	c.hub.Publish(roomID, agentSessionID, publishedEvents)
}

func (c *Controller) forgetSideStreamEvents(session Session) {
	if c == nil || !session.IsSideConversation() {
		return
	}
	c.streamObserverMu.RLock()
	observer := c.sideStreamObserver
	c.streamObserverMu.RUnlock()
	if observer == nil {
		return
	}
	observer.ForgetSideConversation(session.RoomID, session.AgentSessionID)
}
