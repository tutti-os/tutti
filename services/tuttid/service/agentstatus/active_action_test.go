package agentstatus

import (
	"context"
	"strings"
	"testing"
)

// A superseded install run for the same provider must not be able to overwrite,
// append into, or clear the active action a newer run has taken over.
func TestActiveActionTokenScopingIgnoresSupersededRun(t *testing.T) {
	const provider = "codex"

	oldCtx := withActiveActionToken(context.Background(), nextActiveActionToken())
	claimActiveAction(oldCtx, provider, ActiveAction{
		ID:     ActionInstall,
		Status: "running",
		Step:   "old",
	})

	// A newer run claims ownership of the same provider.
	newCtx := withActiveActionToken(context.Background(), nextActiveActionToken())
	claimActiveAction(newCtx, provider, ActiveAction{
		ID:     ActionInstall,
		Status: "running",
		Step:   "new",
	})
	t.Cleanup(func() { clearActiveAction(newCtx, provider) })

	// The superseded run's update and stdout append are no-ops.
	setActiveAction(oldCtx, provider, ActiveAction{ID: ActionInstall, Step: "stale"})
	appendActiveActionStdout(oldCtx, provider, "stale output\n")

	current := activeActionForProvider(provider)
	if current == nil {
		t.Fatal("activeActionForProvider = nil, want the newer run's action")
	}
	if current.Step != "new" {
		t.Fatalf("Step = %q, want %q (superseded run must not overwrite)", current.Step, "new")
	}
	if strings.Contains(current.Stdout, "stale output") {
		t.Fatalf("Stdout = %q, must not contain a superseded run's output", current.Stdout)
	}

	// The newer run still owns its entry, so the superseded run's clear is a no-op.
	clearActiveAction(oldCtx, provider)
	if activeActionForProvider(provider) == nil {
		t.Fatal("a superseded run's clear deleted the newer run's active action")
	}

	// The owning run can update and clear normally.
	appendActiveActionStdout(newCtx, provider, "real output\n")
	if got := activeActionForProvider(provider); got == nil || !strings.Contains(got.Stdout, "real output") {
		t.Fatalf("owning run failed to append its own stdout: %+v", got)
	}
	clearActiveAction(newCtx, provider)
	if activeActionForProvider(provider) != nil {
		t.Fatal("owning run failed to clear its own active action")
	}
}
