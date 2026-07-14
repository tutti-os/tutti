package agentruntime

import (
	"encoding/json"
	"testing"
)

func TestProviderPlanLimitUserMessage(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		text   string
		want   string
		wantOK bool
	}{
		{
			name:   "cursor upgrade",
			text:   "Upgrade your plan to continue",
			want:   "Upgrade your plan to continue",
			wantOK: true,
		},
		{
			name:   "wrapped upgrade",
			text:   "session/prompt: Upgrade your plan to continue",
			want:   "session/prompt: Upgrade your plan to continue",
			wantOK: true,
		},
		{
			name:   "payment gate",
			text:   "Add a payment method to continue",
			want:   "Add a payment method to continue",
			wantOK: true,
		},
		{
			name:   "unrelated",
			text:   "stream disconnected before completion",
			wantOK: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := providerPlanLimitUserMessage(tc.text)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if got != tc.want {
				t.Fatalf("message = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestACPProviderPlanLimitMessageFromCallError(t *testing.T) {
	t.Parallel()

	callErr := &acpCallError{
		Method: "session/prompt",
		Err: acpError{
			Code:    -32000,
			Message: "Upgrade your plan to continue",
			Data:    json.RawMessage(`{"message":"Upgrade your plan to continue"}`),
		},
	}
	got, ok := acpProviderPlanLimitMessage(callErr)
	if !ok {
		t.Fatal("expected plan-limit message")
	}
	if got != "Upgrade your plan to continue" {
		t.Fatalf("message = %q", got)
	}
}

func TestVisibleFailureCodeRecognizesCursorPlanLimit(t *testing.T) {
	t.Parallel()

	if got := visibleFailureCode("Upgrade your plan to continue"); got != "quota_or_rate_limit" {
		t.Fatalf("visibleFailureCode() = %q, want quota_or_rate_limit", got)
	}
	if got := visibleFailureCode("Add a payment method to continue"); got != "quota_or_rate_limit" {
		t.Fatalf("visibleFailureCode() = %q, want quota_or_rate_limit", got)
	}
}
