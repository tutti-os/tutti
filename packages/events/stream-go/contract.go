// Package streamgo is the catalog-agnostic server-side core for the business
// event stream (daemon ↔ renderer over WS). It owns the in-memory pub/sub
// registry, scope routing and session fan-out; it knows nothing about concrete
// topics or scope axes. Each product (tutti workspace, tsh chat) instantiates
// Service with its own scope type S and injects a Catalog + scope normalizer.
package streamgo

import "context"

// Direction is the allowed direction of an event topic on the wire.
type Direction string

const (
	DirectionClientToServer Direction = "client->server"
	DirectionServerToClient Direction = "server->client"
)

// ValidationCode classifies a ValidationError for the wire error frame.
type ValidationCode string

const (
	ValidationCodeInvalidDirection ValidationCode = "invalid_direction"
	ValidationCodeInvalidPayload   ValidationCode = "invalid_payload"
	ValidationCodeInvalidTopic     ValidationCode = "invalid_topic"
)

// ValidationError is a structured, wire-mappable validation failure.
type ValidationError struct {
	Code      ValidationCode
	Message   string
	Topic     string
	Direction Direction
}

func (e *ValidationError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// Catalog is the minimal contract the registry needs from a product catalog.
// Products implement it (e.g. tutti's StaticCatalog) and inject it into Service.
type Catalog interface {
	// TopicVersion returns the wire version of a known topic.
	TopicVersion(topic string) (int, bool)
	ValidatePublish(topic string, direction Direction, payload []byte) error
	ValidateSubscription(topic string) error
}

// ClientEvent is a decoded client→server intent handed to an IntentHandler.
type ClientEvent struct {
	Topic   string
	Payload []byte
}

// IntentHandler processes a validated client→server intent for a topic.
type IntentHandler func(context.Context, ClientEvent) error

// PublishedEvent is a server→client event fanned out to subscribed sessions.
// S is the product scope type used for routing.
type PublishedEvent[S comparable] struct {
	ID        string
	Topic     string
	Version   int
	EmittedAt string
	Scope     S
	Payload   []byte
}

// ScopeNormalizer canonicalizes/validates a product scope before routing.
type ScopeNormalizer[S comparable] func(scope S) (S, error)
