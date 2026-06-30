package streamgo

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Session is one connected client. S is the product scope type.
type Session[S comparable] struct {
	id string

	mu            sync.RWMutex
	closed        bool
	subscriptions map[subscriptionKey[S]]struct{}

	events chan PublishedEvent[S]
	once   sync.Once
}

type subscriptionKey[S comparable] struct {
	topic string
	scope S
}

// Service is the in-memory pub/sub registry with scope routing and fan-out.
type Service[S comparable] struct {
	catalog        Catalog
	normalizeScope ScopeNormalizer[S]

	mu       sync.RWMutex
	sessions map[*Session[S]]struct{}
	handlers map[string]IntentHandler

	nextEventID   uint64
	nextSessionID uint64
}

// NewService builds a registry for scope type S. catalog must not be nil.
// normalizeScope canonicalizes/validates a scope (e.g. trim, reject blanks);
// pass a no-op identity normalizer if a product needs none.
func NewService[S comparable](
	catalog Catalog,
	handlers map[string]IntentHandler,
	normalizeScope ScopeNormalizer[S],
) *Service[S] {
	clonedHandlers := make(map[string]IntentHandler, len(handlers))
	for topic, handler := range handlers {
		clonedHandlers[strings.TrimSpace(topic)] = handler
	}
	if normalizeScope == nil {
		normalizeScope = func(scope S) (S, error) { return scope, nil }
	}

	return &Service[S]{
		catalog:        catalog,
		normalizeScope: normalizeScope,
		handlers:       clonedHandlers,
		sessions:       make(map[*Session[S]]struct{}),
	}
}

func (s *Service[S]) RegisterIntentHandler(topic string, handler IntentHandler) {
	s.mu.Lock()
	defer s.mu.Unlock()

	trimmedTopic := strings.TrimSpace(topic)
	if trimmedTopic == "" {
		return
	}
	if handler == nil {
		delete(s.handlers, trimmedTopic)
		return
	}
	s.handlers[trimmedTopic] = handler
}

