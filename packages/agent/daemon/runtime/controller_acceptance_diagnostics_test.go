package agentruntime

import (
	"errors"
	"testing"
)

func TestProviderAcceptanceMissingIdentityHasStableErrorCode(t *testing.T) {
	err := &AppError{
		Code:    AppErrorProviderAcceptanceMissingIdentity,
		Message: "provider turn was not durably accepted",
		Cause:   errors.New("missing_provider_turn_id"),
	}
	if AppErrorCode(err) != AppErrorProviderAcceptanceMissingIdentity {
		t.Fatalf("app error code = %q, want %q", AppErrorCode(err), AppErrorProviderAcceptanceMissingIdentity)
	}
	if err.Error() != "provider turn was not durably accepted" {
		t.Fatalf("error message = %q", err.Error())
	}
}
