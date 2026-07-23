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
	"time"
)

const identityLifetime = 5 * time.Minute

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
	return i.tlsConfig(expectedPeerFingerprint, false)
}

func (i Identity) ServerTLSConfig(expectedPeerFingerprint string) (*tls.Config, error) {
	return i.tlsConfig(expectedPeerFingerprint, true)
}

func (i Identity) tlsConfig(expectedPeerFingerprint string, server bool) (*tls.Config, error) {
	if len(i.Certificate.Certificate) == 0 || i.Certificate.PrivateKey == nil {
		return nil, errors.New("device-link identity certificate is required")
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
		NextProtos:            []string{ALPN},
		InsecureSkipVerify:    true, // Verification is the strict SPKI pin above.
		VerifyPeerCertificate: verify,
	}
	if server {
		config.ClientAuth = tls.RequireAnyClientCert
	}
	return config, nil
}

func fingerprintSPKI(spki []byte) string {
	digest := sha256.Sum256(spki)
	return base64.RawURLEncoding.EncodeToString(digest[:])
}
