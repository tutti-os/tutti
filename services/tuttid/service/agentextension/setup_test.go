package agentextension

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	agentextensiondata "github.com/tutti-os/tutti/services/tuttid/data/agentextension"
)

func TestAgentTargetSetupInstallsGenericExtensionRuntime(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("TUTTI_INSTALL_SECRET", "must-not-leak")
	runner := &fixtureInstallRunner{binary: "generic-agent", packageName: "@example/generic-agent", version: "1.2.3"}
	service, targetID := setupFixture(
		t, "generic", "Generic Agent", "@example/generic-agent", "1.2.3", "generic-agent", ">=1.2.3 <2.0.0",
		runner, &probeTransport{},
	)

	initial, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if initial.Status != SetupNotInstalled || initial.Plan == nil || initial.Plan.PackageName != "@example/generic-agent" || initial.Plan.PackageVersion != "1.2.3" {
		t.Fatalf("initial setup = %#v", initial)
	}
	started, err := service.Install(context.Background(), InstallInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		PlanDigest: initial.Plan.PlanDigest, ClientActionID: "desktop-double-click-1",
	})
	if err != nil || started.Status != SetupInstalling || started.Action == nil {
		t.Fatalf("start setup = %#v, error = %v", started, err)
	}
	if _, err := service.Install(context.Background(), InstallInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		PlanDigest: initial.Plan.PlanDigest, ClientActionID: "desktop-double-click-1",
	}); err != nil {
		t.Fatalf("idempotent install: %v", err)
	}

	ready := waitForSetupStatus(t, service, targetID, SetupReady)
	if ready.RuntimeSource != "managed" || ready.RuntimeVersion != "1.2.3" || ready.Plan != nil {
		t.Fatalf("ready setup = %#v", ready)
	}
	if runner.calls != 1 {
		t.Fatalf("install calls = %d, want 1", runner.calls)
	}
	userEntry := filepath.Join(service.Plans.Manager.RuntimeBinDir, "generic-agent")
	resolvedEntry, err := filepath.EvalSymlinks(userEntry)
	if err != nil {
		t.Fatalf("resolve user executable entry %q: %v", userEntry, err)
	}
	wantEntry := filepath.Join(
		initial.Plan.InstallRoot,
		"node_modules", "@example", "generic-agent", "bin", "generic-agent",
	)
	resolvedWantEntry, err := filepath.EvalSymlinks(wantEntry)
	if err != nil {
		t.Fatal(err)
	}
	if resolvedEntry != resolvedWantEntry {
		t.Fatalf("user executable entry = %q, want %q", resolvedEntry, resolvedWantEntry)
	}
	t.Setenv("PATH", service.Plans.Manager.RuntimeBinDir)
	resolvedSetup, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if resolvedSetup.RuntimeSource != "managed" {
		t.Fatalf("published user executable bypassed managed integrity checks: %#v", resolvedSetup)
	}
	if !pathWithin(runner.cwd, service.Plans.Manager.RuntimeInstallDir) {
		t.Fatalf("installer cwd = %q, want user-local Tutti runtime scratch", runner.cwd)
	}
	for _, value := range runner.env {
		if strings.HasPrefix(value, "TUTTI_INSTALL_SECRET=") {
			t.Fatalf("installer environment leaked secret: %q", value)
		}
	}
	for _, key := range []string{"npm_config_cache=", "npm_config_userconfig=", "npm_config_globalconfig="} {
		if !environmentPathWithin(runner.env, key, runner.cwd) {
			t.Fatalf("installer environment %s is not isolated under %q: %v", key, runner.cwd, runner.env)
		}
	}
}

