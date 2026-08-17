package mobileremote

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
	deviceauthority "github.com/tutti-os/tutti/packages/clients/device-authority-go"
	devicelink "github.com/tutti-os/tutti/packages/device-link"
	"github.com/tutti-os/tutti/packages/device-link/relaytransport"
	mobileremotebiz "github.com/tutti-os/tutti/services/tuttid/biz/mobileremote"
)

func TestRelayOwnerLifecyclePreparesAndActivatesBoundSession(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	account := &relayOwnerTestAccount{session: &authbridge.Session{
		UserID: "user-1",
		Cookie: "session_id=session-1",
	}}
	controlPlane := &relayOwnerTestAuthority{
		authority: deviceauthority.DeviceAuthorityResult{
			AuthorityID: "authority-1",
			OwnerUserID: "user-1",
			RuntimeID:   "runtime-1",
			Relay: deviceauthority.RelayDescriptor{
				HostEndpoint: "wss://relay.example.test/owner",
				DialEndpoint: "wss://relay.example.test/dial",
			},
			Lease: deviceauthority.LeasePolicy{
				TTLSeconds:           120,
				RenewIntervalSeconds: 120,
			},
			GatewayEnrollment: deviceauthority.GatewayEnrollment{
				Proof:     "enrollment-proof",
				ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano),
			},
		},
		token: deviceauthority.Token{
			Value:     "owner-token",
			ExpiresAt: now.Add(9 * time.Minute).Format(time.RFC3339Nano),
		},
		lease: deviceauthority.RenewDeviceAuthorityLeaseResult{
			AuthorityID: "authority-1",
			State:       "online",
			RenewedAt:   now.Format(time.RFC3339Nano),
			ExpiresAt:   now.Add(2 * time.Minute).Format(time.RFC3339Nano),
		},
	}
	service := &Service{
		Account:         account,
		ControlPlane:    &relayOwnerTestControlPlane{},
		DeviceAuthority: controlPlane,
		RuntimeID:       "runtime-1",
	}
	lifecycle := (&relayOwnerLifecycleFactory{service: service}).NewOwnerLifecycle()
	session, err := lifecycle.Prepare(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if session.Key == "" || session.Dial.Endpoint != "wss://relay.example.test/owner" ||
		session.Dial.Query.Get("authority_id") != "authority-1" ||
		session.Dial.Header.Get("Authorization") != "Bearer owner-token" ||
		session.Dial.Subprotocol != relayOwnerSubprotocol {
		t.Fatalf("owner session = %#v, want bound Relay dial material", session)
	}
	if controlPlane.ensureCalls != 1 || controlPlane.registerCalls != 1 || controlPlane.tokenCalls != 1 {
		t.Fatalf("authority calls = ensure=%d register=%d token=%d, want one each", controlPlane.ensureCalls, controlPlane.registerCalls, controlPlane.tokenCalls)
	}
	activation, err := lifecycle.Activate(context.Background(), session)
	if err != nil {
		t.Fatal(err)
	}
	if activation.Readiness == nil {
		t.Fatal("Activate() returned nil readiness")
	}
	if controlPlane.renewCalls != 1 {
		t.Fatalf("lease renew calls = %d, want activation renewal", controlPlane.renewCalls)
	}
	activation.Deactivate()
}

