package agentstatus

import (
	"context"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func TestCursorAuthCommandUsesSingleOuterAttempt(t *testing.T) {
	spec := ProviderSpec{
		Provider:              providerregistry.CursorProviderID,
		AuthCommandRunnerKind: providerregistry.AuthCommandRunnerKindCursor,
	}
	calls := 0
	service := Service{
		RunAuthStatusCommand: func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
			calls++
			return AuthInfo{}, false
		},
	}
	if _, ok := service.resolveAuthFromCommand(context.Background(), spec, "/cursor-agent"); ok {
		t.Fatal("resolveAuthFromCommand() ok = true, want false")
	}
	if calls != 1 {
		t.Fatalf("Cursor auth command calls = %d, want 1", calls)
	}
}