func TestAgentTargetSetupReusesManagedRuntimeAcrossExtensionVersions(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	runner := &fixtureInstallRunner{binary: "generic-agent", packageName: "@example/generic-agent", version: "1.2.3"}
	service, targetID := setupFixture(
		t, "generic", "Generic Agent", "@example/generic-agent", "1.2.3", "generic-agent", ">=1.2.3 <2.0.0",
		runner, &probeTransport{},
	)
	initial, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Install(context.Background(), InstallInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		PlanDigest: initial.Plan.PlanDigest, ClientActionID: "first-install",
	}); err != nil {
		t.Fatal(err)
	}
	firstReady := waitForSetupStatus(t, service, targetID, SetupReady)
	if firstReady.RuntimeSource != "managed" {
		t.Fatalf("first ready setup = %#v", firstReady)
	}
	var legacyActivation managedRuntimeActivation
	if err := readJSON(filepath.Join(initial.Plan.InstallRoot, "activation.json"), &legacyActivation); err != nil {
		t.Fatal(err)
	}
	legacyActivation.RuntimeIdentity = ""
	if err := writeJSONAtomic(filepath.Join(initial.Plan.InstallRoot, "activation.json"), legacyActivation); err != nil {
		t.Fatal(err)
	}
	legacyRoot := filepath.Join(service.Plans.Manager.RuntimeInstallDir, "generic", "1.0.0")
	if err := os.Rename(initial.Plan.InstallRoot, legacyRoot); err != nil {
		t.Fatal(err)
	}

	manifest := testManifest()
	manifest.AgentKey = "generic"
	manifest.Version = "1.0.1"
	manifest.Name = "Generic Agent"
	manifest.Runtime.Install.Args = []string{"install", "--prefix", "${installRoot}", "@example/generic-agent@1.2.3"}
	manifest.Runtime.Launch.Executable = "${installRoot}/node_modules/.bin/generic-agent"
	discovery := `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["generic-agent"],"version":{"args":["--version"],"constraint":">=1.2.3 <2.0.0"},"launchArgs":["--acp"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`
	next, err := service.Plans.Manager.install(Release{AgentKey: "generic", Version: "1.0.1"}, testPackageZIPFor(t, manifest, discovery))
	if err != nil {
		t.Fatal(err)
	}
	launchRef, err := agenttargetbiz.CanonicalLaunchRefJSON(next.Provider, agenttargetbiz.LaunchRef{
		Type: agenttargetbiz.LaunchRefTypeAgentExtension, ExtensionInstallationID: next.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	store := service.Plans.Targets.(*targetStoreStub)
	target := store.targets[targetID]
	target.LaunchRefJSON = launchRef
	store.targets[targetID] = target

	snapshot, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Status != SetupReady || snapshot.RuntimeSource != "managed" || snapshot.RuntimeVersion != "1.2.3" {
		t.Fatalf("reused runtime setup = %#v", snapshot)
	}
	if _, err := os.Stat(filepath.Join(initial.Plan.InstallRoot, "activation.json")); err != nil {
		t.Fatalf("adopted runtime root is unavailable: %v", err)
	}
	if _, err := os.Stat(legacyRoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("legacy runtime root was not adopted away: %v", err)
	}
	if runner.calls != 1 {
		t.Fatalf("runtime was reinstalled after extension metadata update: calls=%d", runner.calls)
	}
	nextPlan, err := service.Plans.GetInstallPlan(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if nextPlan.InstallRoot != initial.Plan.InstallRoot || nextPlan.RuntimeIdentity != initial.Plan.RuntimeIdentity {
		t.Fatalf("runtime identity changed across extension versions: first=%#v next=%#v", initial.Plan, nextPlan)
	}
}

func TestAgentTargetSetupDoesNotOverwriteUserExecutable(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	service, targetID := setupFixture(
		t, "generic", "Generic Agent", "@example/generic-agent", "1.2.3", "generic-agent", ">=1.2.3 <2.0.0",
		&fixtureInstallRunner{binary: "generic-agent", packageName: "@example/generic-agent", version: "1.2.3"},
		&probeTransport{},
	)
	userEntry := filepath.Join(service.Plans.Manager.RuntimeBinDir, "generic-agent")
	if err := os.MkdirAll(filepath.Dir(userEntry), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(userEntry, []byte("user-owned\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	initial, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Install(context.Background(), InstallInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		PlanDigest: initial.Plan.PlanDigest, ClientActionID: "user-entry-conflict",
	}); err != nil {
		t.Fatal(err)
	}
	failed := waitForSetupStatus(t, service, targetID, SetupFailed)
	if failed.Action == nil || failed.Action.ErrorCode != "activation_failed" ||
		!strings.Contains(failed.Action.ErrorMessage, "already occupied") {
		t.Fatalf("user executable conflict = %#v", failed)
	}
	content, err := os.ReadFile(userEntry)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "user-owned\n" {
		t.Fatalf("user executable was overwritten: %q", content)
	}
	if _, err := os.Stat(initial.Plan.InstallRoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed activation left managed runtime behind: %v", err)
	}
}

func TestAgentTargetSetupPrefersCompatibleLocalCodeBuddy(t *testing.T) {
	binDir := t.TempDir()
	writeVersionExecutable(t, filepath.Join(binDir, "codebuddy"), "2.121.2")
	t.Setenv("PATH", binDir)
	runner := &fixtureInstallRunner{}
	service, targetID := setupFixture(t, "codebuddy", "CodeBuddy Code", "@tencent-ai/codebuddy-code", "2.121.2", "codebuddy", ">=2.121.2 <3.0.0", runner, &probeTransport{})
	snapshot, err := service.GetSetup(context.Background(), InstallPlanInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Status != SetupReady || snapshot.RuntimeSource != "local" || snapshot.RuntimeVersion != "2.121.2" || snapshot.Plan != nil {
		t.Fatalf("local-first setup = %#v", snapshot)
	}
	if runner.calls != 0 {
		t.Fatalf("local-first install calls = %d", runner.calls)
	}
}

func TestAgentTargetSetupAuthenticatesGenericRuntimeToReady(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	transport := &probeTransport{authRequired: true}
	service, targetID := setupFixture(
		t, "generic", "Generic Agent", "@example/generic-agent", "1.2.3", "generic-agent", ">=1.2.3 <2.0.0",
		&fixtureInstallRunner{binary: "generic-agent", packageName: "@example/generic-agent", version: "1.2.3"}, transport,
	)
	initial, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Install(context.Background(), InstallInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		PlanDigest: initial.Plan.PlanDigest, ClientActionID: "auth-install-1",
	}); err != nil {
		t.Fatal(err)
	}
	authRequired := waitForSetupStatus(t, service, targetID, SetupAuthRequired)
	if authRequired.RuntimeSource != "managed" || authRequired.RuntimeVersion != "1.2.3" || len(authRequired.AuthMethods) != 1 {
		t.Fatalf("auth-required setup = %#v", authRequired)
	}
	if _, err := service.Authenticate(context.Background(), AuthenticateInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		MethodID: "attacker-method", ClientActionID: "invalid-auth-action",
	}); !errors.Is(err, ErrInvalidInstallPlanRequest) {
		t.Fatalf("unadvertised method error = %v", err)
	}
	started, err := service.Authenticate(context.Background(), AuthenticateInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		MethodID: "oauth-personal", ClientActionID: "auth-action-1",
	})
	if err != nil || started.Status != SetupAuthenticating || started.Action == nil || started.Action.Kind != SetupActionAuthenticate {
		t.Fatalf("authenticate start = %#v, error = %v", started, err)
	}
	ready := waitForSetupStatus(t, service, targetID, SetupReady)
	if ready.RuntimeSource != "managed" || !transport.isAuthenticated() || ready.Account == nil ||
		ready.Account.ID != "user-1" || ready.Account.DisplayName != "Rhinoc" || ready.Account.AuthMethodID != "oauth-personal" {
		t.Fatalf("authenticated setup = %#v, authenticated = %v", ready, transport.isAuthenticated())
	}
}

func TestAgentTargetSetupFeedsRuntimeAuthFailureBackIntoDetectionAndAllowsRelogin(t *testing.T) {
	binDir := t.TempDir()
	writeVersionExecutable(t, filepath.Join(binDir, "gemini"), "0.50.0")
	t.Setenv("PATH", binDir)
	transport := &probeTransport{authRequired: true, authenticated: true}
	service, targetID := setupFixture(
		t, "gemini", "Gemini CLI", "@google/gemini-cli", "0.50.0", "gemini", ">=0.50.0 <1.0.0",
		&fixtureInstallRunner{}, transport,
	)
	authState := &fixtureRuntimeAuthInvalidation{invalidated: map[string]bool{"acp:gemini": true}}
	service.AuthInvalidation = authState

	snapshot, err := service.GetSetup(context.Background(), InstallPlanInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Status != SetupAuthRequired || snapshot.Reason != "runtime_auth_invalidated" {
		t.Fatalf("runtime auth invalidation snapshot = %#v", snapshot)
	}
	if _, err := service.Authenticate(context.Background(), AuthenticateInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		MethodID: "oauth-personal", ClientActionID: "runtime-auth-retry",
	}); err != nil {
		t.Fatal(err)
	}
	ready := waitForSetupStatus(t, service, targetID, SetupReady)
	if ready.Status != SetupReady || authState.AuthInvalidated("acp:gemini") {
		t.Fatalf("re-authenticated setup = %#v, invalidated = %v", ready, authState.AuthInvalidated("acp:gemini"))
	}
}

func TestAgentTargetSetupPersistsProviderAuthenticationFailure(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	transport := &probeTransport{
		authRequired:      true,
		authenticateError: "This account is not supported by this client",
	}
	service, targetID := setupFixture(
		t, "gemini", "Gemini CLI", "@google/gemini-cli", "0.50.0", "gemini", ">=0.50.0 <1.0.0",
		&fixtureInstallRunner{binary: "gemini", packageName: "@google/gemini-cli", version: "0.50.0"},
		transport,
	)
	initial, err := service.GetSetup(context.Background(), InstallPlanInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Install(context.Background(), InstallInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		PlanDigest: initial.Plan.PlanDigest, ClientActionID: "auth-error-install",
	}); err != nil {
		t.Fatal(err)
	}
	authRequired := waitForSetupStatus(t, service, targetID, SetupAuthRequired)
	if _, err := service.Authenticate(context.Background(), AuthenticateInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		MethodID: "oauth-personal", ClientActionID: "auth-error-action",
	}); err != nil {
		t.Fatal(err)
	}
	authRequired = waitForSetupStatus(t, service, targetID, SetupAuthRequired)
	if authRequired.Action == nil || authRequired.Action.Status != SetupActionFailed ||
		!strings.Contains(authRequired.Action.ErrorMessage, transport.authenticateError) {
		t.Fatalf("failed authentication snapshot = %#v", authRequired)
	}
}

