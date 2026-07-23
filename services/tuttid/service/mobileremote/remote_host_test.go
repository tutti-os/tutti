package mobileremote

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
	authenticatedlink "github.com/tutti-os/tutti/packages/device-link/authenticated"
	mobileremotebiz "github.com/tutti-os/tutti/services/tuttid/biz/mobileremote"
)

type remoteHostControlPlane struct {
	mu          sync.Mutex
	attempt     DeviceLinkAttempt
	identityKey ed25519.PublicKey
	registered  chan struct{}
	updated     chan DeviceLinkAttempt
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
	return []DeviceLinkAttempt{c.attempt}, nil
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
	updated := c.attempt
	c.mu.Unlock()
	c.updated <- updated
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
		identityKey: publicKey, registered: make(chan struct{}, 1), updated: make(chan DeviceLinkAttempt, 1),
		attempt: DeviceLinkAttempt{
			AttemptID: "attempt-1", PairingID: "pairing-1",
			CallerDeviceID: "phone-device", CallerFingerprint: callerDescription.Fingerprint,
			CallerProtocolVersion: deviceLinkProtocolVersion,
			CallerICE: &DeviceLinkICEParams{
				Ufrag: callerDescription.Ufrag, Pwd: callerDescription.Pwd,
				Candidates: append([]string(nil), callerDescription.Candidates...),
			},
			OwnerDeviceID: "desktop-device", State: "awaiting_owner",
			ExpiresAt: attemptExpiry.UTC().Format(time.RFC3339Nano),
		},
	}
	service := &Service{
		Account: &stubAccount{session: &authbridge.Session{
			SessionID: "account-session", Cookie: "session=cookie",
		}},
		Identities: &stubIdentityStore{identity: mobileremotebiz.DeviceIdentity{
			DeviceID: "desktop-device", PublicKey: publicKey, PrivateKey: privateKey,
		}},
		ControlPlane:       controlPlane,
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
	link, err := caller.Connect(ctx, authenticatedlink.Description{
		Fingerprint: updated.OwnerFingerprint, Ufrag: owner.Ufrag, Pwd: owner.Pwd,
		Candidates: append([]string(nil), owner.Candidates...),
	}, authenticatedlink.RoleCaller)
	if err != nil {
		t.Fatal(err)
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
	service.remoteHost.attempts = map[string]activeRemoteAttempt{
		"attempt-1": {generation: 2},
	}
	service.finishRemoteAttempt("attempt-1", 1)
	if _, exists := service.remoteHost.attempts["attempt-1"]; !exists {
		t.Fatal("old worker cleanup deleted the newer attempt generation")
	}
	service.finishRemoteAttempt("attempt-1", 2)
	if _, exists := service.remoteHost.attempts["attempt-1"]; exists {
		t.Fatal("current worker cleanup did not delete its attempt")
	}
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
