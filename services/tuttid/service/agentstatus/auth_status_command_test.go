package agentstatus

import (
	"context"
	"testing"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	claudecodeservice "github.com/tutti-os/tutti/services/tuttid/service/claudecode"
)

func TestDefaultRegistryAllowsClaudeAuthStatusToFinish(t *testing.T) {
	specs, err := DefaultRegistry().Select([]string{agentprovider.ClaudeCode})
	if err != nil {
		t.Fatalf("Select() error = %v", err)
	}
	if len(specs) != 1 {
		t.Fatalf("spec count = %d, want 1", len(specs))
	}

	if got := authStatusTimeout(specs[0]); got != 10*time.Minute {
		t.Fatalf("Claude auth status timeout = %s, want 10m", got)
	}
}

func TestClaudeAuthStatusSharesCredentialStartupGate(t *testing.T) {
	if err := claudecodeservice.DefaultStartupGate.Acquire(context.Background()); err != nil {
		t.Fatalf("Acquire startup gate: %v", err)
	}
	defer claudecodeservice.DefaultStartupGate.Release()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, ok := runAuthStatusCommand(ctx, ProviderSpec{
		Provider:          agentprovider.ClaudeCode,
		AuthStatusCommand: []string{"auth", "status"},
	}, "/bin/echo", nil); ok {
		t.Fatal("Claude auth status bypassed the shared credential startup gate")
	}
}

func TestAuthStatusTimeoutDefaultsToShortProbeWindow(t *testing.T) {
	spec := ProviderSpec{Provider: agentprovider.Codex}
	if got := authStatusTimeout(spec); got != 5*time.Second {
		t.Fatalf("default auth status timeout = %s, want 5s", got)
	}
}