func TestAgentTargetSetupRejectsManagedRuntimeBinaryReplacement(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	service, targetID := setupFixture(
		t, "gemini", "Gemini CLI", "@google/gemini-cli", "0.50.0", "gemini", ">=0.50.0 <1.0.0",
		&fixtureInstallRunner{binary: "gemini", packageName: "@google/gemini-cli", version: "0.50.0"},
		&probeTransport{},
	)
	initial, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Install(context.Background(), InstallInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		PlanDigest: initial.Plan.PlanDigest, ClientActionID: "fingerprint-install",
	}); err != nil {
		t.Fatal(err)
	}
	ready := waitForSetupStatus(t, service, targetID, SetupReady)
	root := initial.Plan.InstallRoot
	var activation managedRuntimeActivation
	if err := readJSON(filepath.Join(root, "activation.json"), &activation); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(root, filepath.FromSlash(activation.ExecutableRelativePath))
	if err := os.WriteFile(executable, []byte("#!/bin/sh\necho 0.50.0\n# replaced\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	snapshot, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if ready.RuntimeSource != "managed" || snapshot.Status != SetupNotInstalled || snapshot.Reason != "runtime_integrity_failed" || snapshot.Plan == nil {
		t.Fatalf("replacement snapshot = %#v", snapshot)
	}
}

