package mobileremote

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"testing"
	"time"

	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
	mobileremotebiz "github.com/tutti-os/tutti/services/tuttid/biz/mobileremote"
)

type stubAccount struct {
	session *authbridge.Session
	err     error
}

func (s stubAccount) ReadSession() (*authbridge.Session, error) {
	return s.session, s.err
}

type stubIdentityStore struct {
	identity mobileremotebiz.DeviceIdentity
	calls    int
}

func (s *stubIdentityStore) LoadOrCreate(context.Context) (mobileremotebiz.DeviceIdentity, error) {
	s.calls++
	return s.identity, nil
}

type stubControlPlane struct {
	registered RegisterDeviceInput
	created    CreateChallengeResult
	confirmed  ConfirmChallengeResult
	secret     string
	signature  []byte
}

func (s *stubControlPlane) RegisterDevice(_ context.Context, _ string, input RegisterDeviceInput) error {
	s.registered = input
	return nil
}

func (s *stubControlPlane) CreateChallenge(context.Context, string, string) (CreateChallengeResult, error) {
	return s.created, nil
}

func (s *stubControlPlane) GetChallenge(context.Context, string, string) (mobileremotebiz.PairingChallenge, error) {
	return s.created.Challenge, nil
}

func (s *stubControlPlane) ConfirmChallenge(_ context.Context, _ string, _ string, secret string, signature []byte) (ConfirmChallengeResult, error) {
	s.secret = secret
	s.signature = append([]byte(nil), signature...)
	return s.confirmed, nil
}

func (*stubControlPlane) ListPairings(context.Context, string) ([]mobileremotebiz.DevicePairing, error) {
	return nil, nil
}

func (*stubControlPlane) RevokePairing(context.Context, string, string) (mobileremotebiz.DevicePairing, error) {
	return mobileremotebiz.DevicePairing{}, nil
}

func TestServiceStartAndConfirmPairing(t *testing.T) {
	t.Parallel()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 23, 10, 0, 0, 0, time.UTC)
	identity := mobileremotebiz.DeviceIdentity{
		DeviceID: "desktop-device", PublicKey: publicKey, PrivateKey: privateKey, CreatedAt: now,
	}
	challenge := mobileremotebiz.PairingChallenge{
		ChallengeID: "challenge-1", TargetUserDeviceID: identity.DeviceID,
		State: "pending", Revision: 1, ExpiresAt: now.Add(5 * time.Minute),
	}
	controlPlane := &stubControlPlane{
		created: CreateChallengeResult{Challenge: challenge, Secret: "pair-secret"},
		confirmed: ConfirmChallengeResult{
			Challenge: challenge,
			Pairing: mobileremotebiz.DevicePairing{
				PairingID: "pairing-1", ControllerUserDeviceID: "phone-device",
				TargetUserDeviceID: identity.DeviceID, State: "active", Revision: 1, ConfirmedAt: now,
			},
		},
	}
	service := &Service{
		Account:    &stubAccount{session: &authbridge.Session{Cookie: "session=cookie"}},
		Identities: &stubIdentityStore{identity: identity}, ControlPlane: controlPlane,
		Metadata: DeviceMetadata{ReportedName: "Mac", Platform: "darwin", Arch: "arm64", ClientVersion: "1.2.3"},
		Now:      func() time.Time { return now },
	}

	started, err := service.StartPairing(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var payload pairingQRPayload
	if err := json.Unmarshal([]byte(started.QRPayload), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Version != 1 || payload.ChallengeID != challenge.ChallengeID || payload.Secret != "pair-secret" {
		t.Fatalf("unexpected QR payload: %+v", payload)
	}
	if !ed25519.Verify(publicKey, identityRegistrationProof(identity.DeviceID, publicKey), controlPlane.registered.Proof) {
		t.Fatal("device registration proof did not verify")
	}

	if _, err := service.ConfirmPairing(context.Background(), challenge.ChallengeID); err != nil {
		t.Fatal(err)
	}
	if controlPlane.secret != "pair-secret" ||
		!ed25519.Verify(publicKey, pairingProof("confirm", challenge.ChallengeID, "pair-secret"), controlPlane.signature) {
		t.Fatal("pairing confirmation proof did not verify")
	}
	if _, err := service.ConfirmPairing(context.Background(), challenge.ChallengeID); !errors.Is(err, ErrPairingSecretUnavailable) {
		t.Fatalf("expected consumed secret error, got %v", err)
	}
}

func TestServiceRequiresAuthenticatedAccountBeforeIdentityAccess(t *testing.T) {
	t.Parallel()
	identities := &stubIdentityStore{}
	service := &Service{
		Account:    &stubAccount{session: &authbridge.Session{}},
		Identities: identities, ControlPlane: &stubControlPlane{},
	}
	if _, err := service.StartPairing(context.Background()); !errors.Is(err, ErrAccountAuthenticationRequired) {
		t.Fatalf("expected account authentication error, got %v", err)
	}
	if identities.calls != 0 {
		t.Fatalf("identity store called %d times before authentication", identities.calls)
	}
}

func TestServiceRejectsExpiredPendingChallenge(t *testing.T) {
	t.Parallel()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 23, 10, 0, 0, 0, time.UTC)
	controlPlane := &stubControlPlane{
		created: CreateChallengeResult{
			Challenge: mobileremotebiz.PairingChallenge{
				ChallengeID: "expired", TargetUserDeviceID: "desktop-device",
				State: "pending", ExpiresAt: now.Add(time.Second),
			},
			Secret: "secret",
		},
	}
	service := &Service{
		Account: &stubAccount{session: &authbridge.Session{Cookie: "session=cookie"}},
		Identities: &stubIdentityStore{identity: mobileremotebiz.DeviceIdentity{
			DeviceID: "desktop-device", PublicKey: publicKey, PrivateKey: privateKey,
		}},
		ControlPlane: controlPlane,
		Now:          func() time.Time { return now },
	}
	if _, err := service.StartPairing(context.Background()); err != nil {
		t.Fatal(err)
	}
	service.Now = func() time.Time { return now.Add(2 * time.Second) }
	if _, err := service.ConfirmPairing(context.Background(), "expired"); !errors.Is(err, ErrPairingSecretUnavailable) {
		t.Fatalf("expected expired secret error, got %v", err)
	}
}
