package agentstatus

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// TestServiceListDetectsProvidersConcurrently proves provider detection fans
// out instead of running serially: each provider's auth status command blocks
// until every requested provider has entered its own command. Serial detection
// would never let the second provider start, so the rendezvous would time out.
func TestServiceListDetectsProvidersConcurrently(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	service := testService(func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}, map[string]bool{})
	started := make(chan string, 2)
	release := make(chan struct{})
	service.RunAuthStatusCommand = func(ctx context.Context, spec ProviderSpec, _ string) (AuthInfo, bool) {
		started <- spec.Provider
		select {
		case <-release:
		case <-ctx.Done():
		}
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	type listResult struct {
		snapshot Snapshot
		err      error
	}
	done := make(chan listResult, 1)
	go func() {
		snapshot, err := service.List(ctx, ListInput{Providers: []string{"codex", "cursor"}})
		done <- listResult{snapshot: snapshot, err: err}
	}()

	seen := map[string]bool{}
	for len(seen) < 2 {
		select {
		case provider := <-started:
			seen[provider] = true
		case <-ctx.Done():
			t.Fatalf("detection did not run concurrently; providers seen before rendezvous: %v", seen)
		}
	}
	close(release)

	var result listResult
	select {
	case result = <-done:
	case <-ctx.Done():
		t.Fatal("provider detection did not finish after rendezvous release")
	}
	if result.err != nil {
		t.Fatalf("List() error = %v", result.err)
	}
	if len(result.snapshot.Providers) != 2 {
		t.Fatalf("Providers length = %d, want 2", len(result.snapshot.Providers))
	}
	// Concurrent detection must not reorder the response: slots follow the
	// requested provider order.
	if result.snapshot.Providers[0].Provider != "codex" {
		t.Fatalf("Providers[0] = %q, want codex", result.snapshot.Providers[0].Provider)
	}
	if result.snapshot.Providers[1].Provider != "cursor" {
		t.Fatalf("Providers[1] = %q, want cursor", result.snapshot.Providers[1].Provider)
	}
	for _, status := range result.snapshot.Providers {
		if status.Auth.Status != AuthAuthenticated {
			t.Fatalf("Auth.Status for %q = %q, want %q", status.Provider, status.Auth.Status, AuthAuthenticated)
		}
	}
}

func TestServiceListLogsProviderDetectionTimings(t *testing.T) {
	var output bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&output, nil)))
	t.Cleanup(func() {
		slog.SetDefault(previousLogger)
	})

	service := testService(func(string) (string, error) {
		return "", errors.New("not found")
	}, map[string]bool{})
	if _, err := service.List(t.Context(), ListInput{Providers: []string{"codex"}}); err != nil {
		t.Fatalf("List() error = %v", err)
	}

	logOutput := output.String()
	for _, field := range []string{
		"event=tutti.agent_provider.status_detection.completed",
		"provider=codex",
		"durationMs=",
		"runtimeResolutionMs=",
		"adapterProbeMs=",
		"authMs=",
		"cliVersionMs=",
		"postChecksMs=",
		"event=tutti.agent_provider.status_list.completed",
		"requestedProviderCount=1",
		"providerCount=1",
		"success=true",
	} {
		if !strings.Contains(logOutput, field) {
			t.Fatalf("status timing log missing %q:\n%s", field, logOutput)
		}
	}
}