func TestRelayOwnerLifecycleReusesAuthorityAndTokenAcrossReconnects(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	controlPlane := newRelayOwnerTestAuthority(now)
	service := &Service{
		Account:         &relayOwnerTestAccount{session: &authbridge.Session{UserID: "user-1", Cookie: "cookie"}},
		ControlPlane:    &relayOwnerTestControlPlane{},
		DeviceAuthority: controlPlane,
		RuntimeID:       "runtime-1",
	}
	lifecycle := (&relayOwnerLifecycleFactory{service: service}).NewOwnerLifecycle()
	if _, err := lifecycle.Prepare(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := lifecycle.Prepare(context.Background()); err != nil {
		t.Fatal(err)
	}
	if controlPlane.ensureCalls != 1 || controlPlane.registerCalls != 1 || controlPlane.tokenCalls != 1 {
		t.Fatalf("reconnect calls = ensure=%d register=%d token=%d, want one each", controlPlane.ensureCalls, controlPlane.registerCalls, controlPlane.tokenCalls)
	}
}

func TestLeaseRenewWaitDoesNotTruncateOneSecondTTL(t *testing.T) {
	now := time.Unix(0, 0)
	got := leaseRenewWait(now, now.Add(time.Second), deviceauthority.LeasePolicy{TTLSeconds: 1})
	if got != 500*time.Millisecond {
		t.Fatalf("leaseRenewWait() = %s, want 500ms", got)
	}
}

func TestRelayOwnerLeaseTransientFailureKeepsReadinessAndConnectionGeneration(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	controlPlane := newRelayOwnerTestAuthority(now)
	controlPlane.authority.Lease = deviceauthority.LeasePolicy{TTLSeconds: 1, RenewIntervalSeconds: 1}
	controlPlane.lease.ExpiresAt = now.Add(250 * time.Millisecond).Format(time.RFC3339Nano)
	controlPlane.renewErrors = map[int]error{2: errors.New("temporary control-plane network failure")}
	controlPlane.renewResults = map[int]deviceauthority.RenewDeviceAuthorityLeaseResult{
		3: {
			AuthorityID: "authority-1", State: "online",
			ExpiresAt: time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano),
		},
	}
	service := &Service{
		Account:         &relayOwnerTestAccount{session: &authbridge.Session{UserID: "user-1", Cookie: "cookie"}},
		ControlPlane:    &relayOwnerTestControlPlane{},
		DeviceAuthority: controlPlane,
		RuntimeID:       "runtime-1",
	}
	lifecycle := (&relayOwnerLifecycleFactory{service: service}).NewOwnerLifecycle()
	if _, err := lifecycle.Prepare(context.Background()); err != nil {
		t.Fatal(err)
	}
	activation, err := lifecycle.Activate(context.Background(), relaytransport.OwnerSession{})
	if err != nil {
		t.Fatal(err)
	}
	defer activation.Deactivate()
	select {
	case <-activation.Readiness.Done():
		t.Fatalf("readiness ended after transient renewal failure: %v", context.Cause(activation.Readiness))
	case <-time.After(350 * time.Millisecond):
	}
	if got := controlPlane.renewCount(); got < 3 {
		t.Fatalf("renew calls = %d, want transient retry and recovery", got)
	}
	select {
	case <-activation.Readiness.Done():
		t.Fatalf("readiness ended after recovery: %v", context.Cause(activation.Readiness))
	default:
	}
}

func TestRelayOwnerLeaseExpiryEndsReadiness(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	controlPlane := newRelayOwnerTestAuthority(now)
	controlPlane.authority.Lease = deviceauthority.LeasePolicy{TTLSeconds: 1, RenewIntervalSeconds: 1}
	controlPlane.lease.ExpiresAt = now.Add(180 * time.Millisecond).Format(time.RFC3339Nano)
	controlPlane.renewErrors = map[int]error{
		2: errors.New("temporary control-plane network failure"),
		3: errors.New("temporary control-plane network failure"),
	}
	service := &Service{
		Account:         &relayOwnerTestAccount{session: &authbridge.Session{UserID: "user-1", Cookie: "cookie"}},
		ControlPlane:    &relayOwnerTestControlPlane{},
		DeviceAuthority: controlPlane,
		RuntimeID:       "runtime-1",
	}
	lifecycle := (&relayOwnerLifecycleFactory{service: service}).NewOwnerLifecycle()
	if _, err := lifecycle.Prepare(context.Background()); err != nil {
		t.Fatal(err)
	}
	activation, err := lifecycle.Activate(context.Background(), relaytransport.OwnerSession{})
	if err != nil {
		t.Fatal(err)
	}
	defer activation.Deactivate()
	select {
	case <-activation.Readiness.Done():
		if !errors.Is(context.Cause(activation.Readiness), errRelayLeaseExpired) {
			t.Fatalf("readiness cause = %v, want lease expiry", context.Cause(activation.Readiness))
		}
	case <-time.After(time.Second):
		t.Fatal("readiness did not end after lease expiry")
	}
}

