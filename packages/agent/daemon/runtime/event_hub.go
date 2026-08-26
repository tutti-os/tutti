package agentruntime

import (
	"log/slog"
	"strings"
	"sync"
	"time"
)

const (
	eventHubSubscriberQueueLimit        = 512
	eventHubQueuePressureThreshold      = 64
	eventHubQueuePressureLogInterval    = time.Second
	eventHubConsumerBlockedLogThreshold = 250 * time.Millisecond
	eventHubConsumerBlockedLogInterval  = 5 * time.Second
)

type EventHub struct {
	mu          sync.Mutex
	subscribers map[string]map[*eventSubscriber]struct{}
}

func NewEventHub() *EventHub {
	return &EventHub{subscribers: make(map[string]map[*eventSubscriber]struct{})}
}

func (h *EventHub) Subscribe(roomID, agentSessionID string) (<-chan StreamEvent, func()) {
	return h.SubscribeWithInitial(roomID, agentSessionID, nil)
}

func (h *EventHub) SubscribeWithInitial(roomID, agentSessionID string, initial []StreamEvent) (<-chan StreamEvent, func()) {
	if h == nil {
		ch := make(chan StreamEvent)
		close(ch)
		return ch, func() {}
	}
	key := eventHubKey(roomID, agentSessionID)
	if key == "" {
		ch := make(chan StreamEvent)
		close(ch)
		return ch, func() {}
	}
	subscriber := newEventSubscriber(roomID, agentSessionID)
	h.mu.Lock()
	if h.subscribers[key] == nil {
		h.subscribers[key] = make(map[*eventSubscriber]struct{})
	}
	h.subscribers[key][subscriber] = struct{}{}
	h.mu.Unlock()
	for _, event := range initial {
		subscriber.enqueue(event)
	}

	return subscriber.ch, func() {
		h.mu.Lock()
		if subscribers := h.subscribers[key]; subscribers != nil {
			delete(subscribers, subscriber)
			if len(subscribers) == 0 {
				delete(h.subscribers, key)
			}
		}
		h.mu.Unlock()
		subscriber.close()
	}
}

func (h *EventHub) Publish(roomID, agentSessionID string, events []StreamEvent) {
	if h == nil || len(events) == 0 {
		return
	}
	key := eventHubKey(roomID, agentSessionID)
	if key == "" {
		return
	}
	h.mu.Lock()
	subscribers := make([]*eventSubscriber, 0, len(h.subscribers[key]))
	for subscriber := range h.subscribers[key] {
		subscribers = append(subscribers, subscriber)
	}
	h.mu.Unlock()
	for _, event := range events {
		for _, subscriber := range subscribers {
			subscriber.enqueue(event)
		}
	}
}

type eventSubscriber struct {
	ch                        chan StreamEvent
	done                      chan struct{}
	wake                      chan struct{}
	mu                        sync.Mutex
	queue                     []queuedStreamEvent
	head                      int
	roomID                    string
	agentSessionID            string
	closed                    bool
	overflowed                bool
	overflowCount             uint64
	consumerBlockedCount      uint64
	lastQueuePressureLogAt    time.Time
	lastQueuePressureLogDepth int
	lastConsumerBlockedLogAt  time.Time
}

type queuedStreamEvent struct {
	event      StreamEvent
	enqueuedAt time.Time
}

func newEventSubscriber(roomID, agentSessionID string) *eventSubscriber {
	subscriber := &eventSubscriber{
		ch:             make(chan StreamEvent, 64),
		done:           make(chan struct{}),
		wake:           make(chan struct{}, 1),
		roomID:         roomID,
		agentSessionID: agentSessionID,
	}
	go subscriber.run()
	return subscriber
}

func (s *eventSubscriber) enqueue(event StreamEvent) {
	if s == nil {
		return
	}
	now := time.Now()
	var pressureLog *eventHubQueueLog
	var overflowLog *eventHubQueueLog
	s.mu.Lock()
	if s.closed || s.overflowed {
		s.mu.Unlock()
		return
	}
	s.queue = append(s.queue, queuedStreamEvent{event: event, enqueuedAt: now})
	if len(s.queue)-s.head > eventHubSubscriberQueueLimit {
		queuedEvents := len(s.queue) - s.head
		oldestAge := now.Sub(s.queue[s.head].enqueuedAt)
		s.overflowCount++
		overflowLog = &eventHubQueueLog{
			queueDepth:      queuedEvents,
			oldestAge:       oldestAge,
			overflowCount:   s.overflowCount,
			consumerBlocked: 0,
		}
		s.queue = []queuedStreamEvent{{
			event: StreamEvent{
				EventType: StreamEventSessionReconcileRequired,
				Data: map[string]any{
					"agentSessionId": s.agentSessionID,
					"eventType":      StreamEventSessionReconcileRequired,
					"reason":         "event_hub_queue_overflow",
				},
			},
			enqueuedAt: now,
		}}
		s.head = 0
		s.overflowed = true
	} else if queueDepth := len(s.queue) - s.head; queueDepth >= eventHubQueuePressureThreshold &&
		(now.Sub(s.lastQueuePressureLogAt) >= eventHubQueuePressureLogInterval ||
			queueDepth >= s.lastQueuePressureLogDepth+eventHubQueuePressureThreshold) {
		oldestAge := now.Sub(s.queue[s.head].enqueuedAt)
		s.lastQueuePressureLogAt = now
		s.lastQueuePressureLogDepth = queueDepth
		pressureLog = &eventHubQueueLog{
			queueDepth:      queueDepth,
			oldestAge:       oldestAge,
			overflowCount:   s.overflowCount,
			consumerBlocked: 0,
		}
	}
	s.mu.Unlock()
	s.notify()
	if pressureLog != nil {
		s.logQueuePressure(*pressureLog)
	}
	if overflowLog != nil {
		s.logQueueOverflow(*overflowLog)
	}
}

