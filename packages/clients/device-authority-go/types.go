package deviceauthority

import (
	"errors"
	"time"
)

// ErrResponseBinding identifies a control-plane response whose authority
// binding does not match the request. The current lease-renewal wire response
// exposes authority binding but not a runtime field; adapters must treat this
// as a non-transient product-state failure rather than retrying the old
// authority.
var ErrResponseBinding = errors.New("device authority response binding mismatch")

// EnsureDeviceAuthorityRequest identifies the product owner and local runtime
// that should own the Device Authority.
type EnsureDeviceAuthorityRequest struct {
	OwnerUserID string
	RuntimeID   string
}

// DeviceAuthorityResult describes the ensured authority and its current Relay
// and lease parameters.
type DeviceAuthorityResult struct {
	AuthorityID       string
	State             string
	OwnerUserID       string
	RuntimeID         string
	Relay             RelayDescriptor
	Lease             LeasePolicy
	GatewayEnrollment GatewayEnrollment
}

// RegisterDeviceGatewayIdentityRequest carries the one-time enrollment proof
// for a runtime identity.
type RegisterDeviceGatewayIdentityRequest struct {
	AuthorityID     string
	RuntimeID       string
	EnrollmentProof string
}

// DeviceGatewayIdentityResult identifies the enrolled local key.
type DeviceGatewayIdentityResult struct {
	AuthorityID string
	RuntimeID   string
	IdentityID  string
	KeyID       string
}

// IssueDeviceGatewayOwnerTunnelTokenRequest selects the authority targets and
// requested token lifetime.
type IssueDeviceGatewayOwnerTunnelTokenRequest struct {
	AuthorityID      string
	RuntimeID        string
	SupportedTargets []string
	TTL              time.Duration
}

// DeviceGatewayOwnerTunnelTokenResult carries the signed owner credential and
// current Relay/lease descriptors.
type DeviceGatewayOwnerTunnelTokenResult struct {
	AuthorityID string
	State       string
	Token       Token
	Relay       RelayDescriptor
	Lease       LeasePolicy
	IdentityID  string
}

// RenewDeviceAuthorityLeaseRequest reports product-owned runtime readiness.
type RenewDeviceAuthorityLeaseRequest struct {
	AuthorityID       string
	OwnerUserID       string
	RuntimeID         string
	TTLSeconds        int
	OwnerTunnelStatus string
	VMStatus          string
}

// RenewDeviceAuthorityLeaseResult reports the renewed server lease window.
type RenewDeviceAuthorityLeaseResult struct {
	AuthorityID string
	State       string
	RenewedAt   string
	ExpiresAt   string
}

// RelayDescriptor contains the endpoints and node selected by the control
// plane. The client does not interpret or dial these values.
type RelayDescriptor struct {
	HostEndpoint string
	DialEndpoint string
	RelayNodeID  string
}

// LeasePolicy carries server-selected lease and renewal durations in seconds.
type LeasePolicy struct {
	TTLSeconds           int
	RenewIntervalSeconds int
}

// GatewayEnrollment is the short-lived proof used to enroll a gateway key.
type GatewayEnrollment struct {
	Proof     string
	ExpiresAt string
}

// Token is an opaque owner-tunnel credential and its server timestamp.
type Token struct {
	Value     string
	ExpiresAt string
}
