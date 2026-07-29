package devicelink

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"
)

const (
	identityLifetime = 5 * time.Minute
	maxALPNProtocols = 4
)

type Identity struct {
	Certificate tls.Certificate
	Fingerprint string
}

func NewEphemeralIdentity(now time.Time) (Identity, error) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return Identity{}, fmt.Errorf("generate device-link identity: %w", err)
	}
	serialLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialLimit)
	if err != nil {
		return Identity{}, fmt.Errorf("generate device-link certificate serial: %w", err)
	}
	now = now.UTC()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "tutti-device-link-ephemeral"},
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.Add(identityLifetime),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{
			x509.ExtKeyUsageClientAuth,
			x509.ExtKeyUsageServerAuth,
		},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, publicKey, privateKey)
	if err != nil {
		return Identity{}, fmt.Errorf("create device-link certificate: %w", err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return Identity{}, fmt.Errorf("parse device-link certificate: %w", err)
	}
	return Identity{
		Certificate: tls.Certificate{
			Certificate: [][]byte{der},
			PrivateKey:  privateKey,
			Leaf:        leaf,
		},
		Fingerprint: fingerprintSPKI(leaf.RawSubjectPublicKeyInfo),
	}, nil
}

func (i Identity) ClientTLSConfig(expectedPeerFingerprint string) (*tls.Config, error) {
	return i.ClientTLSConfigForProtocols(expectedPeerFingerprint, nil)
}

func (i Identity) ServerTLSConfig(expectedPeerFingerprint string) (*tls.Config, error) {
	return i.ServerTLSConfigForProtocols(expectedPeerFingerprint, nil)
}

// ClientTLSConfigForProtocols builds the pinned client TLS configuration with
// an explicit ordered ALPN compatibility set. An empty set uses the canonical
// DeviceLink ALPN. Product adapters may temporarily include an older protocol
// during a rolling migration without forking certificate or pinning behavior.
func (i Identity) ClientTLSConfigForProtocols(expectedPeerFingerprint string, protocols []string) (*tls.Config, error) {
	return i.tlsConfig(expectedPeerFingerprint, protocols, false)
}

// ServerTLSConfigForProtocols is the server-side counterpart of
// ClientTLSConfigForProtocols.
func (i Identity) ServerTLSConfigForProtocols(expectedPeerFingerprint string, protocols []string) (*tls.Config, error) {
	return i.tlsConfig(expectedPeerFingerprint, protocols, true)
}

func (i Identity) tlsConfig(expectedPeerFingerprint string, protocols []string, server bool) (*tls.Config, error) {
	if len(i.Certificate.Certificate) == 0 || i.Certificate.PrivateKey == nil {
		return nil, errors.New("device-link identity certificate is required")
	}
	protocols, err := normalizeALPNProtocols(protocols)
	if err != nil {
		return nil, err
	}
	expected, err := base64.RawURLEncoding.DecodeString(expectedPeerFingerprint)
	if err != nil || len(expected) != sha256.Size {
		return nil, errors.New("valid peer SPKI fingerprint is required")
	}
	verify := func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		if len(rawCerts) != 1 {
			return fmt.Errorf("device-link peer presented %d certificates, want 1", len(rawCerts))
		}
		certificate, err := x509.ParseCertificate(rawCerts[0])
		if err != nil {
			return fmt.Errorf("parse device-link peer certificate: %w", err)
		}
		if time.Now().Before(certificate.NotBefore) || time.Now().After(certificate.NotAfter) {
			return errors.New("device-link peer certificate is outside its validity window")
		}
		actual := sha256.Sum256(certificate.RawSubjectPublicKeyInfo)
		if !bytes.Equal(actual[:], expected) {
			return errors.New("device-link peer certificate fingerprint mismatch")
		}
		return nil
	}
	config := &tls.Config{
		Certificates:          []tls.Certificate{i.Certificate},
		MinVersion:            tls.VersionTLS13,
		NextProtos:            protocols,
		InsecureSkipVerify:    true, // Verification is the strict SPKI pin above.
		VerifyPeerCertificate: verify,
	}
	if server {
		config.ClientAuth = tls.RequireAnyClientCert
	}
	return config, nil
}

func normalizeALPNProtocols(protocols []string) ([]string, error) {
	if len(protocols) == 0 {
		return []string{ALPN}, nil
	}
	if len(protocols) > maxALPNProtocols {
		return nil, fmt.Errorf("device-link ALPN compatibility set exceeds %d entries", maxALPNProtocols)
	}
	normalized := make([]string, 0, len(protocols))
	seen := make(map[string]struct{}, len(protocols))
	for _, protocol := range protocols {
		protocol = strings.TrimSpace(protocol)
		if protocol == "" || len(protocol) > 255 {
			return nil, errors.New("device-link ALPN protocol must contain 1 to 255 bytes")
		}
		if _, ok := seen[protocol]; ok {
			continue
		}
		seen[protocol] = struct{}{}
		normalized = append(normalized, protocol)
	}
	if len(normalized) == 0 {
		return nil, errors.New("device-link ALPN compatibility set is empty")
	}
	return normalized, nil
}

func fingerprintSPKI(spki []byte) string {
	digest := sha256.Sum256(spki)
	return base64.RawURLEncoding.EncodeToString(digest[:])
}