func TestRelayOwnerLeaseUnauthorizedEndsReadinessAndInvalidatesToken(t *testing.T) {
	now := time.Now().UTC()
	controlPlane := newRelayOwnerTestAuthority(now)
	controlPlane.authority.Lease = deviceauthority.LeasePolicy{TTLSeconds: 1, RenewIntervalSeconds: 1}
	controlPlane.lease.ExpiresAt = now.Add(200 * time.Millisecond).Format(time.RFC3339Nano)
	controlPlane.renewErrors = map[int]error{
		2: &deviceauthority.HTTPError{StatusCode: http.StatusUnauthorized},
	}
	service := &Service{
		Account:         &relayOwnerTestAccount{session: &authbridge.Session{UserID: "user-1", Cookie: "cookie"}},
		ControlPlane:    &relayOwnerTestControlPlane{},
		DeviceAuthority: controlPlane,
		RuntimeID:       "runtime-1",
	}
	lifecycle := (&relayOwnerLifecycleFactory{service: service}).NewOwnerLifecycle().(*relayOwnerLifecycle)
	if _, err := lifecycle.Prepare(context.Background()); err != nil {
		t.Fatal(err)
	}
	activation, err := lifecycle.Activate(context.Background(), relaytransport.OwnerSession{})
	if err != nil {
		t.Fatal(err)
	}
	defer activation.Deactivate()
	select {
	case <-activation.Readiness.Done():
		var httpErr *deviceauthority.HTTPError
		if !errors.As(context.Cause(activation.Readiness), &httpErr) || httpErr.StatusCode != http.StatusUnauthorized {
			t.Fatalf("readiness cause = %v, want unauthorized", context.Cause(activation.Readiness))
		}
	case <-time.After(time.Second):
		t.Fatal("readiness did not end after unauthorized renewal")
	}
	lifecycle.mu.Lock()
	tokenBefore := lifecycle.token.Value
	lifecycle.mu.Unlock()
	if tokenBefore != "" {
		t.Fatalf("cached token after unauthorized renewal = %q, want invalidated", tokenBefore)
	}
	if _, err := lifecycle.Prepare(context.Background()); err != nil {
		t.Fatal(err)
	}
	if controlPlane.tokenCalls != 2 {
		t.Fatalf("token calls after unauthorized renewal = %d, want re-sign", controlPlane.tokenCalls)
	}
}

