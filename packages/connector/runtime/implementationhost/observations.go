package implementationhost

import (
	"context"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

// AuthorizationObserver receives runtime-side credential binding outcomes.
// The owning product may project them upstream; this Host does not become the
// account authorization truth source.
type AuthorizationObserver interface {
	ObserveAuthorization(context.Context, AuthorizationObservation)
}

type AuthorizationObservation struct {
	ConnectorKey string
	ConnectionID string
	State        market.AuthorizationState
	ObservedAt   time.Time
}

// RouteObserver receives unexpected long-lived runtime exits after the route
// has been removed from publication. Intentional deactivate, replacement, and
// Host shutdown do not emit an observation.
type RouteObserver interface {
	ObserveRoute(context.Context, RouteObservation)
}

type RouteObservation struct {
	ConnectorKey  string
	ConnectionID  string
	ReleaseDigest string
	Generation    market.HostGeneration
	ObservedAt    time.Time
}
