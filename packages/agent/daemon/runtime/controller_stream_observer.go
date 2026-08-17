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

	c.streamObserverMu.RLock()
	observer := c.streamObserver
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
