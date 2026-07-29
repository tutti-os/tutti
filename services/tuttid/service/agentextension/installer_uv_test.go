package agentextension

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	agentextensiondata "github.com/tutti-os/tutti/services/tuttid/data/agentextension"
)

func TestAgentTargetSetupInstallsUVExtensionRuntimeInPlace(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	runner := &fixtureUVInstallRunner{version: "1.49.0"}
	service, targetID := setupUVFixture(t, runner, &probeTransport{})

	initial, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if initial.Status != SetupNotInstalled || initial.Plan == nil || initial.Plan.Runner != "uv" {
		t.Fatalf("initial setup = %#v", initial)
	}
	if _, err := service.Install(context.Background(), InstallInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		PlanDigest: initial.Plan.PlanDigest, ClientActionID: "uv-install-1",
	}); err != nil {
		t.Fatal(err)
	}
	ready := waitForSetupStatus(t, service, targetID, SetupReady)
	if ready.RuntimeSource != "managed" || ready.RuntimeVersion != "1.49.0" {
		t.Fatalf("ready setup = %#v", ready)
	}
	if runner.calls != 1 {
		t.Fatalf("install calls = %d, want 1", runner.calls)
	}
	// The runner must be invoked with the managed uv executable by absolute
	// path: exec.Command resolves bare names against the daemon's own PATH,
	// not the installer environment's PATH.
	wantCommand := append([]string{filepath.Join(runner.uvDir, "uv")}, "tool", "install", "kimi-cli==1.49.0")
	if !reflect.DeepEqual(runner.command, wantCommand) {
		t.Fatalf("install command = %v, want %v", runner.command, wantCommand)
	}

	root := initial.Plan.InstallRoot
	for _, key := range []string{"UV_TOOL_DIR", "UV_TOOL_BIN_DIR", "UV_PYTHON_INSTALL_DIR"} {
		value := environmentValue(runner.env, key)
		if value == "" || !pathWithin(value, root) {
			t.Fatalf("installer environment %s = %q, want under %q", key, value, root)
		}
	}
	if value := environmentValue(runner.env, "UV_CACHE_DIR"); value == "" || !pathWithin(value, service.Plans.Manager.RuntimeInstallDir) {
		t.Fatalf("UV_CACHE_DIR = %q, want under runtime install dir", value)
	}
	if value := environmentValue(runner.env, "UV_NO_CONFIG"); value != "1" {
		t.Fatalf("UV_NO_CONFIG = %q, want 1", value)
	}
	pathValue := environmentValue(runner.env, "PATH")
	if !strings.HasPrefix(pathValue, runner.uvDir+string(os.PathListSeparator)) {
		t.Fatalf("PATH = %q, want prefix %q", pathValue, runner.uvDir)
	}

	// In-place install: the tool environment, executables, and activation
	// record live directly in the final root, with no staging leftovers.
	for _, relative := range []string{"bin/kimi", "tools/kimi-cli/bin/kimi", "activation.json"} {
		if _, err := os.Lstat(filepath.Join(root, filepath.FromSlash(relative))); err != nil {
			t.Fatalf("installed %s missing: %v", relative, err)
		}
	}
	entries, err := os.ReadDir(filepath.Join(service.Plans.Manager.RuntimeInstallDir, "kimi-code"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".runtime-install-") || strings.HasSuffix(entry.Name(), ".previous") {
			t.Fatalf("stale workspace entry %q remains after install", entry.Name())
		}
	}

	userEntry := filepath.Join(service.Plans.Manager.RuntimeBinDir, "kimi")
	resolvedEntry, err := filepath.EvalSymlinks(userEntry)
	if err != nil {
		t.Fatalf("resolve user executable entry: %v", err)
	}
	wantEntry, err := filepath.EvalSymlinks(filepath.Join(root, "bin", "kimi"))
	if err != nil {
		t.Fatal(err)
	}
	if resolvedEntry != wantEntry {
		t.Fatalf("user executable entry = %q, want %q", resolvedEntry, wantEntry)
	}
}

