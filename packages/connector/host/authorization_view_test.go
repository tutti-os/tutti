package host

import (
	"testing"
	"time"
)

func TestAuthorizationViewForSessionProjectsQRCodeWithV1Protocol(t *testing.T) {
	release := Release{Manifest: Manifest{Implementation: Implementation{
		Kind: ImplementationKindManagedStdio,
		ManagedStdio: &ManagedStdioImplementation{CredentialBroker: &ManagedCredentialBroker{
			Presentation: CredentialBrokerPresentationQRCode,
		}},
	}}}
	session := AuthorizationSession{
		SessionID:        "session-1",
		AuthorizationURL: "https://work.weixin.qq.com/ai/qc/c?s=payload",
		ExpiresAt:        time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC),
		State:            AuthorizationStatePending,
	}

	view := authorizationViewForSession(release, session)
	if view == nil || view.Protocol != AuthorizationViewProtocolV1 || view.View.Type != AuthorizationViewTypeQRCode {
		t.Fatalf("authorization view = %#v, want V1 QR view", view)
	}
	if view.View.URL != "" || view.View.Source == nil ||
		view.View.Source.Type != AuthorizationQRCodeSourcePayload ||
		view.View.Source.Value != session.AuthorizationURL {
		t.Fatalf("QR source = %#v and URL = %q", view.View.Source, view.View.URL)
	}
}

func TestAuthorizationViewForSessionDoesNotEmbedLegacyPagePresentation(t *testing.T) {
	release := Release{Manifest: Manifest{Implementation: Implementation{
		Kind: ImplementationKindManagedStdio,
		ManagedStdio: &ManagedStdioImplementation{CredentialBroker: &ManagedCredentialBroker{
			Presentation: CredentialBrokerPresentationEmbeddedPage,
		}},
	}}}
	session := AuthorizationSession{
		SessionID:        "session-legacy",
		AuthorizationURL: "https://work.weixin.qq.com/ai/qc/gen?scode=legacy",
		State:            AuthorizationStatePending,
	}

	view := authorizationViewForSession(release, session)
	if view == nil || view.View.Type != AuthorizationViewTypeExternalLink ||
		view.View.URL != session.AuthorizationURL || view.View.Source != nil {
		t.Fatalf("legacy authorization view = %#v, want external link", view)
	}
}
