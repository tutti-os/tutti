package mobileremote

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
	mobileremotebiz "github.com/tutti-os/tutti/services/tuttid/biz/mobileremote"
)

var (
	ErrAccountAuthenticationRequired = errors.New("mobile remote access requires an authenticated account")
	ErrPairingSecretUnavailable      = errors.New("mobile remote pairing secret is unavailable")
)

type AccountSessionSource interface {
	ReadSession() (*authbridge.Session, error)
}

type IdentityStore interface {
	LoadOrCreate(context.Context) (mobileremotebiz.DeviceIdentity, error)
}

type DeviceMetadata struct {
	ReportedName  string
	Platform      string
	Arch          string
	ClientVersion string
}

type StartPairingResult struct {
	Challenge mobileremotebiz.PairingChallenge
	QRPayload string
}

type pendingChallenge struct {
	secret    string
	expiresAt time.Time
}

type Service struct {
	Account      AccountSessionSource
	Identities   IdentityStore
	ControlPlane ControlPlane
	Metadata     DeviceMetadata
	Now          func() time.Time

	mu      sync.Mutex
	pending map[string]pendingChallenge
}

type pairingQRPayload struct {
	Version     int    `json:"version"`
	ChallengeID string `json:"challengeId"`
	Secret      string `json:"secret"`
}

func (s *Service) StartPairing(ctx context.Context) (StartPairingResult, error) {
	session, identity, err := s.readyIdentity(ctx)
	if err != nil {
		return StartPairingResult{}, err
	}
	if err := s.registerIdentity(ctx, session.Cookie, identity); err != nil {
		return StartPairingResult{}, err
	}
	created, err := s.ControlPlane.CreateChallenge(ctx, session.Cookie, identity.DeviceID)
	if err != nil {
		return StartPairingResult{}, err
	}
	payload, err := json.Marshal(pairingQRPayload{
		Version: mobileremotebiz.PairingProtocolVersion, ChallengeID: created.Challenge.ChallengeID, Secret: created.Secret,
	})
	if err != nil {
		return StartPairingResult{}, fmt.Errorf("encode mobile remote pairing QR payload: %w", err)
	}
	s.mu.Lock()
	if s.pending == nil {
		s.pending = make(map[string]pendingChallenge)
	}
	s.removeExpiredLocked(s.now())
	s.pending[created.Challenge.ChallengeID] = pendingChallenge{
		secret: created.Secret, expiresAt: created.Challenge.ExpiresAt,
	}
	s.mu.Unlock()
	return StartPairingResult{Challenge: created.Challenge, QRPayload: string(payload)}, nil
}

func (s *Service) GetChallenge(ctx context.Context, challengeID string) (mobileremotebiz.PairingChallenge, error) {
	session, err := s.accountSession()
	if err != nil {
		return mobileremotebiz.PairingChallenge{}, err
	}
	challengeID = strings.TrimSpace(challengeID)
	if challengeID == "" {
		return mobileremotebiz.PairingChallenge{}, ErrPairingSecretUnavailable
	}
	return s.ControlPlane.GetChallenge(ctx, session.Cookie, challengeID)
}

func (s *Service) ConfirmPairing(ctx context.Context, challengeID string) (ConfirmChallengeResult, error) {
	session, identity, err := s.readyIdentity(ctx)
	if err != nil {
		return ConfirmChallengeResult{}, err
	}
	challengeID = strings.TrimSpace(challengeID)
	s.mu.Lock()
	s.removeExpiredLocked(s.now())
	pending, ok := s.pending[challengeID]
	s.mu.Unlock()
	if !ok || challengeID == "" {
		return ConfirmChallengeResult{}, ErrPairingSecretUnavailable
	}
	signature := ed25519.Sign(identity.PrivateKey, pairingProof("confirm", challengeID, pending.secret))
	confirmed, err := s.ControlPlane.ConfirmChallenge(ctx, session.Cookie, challengeID, pending.secret, signature)
	if err != nil {
		return ConfirmChallengeResult{}, err
	}
	s.mu.Lock()
	delete(s.pending, challengeID)
	s.mu.Unlock()
	return confirmed, nil
}

