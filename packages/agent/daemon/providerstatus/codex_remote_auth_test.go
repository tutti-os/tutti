package providerstatus

import "testing"

func TestCodexRemoteAuthEvidenceClassifiesProviderResult(t *testing.T) {
	tests := []struct {
		name       string
		success    bool
		failure    string
		wantKind   AuthEvidenceKind
		wantReason string
	}{
		{name: "accepted", success: true, wantKind: AuthEvidenceRemoteSuccess},
		{name: "revoked", failure: "401 Unauthorized: refresh token was revoked", wantKind: AuthEvidenceRemoteAuthFailure, wantReason: AuthReasonSessionExpired},
		{name: "signed out", failure: "authentication required", wantKind: AuthEvidenceRemoteAuthFailure, wantReason: AuthReasonAuthRequired},
		{name: "transient", failure: "connection reset", wantKind: AuthEvidenceProbeFailure, wantReason: AuthReasonProbeFailed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			evidence := CodexRemoteAuthEvidence(test.success, test.failure)
			if evidence.Kind != test.wantKind || evidence.Reason != test.wantReason {
				t.Fatalf("evidence = %#v", evidence)
			}
		})
	}
}
