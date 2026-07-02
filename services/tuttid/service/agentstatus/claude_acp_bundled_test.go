package agentstatus

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	externalagentregistry "github.com/tutti-os/tutti/services/tuttid/service/externalagentregistry"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

// unavailableManagedRuntime simulates the managed Node runtime not being ready
// yet (e.g. node-static still materializing at startup): Resolve errors.
type unavailableManagedRuntime struct{}

func (unavailableManagedRuntime) Resolve(context.Context) (managedruntime.ResolvedRuntime, error) {
	return managedruntime.ResolvedRuntime{}, errors.New("managed runtime not ready")
}

// brokenExternalRegistry points at a non-existent source so any attempt to read
// the ACP external agent registry fails. A passing test that uses it proves the
// bundled path never touches the network/registry.
func brokenExternalRegistry(t *testing.T) externalagentregistry.Store {
	t.Helper()
	return externalagentregistry.Store{
		SourceURL: filepath.Join(t.TempDir(), "does-not-exist.json"),
		CacheRoot: filepath.Join(t.TempDir(), "cache"),
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
		},
	}
}

func TestServiceResolveProviderCommandUsesBundledClaudeACP(t *testing.T) {
	home := t.TempDir()
	runtimeRoot := fakeManagedRuntimeRoot(t)
	entry := filepath.Join(t.TempDir(), "claude-acp", "dist", "index.js")
	if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
		t.Fatalf("mkdir entry dir: %v", err)
	}
	if err := os.WriteFile(entry, []byte("// vendored bridge\n"), 0o644); err != nil {
		t.Fatalf("write entry: %v", err)
	}
	expectedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())

	service := probeTestService(home)
	// A deliberately broken registry: success proves we never consult it.
	service.ExternalAgentRegistry = brokenExternalRegistry(t)
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)
	service.Environ = func() []string {
		return []string{"PATH=/usr/bin:/bin", claudeACPEntryPathEnv + "=" + entry}
	}
	service.FileExists = func(path string) bool { return path == entry }
	// System claude is installed; the bundled bridge must be pointed at it.
	service.LookPath = func(name string) (string, error) {
		if name == "claude" {
			return "/usr/local/bin/claude", nil
		}
		return "", errors.New("not found")
	}

	result, err := service.ResolveProviderCommand(context.Background(), "claude-code")
	if err != nil {
		t.Fatalf("ResolveProviderCommand() error = %v", err)
	}
	want := []string{expectedNode, entry}
	if !slices.Equal(result.Command, want) {
		t.Fatalf("Command = %#v, want bundled bridge %#v", result.Command, want)
	}
	if slices.Contains(result.Command, "exec") || slices.Contains(result.Command, "install") {
		t.Fatalf("Command = %#v, want bundled run without npm exec/install", result.Command)
	}
	if !slices.Contains(result.Env, "CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude") {
		t.Fatalf("Env = %#v, want CLAUDE_CODE_EXECUTABLE pointing at system claude", result.Env)
	}
}

func TestServiceRunActionSkipsInstallWhenClaudeACPBundled(t *testing.T) {
	home := t.TempDir()
	runtimeRoot := fakeManagedRuntimeRoot(t)
	entry := filepath.Join(t.TempDir(), "claude-acp", "dist", "index.js")
	if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
		t.Fatalf("mkdir entry dir: %v", err)
	}
	if err := os.WriteFile(entry, []byte("// vendored bridge\n"), 0o644); err != nil {
		t.Fatalf("write entry: %v", err)
	}

	service := probeTestService(home)
	service.ExternalAgentRegistry = brokenExternalRegistry(t)
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)
	service.Environ = func() []string {
		return []string{"PATH=/usr/bin:/bin", claudeACPEntryPathEnv + "=" + entry}
	}
	service.FileExists = func(path string) bool { return path == entry }
	// The Claude CLI is already installed (as in the real onboarding flow), so the
	// only install that could run is the adapter — which bundling must skip.
	service.LookPath = func(name string) (string, error) {
		if name == "claude" {
			return "/usr/local/bin/claude", nil
		}
		return "", errors.New("not found")
	}
	installCalled := false
	service.InstallCommand = func(context.Context, InstallCommandInput) (InstallCommandResult, error) {
		installCalled = true
		return InstallCommandResult{ExitCode: 0}, nil
	}

	if _, err := service.RunAction(context.Background(), RunActionInput{
		Provider: "claude-code",
		ActionID: ActionInstall,
	}); err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if installCalled {
		t.Fatal("InstallCommand was called, want bundled bridge to skip install")
	}
}

func TestResolveProviderSpecBundledNeverFallsBackToRegistry(t *testing.T) {
	home := t.TempDir()
	entry := filepath.Join(t.TempDir(), "claude-acp", "dist", "index.js")
	if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
		t.Fatalf("mkdir entry dir: %v", err)
	}
	if err := os.WriteFile(entry, []byte("// vendored bridge\n"), 0o644); err != nil {
		t.Fatalf("write entry: %v", err)
	}

	// A valid registry is available: if the bundled path wrongly fell back, the
	// npm installer would be selected. The managed runtime is NOT ready, which is
	// exactly the startup race that previously caused a spurious npm install and a
	// version mismatch ("provider adapter is still unavailable after install").
	registryStore, _ := fakeClaudeExternalRegistry(t)
	service := probeTestService(home)
	service.ExternalAgentRegistry = registryStore
	service.ManagedRuntime = unavailableManagedRuntime{}
	service.Environ = func() []string {
		return []string{"PATH=/usr/bin:/bin", claudeACPEntryPathEnv + "=" + entry}
	}
	service.FileExists = func(path string) bool { return path == entry }

	specs, err := service.selectProviderSpecs(context.Background(), []string{"claude-code"}, true)
	if err != nil {
		t.Fatalf("selectProviderSpecs() error = %v", err)
	}
	spec := specs[0]
	if spec.AdapterInstall.Kind != "" || spec.AdapterInstall.RegistryNPM != nil {
		t.Fatalf("AdapterInstall = %#v, want empty (bundle must never fall back to registry npm)", spec.AdapterInstall)
	}
	if spec.AdapterPackage.Version != claudeACPPinnedVersion {
		t.Fatalf("AdapterPackage.Version = %q, want bundled %q", spec.AdapterPackage.Version, claudeACPPinnedVersion)
	}
}

func TestServiceResolveProviderSpecFallsBackWhenClaudeACPEntryMissing(t *testing.T) {
	home := t.TempDir()
	registryStore, prefixDir := fakeClaudeExternalRegistry(t)
	runtimeRoot := fakeManagedRuntimeRoot(t)

	service := probeTestService(home)
	service.ExternalAgentRegistry = registryStore
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)
	// Entry env points at a path that does not exist: bundled is skipped.
	missingEntry := filepath.Join(t.TempDir(), "missing", "dist", "index.js")
	service.Environ = func() []string {
		return []string{"PATH=/usr/bin:/bin", claudeACPEntryPathEnv + "=" + missingEntry}
	}
	service.FileExists = func(string) bool { return false }

	result, err := service.ResolveProviderCommand(context.Background(), "claude-code")
	if err != nil {
		t.Fatalf("ResolveProviderCommand() error = %v", err)
	}
	// Falls back to the npm-registry exec path against the resolved prefix dir.
	if !slices.Contains(result.Command, "exec") || !slices.Contains(result.Command, prefixDir) {
		t.Fatalf("Command = %#v, want npm registry exec fallback under %q", result.Command, prefixDir)
	}
}
