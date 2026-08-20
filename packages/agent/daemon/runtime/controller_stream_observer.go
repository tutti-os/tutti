package agentruntime

import (
	"context"
	"log/slog"
	"strings"
)

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
