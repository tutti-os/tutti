package agentextension

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/managednpm"
)

type npmProbeRoundTripFunc func(*http.Request) (*http.Response, error)

func (f npmProbeRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func npmProbeResponse(status int) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader("{}")),
		Header:     make(http.Header),
	}
}

func npmProbeClient(fn func(host string) int) *http.Client {
	return &http.Client{Transport: npmProbeRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		return npmProbeResponse(fn(request.URL.Host)), nil
	})}
}

func npmRegistryFromEnv(env []string) string {
	for _, kv := range env {
		if strings.HasPrefix(kv, "npm_config_registry=") {
			return strings.TrimPrefix(kv, "npm_config_registry=")
		}
	}
	return ""
}

// sequencedInstallRunner returns a scripted result per call, records the
// npm_config_registry each attempt saw, and simulates a half-written install
// tree on failure so the caller's purge can be observed.
type sequencedInstallRunner struct {
	staging    string
	results    []error
	calls      int
	registries []string
}

func (r *sequencedInstallRunner) Run(_ context.Context, _ []string, _ string, env []string) error {
	r.registries = append(r.registries, npmRegistryFromEnv(env))
	index := r.calls
	r.calls++
	var result error
	if index < len(r.results) {
		result = r.results[index]
	}
	if result != nil && r.staging != "" {
		_ = os.MkdirAll(filepath.Join(r.staging, "node_modules", ".pkg-staging"), 0o700)
	}
	return result
}

func newNPMFallbackService(client *http.Client) *SetupService {
	return &SetupService{Plans: InstallPlanService{Manager: &Manager{Client: client}}}
}

func npmFallbackPlan() InstallPlan {
	return InstallPlan{AgentKey: "kimi-code", Runner: "npm", PackageName: "pkg", PackageVersion: "1.0.0"}
}

func TestIsNPMRunner(t *testing.T) {
	for _, runner := range []string{"npm", "pnpm"} {
		if !isNPMRunner(runner) {
			t.Fatalf("isNPMRunner(%q) = false, want true", runner)
		}
	}
	for _, runner := range []string{"uv", "binary", "", "pip"} {
		if isNPMRunner(runner) {
			t.Fatalf("isNPMRunner(%q) = true, want false", runner)
		}
	}
}

func TestWithNPMRegistryReplacesInherited(t *testing.T) {
	env := []string{"PATH=/x", "NPM_CONFIG_REGISTRY=https://old.example", "npm_config_registry=https://stale.example"}
	got := withNPMRegistry(env, "https://mirror.example")
	registries := 0
	for _, kv := range got {
		if strings.HasPrefix(strings.ToLower(kv), "npm_config_registry=") {
			registries++
		}
	}
	if registries != 1 {
		t.Fatalf("npm_config_registry entries = %d, want 1 (env=%v)", registries, got)
	}
	if npmRegistryFromEnv(got) != "https://mirror.example" {
		t.Fatalf("registry = %q, want https://mirror.example", npmRegistryFromEnv(got))
	}
	if !slicesContains(got, "PATH=/x") {
		t.Fatalf("unrelated env dropped: %v", got)
	}
}

func TestRankedNPMRegistriesHonoursOverride(t *testing.T) {
	t.Setenv(managednpm.RegistryOverrideEnv, "https://pinned.example")
	got := rankedNPMRegistries(context.Background(), npmProbeClient(func(string) int { return 200 }), "pkg", "1.0.0")
	if len(got) != 1 || got[0] != "https://pinned.example" {
		t.Fatalf("ranked registries = %v, want [https://pinned.example]", got)
	}
}

func TestRankedNPMRegistriesDeprioritisesUnreachableOfficial(t *testing.T) {
	t.Setenv(managednpm.RegistryOverrideEnv, "")
	client := npmProbeClient(func(host string) int {
		if strings.Contains(host, "registry.npmjs.org") {
			return 404
		}
		return 200
	})
	got := rankedNPMRegistries(context.Background(), client, "pkg", "1.0.0")
	if len(got) != 3 {
		t.Fatalf("ranked registries = %v, want 3 entries", got)
	}
	if got[len(got)-1] != managednpm.OfficialRegistryURL {
		t.Fatalf("unreachable official registry ranked %v, want last", got)
	}
}