func TestRemoteHostOwnsRelayDemandOnlyWhileRunning(t *testing.T) {
	t.Parallel()
	demand := &relayOwnerDemandSpy{acquired: make(chan struct{}, 1)}
	service := &Service{RelayOwner: demand}
	service.StartRemoteHost(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	select {
	case <-demand.acquired:
	case <-time.After(time.Second):
		t.Fatal("remote host did not acquire Relay demand")
	}
	service.StartRemoteHost(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	if got := demand.acquireCount(); got != 1 {
		t.Fatalf("Relay acquire count after idempotent start = %d, want 1", got)
	}
	service.StopRemoteHost()
	if got := demand.releaseCount(); got != 1 {
		t.Fatalf("Relay release count after stop = %d, want 1", got)
	}
}

func TestHandleRelayStreamValidatesPreludeAndUsesExistingAgentFraming(t *testing.T) {
	t.Parallel()
	service := &Service{
		Account:      &relayOwnerTestAccount{session: &authbridge.Session{UserID: "user-1", Cookie: "cookie"}},
		ControlPlane: &relayOwnerTestControlPlane{},
		RuntimeID:    "runtime-1",
	}
	service.remoteHost.handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/workspaces" {
			t.Errorf("handler path = %q, want /v1/workspaces", r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	service.remoteHost.registeredDevice = RegisteredDevice{UserDeviceID: "target-device"}
	service.remoteHost.activePairings = map[string]struct{}{"pairing-1": {}}

	owner, caller := net.Pipe()
	defer caller.Close()
	done := make(chan error, 1)
	go func() {
		done <- service.handleRelayStream(context.Background(), owner)
	}()
	writeRelayTestPrelude(t, caller)
	if err := devicelink.ProbeStream(context.Background(), caller); err != nil {
		t.Fatalf("probe Relay stream: %v", err)
	}
	if err := writeRemoteFrame(caller, RemoteRequest{
		ProtocolEpoch: ApplicationProtocolEpoch,
		Service:       AgentHTTPService,
		RequestID:     "request-1",
		Method:        http.MethodGet,
		Path:          "/v1/workspaces",
	}); err != nil {
		t.Fatal(err)
	}
	var response RemoteResponse
	if err := readRemoteFrame(caller, maxRemoteResponseFrameBytes, &response); err != nil {
		t.Fatal(err)
	}
	if response.Status != http.StatusNoContent || response.RequestID != "request-1" {
		t.Fatalf("Relay Agent response = %#v, want 204/request-1", response)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func writeRelayTestPrelude(t *testing.T, writer io.Writer) {
	writeRelayTestPreludeWith(t, writer, func(*relayStreamPrelude) {})
}

func writeRelayTestPreludeWith(t *testing.T, writer io.Writer, mutate func(*relayStreamPrelude)) {
	t.Helper()
	prelude := relayStreamPrelude{
		Type:            "open_stream",
		ProtocolVersion: relayStreamSubprotocol,
		StreamID:        "stream-1",
		AuthorityID:     "authority-1",
		UserID:          "user-1",
		Target:          deviceGatewayTarget,
		Channel:         "agent",
		RequestID:       "request-1",
	}
	prelude.TokenClaims.Scope.Kind = "paired_device"
	prelude.TokenClaims.Scope.PairingID = "pairing-1"
	mutate(&prelude)
	payload, err := json.Marshal(prelude)
	if err != nil {
		t.Fatal(err)
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := writer.Write(header[:]); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(payload); err != nil {
		t.Fatal(err)
	}
}

func TestHandleRelayStreamRejectsInvalidPreludeScope(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		mutate func(*relayStreamPrelude)
		want   string
	}{
		{
			name: "empty authority",
			mutate: func(prelude *relayStreamPrelude) {
				prelude.AuthorityID = " "
			},
			want: "prelude is invalid",
		},
		{
			name: "wrong scope kind",
			mutate: func(prelude *relayStreamPrelude) {
				prelude.TokenClaims.Scope.Kind = "room"
			},
			want: "scope is invalid",
		},
		{
			name: "wrong user",
			mutate: func(prelude *relayStreamPrelude) {
				prelude.UserID = "user-2"
			},
			want: "user scope is invalid",
		},
		{
			name: "revoked pairing",
			mutate: func(prelude *relayStreamPrelude) {
				prelude.TokenClaims.Scope.PairingID = "pairing-revoked"
			},
			want: "pairing is no longer active",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &Service{
				Account:      &relayOwnerTestAccount{session: &authbridge.Session{UserID: "user-1", Cookie: "cookie"}},
				ControlPlane: &relayOwnerTestControlPlane{},
				RuntimeID:    "runtime-1",
			}
			service.remoteHost.registeredDevice = RegisteredDevice{UserDeviceID: "target-device"}
			service.remoteHost.activePairings = map[string]struct{}{"pairing-1": {}}

			owner, caller := net.Pipe()
			done := make(chan error, 1)
			go func() {
				done <- service.handleRelayStream(context.Background(), owner)
			}()
			writeRelayTestPreludeWith(t, caller, test.mutate)
			_ = caller.Close()
			defer owner.Close()
			if err := <-done; err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("handleRelayStream() error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func newRelayOwnerTestAuthority(now time.Time) *relayOwnerTestAuthority {
	return &relayOwnerTestAuthority{
		authority: deviceauthority.DeviceAuthorityResult{
			AuthorityID: "authority-1",
			OwnerUserID: "user-1",
			RuntimeID:   "runtime-1",
			Relay:       deviceauthority.RelayDescriptor{HostEndpoint: "wss://relay.example.test/owner"},
			Lease:       deviceauthority.LeasePolicy{TTLSeconds: 60, RenewIntervalSeconds: 60},
			GatewayEnrollment: deviceauthority.GatewayEnrollment{
				Proof: "proof", ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano),
			},
		},
		token: deviceauthority.Token{
			Value: "token", ExpiresAt: now.Add(9 * time.Minute).Format(time.RFC3339Nano),
		},
		lease: deviceauthority.RenewDeviceAuthorityLeaseResult{
			AuthorityID: "authority-1", State: "online",
			RenewedAt: now.Format(time.RFC3339Nano), ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano),
		},
	}
}

type relayOwnerTestAccount struct {
	session *authbridge.Session
}

func (a *relayOwnerTestAccount) ReadSession() (*authbridge.Session, error) {
	return a.session, nil
}

type relayOwnerTestAuthority struct {
	mu sync.Mutex

	authority     deviceauthority.DeviceAuthorityResult
	token         deviceauthority.Token
	lease         deviceauthority.RenewDeviceAuthorityLeaseResult
	ensureCalls   int
	registerCalls int
	tokenCalls    int
	renewCalls    int
	renewErrors   map[int]error
	renewResults  map[int]deviceauthority.RenewDeviceAuthorityLeaseResult
}

func (c *relayOwnerTestAuthority) EnsureDeviceAuthority(context.Context, deviceauthority.EnsureDeviceAuthorityRequest) (deviceauthority.DeviceAuthorityResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ensureCalls++
	return c.authority, nil
}

func (c *relayOwnerTestAuthority) RegisterDeviceGatewayIdentity(context.Context, deviceauthority.RegisterDeviceGatewayIdentityRequest) (deviceauthority.DeviceGatewayIdentityResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.registerCalls++
	return deviceauthority.DeviceGatewayIdentityResult{AuthorityID: "authority-1", RuntimeID: "runtime-1", KeyID: "key-1"}, nil
}

func (c *relayOwnerTestAuthority) IssueDeviceGatewayOwnerTunnelToken(context.Context, deviceauthority.IssueDeviceGatewayOwnerTunnelTokenRequest) (deviceauthority.DeviceGatewayOwnerTunnelTokenResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.tokenCalls++
	return deviceauthority.DeviceGatewayOwnerTunnelTokenResult{AuthorityID: "authority-1", Token: c.token}, nil
}

func (c *relayOwnerTestAuthority) RenewDeviceAuthorityLease(context.Context, deviceauthority.RenewDeviceAuthorityLeaseRequest) (deviceauthority.RenewDeviceAuthorityLeaseResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.renewCalls++
	if err := c.renewErrors[c.renewCalls]; err != nil {
		return deviceauthority.RenewDeviceAuthorityLeaseResult{}, err
	}
	if lease, ok := c.renewResults[c.renewCalls]; ok {
		return lease, nil
	}
	return c.lease, nil
}

func (c *relayOwnerTestAuthority) renewCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.renewCalls
}

type relayOwnerTestControlPlane struct{}

func (*relayOwnerTestControlPlane) RegisterDevice(context.Context, string, RegisterDeviceInput) (RegisteredDevice, error) {
	return RegisteredDevice{}, nil
}
func (*relayOwnerTestControlPlane) CreateChallenge(context.Context, string, string) (CreateChallengeResult, error) {
	return CreateChallengeResult{}, nil
}
func (*relayOwnerTestControlPlane) GetChallenge(context.Context, string, string) (mobileremotebiz.PairingChallenge, error) {
	return mobileremotebiz.PairingChallenge{}, nil
}
func (*relayOwnerTestControlPlane) ConfirmChallenge(context.Context, string, string, string, []byte) (ConfirmChallengeResult, error) {
	return ConfirmChallengeResult{}, nil
}
func (*relayOwnerTestControlPlane) ListPairings(context.Context, string) ([]mobileremotebiz.DevicePairing, error) {
	return nil, nil
}
func (*relayOwnerTestControlPlane) RevokePairing(context.Context, string, string) (mobileremotebiz.DevicePairing, error) {
	return mobileremotebiz.DevicePairing{}, nil
}
func (*relayOwnerTestControlPlane) ListDeviceLinkAttempts(context.Context, string, string, string, []byte) ([]DeviceLinkAttempt, error) {
	return nil, nil
}
func (*relayOwnerTestControlPlane) UpdateDeviceLinkParticipant(context.Context, string, string, string, string, DeviceLinkParticipantInput) (DeviceLinkAttempt, error) {
	return DeviceLinkAttempt{}, nil
}

var _ DeviceAuthorityClient = (*relayOwnerTestAuthority)(nil)
var _ ControlPlane = (*relayOwnerTestControlPlane)(nil)

type relayOwnerDemandSpy struct {
	mu       sync.Mutex
	acquires int
	releases int
	acquired chan struct{}
}

func (s *relayOwnerDemandSpy) Acquire(context.Context, string) error {
	s.mu.Lock()
	s.acquires++
	s.mu.Unlock()
	s.acquired <- struct{}{}
	return nil
}

func (s *relayOwnerDemandSpy) Release(string) error {
	s.mu.Lock()
	s.releases++
	s.mu.Unlock()
	return nil
}

func (s *relayOwnerDemandSpy) acquireCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.acquires
}

func (s *relayOwnerDemandSpy) releaseCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.releases
}
