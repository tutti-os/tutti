package mobileremote

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	deviceauthority "github.com/tutti-os/tutti/packages/clients/device-authority-go"
	devicelink "github.com/tutti-os/tutti/packages/device-link"
	"github.com/tutti-os/tutti/packages/device-link/relaytransport"
)

const (
	relayOwnerSubprotocol   = "tsh.relay.owner.v1"
	deviceGatewayTarget     = "device-gateway"
	relayStreamSubprotocol  = "tsh.relay.stream.v1"
	maxRelayPreludeBytes    = 64 * 1024
	defaultRelayLeaseRenew  = 30 * time.Second
	defaultRelayLeaseWindow = 5 * time.Second
	defaultRelayTokenTTL    = 10 * time.Minute
)

// NewRelayOwner creates the product adapter for the shared Relay owner host.
// The host remains idle until StartRemoteHost acquires the mobile-remote
// demand reference, so enabling the desktop feature is the only trigger for
// control-plane polling and Relay credentials.
func (s *Service) NewRelayOwner() (RelayOwnerHost, error) {
	if s == nil || s.DeviceAuthority == nil {
		return nil, errors.New("mobile remote device authority client is unavailable")
	}
	if strings.TrimSpace(s.RuntimeID) == "" {
		return nil, errors.New("mobile remote Relay owner runtime id is required")
	}
	factory := &relayOwnerLifecycleFactory{service: s}
	host, err := relaytransport.NewOwnerHost(relaytransport.OwnerHostConfig{
		LifecycleFactory: factory,
		Handler: relaytransport.StreamHandlerFunc(func(ctx context.Context, stream net.Conn) error {
			return s.handleRelayStream(ctx, stream)
		}),
		StableSessionFor: 30 * time.Second,
		PingInterval:     20 * time.Second,
		PongTimeout:      60 * time.Second,
	})
	if err != nil {
		return nil, err
	}
	return host, nil
}

type relayOwnerLifecycleFactory struct {
	service *Service
	mu      sync.Mutex
	nextID  uint64
}

func (f *relayOwnerLifecycleFactory) NewOwnerLifecycle() relaytransport.OwnerLifecycle {
	f.mu.Lock()
	f.nextID++
	runID := f.nextID
	f.mu.Unlock()
	return &relayOwnerLifecycle{
		runKey:  fmt.Sprintf("mobile-remote-owner-%d", runID),
		service: f.service,
	}
}

type relayOwnerLifecycle struct {
	service *Service
	runKey  string

	mu               sync.Mutex
	ownerUserID      string
	authority        deviceauthority.DeviceAuthorityResult
	identityEnrolled bool
	token            deviceauthority.Token
}

func (l *relayOwnerLifecycle) Prepare(ctx context.Context) (relaytransport.OwnerSession, error) {
	session := relaytransport.OwnerSession{Key: l.runKey, PingPayload: []byte("owner")}
	ownerUserID, err := l.currentOwnerUserID()
	if err != nil {
		return session, err
	}
	runtimeID := strings.TrimSpace(l.service.RuntimeID)
	l.mu.Lock()
	if l.ownerUserID != ownerUserID {
		l.ownerUserID = ownerUserID
		l.authority = deviceauthority.DeviceAuthorityResult{}
		l.identityEnrolled = false
		l.token = deviceauthority.Token{}
	}
	l.mu.Unlock()

	if err := l.ensureAuthority(ctx, ownerUserID, runtimeID); err != nil {
		return session, err
	}
	if err := l.ensureIdentity(ctx, runtimeID); err != nil {
		return session, err
	}
	if err := l.ensureToken(ctx, runtimeID); err != nil {
		return session, err
	}

	l.mu.Lock()
	authority := l.authority
	token := l.token
	l.mu.Unlock()
	session.Dial = relaytransport.DialRequest{
		Endpoint: strings.TrimSpace(authority.Relay.HostEndpoint),
		Query: url.Values{
			"authority_id": []string{strings.TrimSpace(authority.AuthorityID)},
		},
		Header: http.Header{
			"Authorization": []string{"Bearer " + strings.TrimSpace(token.Value)},
		},
		Subprotocol: relayOwnerSubprotocol,
	}
	return session, nil
}

