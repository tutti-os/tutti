package mobileremote

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	agenthttpx "github.com/tutti-os/tutti/packages/agent/daemon/httpx"
	deviceauthority "github.com/tutti-os/tutti/packages/clients/device-authority-go"
)

// NewDeviceAuthorityClient adapts the existing desktop account cookie and
// mobile identity store to the shared Device Authority client. The returned
// client never stores the cookie; every request resolves the current session.
func NewDeviceAuthorityClient(
	baseURL string,
	account AccountSessionSource,
	identities IdentityStore,
) (*deviceauthority.Client, error) {
	controlBase, apiPrefix, err := splitControlPlaneURL(baseURL)
	if err != nil {
		return nil, err
	}
	if account == nil {
		return nil, errors.New("mobile remote Device Authority account source is required")
	}
	if identities == nil {
		return nil, errors.New("mobile remote Device Authority identity store is required")
	}
	return deviceauthority.NewClient(deviceauthority.Config{
		BaseURL:    controlBase,
		APIPrefix:  apiPrefix,
		HTTPClient: agenthttpx.NewClient(15 * time.Second),
		Identities: deviceAuthorityIdentitySource{store: identities},
		PrepareRequest: func(req *http.Request, _ deviceauthority.RequestMetadata) error {
			session, err := account.ReadSession()
			if err != nil {
				return err
			}
			if session == nil || strings.TrimSpace(session.Cookie) == "" {
				return ErrAccountAuthenticationRequired
			}
			req.Header.Set("Cookie", strings.TrimSpace(session.Cookie))
			return nil
		},
	})
}

type deviceAuthorityIdentitySource struct {
	store IdentityStore
}

func (s deviceAuthorityIdentitySource) Identity(ctx context.Context, runtimeID string) (deviceauthority.SigningIdentity, error) {
	if s.store == nil {
		return deviceauthority.SigningIdentity{}, errors.New("mobile remote Device Authority identity store is unavailable")
	}
	identity, err := s.store.LoadOrCreate(ctx)
	if err != nil {
		return deviceauthority.SigningIdentity{}, err
	}
	if strings.TrimSpace(identity.DeviceID) != strings.TrimSpace(runtimeID) ||
		len(identity.PrivateKey) != ed25519.PrivateKeySize || len(identity.PublicKey) != ed25519.PublicKeySize {
		return deviceauthority.SigningIdentity{}, errors.New("mobile remote Device Authority identity is invalid")
	}
	privateKey := append(ed25519.PrivateKey(nil), identity.PrivateKey...)
	if publicKey, ok := privateKey.Public().(ed25519.PublicKey); !ok || len(publicKey) != ed25519.PublicKeySize || !bytes.Equal(publicKey, identity.PublicKey) {
		return deviceauthority.SigningIdentity{}, errors.New("mobile remote Device Authority identity public key is invalid")
	}
	return deviceauthority.SigningIdentity{
		KeyID:  deviceauthority.GatewayIdentityKeyID(identity.PublicKey),
		Signer: privateKey,
	}, nil
}

func splitControlPlaneURL(raw string) (string, string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		value = DefaultControlPlaneBaseURL
	}
	parsed, err := url.Parse(strings.TrimRight(value, "/"))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", "", fmt.Errorf("mobile remote control-plane URL is invalid")
	}
	prefix := strings.TrimRight(parsed.EscapedPath(), "/")
	if prefix == "" {
		prefix = "/v1"
	}
	base := parsed.Scheme + "://" + parsed.Host
	return base, prefix, nil
}

var _ deviceauthority.IdentitySource = deviceAuthorityIdentitySource{}