func (s *Service[S]) OpenSession() *Session[S] {
	session := &Session[S]{
		id:            fmt.Sprintf("session-%d", atomic.AddUint64(&s.nextSessionID, 1)),
		subscriptions: make(map[subscriptionKey[S]]struct{}),
		events:        make(chan PublishedEvent[S], 32),
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[session] = struct{}{}
	return session
}

func (s *Service[S]) CloseSession(session *Session[S]) {
	if session == nil {
		return
	}

	s.mu.Lock()
	delete(s.sessions, session)
	s.mu.Unlock()

	session.once.Do(func() {
		session.mu.Lock()
		session.closed = true
		session.mu.Unlock()
		close(session.events)
	})
}

func (s *Service[S]) Subscribe(session *Session[S], topics []string, scope S) error {
	normalizedTopics, err := normalizeTopics(topics)
	if err != nil {
		return err
	}
	normalizedScope, err := s.normalizeScope(scope)
	if err != nil {
		return err
	}
	for _, topic := range normalizedTopics {
		if err := s.catalog.ValidateSubscription(topic); err != nil {
			return err
		}
	}

	session.mu.Lock()
	defer session.mu.Unlock()
	for _, topic := range normalizedTopics {
		session.subscriptions[subscriptionKey[S]{topic: strings.TrimSpace(topic), scope: normalizedScope}] = struct{}{}
	}
	return nil
}

func (s *Service[S]) Unsubscribe(session *Session[S], topics []string, scope S) error {
	normalizedTopics, err := normalizeTopics(topics)
	if err != nil {
		return err
	}
	normalizedScope, err := s.normalizeScope(scope)
	if err != nil {
		return err
	}

	session.mu.Lock()
	defer session.mu.Unlock()
	for _, topic := range normalizedTopics {
		delete(session.subscriptions, subscriptionKey[S]{topic: strings.TrimSpace(topic), scope: normalizedScope})
	}
	return nil
}

func (s *Service[S]) PublishFromClient(ctx context.Context, event ClientEvent) error {
	trimmedTopic := strings.TrimSpace(event.Topic)
	if err := s.catalog.ValidatePublish(trimmedTopic, DirectionClientToServer, event.Payload); err != nil {
		return err
	}

	s.mu.RLock()
	handler := s.handlers[trimmedTopic]
	s.mu.RUnlock()
	if handler == nil {
		return fmt.Errorf("intent handler is not configured for topic %q", trimmedTopic)
	}
	return handler(ctx, ClientEvent{
		Topic:   trimmedTopic,
		Payload: append([]byte(nil), event.Payload...),
	})
}

func (s *Service[S]) PublishFromServer(ctx context.Context, topic string, payload []byte) error {
	var zero S
	return s.PublishFromServerScoped(ctx, topic, payload, zero)
}

func (s *Service[S]) PublishFromServerScoped(_ context.Context, topic string, payload []byte, scope S) error {
	trimmedTopic := strings.TrimSpace(topic)
	normalizedScope, err := s.normalizeScope(scope)
	if err != nil {
		return err
	}
	version, ok := s.catalog.TopicVersion(trimmedTopic)
	if !ok {
		return &ValidationError{
			Code:    ValidationCodeInvalidTopic,
			Message: fmt.Sprintf("unknown topic %q", trimmedTopic),
			Topic:   trimmedTopic,
		}
	}
	if err := s.catalog.ValidatePublish(trimmedTopic, DirectionServerToClient, payload); err != nil {
		return err
	}

	event := PublishedEvent[S]{
		ID:        fmt.Sprintf("event-%d", atomic.AddUint64(&s.nextEventID, 1)),
		Topic:     trimmedTopic,
		Version:   version,
		EmittedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Scope:     normalizedScope,
		Payload:   append([]byte(nil), payload...),
	}

	sessions := s.subscribedSessions(trimmedTopic, normalizedScope)
	for _, session := range sessions {
		if !session.enqueue(event) {
			s.CloseSession(session)
		}
	}

	return nil
}

func (*Service[S]) Events(session *Session[S]) <-chan PublishedEvent[S] {
	if session == nil {
		return nil
	}
	return session.Events()
}

// Events returns the read side of the session's outbound event channel.
func (s *Session[S]) Events() <-chan PublishedEvent[S] {
	return s.events
}

func normalizeTopics(topics []string) ([]string, error) {
	if len(topics) == 0 {
		return nil, &ValidationError{
			Code:    ValidationCodeInvalidPayload,
			Message: "at least one topic is required",
		}
	}

	normalized := make([]string, 0, len(topics))
	seen := make(map[string]struct{}, len(topics))
	for _, topic := range topics {
		trimmedTopic := strings.TrimSpace(topic)
		if trimmedTopic == "" {
			return nil, &ValidationError{
				Code:    ValidationCodeInvalidPayload,
				Message: "topic must not be empty",
			}
		}
		if _, ok := seen[trimmedTopic]; ok {
			continue
		}
		seen[trimmedTopic] = struct{}{}
		normalized = append(normalized, trimmedTopic)
	}
	return normalized, nil
}

func (s *Service[S]) subscribedSessions(topic string, scope S) []*Session[S] {
	s.mu.RLock()
	defer s.mu.RUnlock()

	sessions := make([]*Session[S], 0, len(s.sessions))
	for session := range s.sessions {
		if session.isSubscribed(topic, scope) {
			sessions = append(sessions, session)
		}
	}
	return sessions
}

func (s *Session[S]) enqueue(event PublishedEvent[S]) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return false
	}

	select {
	case s.events <- event:
		return true
	default:
		return false
	}
}

func (s *Session[S]) isSubscribed(topic string, scope S) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var zero S
	for key := range s.subscriptions {
		if key.topic != topic {
			continue
		}
		if key.scope == zero {
			return true
		}
		if key.scope == scope {
			return true
		}
	}
	return false
}