func TestAgentTargetSetupRequiresPublishedUserExecutable(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	service, targetID := setupFixture(
		t, "gemini", "Gemini CLI", "@google/gemini-cli", "0.50.0", "gemini", ">=0.50.0 <1.0.0",
		&fixtureInstallRunner{binary: "gemini", packageName: "@google/gemini-cli", version: "0.50.0"},
		&probeTransport{},
	)
	initial, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Install(context.Background(), InstallInput{
		WorkspaceID: "workspace-1", AgentTargetID: targetID,
		PlanDigest: initial.Plan.PlanDigest, ClientActionID: "published-entry-install",
	}); err != nil {
		t.Fatal(err)
	}
	waitForSetupStatus(t, service, targetID, SetupReady)
	if err := os.Remove(filepath.Join(service.Plans.Manager.RuntimeBinDir, "gemini")); err != nil {
		t.Fatal(err)
	}
	snapshot, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Status != SetupNotInstalled || snapshot.Reason != "runtime_integrity_failed" || snapshot.Plan == nil {
		t.Fatalf("missing user executable snapshot = %#v", snapshot)
	}
}

func TestAgentTargetSetupRecoversRunningActionAsInterrupted(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	service, targetID := setupFixture(
		t, "gemini", "Gemini CLI", "@google/gemini-cli", "0.50.0", "gemini", ">=0.50.0 <1.0.0",
		&fixtureInstallRunner{}, &probeTransport{},
	)
	plan, err := service.Plans.GetInstallPlan(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	action := SetupAction{
		ActionID: "stale-action", ClientActionID: "stale-client", WorkspaceID: "workspace-1",
		Kind:          SetupActionInstall,
		AgentTargetID: plan.AgentTargetID, ExtensionInstallationID: plan.ExtensionInstallationID, PlanDigest: plan.PlanDigest,
		Status: SetupActionRunning, Phase: SetupPhaseInstalling,
	}
	if err := service.writeAction(context.Background(), plan, action); err != nil {
		t.Fatal(err)
	}
	restarted := NewSetupService(context.Background())
	restarted.Plans = service.Plans
	restarted.Transport = service.Transport
	restarted.Actions = service.Actions
	restarted.Discovery = service.Discovery
	restarted.Runner = service.Runner
	t.Cleanup(func() { _ = restarted.Close() })
	snapshot, err := restarted.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Status != SetupFailed || snapshot.Action == nil || snapshot.Action.Status != SetupActionInterrupted || snapshot.Reason != "daemon_restarted" {
		t.Fatalf("recovered setup = %#v", snapshot)
	}
}

func setupFixture(
	t *testing.T,
	key, name, packageName, packageVersion, binary, constraint string,
	runner InstallCommandRunner,
	transport agentruntime.ProcessTransport,
) (*SetupService, string) {
	t.Helper()
	manifest := testManifest()
	manifest.AgentKey = key
	manifest.Name = name
	manifest.Runtime.Install.Args = []string{"install", "--prefix", "${installRoot}", packageName + "@" + packageVersion}
	manifest.Runtime.Launch.Executable = "${installRoot}/node_modules/.bin/" + binary
	discovery := `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["` + binary + `"],"version":{"args":["--version"],"constraint":"` + constraint + `"},"launchArgs":["--acp"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`
	stateDir := t.TempDir()
	runtimeInstallDir := filepath.Join(t.TempDir(), ".local", "share", "tutti", "agent-runtimes")
	runtimeBinDir := filepath.Join(t.TempDir(), ".local", "bin")
	store := &targetStoreStub{targets: map[string]agenttargetbiz.Target{}}
	manager := &Manager{
		RuntimeInstallDir: runtimeInstallDir, RuntimeBinDir: runtimeBinDir, Store: store,
		Installations: agentextensiondata.NewFileInstallationStore(stateDir),
		Discovery:     agentextensiondata.NewFileSetupDiscoveryDirectory(stateDir),
	}
	installation, err := manager.install(Release{AgentKey: key, Version: "1.0.0"}, testPackageZIPFor(t, manifest, discovery))
	if err != nil {
		t.Fatal(err)
	}
	launchRef, err := agenttargetbiz.CanonicalLaunchRefJSON(installation.Provider, agenttargetbiz.LaunchRef{
		Type: agenttargetbiz.LaunchRefTypeAgentExtension, ExtensionInstallationID: installation.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	targetID := "extension:" + key
	store.targets[targetID] = agenttargetbiz.Target{
		ID: targetID, Provider: installation.Provider, LaunchRefJSON: launchRef,
		Name: name, Enabled: true, Source: agenttargetbiz.SourceSystem,
	}
	plans := InstallPlanService{
		Manager: manager, Workspaces: workspaceLookupStub{workspace: workspacebiz.Summary{ID: "workspace-1"}}, Targets: store,
	}
	service := NewSetupService(context.Background())
	service.Plans = plans
	service.Transport = transport
	service.Actions = agentextensiondata.NewFileSetupActionStore(stateDir)
	service.Discovery = agentextensiondata.NewFileSetupDiscoveryDirectory(stateDir)
	service.Runner = runner
	t.Cleanup(func() { _ = service.Close() })
	return service, targetID
}

func waitForSetupStatus(t *testing.T, service *SetupService, targetID string, status SetupStatus) SetupSnapshot {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	var last SetupSnapshot
	for time.Now().Before(deadline) {
		snapshot, err := service.GetSetup(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: targetID})
		if err != nil {
			t.Fatal(err)
		}
		if snapshot.Status == status {
			return snapshot
		}
		last = snapshot
		time.Sleep(25 * time.Millisecond)
	}
	if last.Action != nil {
		t.Fatalf("setup did not reach %q; status=%s reason=%s action=%#v", status, last.Status, last.Reason, *last.Action)
	}
	t.Fatalf("setup did not reach %q; last snapshot = %#v", status, last)
	return SetupSnapshot{}
}

type fixtureInstallRunner struct {
	mu          sync.Mutex
	calls       int
	binary      string
	packageName string
	version     string
	cwd         string
	env         []string
}

func (r *fixtureInstallRunner) Run(_ context.Context, command []string, cwd string, env []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	r.cwd = cwd
	r.env = append([]string(nil), env...)
	var root string
	for index, value := range command {
		if value == "--prefix" && index+1 < len(command) {
			root = command[index+1]
		}
	}
	if root == "" {
		return errors.New("missing install prefix")
	}
	packageRoot := filepath.Join(root, "node_modules", filepath.FromSlash(r.packageName))
	realExecutable := filepath.Join(packageRoot, "bin", r.binary)
	if err := os.MkdirAll(filepath.Dir(realExecutable), 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(root, "node_modules", ".bin"), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(realExecutable, []byte("#!/bin/sh\necho "+r.version+"\n"), 0o700); err != nil {
		return err
	}
	relative, err := filepath.Rel(filepath.Join(root, "node_modules", ".bin"), realExecutable)
	if err != nil {
		return err
	}
	return os.Symlink(relative, filepath.Join(root, "node_modules", ".bin", r.binary))
}

func environmentPathWithin(environment []string, prefix, root string) bool {
	for _, value := range environment {
		if strings.HasPrefix(value, prefix) {
			return pathWithin(strings.TrimPrefix(value, prefix), root)
		}
	}
	return false
}

func writeVersionExecutable(t *testing.T, path, version string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho "+version+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
}

type probeTransport struct {
	mu                sync.Mutex
	authRequired      bool
	authenticated     bool
	authenticateError string
}

type fixtureRuntimeAuthInvalidation struct {
	mu          sync.Mutex
	invalidated map[string]bool
}

func (s *fixtureRuntimeAuthInvalidation) AuthInvalidated(provider string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.invalidated[provider]
}

func (s *fixtureRuntimeAuthInvalidation) ClearAuthInvalidated(provider string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.invalidated, provider)
}

func (t *probeTransport) Start(context.Context, agentruntime.ProcessSpec) (agentruntime.ProcessConnection, error) {
	return &probeConnection{frames: make(chan agentruntime.ProcessFrame, 4), owner: t}, nil
}

func (t *probeTransport) isAuthenticated() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.authenticated
}

type probeConnection struct {
	frames chan agentruntime.ProcessFrame
	once   sync.Once
	owner  *probeTransport
}

func (c *probeConnection) Send(value []byte) error {
	var request struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(value))), &request); err != nil {
		return err
	}
	result := map[string]any{}
	switch request.Method {
	case "initialize":
		result = map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{}, "agentInfo": map[string]any{"name": "fixture", "version": "1.0.0"}}
		if c.owner.authRequired {
			result["authMethods"] = []any{map[string]any{"id": "oauth-personal", "name": "Log in with Google"}}
		}
	case "authenticate":
		if c.owner.authenticateError != "" {
			response, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0", "id": request.ID,
				"error": map[string]any{"code": -32000, "message": c.owner.authenticateError},
			})
			c.frames <- agentruntime.ProcessFrame{Stdout: append(response, '\n')}
			return nil
		}
		c.owner.mu.Lock()
		c.owner.authenticated = true
		c.owner.mu.Unlock()
		result = map[string]any{
			"_meta": map[string]any{
				"codebuddy.ai/userinfo": map[string]any{
					"userId": "user-1", "userName": "Ryan", "userNickname": "Rhinoc",
				},
			},
		}
	case "session/new":
		if c.owner.authRequired && !c.owner.isAuthenticated() {
			response, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0", "id": request.ID,
				"error": map[string]any{"code": -32000, "message": "authentication required"},
			})
			c.frames <- agentruntime.ProcessFrame{Stdout: append(response, '\n')}
			return nil
		}
		result = map[string]any{"sessionId": "fixture-session", "configOptions": []any{}}
	}
	response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
	c.frames <- agentruntime.ProcessFrame{Stdout: append(response, '\n')}
	return nil
}

func (c *probeConnection) Recv() (agentruntime.ProcessFrame, error) {
	frame, ok := <-c.frames
	if !ok {
		return agentruntime.ProcessFrame{}, io.EOF
	}
	return frame, nil
}

func (c *probeConnection) Close() error {
	c.once.Do(func() { close(c.frames) })
	return nil
}