func (l *relayOwnerLifecycle) Activate(ctx context.Context, _ relaytransport.OwnerSession) (func(), error) {
	l.mu.Lock()
	authority := l.authority
	ownerUserID := l.ownerUserID
	l.mu.Unlock()
	if strings.TrimSpace(authority.AuthorityID) == "" {
		return nil, errors.New("mobile remote Relay authority is unavailable")
	}
	activationCtx, cancel := context.WithTimeout(ctx, defaultRelayLeaseWindow)
	_, err := l.renewLease(activationCtx, authority, ownerUserID)
	cancel()
	if err != nil {
		return nil, fmt.Errorf("activate mobile remote Relay lease: %w", err)
	}
	renewCtx, renewCancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		l.maintainLease(renewCtx, authority, ownerUserID)
	}()
	return func() {
		renewCancel()
		<-done
	}, nil
}

func (l *relayOwnerLifecycle) SessionEnded(_ relaytransport.OwnerSession, err error) {
	var dialErr *relaytransport.DialError
	if !errors.As(err, &dialErr) {
		return
	}
	if dialErr.HTTPStatusCode() != http.StatusUnauthorized && dialErr.HTTPStatusCode() != http.StatusForbidden {
		return
	}
	l.mu.Lock()
	l.token = deviceauthority.Token{}
	l.mu.Unlock()
}

func (*relayOwnerLifecycle) Release(context.Context, relaytransport.OwnerSession) error {
	return nil
}

func (l *relayOwnerLifecycle) currentOwnerUserID() (string, error) {
	if l == nil || l.service == nil || l.service.Account == nil {
		return "", ErrAccountAuthenticationRequired
	}
	session, err := l.service.Account.ReadSession()
	if err != nil {
		return "", err
	}
	if session == nil || strings.TrimSpace(session.Cookie) == "" || strings.TrimSpace(session.UserID) == "" {
		return "", ErrAccountAuthenticationRequired
	}
	return strings.TrimSpace(session.UserID), nil
}

func (l *relayOwnerLifecycle) ensureAuthority(ctx context.Context, ownerUserID, runtimeID string) error {
	l.mu.Lock()
	ready := strings.TrimSpace(l.authority.AuthorityID) != ""
	l.mu.Unlock()
	if ready {
		return nil
	}
	authority, err := l.service.DeviceAuthority.EnsureDeviceAuthority(ctx, deviceauthority.EnsureDeviceAuthorityRequest{
		OwnerUserID: ownerUserID,
		RuntimeID:   runtimeID,
	})
	if err != nil {
		return fmt.Errorf("ensure mobile remote Relay authority: %w", err)
	}
	if err := validateRelayAuthority(authority, ownerUserID, runtimeID, l.service.now()); err != nil {
		return err
	}
	l.mu.Lock()
	l.authority = authority
	l.mu.Unlock()
	return nil
}

func (l *relayOwnerLifecycle) ensureIdentity(ctx context.Context, runtimeID string) error {
	l.mu.Lock()
	if l.identityEnrolled {
		l.mu.Unlock()
		return nil
	}
	authority := l.authority
	l.mu.Unlock()
	identity, err := l.service.DeviceAuthority.RegisterDeviceGatewayIdentity(ctx, deviceauthority.RegisterDeviceGatewayIdentityRequest{
		AuthorityID:     authority.AuthorityID,
		RuntimeID:       runtimeID,
		EnrollmentProof: authority.GatewayEnrollment.Proof,
	})
	if err != nil {
		// Enrollment proofs are single-use. A lost response must force a fresh
		// authority projection instead of replaying the consumed proof.
		l.mu.Lock()
		l.authority = deviceauthority.DeviceAuthorityResult{}
		l.identityEnrolled = false
		l.token = deviceauthority.Token{}
		l.mu.Unlock()
		return fmt.Errorf("register mobile remote Relay identity: %w", err)
	}
	if identity.AuthorityID != authority.AuthorityID || identity.RuntimeID != runtimeID || strings.TrimSpace(identity.KeyID) == "" {
		return errors.New("register mobile remote Relay identity returned an invalid binding")
	}
	l.mu.Lock()
	l.identityEnrolled = true
	l.authority.GatewayEnrollment = deviceauthority.GatewayEnrollment{}
	l.mu.Unlock()
	return nil
}

