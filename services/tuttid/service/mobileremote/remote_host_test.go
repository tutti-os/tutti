package mobileremote

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
	devicelink "github.com/tutti-os/tutti/packages/device-link"
	authenticatedlink "github.com/tutti-os/tutti/packages/device-link/authenticated"
	"github.com/tutti-os/tutti/packages/device-link/linkmanager"
	mobileremotebiz "github.com/tutti-os/tutti/services/tuttid/biz/mobileremote"
)

type remoteHostControlPlane struct {
	mu          sync.Mutex
	attempt     DeviceLinkAttempt
	identityKey ed25519.PublicKey
	registered  chan struct{}
	updated     chan DeviceLinkAttempt
}

func cloneRemoteHostAttempt(attempt DeviceLinkAttempt) DeviceLinkAttempt {
	attempt.STUNEndpoints = append([]string{}, attempt.STUNEndpoints...)
	if attempt.CallerICE != nil {
		callerICE := *attempt.CallerICE
		callerICE.Candidates = append([]string{}, attempt.CallerICE.Candidates...)
		attempt.CallerICE = &callerICE
	}
	if attempt.OwnerICE != nil {
		ownerICE := *attempt.OwnerICE
		ownerICE.Candidates = append([]string{}, attempt.OwnerICE.Candidates...)
		attempt.OwnerICE = &ownerICE
	}
	return attempt
}

type remoteHostDiagnostics struct {
	events chan RemoteAttemptEvent
}

func (d *remoteHostDiagnostics) Record(event RemoteAttemptEvent) {
	select {
	case d.events <- event:
	default:
	}
}

func (c *remoteHostControlPlane) RegisterDevice(_ context.Context, _ string, input RegisterDeviceInput) (RegisteredDevice, error) {
	if !ed25519.Verify(c.identityKey, identityRegistrationProof(input.DeviceID, input.PublicKey), input.Proof) {
		return RegisteredDevice{}, errTestInvalidProof
	}
	select {
	case c.registered <- struct{}{}:
	default:
	}
	return RegisteredDevice{UserDeviceID: "desktop-user-device", DeviceID: input.DeviceID}, nil
}

func (*remoteHostControlPlane) CreateChallenge(context.Context, string, string) (CreateChallengeResult, error) {
	return CreateChallengeResult{}, nil
}

func (*remoteHostControlPlane) GetChallenge(context.Context, string, string) (mobileremotebiz.PairingChallenge, error) {
	return mobileremotebiz.PairingChallenge{}, nil
}

func (*remoteHostControlPlane) ConfirmChallenge(context.Context, string, string, string, []byte) (ConfirmChallengeResult, error) {
	return ConfirmChallengeResult{}, nil
}

func (*remoteHostControlPlane) ListPairings(context.Context, string) ([]mobileremotebiz.DevicePairing, error) {
	return []mobileremotebiz.DevicePairing{{
		PairingID: "pairing-1", ControllerUserDeviceID: "phone-user-device",
		TargetUserDeviceID: "desktop-user-device", State: "active",
	}}, nil
}

func (*remoteHostControlPlane) RevokePairing(context.Context, string, string) (mobileremotebiz.DevicePairing, error) {
	return mobileremotebiz.DevicePairing{}, nil
}

