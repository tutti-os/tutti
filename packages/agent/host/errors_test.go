package agenthost

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestProviderErrorPreservesStructuredDiagnosticsAndCause(t *testing.T) {
	cause := errors.New("provider process rejected the request")
	providerErr := &ProviderError{
		Code:         "provider_auth_required",
		Message:      "Agent provider needs authentication",
		DebugMessage: "provider exited with status 1",
		Cause:        cause,
	}
	wrapped := fmt.Errorf("create agent session: %w", providerErr)

	var got *ProviderError
	if !errors.As(wrapped, &got) {
		t.Fatalf("errors.As(%v) did not preserve ProviderError", wrapped)
	}
	if got.Code != providerErr.Code || got.Message != providerErr.Message || got.DebugMessage != providerErr.DebugMessage {
		t.Fatalf("ProviderError = %#v, want %#v", got, providerErr)
	}
	if !errors.Is(wrapped, cause) {
		t.Fatalf("errors.Is(%v, cause) = false", wrapped)
	}
}

func TestProviderErrorFallsBackWithoutInventingAStableCode(t *testing.T) {
	cause := errors.New("provider unavailable")
	providerErr := &ProviderError{Cause: cause}
	if got := providerErr.Error(); got != cause.Error() {
		t.Fatalf("Error() = %q, want %q", got, cause.Error())
	}
	if providerErr.Code != "" {
		t.Fatalf("Code = %q, want no invented provider taxonomy", providerErr.Code)
	}
}

func TestNewProviderErrorLeavesDeliveryUnknownContextErrorsRecoverable(t *testing.T) {
	for _, cause := range []error{
		fmt.Errorf("provider start: %w", context.Canceled),
		fmt.Errorf("provider start: %w", context.DeadlineExceeded),
	} {
		mapped := NewProviderError("request_failed", "Provider request failed", "timeout", cause)
		var providerErr *ProviderError
		if errors.As(mapped, &providerErr) {
			t.Fatalf("NewProviderError(%v) = %#v, want unclassified context error", cause, providerErr)
		}
		if !errors.Is(mapped, cause) {
			t.Fatalf("NewProviderError(%v) did not preserve original error", cause)
		}
	}
	if mapped := NewProviderError("request_failed", "Provider request failed", "", nil); mapped != nil {
		t.Fatalf("NewProviderError(nil) = %v, want nil", mapped)
	}
}
