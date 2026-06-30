package agentruntime

import "testing"

func TestIsACPProviderSessionNotFoundAcceptsResourceSuffixDetails(t *testing.T) {
	t.Parallel()

	callErr := &acpCallError{
		Method: acpMethodLoadSession,
		Err: acpError{
			Code:    -32002,
			Message: "Resource not found: a4009694-9d5c-48be-8480-6d1e0ede5410",
		},
	}

	if !isACPProviderSessionNotFound(acpMethodLoadSession, callErr) {
		t.Fatalf("expected load-session missing resource error with suffix details to be classified as provider session missing")
	}
}

func TestIsACPProviderSessionNotFoundAcceptsCodexAppServerMissingRollout(t *testing.T) {
	t.Parallel()

	// Codex app server thread/resume reports an absent rollout file as -32600
	// "no rollout found for thread id …" (imported conversation whose rollout is
	// not on this device). It must be classified so the runtime recreates the
	// provider session instead of dead-ending the user.
	callErr := &acpCallError{
		Method: appServerMethodThreadResume,
		Err: acpError{
			Code:    -32600,
			Message: "no rollout found for thread id 019eeec5-940b-7c00-9fef-a0da2990cfe5",
		},
	}

	if !isACPProviderSessionNotFound(appServerMethodThreadResume, callErr) {
		t.Fatalf("expected codex app server missing-rollout thread/resume error to be classified as provider session missing")
	}
}

func TestClassifyACPResumeErrorMapsMissingRolloutToProviderSessionNotFound(t *testing.T) {
	t.Parallel()

	callErr := &acpCallError{
		Method: appServerMethodThreadResume,
		Err: acpError{
			Code:    -32600,
			Message: "no rollout found for thread id 019eeec5-940b-7c00-9fef-a0da2990cfe5",
		},
	}

	classified := classifyACPResumeError(
		Session{Provider: ProviderCodex, ProviderSessionID: "019eeec5-940b-7c00-9fef-a0da2990cfe5"},
		appServerMethodThreadResume,
		callErr,
	)
	if AppErrorCode(classified) != AppErrorProviderSessionNotFound {
		t.Fatalf("classified error code = %q, want %q", AppErrorCode(classified), AppErrorProviderSessionNotFound)
	}
	// The classified error must be recreatable so RecreateIfMissing can recover.
	if !isResumeRecreatableError(classified) {
		t.Fatalf("missing-rollout error should be recreatable")
	}
}

func TestIsACPProviderSessionNotFoundIgnoresUnrelatedInvalidRequest(t *testing.T) {
	t.Parallel()

	// A generic -32600 that is NOT a missing rollout must not be misclassified.
	callErr := &acpCallError{
		Method: appServerMethodThreadResume,
		Err: acpError{
			Code:    -32600,
			Message: "invalid request: missing params",
		},
	}

	if isACPProviderSessionNotFound(appServerMethodThreadResume, callErr) {
		t.Fatalf("unrelated invalid-request error must not be classified as provider session missing")
	}
}
