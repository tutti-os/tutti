package agentextension

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func uvIndexFromEnv(env []string) string {
	for _, kv := range env {
		if strings.HasPrefix(kv, "UV_DEFAULT_INDEX=") {
			return strings.TrimPrefix(kv, "UV_DEFAULT_INDEX=")
		}
	}
	return ""
}

// sequencedUVInstallRunner returns a scripted result per call and records the
// UV_DEFAULT_INDEX each attempt saw.
type sequencedUVInstallRunner struct {
	results []error
	calls   int
	indexes []string
}

func (r *sequencedUVInstallRunner) Run(_ context.Context, _ []string, _ string, env []string) error {
	r.indexes = append(r.indexes, uvIndexFromEnv(env))
	index := r.calls
	r.calls++
	if index < len(r.results) {
		return r.results[index]
	}
	return nil
}

func uvIndexFallbackPlan() InstallPlan {
	return InstallPlan{AgentKey: "hermes", Runner: "uv", PackageName: "hermes-agent[acp]", PackageVersion: "0.18.2"}
}

func TestDefaultPyPIIndexesHonoursOverride(t *testing.T) {
	t.Setenv(uvIndexOverrideEnv, "https://pinned.example/simple")
	got := defaultPyPIIndexes()
	if len(got) != 1 || got[0] != "https://pinned.example/simple" {
		t.Fatalf("indexes = %v, want single pinned entry", got)
	}
}

func TestDefaultPyPIIndexesOfficialFirst(t *testing.T) {
	t.Setenv(uvIndexOverrideEnv, "")
	got := defaultPyPIIndexes()
	if len(got) != 3 || got[0] != officialPyPIIndexURL {
		t.Fatalf("indexes = %v, want official first of 3", got)
	}
}

func TestWithUVDefaultIndexReplacesInherited(t *testing.T) {
	env := []string{"PATH=/x", "UV_DEFAULT_INDEX=https://stale.example/simple", "UV_NO_CONFIG=1"}
	got := withUVDefaultIndex(env, "https://mirror.example/simple")
	entries := 0
	for _, kv := range got {
		if strings.HasPrefix(kv, "UV_DEFAULT_INDEX=") {
			entries++
		}
	}
	if entries != 1 {
		t.Fatalf("UV_DEFAULT_INDEX entries = %d, want 1 (env=%v)", entries, got)
	}
	if uvIndexFromEnv(got) != "https://mirror.example/simple" {
		t.Fatalf("index = %q, want mirror", uvIndexFromEnv(got))
	}
}

func TestRunUVInstallWithIndexFallbackFailsOver(t *testing.T) {
	t.Setenv(uvIndexOverrideEnv, "")
	service := &SetupService{}
	runner := &sequencedUVInstallRunner{results: []error{errors.New("index unreachable")}}

	err := service.runUVInstallWithIndexFallback(
		context.Background(), runner, []string{"uv", "tool", "install", "hermes-agent[acp]==0.18.2"},
		t.TempDir(), []string{"PATH=/x", "UV_NO_CONFIG=1"}, uvIndexFallbackPlan(),
	)
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if runner.calls != 2 {
		t.Fatalf("runner calls = %d, want 2 (fail then succeed)", runner.calls)
	}
	if runner.indexes[0] != officialPyPIIndexURL {
		t.Fatalf("first index = %q, want official first", runner.indexes[0])
	}
	if runner.indexes[1] == runner.indexes[0] {
		t.Fatalf("failover did not switch index: both %q", runner.indexes[0])
	}
}

func TestRunUVInstallWithIndexFallbackExhaustsAllIndexes(t *testing.T) {
	t.Setenv(uvIndexOverrideEnv, "")
	service := &SetupService{}
	runner := &sequencedUVInstallRunner{results: []error{errors.New("a"), errors.New("b"), errors.New("c")}}

	err := service.runUVInstallWithIndexFallback(
		context.Background(), runner, []string{"uv", "tool", "install", "hermes-agent[acp]==0.18.2"},
		t.TempDir(), []string{"PATH=/x"}, uvIndexFallbackPlan(),
	)
	if !errors.Is(err, ErrRuntimeInstallFailed) {
		t.Fatalf("err = %v, want wrap of ErrRuntimeInstallFailed", err)
	}
	if runner.calls != 3 {
		t.Fatalf("runner calls = %d, want 3", runner.calls)
	}
	distinct := map[string]struct{}{}
	for _, index := range runner.indexes {
		distinct[index] = struct{}{}
	}
	if len(distinct) != 3 {
		t.Fatalf("attempted indexes = %v, want 3 distinct", runner.indexes)
	}
}

type cancelOnFirstUVInstallRunner struct {
	cancel context.CancelFunc
	calls  int
}

func (r *cancelOnFirstUVInstallRunner) Run(_ context.Context, _ []string, _ string, _ []string) error {
	r.calls++
	r.cancel()
	return context.Canceled
}

func TestRunUVInstallStopsFailoverOnContextCancel(t *testing.T) {
	t.Setenv(uvIndexOverrideEnv, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	service := &SetupService{}
	runner := &cancelOnFirstUVInstallRunner{cancel: cancel}

	err := service.runUVInstallWithIndexFallback(
		ctx, runner, []string{"uv", "tool", "install", "hermes-agent[acp]==0.18.2"},
		t.TempDir(), []string{"PATH=/x"}, uvIndexFallbackPlan(),
	)
	if !errors.Is(err, ErrRuntimeInstallFailed) {
		t.Fatalf("err = %v, want wrap of ErrRuntimeInstallFailed", err)
	}
	if runner.calls != 1 {
		t.Fatalf("runner calls = %d, want 1 (no failover after parent cancel)", runner.calls)
	}
}
