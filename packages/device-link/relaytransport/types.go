package relaytransport

import (
	"context"
	"errors"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"time"
)

// DialRequest describes one Relay byte-stream dial. Query and Header are
// cloned before use so a concurrent product refresh cannot mutate an in-flight
// handshake.
type DialRequest struct {
	Endpoint    string
	Query       url.Values
	Header      http.Header
	Subprotocol string
	Liveness    DialLivenessConfig
}

// DialLivenessConfig controls WebSocket keepalive for one Relay caller stream.
// A non-positive PingInterval uses the transport default. A PongTimeout not
// greater than the effective ping interval uses three ping intervals.
//
// The returned net.Conn fails when its peer does not answer WebSocket pings
// before PongTimeout. Callers can then apply their existing reconnect policy.
type DialLivenessConfig struct {
	PingInterval time.Duration
	PongTimeout  time.Duration
}

// StreamHandler consumes one stream opened over an owner tunnel.
type StreamHandler interface {
	HandleRelayStream(ctx context.Context, stream net.Conn) error
}

// StreamHandlerFunc adapts a function to StreamHandler.
type StreamHandlerFunc func(context.Context, net.Conn) error

func (f StreamHandlerFunc) HandleRelayStream(ctx context.Context, stream net.Conn) error {
	return f(ctx, stream)
}

// OwnerSession contains the transport material prepared by one product-owned
// lifecycle. Key is an opaque, non-secret correlation key such as an authority
// ID. It must not contain a token or application identifier.
type OwnerSession struct {
	Key         string
	Dial        DialRequest
	PingPayload []byte
}

// OwnerActivation is the continuous product health contract for one connected
// owner session. Readiness remains valid for the whole connection generation;
// its cancellation cause is the product-neutral explanation for why the
// generation must end. Deactivate stops and joins all product maintenance
// started by Activate.
type OwnerActivation struct {
	Readiness  context.Context
	Deactivate func()
}

// ErrOwnerWake identifies a host-directed wake request. A wake interrupts the
// current generation or retry wait without changing demand or resetting
// reconnect backoff.
var ErrOwnerWake = errors.New("relay owner wake requested")

// ErrOwnerActivationReadiness identifies an invalid lifecycle activation that
// did not return the required continuous readiness context.
var ErrOwnerActivationReadiness = errors.New("relay owner activation readiness is required")

// OwnerReadinessError preserves a product readiness cause while keeping the
// transport observer's error text free of product payloads. Callers can use
// errors.Is or errors.As to inspect Cause.
type OwnerReadinessError struct {
	Cause error
}

func (*OwnerReadinessError) Error() string { return "relay owner readiness ended" }

