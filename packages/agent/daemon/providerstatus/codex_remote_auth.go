package providerstatus

// CodexRemoteAuthEvidence converts the provider-backed result of
// account/rateLimits/read into the shared authentication evidence vocabulary.
// This compatibility helper deliberately does not parse failure prose. New
// callers use account/read's structured AccountState instead.
func CodexRemoteAuthEvidence(success bool, failure string) AuthEvidence {
	if success {
		return AuthEvidence{Kind: AuthEvidenceRemoteSuccess}
	}
	_ = failure
	return AuthEvidence{Kind: AuthEvidenceProbeFailure, Reason: AuthReasonProbeFailed}
}