func TestUVInstallFailureRestoresPreviousRuntime(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	runner := &fixtureUVInstallRunner{version: "1.49.0"}
	service, targetID := setupUVFixture(t, runner, &probeTransport{})
	plan := uvInstallPlan(t, service, targetID)
	update := func(SetupActionPhase) error { return nil }

	if err := service.executeInstall(context.Background(), plan, t.TempDir(), update); err != nil {
		t.Fatal(err)
	}
	committedBytes, err := os.ReadFile(filepath.Join(plan.InstallRoot, "tools", "kimi-cli", "bin", "kimi"))
	if err != nil {
		t.Fatal(err)
	}

	runner.failErr = errors.New("simulated uv failure")
	err = service.executeInstall(context.Background(), plan, t.TempDir(), update)
	if !errors.Is(err, ErrRuntimeInstallFailed) {
		t.Fatalf("second install error = %v, want ErrRuntimeInstallFailed", err)
	}
	if runner.calls != 2 {
		t.Fatalf("install calls = %d, want 2", runner.calls)
	}
	restoredBytes, err := os.ReadFile(filepath.Join(plan.InstallRoot, "tools", "kimi-cli", "bin", "kimi"))
	if err != nil {
		t.Fatalf("previous runtime was not restored: %v", err)
	}
	if string(restoredBytes) != string(committedBytes) {
		t.Fatalf("restored executable = %q, want %q", restoredBytes, committedBytes)
	}
	if _, err := os.Lstat(filepath.Join(plan.InstallRoot, "activation.json")); err != nil {
		t.Fatalf("restored activation missing: %v", err)
	}
	assertPathDoesNotExist(t, plan.InstallRoot+".previous")
}

