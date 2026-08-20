package providerstatus

import "testing"

func TestReduceAuthEvidenceKeepsLocalConfigurationDistinctFromRemoteAuthentication(t *testing.T) {
	configured := ReduceAuthEvidence(AuthObservation{}, LocalAuthEvidence(AuthInfo{
		Status: AuthAuthenticated, AccountLabel: "user@example.com", AuthMethod: "oauth",
	}))
	if configured.Status != AuthObservationConfigured ||
		configured.Authority != AuthEvidenceAuthorityLocal ||
		configured.Reason != AuthReasonLocalSessionDetected {
		t.Fatalf("configured observation = %#v", configured)
	}

	authenticated := ReduceAuthEvidence(configured, AuthEvidence{Kind: AuthEvidenceRemoteSuccess})
	if authenticated.Status != AuthObservationAuthenticated ||
		authenticated.Authority != AuthEvidenceAuthorityRemote {
		t.Fatalf("authenticated observation = %#v", authenticated)
	}
}

func TestAuthInfoFromObservationPreservesConfiguredAsPublicState(t *testing.T) {
	info := AuthInfoFromObservation(AuthObservation{
		Status: AuthObservationConfigured, Authority: AuthEvidenceAuthorityLocal,
		AccountLabel: " user@example.com ", AuthMethod: " oauth ",
	})
	if info.Status != AuthConfigured || info.AccountLabel != "user@example.com" || info.AuthMethod != "oauth" {
		t.Fatalf("auth info = %#v", info)
	}
}

func TestReduceAuthEvidenceRemoteFailureOutranksStaleLocalStatus(t *testing.T) {
	revoked := ReduceAuthEvidence(AuthObservation{}, AuthEvidence{
		Kind: AuthEvidenceRemoteAuthFailure, Reason: AuthReasonSessionExpired,
	})
	got := ReduceAuthEvidence(revoked, LocalAuthEvidence(AuthInfo{
		Status: AuthAuthenticated, AccountLabel: "stale@example.com",
	}))
	if got != revoked {
		t.Fatalf("observation = %#v, want revoked %#v", got, revoked)
	}
}

func TestReduceAuthEvidenceTransientFailurePreservesSettledState(t *testing.T) {
	configured := ReduceAuthEvidence(AuthObservation{}, AuthEvidence{
		Kind: AuthEvidenceLocalCredential, AuthMethod: "apiKey",
	})
	got := ReduceAuthEvidence(configured, AuthEvidence{
		Kind: AuthEvidenceProbeFailure, Reason: "runtime-unavailable",
	})
	if got != configured {
		t.Fatalf("observation = %#v, want configured %#v", got, configured)
	}

	initial := ReduceAuthEvidence(AuthObservation{}, AuthEvidence{Kind: AuthEvidenceProbeFailure})
	if initial.Status != AuthObservationProbeFailed || initial.Reason != AuthReasonProbeFailed {
		t.Fatalf("initial failure = %#v", initial)
	}
}

func TestReduceAuthEvidenceExplicitResetAllowsFreshLocalCredentials(t *testing.T) {
	revoked := ReduceAuthEvidence(AuthObservation{}, AuthEvidence{
		Kind: AuthEvidenceRemoteAuthFailure, Reason: AuthReasonSessionExpired,
	})
	stillRevoked := ReduceAuthEvidence(revoked, AuthEvidence{Kind: AuthEvidenceLocalCredential})
	if stillRevoked != revoked {
		t.Fatalf("stale local evidence replaced remote failure: %#v", stillRevoked)
	}

	configured := ReduceAuthEvidence(AuthObservation{}, AuthEvidence{
		Kind: AuthEvidenceLocalCredential, AuthMethod: "apiKey",
	})
	if configured.Status != AuthObservationConfigured {
		t.Fatalf("fresh observation = %#v", configured)
	}
}