func (c *remoteHostControlPlane) ListDeviceLinkAttempts(
	_ context.Context,
	_ string,
	pairingID string,
	deviceID string,
	signature []byte,
) ([]DeviceLinkAttempt, error) {
	if pairingID != "pairing-1" || deviceID != "desktop-device" ||
		!ed25519.Verify(c.identityKey, deviceLinkProof("list", pairingID, "", ""), signature) {
		return nil, errTestInvalidProof
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return []DeviceLinkAttempt{cloneRemoteHostAttempt(c.attempt)}, nil
}

func (c *remoteHostControlPlane) UpdateDeviceLinkParticipant(
	_ context.Context,
	_ string,
	pairingID string,
	attemptID string,
	deviceID string,
	input DeviceLinkParticipantInput,
) (DeviceLinkAttempt, error) {
	if pairingID != "pairing-1" || attemptID != "attempt-1" || deviceID != "desktop-device" ||
		!ed25519.Verify(c.identityKey, deviceLinkProof("update", pairingID, attemptID, input.Fingerprint), input.IdentitySignature) {
		return DeviceLinkAttempt{}, errTestInvalidProof
	}
	c.mu.Lock()
	c.attempt.OwnerFingerprint = input.Fingerprint
	c.attempt.OwnerProtocolVersion = input.ProtocolVersion
	c.attempt.OwnerICE = &DeviceLinkICEParams{
		Ufrag: input.ICE.Ufrag, Pwd: input.ICE.Pwd,
		Candidates: append([]string(nil), input.ICE.Candidates...),
	}
	c.attempt.State = "ready"
	updated := cloneRemoteHostAttempt(c.attempt)
	c.mu.Unlock()
	select {
	case c.updated <- cloneRemoteHostAttempt(updated):
	default:
	}
	return updated, nil
}

type testProofError string

func (e testProofError) Error() string { return string(e) }

const errTestInvalidProof = testProofError("invalid test proof")

func TestRemoteHostConnectsAuthenticatedLinkAndServesAgentHTTP(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caller, err := authenticatedlink.NewParticipant(authenticatedlink.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer caller.Close()
	callerDescription, err := caller.LocalDescription(ctx)
	if err != nil {
		t.Fatal(err)
	}
	attemptExpiry := time.Now().Add(8 * time.Second)
	controlPlane := &remoteHostControlPlane{
		identityKey: publicKey, registered: make(chan struct{}, 1), updated: make(chan DeviceLinkAttempt, 8),
		attempt: DeviceLinkAttempt{
			AttemptID: "attempt-1", PairingID: "pairing-1",
			CallerDeviceID: "phone-device", CallerFingerprint: callerDescription.Fingerprint,
			CallerProtocolVersion: deviceLinkProtocolVersion,
			CallerICE: &DeviceLinkICEParams{
				Ufrag: callerDescription.Ufrag, Pwd: callerDescription.Pwd,
				Candidates: []string{},
			},
			OwnerDeviceID: "desktop-device", State: "awaiting_owner",
			ExpiresAt: attemptExpiry.UTC().Format(time.RFC3339Nano),
		},
	}
	diagnostics := &remoteHostDiagnostics{events: make(chan RemoteAttemptEvent, 32)}
	service := &Service{
		Account: &stubAccount{session: &authbridge.Session{
			SessionID: "account-session", Cookie: "session=cookie",
		}},
		Identities: &stubIdentityStore{identity: mobileremotebiz.DeviceIdentity{
			DeviceID: "desktop-device", PublicKey: publicKey, PrivateKey: privateKey,
		}},
		ControlPlane:       controlPlane,
		Diagnostics:        diagnostics,
		RemotePollInterval: 10 * time.Millisecond,
		includeLoopback:    true,
	}
	service.StartRemoteHost(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/workspaces" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"workspaces":[{"workspaceId":"workspace-1"}]}`))
	}))
	defer service.Close()

	select {
	case <-controlPlane.registered:
	case <-ctx.Done():
		t.Fatal("desktop was not registered")
	}
	var updated DeviceLinkAttempt
	select {
	case updated = <-controlPlane.updated:
	case <-ctx.Done():
		t.Fatal("owner participant was not published")
	}
	owner := updated.OwnerICE
	if owner == nil {
		t.Fatal("owner ICE description is missing")
	}
	if updated.OwnerFingerprint == "" || owner.Ufrag == "" || owner.Pwd == "" {
		t.Fatalf("initial owner credentials are incomplete: %+v", updated)
	}
	peerDescription := authenticatedlink.Description{
		Fingerprint: updated.OwnerFingerprint, Ufrag: owner.Ufrag, Pwd: owner.Pwd,
		Candidates: append([]string(nil), owner.Candidates...),
	}
	type connectResult struct {
		link *authenticatedlink.Link
		err  error
	}
	connected := make(chan connectResult, 1)
	go func() {
		link, connectErr := caller.Connect(ctx, peerDescription, authenticatedlink.RoleCaller)
		connected <- connectResult{link: link, err: connectErr}
	}()
	controlPlane.mu.Lock()
	controlPlane.attempt.CallerICE.Candidates = append(
		[]string{},
		callerDescription.Candidates...,
	)
	controlPlane.mu.Unlock()
	service.notifyRemoteAttemptChanged("attempt-1")
	refetchedCallerCandidates := false
	for !refetchedCallerCandidates {
		select {
		case event := <-diagnostics.events:
			refetchedCallerCandidates = event.Stage == "caller_candidate_refetch" &&
				event.Outcome == "succeeded"
		case <-ctx.Done():
			t.Fatal("owner did not refetch trickled caller candidates")
		}
	}
	var link *authenticatedlink.Link
	for link == nil {
		select {
		case result := <-connected:
			if result.err != nil {
				t.Fatal(result.err)
			}
			link = result.link
		case candidateUpdate := <-controlPlane.updated:
			if candidateUpdate.OwnerICE != nil {
				caller.AddRemoteCandidates(candidateUpdate.OwnerICE.Candidates)
			}
		case <-ctx.Done():
			t.Fatal("timed out while trickling owner candidates")
		}
	}
	defer link.Close()
	if wait := time.Until(attemptExpiry.Add(100 * time.Millisecond)); wait > 0 {
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			t.Fatal("timed out while waiting for rendezvous attempt expiry")
		case <-timer.C:
		}
	}
	stream, err := link.OpenStream(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := devicelink.ProbeStream(ctx, stream); err != nil {
		t.Fatalf("probe DeviceLink stream: %v", err)
	}
	if err := writeRemoteFrame(stream, RemoteRequest{
		ProtocolEpoch: ApplicationProtocolEpoch, Service: AgentHTTPService,
		RequestID: "request-1", Method: http.MethodGet, Path: "/v1/workspaces",
	}); err != nil {
		t.Fatal(err)
	}
	var response RemoteResponse
	if err := readRemoteFrame(stream, maxRemoteResponseFrameBytes, &response); err != nil {
		t.Fatal(err)
	}
	_ = stream.Close()
	if response.Status != http.StatusOK ||
		!strings.Contains(string(response.Body), `"workspaceId":"workspace-1"`) {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestRemoteHostAttemptCleanupDoesNotDeleteNewGeneration(t *testing.T) {
	t.Parallel()
	service := &Service{}
	service.remoteHost.attemptWake = NewAttemptWake()
	service.remoteHost.attempts = map[string]activeRemoteAttempt{
		"attempt-1": {generation: 2},
	}
	service.remoteHost.attemptWake.Notify("attempt-1")
	service.finishRemoteAttempt("attempt-1", 1)
	if _, exists := service.remoteHost.attempts["attempt-1"]; !exists {
		t.Fatal("old worker cleanup deleted the newer attempt generation")
	}
	if got := service.remoteHost.attemptWake.Version("attempt-1"); got != 1 {
		t.Fatalf("old worker cleanup forgot current wake version: %d", got)
	}
	service.finishRemoteAttempt("attempt-1", 2)
	if _, exists := service.remoteHost.attempts["attempt-1"]; exists {
		t.Fatal("current worker cleanup did not delete its attempt")
	}
	if got := service.remoteHost.attemptWake.Version("attempt-1"); got != 0 {
		t.Fatalf("current worker cleanup retained wake version: %d", got)
	}
}

func TestRemoteHostAttemptChangeWakesDiscoveryAndRendezvous(t *testing.T) {
	service := &Service{}
	service.remoteHost.attemptWake = NewAttemptWake()
	service.remoteHost.pollWake = make(chan struct{}, 1)

	service.notifyRemoteAttemptChanged("attempt-1")

	if got := service.remoteHost.attemptWake.Version("attempt-1"); got != 1 {
		t.Fatalf("attempt wake version = %d, want 1", got)
	}
	select {
	case <-service.remoteHost.pollWake:
	default:
		t.Fatal("attempt change did not wake owner discovery")
	}
}

func TestRemoteHostDisablesSharedAdmissionUntilIdentityRecovers(t *testing.T) {
	t.Parallel()
	service := &Service{}
	service.remoteHost.managedLinks = make(map[string]remoteManagedLink)
	service.remoteHost.observedLinkEvents = make(map[string]uint64)
	service.remoteHost.linkManager = service.newRemoteLinkManager()
	manager := service.remoteHost.linkManager

	service.stopRemoteAttempts(nil)
	if _, err := manager.Admit(context.Background(), "pairing-1"); !errors.Is(err, linkmanager.ErrManagerDisabled) {
		t.Fatalf("Admit while identity unavailable error = %v, want disabled", err)
	}
	service.setRemoteLinkEnabled(true)
	admission, err := manager.Admit(context.Background(), "pairing-1")
	if err != nil {
		t.Fatalf("Admit after identity recovery: %v", err)
	}
	admission.Close()
	if err := manager.WaitForQuiescence(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRemoteHostStartWaitsForInProgressClose(t *testing.T) {
	t.Parallel()
	service := &Service{}
	service.remoteHost.cancel = func() {}
	service.remoteHost.managedLinks = make(map[string]remoteManagedLink)
	service.remoteHost.observedLinkEvents = make(map[string]uint64)
	service.remoteHost.linkManager = service.newRemoteLinkManager()
	admission, err := service.remoteHost.linkManager.Admit(context.Background(), "pairing-1")
	if err != nil {
		t.Fatal(err)
	}

	closed := make(chan struct{})
	go func() {
		service.Close()
		close(closed)
	}()
	waitForRemoteHostCondition(t, func() bool {
		service.remoteHost.mu.Lock()
		defer service.remoteHost.mu.Unlock()
		return service.remoteHost.stopping
	})

	started := make(chan struct{})
	go func() {
		service.StartRemoteHost(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		close(started)
	}()
	select {
	case <-started:
		t.Fatal("StartRemoteHost returned before the previous run closed")
	case <-time.After(20 * time.Millisecond):
	}

	admission.Close()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("Close did not finish after admission release")
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("StartRemoteHost did not resume after Close")
	}
	service.Close()
}

func TestControlPlaneUnauthorizedClassification(t *testing.T) {
	t.Parallel()
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		if !isControlPlaneUnauthorized(&ControlPlaneError{StatusCode: status}) {
			t.Fatalf("status %d was not classified as unauthorized", status)
		}
	}
	if isControlPlaneUnauthorized(&ControlPlaneError{StatusCode: http.StatusInternalServerError}) {
		t.Fatal("server error was classified as unauthorized")
	}
}

func waitForRemoteHostCondition(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("remote host condition was not satisfied")
		}
		time.Sleep(time.Millisecond)
	}
}