func (l *relayOwnerLifecycle) ensureToken(ctx context.Context, runtimeID string) error {
	now := l.service.now()
	l.mu.Lock()
	authority := l.authority
	identityEnrolled := l.identityEnrolled
	token := l.token
	l.mu.Unlock()
	if !identityEnrolled {
		return errors.New("mobile remote Relay identity is not enrolled")
	}
	if strings.TrimSpace(token.Value) != "" {
		if expiresAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(token.ExpiresAt)); err == nil && expiresAt.After(now.Add(2*time.Minute)) {
			return nil
		}
	}
	issued, err := l.service.DeviceAuthority.IssueDeviceGatewayOwnerTunnelToken(ctx, deviceauthority.IssueDeviceGatewayOwnerTunnelTokenRequest{
		AuthorityID:      authority.AuthorityID,
		RuntimeID:        runtimeID,
		SupportedTargets: []string{deviceGatewayTarget},
		TTL:              defaultRelayTokenTTL,
	})
	if err != nil {
		return fmt.Errorf("issue mobile remote Relay owner token: %w", err)
	}
	if issued.AuthorityID != authority.AuthorityID || strings.TrimSpace(issued.Token.Value) == "" {
		return errors.New("issue mobile remote Relay owner token returned an invalid binding")
	}
	if _, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(issued.Token.ExpiresAt)); err != nil {
		return fmt.Errorf("parse mobile remote Relay owner token expiry: %w", err)
	}
	l.mu.Lock()
	l.token = issued.Token
	l.mu.Unlock()
	return nil
}

func (l *relayOwnerLifecycle) renewLease(
	ctx context.Context,
	authority deviceauthority.DeviceAuthorityResult,
	ownerUserID string,
) (deviceauthority.RenewDeviceAuthorityLeaseResult, error) {
	ttl := authority.Lease.TTLSeconds
	if ttl <= 0 {
		ttl = int(defaultRelayLeaseRenew.Seconds())
	}
	lease, err := l.service.DeviceAuthority.RenewDeviceAuthorityLease(ctx, deviceauthority.RenewDeviceAuthorityLeaseRequest{
		AuthorityID:       authority.AuthorityID,
		OwnerUserID:       ownerUserID,
		RuntimeID:         strings.TrimSpace(l.service.RuntimeID),
		TTLSeconds:        ttl,
		OwnerTunnelStatus: "connected",
	})
	if err != nil {
		return deviceauthority.RenewDeviceAuthorityLeaseResult{}, err
	}
	if lease.AuthorityID != authority.AuthorityID || strings.TrimSpace(lease.State) != "online" {
		return deviceauthority.RenewDeviceAuthorityLeaseResult{}, errors.New("mobile remote Relay lease is not online")
	}
	return lease, nil
}

func (l *relayOwnerLifecycle) maintainLease(ctx context.Context, authority deviceauthority.DeviceAuthorityResult, ownerUserID string) {
	intervalSeconds := authority.Lease.RenewIntervalSeconds
	if intervalSeconds <= 0 && authority.Lease.TTLSeconds > 0 {
		intervalSeconds = authority.Lease.TTLSeconds / 2
		if intervalSeconds <= 0 {
			intervalSeconds = 1
		}
	}
	interval := time.Duration(intervalSeconds) * time.Second
	if interval <= 0 {
		interval = defaultRelayLeaseRenew
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := l.renewLease(ctx, authority, ownerUserID); err != nil && !errors.Is(err, context.Canceled) {
				// The owner tunnel remains transport-owned. Clear the cached token so
				// the next reconnect cannot reuse credentials issued before a failed
				// lease renewal.
				l.mu.Lock()
				l.token = deviceauthority.Token{}
				l.mu.Unlock()
			}
		}
	}
}

func validateRelayAuthority(authority deviceauthority.DeviceAuthorityResult, ownerUserID, runtimeID string, now time.Time) error {
	if strings.TrimSpace(authority.AuthorityID) == "" || strings.TrimSpace(authority.OwnerUserID) != ownerUserID || strings.TrimSpace(authority.RuntimeID) != runtimeID {
		return errors.New("mobile remote Relay authority returned an invalid owner binding")
	}
	if err := validateRelayEndpoint(authority.Relay.HostEndpoint); err != nil {
		return fmt.Errorf("mobile remote Relay owner endpoint is invalid: %w", err)
	}
	if strings.TrimSpace(authority.GatewayEnrollment.Proof) == "" {
		return errors.New("mobile remote Relay enrollment proof is missing")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(authority.GatewayEnrollment.ExpiresAt))
	if err != nil || !expiresAt.After(now) {
		return errors.New("mobile remote Relay enrollment proof is expired")
	}
	return nil
}