func (e *OwnerReadinessError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

// OwnerLifecycle owns product state for exactly one zero-to-one Host demand
// lifecycle. A Host never reuses a lifecycle after its final Release.
type OwnerLifecycle interface {
	// Prepare returns current owner-tunnel material. It may return a partial
	// session together with an error so Release can clean up product state that
	// was committed before preparation failed.
	Prepare(ctx context.Context) (OwnerSession, error)
	// Activate establishes the product conditions for this connection
	// generation after the WebSocket connects and before relay streams are
	// accepted. Readiness is a continuous condition, not just a one-time
	// barrier: cancelling it ends the generation and carries the product cause
	// to SessionEnded. Deactivate stops maintenance and joins all goroutines
	// started by Activate.
	Activate(ctx context.Context, session OwnerSession) (OwnerActivation, error)
	// SessionEnded lets the product invalidate credentials or projections based
	// on a completed connection attempt. It must not block.
	SessionEnded(session OwnerSession, err error)
	// Release removes product state for this exact business lifecycle.
	Release(ctx context.Context, session OwnerSession) error
}

// OwnerLifecycleFactory creates isolated product state for each Host business
// lifecycle. Isolation prevents a delayed Release from detaching a newer run.
type OwnerLifecycleFactory interface {
	NewOwnerLifecycle() OwnerLifecycle
}

// OwnerLifecycleFactoryFunc adapts a function to OwnerLifecycleFactory.
type OwnerLifecycleFactoryFunc func() OwnerLifecycle

func (f OwnerLifecycleFactoryFunc) NewOwnerLifecycle() OwnerLifecycle { return f() }

// OwnerPhase identifies one stable phase in the owner-tunnel lifecycle. New
// phases may be added compatibly; observers must ignore phases they do not
// recognize.
type OwnerPhase string

const (
	OwnerPhasePrepare  OwnerPhase = "prepare"
	OwnerPhaseDial     OwnerPhase = "dial"
	OwnerPhaseServe    OwnerPhase = "serve"
	OwnerPhaseSession  OwnerPhase = "session"
	OwnerPhaseRetry    OwnerPhase = "retry"
	OwnerPhaseStream   OwnerPhase = "stream"
	OwnerPhaseLiveness OwnerPhase = "liveness"
	OwnerPhaseRelease  OwnerPhase = "release"
)

// OwnerEndReason identifies a diagnostic reason for ending an owner attempt.
// Empty remains the normal value for legacy failure-driven endings.
type OwnerEndReason string

const (
	// OwnerEndReasonNetworkChanged means the attempt was fenced by a newer
	// network generation. Product lifecycles receive the same reason through
	// NetworkGenerationChangedError and decide whether credentials remain valid.
	OwnerEndReasonNetworkChanged OwnerEndReason = "network_changed"
)

// OwnerOutcome identifies the result of one owner-tunnel phase. New outcomes
// may be added compatibly; observers must ignore outcomes they do not recognize.
type OwnerOutcome string

const (
	OwnerOutcomeSucceeded    OwnerOutcome = "succeeded"
	OwnerOutcomeFailed       OwnerOutcome = "failed"
	OwnerOutcomeConnected    OwnerOutcome = "connected"
	OwnerOutcomeReady        OwnerOutcome = "ready"
	OwnerOutcomeEnded        OwnerOutcome = "ended"
	OwnerOutcomeScheduled    OwnerOutcome = "scheduled"
	OwnerOutcomePingSent     OwnerOutcome = "ping_sent"
	OwnerOutcomePongReceived OwnerOutcome = "pong_received"
	OwnerOutcomeStopped      OwnerOutcome = "stopped"
)

// OwnerEvent is a sanitized transport observation. Product adapters decide how
// to map it to logs or metrics and must sanitize Error before persistence.
type OwnerEvent struct {
	Phase      OwnerPhase
	Outcome    OwnerOutcome
	Generation uint64
	EndReason  OwnerEndReason
	SessionKey string
	Retry      *OwnerRetryObservation
	Liveness   *OwnerLivenessObservation
	Error      error
}

// ErrNetworkGenerationChanged is the sentinel wrapped by
// NetworkGenerationChangedError. It is transport cancellation, not a
// credential invalidation signal.
var ErrNetworkGenerationChanged = errors.New("relay owner network generation changed")

// NetworkGenerationChangedError identifies an attempt canceled by a newer
// network generation without exposing any network material.
type NetworkGenerationChangedError struct {
	PreviousGeneration uint64
	Generation         uint64
}

func (e *NetworkGenerationChangedError) Error() string {
	if e == nil {
		return ErrNetworkGenerationChanged.Error()
	}
	return "relay owner network generation changed"
}

func (*NetworkGenerationChangedError) Unwrap() error { return ErrNetworkGenerationChanged }

// OwnerRetryObservation describes one scheduled reconnect without product
// identifiers or credentials.
type OwnerRetryObservation struct {
	Delay        time.Duration
	BackoffCap   time.Duration
	BackoffDelay time.Duration
	RetryAfter   time.Duration
}

// OwnerLivenessObservation describes WebSocket ping/pong progress. LastPongAt
// is populated on the stopped event after at least one pong was received.
type OwnerLivenessObservation struct {
	PingCount  int64
	PongCount  int64
	At         time.Time
	LastPongAt time.Time
}

// OwnerObserver receives synchronous, non-payload transport observations. It
// must return quickly and must not call Host methods.
type OwnerObserver func(OwnerEvent)

// BackoffConfig configures full-jitter reconnect backoff.
type BackoffConfig struct {
	Initial    time.Duration
	Max        time.Duration
	Multiplier float64
	// RandFactory is called once per zero-to-one owner lifecycle. It may return
	// a seeded generator for deterministic tests; nil uses an isolated random
	// generator. The Host never shares one returned generator between runs.
	RandFactory func() *rand.Rand
}

// OwnerHostConfig configures one reference-counted Relay owner tunnel.
type OwnerHostConfig struct {
	LifecycleFactory OwnerLifecycleFactory
	Handler          StreamHandler
	Backoff          BackoffConfig
	StableSessionFor time.Duration
	PingInterval     time.Duration
	PongTimeout      time.Duration
	Sleep            func(context.Context, time.Duration) error
	Now              func() time.Time
	Observe          OwnerObserver
}