func TestUVInstallReplacesUncommittedRoot(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	runner := &fixtureUVInstallRunner{version: "1.49.0"}
	service, targetID := setupUVFixture(t, runner, &probeTransport{})
	plan := uvInstallPlan(t, service, targetID)
	update := func(SetupActionPhase) error { return nil }

	// Plant a partial install: no activation.json, so it must be discarded.
	if err := os.MkdirAll(filepath.Join(plan.InstallRoot, "junk"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := service.executeInstall(context.Background(), plan, t.TempDir(), update); err != nil {
		t.Fatal(err)
	}
	if runner.calls != 1 {
		t.Fatalf("install calls = %d, want 1", runner.calls)
	}
	assertPathDoesNotExist(t, filepath.Join(plan.InstallRoot, "junk"))
	if _, err := os.Lstat(filepath.Join(plan.InstallRoot, "activation.json")); err != nil {
		t.Fatalf("activation missing: %v", err)
	}
}

func TestUVInstallRestoresCommittedBackupWithoutReinstall(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	runner := &fixtureUVInstallRunner{version: "1.49.0"}
	service, targetID := setupUVFixture(t, runner, &probeTransport{})
	plan := uvInstallPlan(t, service, targetID)
	update := func(SetupActionPhase) error { return nil }

	if err := service.executeInstall(context.Background(), plan, t.TempDir(), update); err != nil {
		t.Fatal(err)
	}
	// Simulate an interrupted reinstall: the committed root was moved aside and
	// the replacement never arrived.
	if err := os.Rename(plan.InstallRoot, plan.InstallRoot+".previous"); err != nil {
		t.Fatal(err)
	}
	if err := service.executeInstall(context.Background(), plan, t.TempDir(), update); err != nil {
		t.Fatal(err)
	}
	if runner.calls != 1 {
		t.Fatalf("install calls = %d, want 1 (backup restored without reinstall)", runner.calls)
	}
	if _, err := os.Lstat(filepath.Join(plan.InstallRoot, "activation.json")); err != nil {
		t.Fatalf("restored activation missing: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(plan.InstallRoot, "bin", "kimi")); err != nil {
		t.Fatalf("restored executable missing: %v", err)
	}
}

func TestUVInstallRejectsChangedRunnerIdentity(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	runner := &fixtureUVInstallRunner{version: "1.49.0"}
	service, targetID := setupUVFixture(t, runner, &probeTransport{})
	plan := uvInstallPlan(t, service, targetID)
	plan.InstallCommand[0] = "uvx"

	err := service.executeInstall(context.Background(), plan, t.TempDir(), func(SetupActionPhase) error { return nil })
	if !errors.Is(err, ErrRuntimeInstallFailed) || !strings.Contains(err.Error(), "runner identity changed") {
		t.Fatalf("runner identity error = %v", err)
	}
	if runner.calls != 0 {
		t.Fatalf("install calls = %d, want 0", runner.calls)
	}
}

func uvInstallPlan(t *testing.T, service *SetupService, targetID string) InstallPlan {
	t.Helper()
	plan, err := service.Plans.GetInstallPlan(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Runner != "uv" {
		t.Fatalf("plan runner = %q, want uv", plan.Runner)
	}
	return plan
}

type fixtureUVInstallRunner struct {
	mu      sync.Mutex
	calls   int
	version string
	failErr error
	uvDir   string
	command []string
	cwd     string
	env     []string
}

func (r *fixtureUVInstallRunner) Run(_ context.Context, command []string, cwd string, env []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	r.command = append([]string(nil), command...)
	r.cwd = cwd
	r.env = append([]string(nil), env...)
	if r.failErr != nil {
		return r.failErr
	}
	toolDir := environmentValue(env, "UV_TOOL_DIR")
	binDir := environmentValue(env, "UV_TOOL_BIN_DIR")
	if toolDir == "" || binDir == "" {
		return errors.New("uv tool directories missing from installer environment")
	}
	// Mirror uv's layout: a real executable inside the tool environment and an
	// absolute symlink in the bin directory.
	realExecutable := filepath.Join(toolDir, "kimi-cli", "bin", "kimi")
	if err := os.MkdirAll(filepath.Dir(realExecutable), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(realExecutable, []byte("#!/bin/sh\necho "+r.version+"\n"), 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		return err
	}
	return os.Symlink(realExecutable, filepath.Join(binDir, "kimi"))
}

func setupUVFixture(
	t *testing.T,
	runner *fixtureUVInstallRunner,
	transport agentruntime.ProcessTransport,
) (*SetupService, string) {
	t.Helper()
	manifest := testManifest()
	manifest.AgentKey = "kimi-code"
	manifest.Name = "Kimi Code"
	manifest.Runtime.Install.Runner = "uv"
	manifest.Runtime.Install.Args = []string{"tool", "install", "kimi-cli==1.49.0"}
	manifest.Runtime.Launch.Executable = "${installRoot}/bin/kimi"
	manifest.Runtime.Launch.Args = []string{"acp"}
	discovery := `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["kimi"],"version":{"args":["--version"],"constraint":">=1.49.0 <2.0.0"},"launchArgs":["acp"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`
	stateDir := t.TempDir()
	runtimeInstallDir := filepath.Join(testResolvedTempDir(t), ".local", "share", "tutti", "agent-runtimes")
	runtimeBinDir := filepath.Join(t.TempDir(), ".local", "bin")
	store := &targetStoreStub{targets: map[string]agenttargetbiz.Target{}}
	manager := &Manager{
		RuntimeInstallDir: runtimeInstallDir, RuntimeBinDir: runtimeBinDir, Store: store,
		Installations:   agentextensiondata.NewFileInstallationStore(stateDir),
		Discovery:       agentextensiondata.NewFileSetupDiscoveryDirectory(stateDir),
		RuntimeResolver: setupFixtureRuntimeResolver(t),
	}
	installation, err := installTestPackage(t, manager, Release{AgentKey: "kimi-code", Version: "1.0.0"}, testPackageZIPFor(t, manifest, discovery))
	if err != nil {
		t.Fatal(err)
	}
	launchRef, err := agenttargetbiz.CanonicalLaunchRefJSON(installation.Provider, agenttargetbiz.LaunchRef{
		Type: agenttargetbiz.LaunchRefTypeAgentExtension, ExtensionInstallationID: installation.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	targetID := "extension:kimi-code"
	store.targets[targetID] = agenttargetbiz.Target{
		ID: targetID, Provider: installation.Provider, LaunchRefJSON: launchRef,
		Name: "Kimi Code", Enabled: true, Source: agenttargetbiz.SourceSystem,
	}
	service := NewSetupService(context.Background())
	service.Plans = InstallPlanService{
		Manager: manager, Workspaces: workspaceLookupStub{workspace: workspacebiz.Summary{ID: "workspace-1"}}, Targets: store,
	}
	service.Transport = transport
	service.Actions = agentextensiondata.NewFileSetupActionStore(stateDir)
	service.Discovery = agentextensiondata.NewFileSetupDiscoveryDirectory(stateDir)
	service.Runner = runner
	runner.uvDir = t.TempDir()
	service.UVToolchain = func(context.Context, *http.Client, string) (string, error) {
		return runner.uvDir, nil
	}
	t.Cleanup(func() { _ = service.Close() })
	return service, targetID
}