func TestRunNPMInstallWithRegistryFallbackFailsOverAndPurges(t *testing.T) {
	t.Setenv(managednpm.RegistryOverrideEnv, "")
	staging := t.TempDir()
	service := newNPMFallbackService(npmProbeClient(func(string) int { return 200 }))
	runner := &sequencedInstallRunner{staging: staging, results: []error{errors.New("registry unreachable")}}

	err := service.runNPMInstallWithRegistryFallback(
		context.Background(), runner, []string{"npm", "install"}, t.TempDir(), staging,
		[]string{"PATH=/x"}, npmFallbackPlan(),
	)
	if err != nil {
		t.Fatalf("runNPMInstallWithRegistryFallback err = %v, want nil", err)
	}
	if runner.calls != 2 {
		t.Fatalf("runner calls = %d, want 2 (fail then succeed)", runner.calls)
	}
	if runner.registries[0] == runner.registries[1] {
		t.Fatalf("fallover did not switch registry: both %q", runner.registries[0])
	}
	if runner.registries[0] != managednpm.OfficialRegistryURL {
		t.Fatalf("first attempt registry = %q, want official first", runner.registries[0])
	}
	if _, statErr := os.Stat(filepath.Join(staging, "node_modules")); !os.IsNotExist(statErr) {
		t.Fatalf("staging node_modules not purged after failed attempt (stat err = %v)", statErr)
	}
}

func TestRunNPMInstallWithRegistryFallbackExhaustsAllRegistries(t *testing.T) {
	t.Setenv(managednpm.RegistryOverrideEnv, "")
	staging := t.TempDir()
	service := newNPMFallbackService(npmProbeClient(func(string) int { return 200 }))
	runner := &sequencedInstallRunner{
		staging: staging,
		results: []error{errors.New("a"), errors.New("b"), errors.New("c")},
	}

	err := service.runNPMInstallWithRegistryFallback(
		context.Background(), runner, []string{"npm", "install"}, t.TempDir(), staging,
		[]string{"PATH=/x"}, npmFallbackPlan(),
	)
	if !errors.Is(err, ErrRuntimeInstallFailed) {
		t.Fatalf("err = %v, want wrap of ErrRuntimeInstallFailed", err)
	}
	if runner.calls != 3 {
		t.Fatalf("runner calls = %d, want 3 (all registries tried)", runner.calls)
	}
	distinct := map[string]struct{}{}
	for _, registry := range runner.registries {
		distinct[registry] = struct{}{}
	}
	if len(distinct) != 3 {
		t.Fatalf("attempted registries = %v, want 3 distinct", runner.registries)
	}
}

func TestRankedNPMRegistriesSkipsProbeWithoutClient(t *testing.T) {
	t.Setenv(managednpm.RegistryOverrideEnv, "")
	got := rankedNPMRegistries(context.Background(), nil, "pkg", "1.0.0")
	want := []string{managednpm.OfficialRegistryURL, managednpm.HuaweiRegistryURL, managednpm.TencentRegistryURL}
	if len(got) != len(want) {
		t.Fatalf("registries = %v, want default order %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("registries = %v, want default order %v", got, want)
		}
	}
}

type cancelOnFirstInstallRunner struct {
	cancel context.CancelFunc
	calls  int
}

func (r *cancelOnFirstInstallRunner) Run(_ context.Context, _ []string, _ string, _ []string) error {
	r.calls++
	r.cancel()
	return context.Canceled
}

func TestRunNPMInstallStopsFailoverOnContextCancel(t *testing.T) {
	t.Setenv(managednpm.RegistryOverrideEnv, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	service := newNPMFallbackService(npmProbeClient(func(string) int { return 200 }))
	runner := &cancelOnFirstInstallRunner{cancel: cancel}

	err := service.runNPMInstallWithRegistryFallback(
		ctx, runner, []string{"npm", "install"}, t.TempDir(), t.TempDir(),
		[]string{"PATH=/x"}, npmFallbackPlan(),
	)
	if !errors.Is(err, ErrRuntimeInstallFailed) {
		t.Fatalf("err = %v, want wrap of ErrRuntimeInstallFailed", err)
	}
	if runner.calls != 1 {
		t.Fatalf("runner calls = %d, want 1 (no failover after parent cancel)", runner.calls)
	}
}

func slicesContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
