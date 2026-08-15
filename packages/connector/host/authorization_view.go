package host

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

const AuthorizationViewProtocolV2 = "tutti.connector.authorization.view.v2"

const (
	AuthorizationViewTypeExternalLink = "external_link"
	AuthorizationViewTypeEmbeddedPage = "embedded_page"
	AuthorizationViewTypeQRCode       = "qr_code"
	AuthorizationQRCodeSourcePayload  = "payload"
)

// AuthorizationViewEnvelope is the host-neutral runtime presentation produced
// after provider output has passed host URL policy. Connector-owned static
// interactions and runtime views converge on the same renderer protocol.
type AuthorizationViewEnvelope struct {
	Protocol string            `json:"protocol"`
	ViewID   string            `json:"viewId"`
	View     AuthorizationView `json:"view"`
}

type AuthorizationView struct {
	Type      string                     `json:"type"`
	FlowID    string                     `json:"flowId,omitempty"`
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
	viewType := AuthorizationViewTypeExternalLink
	if managed := release.Manifest.Implementation.ManagedStdio; managed != nil && managed.CredentialBroker != nil {
		switch managed.CredentialBroker.Presentation {
		case CredentialBrokerPresentationEmbeddedPage:
			viewType = AuthorizationViewTypeEmbeddedPage
		case CredentialBrokerPresentationQRCode:
			viewType = AuthorizationViewTypeQRCode
		}
	}
	flowDigest := sha256.Sum256([]byte(session.SessionID))
	viewDigest := sha256.Sum256([]byte(session.SessionID + "\x00" + session.AuthorizationURL))
	view := AuthorizationView{Type: viewType}
	if viewType == AuthorizationViewTypeQRCode {
		view.Source = &AuthorizationQRCodeSource{Type: AuthorizationQRCodeSourcePayload, Value: session.AuthorizationURL}
	} else {
		view.URL = session.AuthorizationURL
	}
	if viewType == AuthorizationViewTypeEmbeddedPage {
		view.FlowID = "authorization-flow-" + hex.EncodeToString(flowDigest[:16])
	}
	if !session.ExpiresAt.IsZero() {
		view.ExpiresAt = session.ExpiresAt.UTC().Format("2006-01-02T15:04:05.999999999Z07:00")
	}
	return &AuthorizationViewEnvelope{
		Protocol: AuthorizationViewProtocolV2,
		ViewID:   "authorization-" + hex.EncodeToString(viewDigest[:16]),
		View:     view,
	}
}
