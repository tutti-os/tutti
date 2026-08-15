package host

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

const (
	AuthorizationViewProtocolV1       = "tutti.connector.authorization.view.v1"
	AuthorizationViewTypeExternalLink = "external_link"
	AuthorizationViewTypeQRCode       = "qr_code"
	AuthorizationQRCodeSourcePayload  = "payload"
)

// AuthorizationViewEnvelope projects validated provider output into the
// existing host-neutral authorization view protocol.
type AuthorizationViewEnvelope struct {
	Protocol string            `json:"protocol"`
	ViewID   string            `json:"viewId"`
	View     AuthorizationView `json:"view"`
}

type AuthorizationView struct {
	Type      string                     `json:"type"`
	URL       string                     `json:"url,omitempty"`
	Source    *AuthorizationQRCodeSource `json:"source,omitempty"`
	ExpiresAt string                     `json:"expiresAt,omitempty"`
}

type AuthorizationQRCodeSource struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

func authorizationViewForSession(release Release, session AuthorizationSession) *AuthorizationViewEnvelope {
	if session.State != AuthorizationStatePending || strings.TrimSpace(session.AuthorizationURL) == "" {
		return nil
	}

	view := AuthorizationView{Type: AuthorizationViewTypeExternalLink, URL: session.AuthorizationURL}
	managed := release.Manifest.Implementation.ManagedStdio
	if managed != nil && managed.CredentialBroker != nil &&
		managed.CredentialBroker.Presentation == CredentialBrokerPresentationQRCode {
		view = AuthorizationView{
			Type: AuthorizationViewTypeQRCode,
			Source: &AuthorizationQRCodeSource{
				Type:  AuthorizationQRCodeSourcePayload,
				Value: session.AuthorizationURL,
			},
		}
	}
	if !session.ExpiresAt.IsZero() {
		view.ExpiresAt = session.ExpiresAt.UTC().Format("2006-01-02T15:04:05.999999999Z07:00")
	}
	viewDigest := sha256.Sum256([]byte(session.SessionID + "\x00" + session.AuthorizationURL))
	return &AuthorizationViewEnvelope{
		Protocol: AuthorizationViewProtocolV1,
		ViewID:   "authorization-" + hex.EncodeToString(viewDigest[:16]),
		View:     view,
	}
}