func (s *Service) ListPairings(ctx context.Context) ([]mobileremotebiz.DevicePairing, error) {
	session, err := s.accountSession()
	if err != nil {
		return nil, err
	}
	pairings, err := s.ControlPlane.ListPairings(ctx, session.Cookie)
	if err == nil && pairings == nil {
		pairings = make([]mobileremotebiz.DevicePairing, 0)
	}
	return pairings, err
}

func (s *Service) RevokePairing(ctx context.Context, pairingID string) (mobileremotebiz.DevicePairing, error) {
	session, err := s.accountSession()
	if err != nil {
		return mobileremotebiz.DevicePairing{}, err
	}
	pairingID = strings.TrimSpace(pairingID)
	if pairingID == "" {
		return mobileremotebiz.DevicePairing{}, errors.New("device pairing id is required")
	}
	return s.ControlPlane.RevokePairing(ctx, session.Cookie, pairingID)
}

func (s *Service) readyIdentity(ctx context.Context) (*authbridge.Session, mobileremotebiz.DeviceIdentity, error) {
	session, err := s.accountSession()
	if err != nil {
		return nil, mobileremotebiz.DeviceIdentity{}, err
	}
	if s.Identities == nil {
		return nil, mobileremotebiz.DeviceIdentity{}, errors.New("mobile remote device identity store is unavailable")
	}
	identity, err := s.Identities.LoadOrCreate(ctx)
	if err != nil {
		return nil, mobileremotebiz.DeviceIdentity{}, err
	}
	if strings.TrimSpace(identity.DeviceID) == "" || len(identity.PrivateKey) != ed25519.PrivateKeySize || len(identity.PublicKey) != ed25519.PublicKeySize {
		return nil, mobileremotebiz.DeviceIdentity{}, errors.New("mobile remote device identity is invalid")
	}
	return session, identity, nil
}

func (s *Service) accountSession() (*authbridge.Session, error) {
	if s == nil || s.Account == nil || s.ControlPlane == nil {
		return nil, errors.New("mobile remote access service is unavailable")
	}
	session, err := s.Account.ReadSession()
	if err != nil {
		return nil, err
	}
	if session == nil || strings.TrimSpace(session.Cookie) == "" {
		return nil, ErrAccountAuthenticationRequired
	}
	return session, nil
}

func (s *Service) registerIdentity(ctx context.Context, cookie string, identity mobileremotebiz.DeviceIdentity) error {
	publicKey := append([]byte(nil), identity.PublicKey...)
	proof := ed25519.Sign(identity.PrivateKey, identityRegistrationProof(identity.DeviceID, publicKey))
	return s.ControlPlane.RegisterDevice(ctx, cookie, RegisterDeviceInput{
		DeviceID: identity.DeviceID, ReportedName: s.Metadata.ReportedName,
		Platform: s.Metadata.Platform, Arch: s.Metadata.Arch, ClientVersion: s.Metadata.ClientVersion,
		Algorithm: mobileremotebiz.IdentityAlgorithmEd25519, PublicKey: publicKey, Proof: proof,
	})
}

func identityRegistrationProof(deviceID string, publicKey []byte) []byte {
	return []byte("tutti-device-identity/1\nregister\n" + strings.TrimSpace(deviceID) + "\n" +
		mobileremotebiz.IdentityAlgorithmEd25519 + "\n" + base64.RawURLEncoding.EncodeToString(publicKey))
}

func pairingProof(action, challengeID, secret string) []byte {
	return []byte("tutti-device-pairing/1\n" + strings.TrimSpace(action) + "\n" +
		strings.TrimSpace(challengeID) + "\n" + strings.TrimSpace(secret))
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) removeExpiredLocked(now time.Time) {
	for challengeID, pending := range s.pending {
		if !pending.expiresAt.After(now) {
			delete(s.pending, challengeID)
		}
	}
}