func validateRelayEndpoint(value string) error {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil {
		return err
	}
	if parsed.Scheme != "ws" && parsed.Scheme != "wss" {
		return fmt.Errorf("scheme %q is not ws or wss", parsed.Scheme)
	}
	if strings.TrimSpace(parsed.Host) == "" || parsed.User != nil {
		return errors.New("relay endpoint host or userinfo is invalid")
	}
	return nil
}

type relayStreamPrelude struct {
	Type            string `json:"type"`
	ProtocolVersion string `json:"protocol_version"`
	StreamID        string `json:"stream_id"`
	AuthorityID     string `json:"authority_id"`
	UserID          string `json:"user_id"`
	Target          string `json:"target"`
	Channel         string `json:"channel"`
	RequestID       string `json:"request_id"`
	TokenClaims     struct {
		Scope struct {
			Kind      string `json:"kind"`
			PairingID string `json:"pairing_id"`
		} `json:"scope"`
	} `json:"token_claims"`
}

func readRelayStreamPrelude(reader io.Reader) (relayStreamPrelude, error) {
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return relayStreamPrelude{}, fmt.Errorf("read Relay stream prelude length: %w", err)
	}
	length := binary.BigEndian.Uint32(header[:])
	if length == 0 || length > maxRelayPreludeBytes {
		return relayStreamPrelude{}, fmt.Errorf("relay stream prelude size %d is invalid", length)
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return relayStreamPrelude{}, fmt.Errorf("read relay stream prelude: %w", err)
	}
	var prelude relayStreamPrelude
	if err := json.Unmarshal(payload, &prelude); err != nil {
		return relayStreamPrelude{}, fmt.Errorf("decode relay stream prelude: %w", err)
	}
	return prelude, nil
}

func (s *Service) handleRelayStream(ctx context.Context, stream net.Conn) error {
	if stream == nil {
		return errors.New("mobile remote Relay stream is missing")
	}
	prelude, err := readRelayStreamPrelude(stream)
	if err != nil {
		return err
	}
	if strings.TrimSpace(prelude.Type) != "open_stream" ||
		strings.TrimSpace(prelude.ProtocolVersion) != relayStreamSubprotocol ||
		strings.TrimSpace(prelude.AuthorityID) == "" ||
		strings.TrimSpace(prelude.Target) != deviceGatewayTarget ||
		strings.TrimSpace(prelude.Channel) != "agent" ||
		strings.TrimSpace(prelude.StreamID) == "" || strings.TrimSpace(prelude.RequestID) == "" {
		return errors.New("mobile remote Relay stream prelude is invalid")
	}
	pairingID := strings.TrimSpace(prelude.TokenClaims.Scope.PairingID)
	if strings.TrimSpace(prelude.TokenClaims.Scope.Kind) != "paired_device" || pairingID == "" {
		return errors.New("mobile remote Relay stream scope is invalid")
	}
	if err := s.authorizeRelayPairing(ctx, prelude.UserID, pairingID); err != nil {
		return err
	}
	s.remoteHost.mu.Lock()
	handler := s.remoteHost.handler
	liveEvents := s.remoteHost.liveEvents
	s.remoteHost.mu.Unlock()
	if handler == nil {
		return errors.New("mobile remote handler is unavailable")
	}
	return devicelink.ServeStreamProbe(ctx, stream, func(
		ctx context.Context,
		stream net.Conn,
	) error {
		return serveRemoteStreamWithAgentLive(ctx, stream, handler, pairingID, liveEvents)
	})
}

func (s *Service) authorizeRelayPairing(_ context.Context, targetUserID, pairingID string) error {
	session, err := s.accountSession()
	if err != nil {
		return err
	}
	if strings.TrimSpace(session.UserID) != strings.TrimSpace(targetUserID) {
		return errors.New("mobile remote Relay user scope is invalid")
	}
	s.remoteHost.mu.Lock()
	registeredDeviceID := s.remoteHost.registeredDevice.UserDeviceID
	_, active := s.remoteHost.activePairings[pairingID]
	s.remoteHost.mu.Unlock()
	if active && registeredDeviceID != "" {
		return nil
	}
	return errors.New("mobile remote Relay pairing is no longer active")
}

var _ relaytransport.OwnerLifecycle = (*relayOwnerLifecycle)(nil)
var _ DeviceAuthorityClient = (*deviceauthority.Client)(nil)
