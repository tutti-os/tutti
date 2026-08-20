package providerstatus

import "strings"

// CodexRemoteAuthEvidence converts the provider-backed result of
// account/rateLimits/read into the shared authentication evidence vocabulary.
// Only explicit authentication rejection invalidates the weaker local session.
func CodexRemoteAuthEvidence(success bool, failure string) AuthEvidence {
	if success {
		return AuthEvidence{Kind: AuthEvidenceRemoteSuccess}
	}
	lower := strings.ToLower(strings.TrimSpace(failure))
	switch {
	case strings.Contains(lower, "session expired"),
		strings.Contains(lower, "unauthorized"),
		strings.Contains(lower, "401"),
		strings.Contains(lower, "403"),
		strings.Contains(lower, "access token expired"),
		strings.Contains(lower, "refresh token"),
		strings.Contains(lower, "token has been revoked"),
		strings.Contains(lower, "token was revoked"),
		strings.Contains(lower, "invalid bearer token"):
		return AuthEvidence{Kind: AuthEvidenceRemoteAuthFailure, Reason: AuthReasonSessionExpired}
	case strings.Contains(lower, "not logged in"),
		strings.Contains(lower, "unauthenticated"),
		strings.Contains(lower, "authentication required"):
		return AuthEvidence{Kind: AuthEvidenceRemoteAuthFailure, Reason: AuthReasonAuthRequired}
	default:
		return AuthEvidence{Kind: AuthEvidenceProbeFailure, Reason: AuthReasonProbeFailed}
	}
}
