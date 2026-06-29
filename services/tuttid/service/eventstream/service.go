// Package eventstream is the tutti workspace binding of the catalog-agnostic
// event-stream registry (github.com/tutti-os/tutti/packages/events/stream-go).
//
// The pub/sub registry, scope routing and session fan-out live in stream-go.
// This package only fixes the scope axis to the workspace (EventScope) and keeps
// the tutti catalog (TopicDefinition / StaticCatalog / DefaultCatalog + payload
// validators). The aliases below preserve the original public surface so existing
// callers (daemon_events.go, wiring.go, tests) are unchanged.
package eventstream

import (
	"strings"

	streamgo "github.com/tutti-os/tutti/packages/events/stream-go"
)

// EventScope is the workspace scope axis used to route events.
type EventScope struct {
	WorkspaceID string
}

// Re-exported core types, instantiated with the workspace scope.
type (
	Service        = streamgo.Service[EventScope]
	Session        = streamgo.Session[EventScope]
	PublishedEvent = streamgo.PublishedEvent[EventScope]
	ClientEvent    = streamgo.ClientEvent
	IntentHandler  = streamgo.IntentHandler

	Direction       = streamgo.Direction
	ValidationCode  = streamgo.ValidationCode
	ValidationError = streamgo.ValidationError
)

const (
	DirectionClientToServer = streamgo.DirectionClientToServer
	DirectionServerToClient = streamgo.DirectionServerToClient

	ValidationCodeInvalidDirection = streamgo.ValidationCodeInvalidDirection
	ValidationCodeInvalidPayload   = streamgo.ValidationCodeInvalidPayload
	ValidationCodeInvalidTopic     = streamgo.ValidationCodeInvalidTopic
)

// NewService builds a workspace-scoped registry over the tutti catalog.
func NewService(catalog Catalog, handlers map[string]IntentHandler) *Service {
	if catalog == nil {
		catalog = DefaultCatalog()
	}
	return streamgo.NewService[EventScope](catalog, handlers, normalizeWorkspaceScope)
}

// normalizeWorkspaceScope trims the workspaceId and rejects whitespace-only ids.
func normalizeWorkspaceScope(scope EventScope) (EventScope, error) {
	workspaceID := strings.TrimSpace(scope.WorkspaceID)
	if scope.WorkspaceID != "" && workspaceID == "" {
		return EventScope{}, &streamgo.ValidationError{
			Code:    streamgo.ValidationCodeInvalidPayload,
			Message: "scope.workspaceId must not be empty",
		}
	}
	return EventScope{WorkspaceID: workspaceID}, nil
}
