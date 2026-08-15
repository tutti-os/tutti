package host

import (
	"testing"
	"time"
)

func TestValidAuthorizationURLRequiresCredentialFreeHTTPS(t *testing.T) {
	tests := []struct {
		url   string
		valid bool
	}{
		{url: "https://work.weixin.qq.com/ai/qc/gen?scode=opaque", valid: true},
		{url: "http://work.weixin.qq.com/ai/qc/gen", valid: false},
		{url: "https://user:secret@work.weixin.qq.com/ai/qc/gen", valid: false},
		{url: "/ai/qc/gen", valid: false},
		{url: "", valid: false},
	}
	for _, test := range tests {
		if got := validAuthorizationURL(test.url); got != test.valid {
			t.Errorf("validAuthorizationURL(%q) = %t, want %t", test.url, got, test.valid)
		}
	}
}

func TestAuthorizationViewForSessionNormalizesRuntimeURL(t *testing.T) {
	release := testReleaseWithImplementation("wecom-cli", "1.0.0", ImplementationKindManagedStdio)
	release.Manifest.Implementation.ManagedStdio.CredentialBroker = &ManagedCredentialBroker{
		Presentation: CredentialBrokerPresentationEmbeddedPage,
	}
	expiresAt := time.Date(2026, 8, 15, 7, 0, 0, 0, time.FixedZone("UTC+8", 8*60*60))
	session := AuthorizationSession{
		SessionID:        "session-1",
		AuthorizationURL: "https://work.weixin.qq.com/ai/qc/gen?scode=opaque",
		ExpiresAt:        expiresAt,
		State:            AuthorizationStatePending,
	}

	view := authorizationViewForSession(release, session)
	if view == nil || view.Protocol != AuthorizationViewProtocolV2 || view.ViewID == "" {
		t.Fatalf("view = %#v", view)
	}
	if view.View.Type != AuthorizationViewTypeEmbeddedPage || view.View.URL != session.AuthorizationURL {
		t.Fatalf("runtime view = %#v", view.View)
	}
	if view.View.FlowID == "" {
		t.Fatalf("flowId = %q", view.View.FlowID)
	}
	if view.View.ExpiresAt != "2026-08-14T23:00:00Z" {
		t.Fatalf("expiresAt = %q", view.View.ExpiresAt)
	}
}

func TestAuthorizationViewForSessionDefaultsToExternalLink(t *testing.T) {
	release := testReleaseWithImplementation("github", "1.0.0", ImplementationKindManagedStdio)
	session := AuthorizationSession{
		SessionID:        "session-1",
		AuthorizationURL: "https://github.com/login/device",
		State:            AuthorizationStatePending,
	}

	view := authorizationViewForSession(release, session)
	if view == nil || view.View.Type != AuthorizationViewTypeExternalLink {
		t.Fatalf("view = %#v", view)
	}
}

func TestAuthorizationViewForSessionRendersQRCodePayload(t *testing.T) {
	release := testReleaseWithImplementation("wecom-cli", "1.0.0", ImplementationKindManagedStdio)
	release.Manifest.Implementation.ManagedStdio.CredentialBroker = &ManagedCredentialBroker{
		Presentation: CredentialBrokerPresentationQRCode,
	}
	session := AuthorizationSession{
		SessionID:        "session-1",
		AuthorizationURL: "https://work.weixin.qq.com/ai/qc/c?s=opaque",
		State:            AuthorizationStatePending,
	}

	view := authorizationViewForSession(release, session)
	if view == nil || view.View.Type != AuthorizationViewTypeQRCode || view.View.URL != "" {
		t.Fatalf("view = %#v", view)
	}
	if view.View.Source == nil || view.View.Source.Type != AuthorizationQRCodeSourcePayload ||
		view.View.Source.Value != session.AuthorizationURL {
		t.Fatalf("QR source = %#v", view.View.Source)
	}
}

func TestAuthorizationViewForSessionChangesIdentityWithProviderStep(t *testing.T) {
	release := testReleaseWithImplementation("wecom-cli", "1.0.0", ImplementationKindManagedStdio)
	session := AuthorizationSession{
		SessionID:        "session-1",
		AuthorizationURL: "https://work.weixin.qq.com/ai/qc/gen?step=one",
		State:            AuthorizationStatePending,
	}
	first := authorizationViewForSession(release, session)
	session.AuthorizationURL = "https://work.weixin.qq.com/ai/qc/gen?step=two"
	second := authorizationViewForSession(release, session)

	if first == nil || second == nil || first.ViewID == second.ViewID {
		t.Fatalf("first=%#v second=%#v", first, second)
	}
	if first.View.FlowID != second.View.FlowID {
		t.Fatalf("flow changed: first=%q second=%q", first.View.FlowID, second.View.FlowID)
	}
}

func TestAuthorizationViewForSessionOmitsNonPendingState(t *testing.T) {
	release := testReleaseWithImplementation("github", "1.0.0", ImplementationKindManagedStdio)
	view := authorizationViewForSession(release, AuthorizationSession{
		SessionID:        "session-1",
		AuthorizationURL: "https://github.com/login/device",
		State:            AuthorizationStateConnected,
	})
	if view != nil {
		t.Fatalf("view = %#v", view)
	}
}