func (s *eventSubscriber) run() {
	defer close(s.ch)
	for {
		event, ok := s.next()
		if !ok {
			return
		}
		sendStartedAt := time.Now()
		select {
		case s.ch <- event:
			if blockedFor := time.Since(sendStartedAt); blockedFor >= eventHubConsumerBlockedLogThreshold {
				s.logConsumerBlocked(blockedFor)
			}
		case <-s.done:
			return
		}
	}
}

func (s *eventSubscriber) next() (StreamEvent, bool) {
	for {
		s.mu.Lock()
		if s.head < len(s.queue) {
			event := s.queue[s.head].event
			s.queue[s.head] = queuedStreamEvent{}
			s.head++
			s.compactQueueLocked()
			s.mu.Unlock()
			return event, true
		}
		if s.closed || s.overflowed {
			s.mu.Unlock()
			return StreamEvent{}, false
		}
		s.mu.Unlock()

		select {
		case <-s.wake:
		case <-s.done:
			return StreamEvent{}, false
		}
	}
}

type eventHubQueueLog struct {
	queueDepth      int
	oldestAge       time.Duration
	overflowCount   uint64
	consumerBlocked time.Duration
}

func (s *eventSubscriber) logQueuePressure(log eventHubQueueLog) {
	slog.Warn("agent session event subscriber queue pressure",
		"event", "agent_session.event_hub_queue_pressure",
		"room_id", s.roomID,
		"agent_session_id", s.agentSessionID,
		"queue_depth", log.queueDepth,
		"queue_limit", eventHubSubscriberQueueLimit,
		"oldest_event_age_ms", log.oldestAge.Milliseconds(),
		"overflow_count", log.overflowCount,
	)
}

func (s *eventSubscriber) logQueueOverflow(log eventHubQueueLog) {
	slog.Warn("agent session event subscriber queue overflowed",
		"event", "agent_session.event_hub_queue_overflow",
		"room_id", s.roomID,
		"agent_session_id", s.agentSessionID,
		"queue_depth", log.queueDepth,
		"queue_limit", eventHubSubscriberQueueLimit,
		"oldest_event_age_ms", log.oldestAge.Milliseconds(),
		"overflow_count", log.overflowCount,
	)
}

func (s *eventSubscriber) logConsumerBlocked(blockedFor time.Duration) {
	now := time.Now()
	s.mu.Lock()
	s.consumerBlockedCount++
	if now.Sub(s.lastConsumerBlockedLogAt) < eventHubConsumerBlockedLogInterval {
		s.mu.Unlock()
		return
	}
	s.lastConsumerBlockedLogAt = now
	queueDepth := len(s.queue) - s.head
	oldestAge := time.Duration(0)
	if queueDepth > 0 {
		oldestAge = now.Sub(s.queue[s.head].enqueuedAt)
	}
	log := eventHubQueueLog{
		queueDepth:      queueDepth,
		oldestAge:       oldestAge,
		overflowCount:   s.overflowCount,
		consumerBlocked: blockedFor,
	}
	blockedCount := s.consumerBlockedCount
	s.mu.Unlock()

	slog.Warn("agent session event subscriber consumer blocked",
		"event", "agent_session.event_hub_consumer_blocked",
		"room_id", s.roomID,
		"agent_session_id", s.agentSessionID,
		"queue_depth", log.queueDepth,
		"queue_limit", eventHubSubscriberQueueLimit,
		"oldest_event_age_ms", log.oldestAge.Milliseconds(),
		"consumer_blocked_ms", log.consumerBlocked.Milliseconds(),
		"consumer_blocked_count", blockedCount,
		"overflow_count", log.overflowCount,
	)
}

func (s *eventSubscriber) compactQueueLocked() {
	if s.head == 0 {
		return
	}
	if s.head == len(s.queue) {
		s.queue = s.queue[:0]
		s.head = 0
		return
	}
	if s.head < 64 || s.head*2 < len(s.queue) {
		return
	}
	copy(s.queue, s.queue[s.head:])
	s.queue = s.queue[:len(s.queue)-s.head]
	s.head = 0
}

func (s *eventSubscriber) close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	close(s.done)
	s.mu.Unlock()
	s.notify()
}

func (s *eventSubscriber) notify() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func eventHubKey(roomID, agentSessionID string) string {
	roomID = strings.TrimSpace(roomID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if roomID == "" || agentSessionID == "" {
		return ""
	}
	return roomID + "\x00" + agentSessionID
}
