package agentextension

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	agentextensiondata "github.com/tutti-os/tutti/services/tuttid/data/agentextension"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

type workspaceLookupStub struct {
	workspace workspacebiz.Summary
	err       error
}

func (s workspaceLookupStub) Get(_ context.Context, id string) (workspacebiz.Summary, error) {
	if s.err != nil {
		return workspacebiz.Summary{}, s.err
	}
	if id != s.workspace.ID {
		return workspacebiz.Summary{}, workspacedata.ErrWorkspaceNotFound
	}
	return s.workspace, nil
}

func TestInstallPlanServiceBuildsDeterministicTargetScopedPlan(t *testing.T) {
	stateDir := t.TempDir()
	runtimeInstallDir := filepath.Join(testResolvedTempDir(t), ".local", "share", "tutti", "agent-runtimes")
	store := &targetStoreStub{targets: map[string]agenttargetbiz.Target{}}
	manager := &Manager{Installations: agentextensiondata.NewFileInstallationStore(stateDir), RuntimeInstallDir: runtimeInstallDir, Store: store}
	installation, err := installTestPackage(t, manager,
		Release{AgentKey: "gemini", Version: "1.0.0"},
		testPackageZIP(t),
	)
	if err != nil {
		t.Fatal(err)
	}
	launchRef, err := agenttargetbiz.CanonicalLaunchRefJSON(installation.Provider, agenttargetbiz.LaunchRef{
		Type: agenttargetbiz.LaunchRefTypeAgentExtension, ExtensionInstallationID: installation.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	store.targets["extension:gemini"] = agenttargetbiz.Target{
		ID: "extension:gemini", Provider: installation.Provider, LaunchRefJSON: launchRef,
		Name: "Gemini CLI", Enabled: true, Source: agenttargetbiz.SourceSystem,
	}
	service := InstallPlanService{
		Manager: manager, Workspaces: workspaceLookupStub{workspace: workspacebiz.Summary{ID: "workspace-1"}}, Targets: store,
	}
	input := InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: "extension:gemini"}
	plan, err := service.GetInstallPlan(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if plan.RuntimeIdentity == "" {
		t.Fatalf("plan runtime identity is empty: %#v", plan)
	}
	wantRoot := filepath.Join(runtimeInstallDir, "gemini", plan.RuntimeIdentity)
	wantInstallCommand := []string{"npm", "install", "--prefix", wantRoot, "@google/gemini-cli@0.50.0"}
	if plan.InstallRoot != wantRoot || !reflect.DeepEqual(plan.InstallCommand, wantInstallCommand) {
		t.Fatalf("plan scope/command = %#v", plan)
	}
	if plan.PackageName != "@google/gemini-cli" || plan.PackageVersion != "0.50.0" {
		t.Fatalf("plan package = %q@%q", plan.PackageName, plan.PackageVersion)
	}
	if plan.Platform != runtime.GOOS+"-"+runtime.GOARCH || len(plan.PlanDigest) != 64 {
		t.Fatalf("plan platform/digest = %q/%q", plan.Platform, plan.PlanDigest)
	}
	repeated, err := service.GetInstallPlan(context.Background(), input)
	if err != nil || repeated.PlanDigest != plan.PlanDigest {
		t.Fatalf("repeated plan digest = %q, error = %v; want %q", repeated.PlanDigest, err, plan.PlanDigest)
	}

	service.Workspaces = workspaceLookupStub{workspace: workspacebiz.Summary{ID: "workspace-2"}}
	otherScope, err := service.GetInstallPlan(context.Background(), InstallPlanInput{
		WorkspaceID: "workspace-2", AgentTargetID: input.AgentTargetID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if otherScope.PlanDigest != plan.PlanDigest {
		t.Fatal("target-managed plan changed across workspaces")
	}

	if err := validateManagedRuntimeRoot(t.TempDir(), runtimeInstallDir, installation.AgentKey, plan.RuntimeIdentity); !errors.Is(err, ErrInvalidInstallPlanRequest) {
		t.Fatalf("invalid managed install root error = %v", err)
	}
}

func TestValidateManagedRuntimeRootRejectsSymlinkedAncestor(t *testing.T) {
	base := testResolvedTempDir(t)
	foreign := testResolvedTempDir(t)
	symlink := filepath.Join(base, "redirected")
	if err := os.Symlink(foreign, symlink); err != nil {
		t.Fatal(err)
	}
	runtimeInstallDir := filepath.Join(symlink, "agent-runtimes")
	installRoot := managedRuntimeRoot(runtimeInstallDir, "grok", "runtime-current")
	err := validateManagedRuntimeRoot(installRoot, runtimeInstallDir, "grok", "runtime-current")
	if !errors.Is(err, ErrInvalidInstallPlanRequest) || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("symlinked managed root error = %v", err)
	}
	if _, err := os.Lstat(filepath.Join(foreign, "agent-runtimes")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("managed root validation followed symlink: %v", err)
	}
}

func TestInstallPlanServiceReusesRuntimeIdentityAcrossExtensionVersions(t *testing.T) {
	stateDir := t.TempDir()
	runtimeInstallDir := filepath.Join(testResolvedTempDir(t), ".local", "share", "tutti", "agent-runtimes")
	manager := &Manager{Installations: agentextensiondata.NewFileInstallationStore(stateDir), RuntimeInstallDir: runtimeInstallDir}
	first, err := installTestPackage(t, manager, Release{AgentKey: "gemini", Version: "1.0.0"}, testPackageZIP(t))
	if err != nil {
		t.Fatal(err)
	}
	nextManifest := testManifest()
	nextManifest.Version = "1.0.1"
	second, err := installTestPackage(t, manager, Release{AgentKey: "gemini", Version: "1.0.1"}, testPackageZIPFor(
		t,
		nextManifest,
		`{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["gemini"],"version":{"args":["--version"],"constraint":">=0.50.0 <1.0.0"},"launchArgs":["--acp"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`,
	))
	if err != nil {
		t.Fatal(err)
	}
	firstPlan, err := buildInstallPlan("extension:gemini", runtimeInstallDir, first)
	if err != nil {
		t.Fatal(err)
	}
	secondPlan, err := buildInstallPlan("extension:gemini", runtimeInstallDir, second)
	if err != nil {
		t.Fatal(err)
	}
	if firstPlan.RuntimeIdentity != secondPlan.RuntimeIdentity || firstPlan.InstallRoot != secondPlan.InstallRoot {
		t.Fatalf("runtime identity changed across extension metadata update: first=%#v second=%#v", firstPlan, secondPlan)
	}
	if firstPlan.ExtensionInstallationID == secondPlan.ExtensionInstallationID {
		t.Fatalf("fixture did not create distinct extension installations: %q", firstPlan.ExtensionInstallationID)
	}
	if firstPlan.PlanDigest == secondPlan.PlanDigest {
		t.Fatal("plan digest did not retain extension installation binding")
	}
}

func TestManagedRuntimeIdentityPreservesExistingV2PackageIdentity(t *testing.T) {
	manifest := testManifest()
	installation := Installation{AgentKey: manifest.AgentKey, Manifest: manifest}
	profile := DiscoveryProfile{}
	if err := json.Unmarshal([]byte(`{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["gemini"],"version":{"args":["--version"],"constraint":">=0.50.0 <1.0.0"},"launchArgs":["--acp"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`), &profile); err != nil {
		t.Fatal(err)
	}
	platform := runtime.GOOS + "-" + runtime.GOARCH
	got, err := managedRuntimeIdentity(installation, profile, "@google/gemini-cli", "0.50.0", platform)
	if err != nil {
		t.Fatal(err)
	}
	legacyValue := struct {
		SchemaVersion  string           `json:"schemaVersion"`
		AgentKey       string           `json:"agentKey"`
		RuntimeKind    string           `json:"runtimeKind"`
		Platform       string           `json:"platform"`
		Runner         string           `json:"runner"`
		PackageName    string           `json:"packageName"`
		PackageVersion string           `json:"packageVersion"`
		InstallArgs    []string         `json:"installArgs"`
		Launch         runtimeLaunchKey `json:"launch"`
		Discovery      DiscoveryProfile `json:"discovery"`
	}{
		SchemaVersion: "tutti.agent.managed-runtime-identity.v1", AgentKey: manifest.AgentKey,
		RuntimeKind: manifest.Runtime.Kind, Platform: platform, Runner: manifest.Runtime.Install.Runner,
		PackageName: "@google/gemini-cli", PackageVersion: "0.50.0",
		InstallArgs: append([]string(nil), manifest.Runtime.Install.Args...),
		Launch:      runtimeLaunchKey{Executable: manifest.Runtime.Launch.Executable, Args: append([]string(nil), manifest.Runtime.Launch.Args...)},
		Discovery:   profile,
	}
	encoded, err := json.Marshal(legacyValue)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(encoded)
	want := "runtime-" + hex.EncodeToString(digest[:])[:16]
	if got != want {
		t.Fatalf("existing v2 runtime identity = %q, want legacy %q", got, want)
	}
}

func TestInstallPlanServiceUsesValidatedPackageManifest(t *testing.T) {
	store := &targetStoreStub{targets: map[string]agenttargetbiz.Target{}}
	manager := &Manager{Installations: agentextensiondata.NewFileInstallationStore(t.TempDir()), RuntimeInstallDir: testResolvedTempDir(t), Store: store}
	installation, err := installTestPackage(t, manager, Release{AgentKey: "gemini", Version: "1.0.0"}, testPackageZIP(t))
	if err != nil {
		t.Fatal(err)
	}
	installation.Manifest.Runtime.Install.Args = []string{
		"install", "--prefix", "${installRoot}", "@attacker/runtime@9.9.9",
	}
	if err := writeJSONAtomic(filepath.Join(installation.PackageDir, "installation.json"), installation); err != nil {
		t.Fatal(err)
	}
	loaded, err := manager.loadInstallationByID(installation.ID)
	if err == nil || !strings.Contains(err.Error(), "manifest does not match signed package authority") {
		t.Fatalf("mutable installation manifest error = %v, loaded = %#v", err, loaded)
	}
}

func TestInstallPlanServiceRejectsInvalidScopeAndTarget(t *testing.T) {
	service := InstallPlanService{
		Manager: &Manager{}, Workspaces: workspaceLookupStub{err: workspacedata.ErrWorkspaceNotFound},
		Targets: &targetStoreStub{targets: map[string]agenttargetbiz.Target{}},
	}
	if _, err := service.GetInstallPlan(context.Background(), InstallPlanInput{WorkspaceID: "missing", AgentTargetID: "target"}); !errors.Is(err, workspacedata.ErrWorkspaceNotFound) {
		t.Fatalf("missing workspace error = %v", err)
	}
	service.Workspaces = workspaceLookupStub{workspace: workspacebiz.Summary{ID: "workspace-1"}}
	if _, err := service.GetInstallPlan(context.Background(), InstallPlanInput{WorkspaceID: "workspace-1", AgentTargetID: "missing"}); !errors.Is(err, workspacedata.ErrAgentTargetNotFound) {
		t.Fatalf("missing target error = %v", err)
	}
}

func TestValidateRuntimeContractRequiresExactUVPackage(t *testing.T) {
	manifest := testManifest()
	manifest.Runtime.Install.Runner = "uv"
	manifest.Runtime.Install.Args = []string{"tool", "install", "gemini-cli[acp]==1.2.3"}
	manifest.Runtime.Launch.Executable = "${installRoot}/bin/gemini"
	if err := validateRuntimeContract(manifest); err != nil {
		t.Fatalf("validateRuntimeContract(exact uv package) error = %v", err)
	}
	manifest.Runtime.Install.Args[2] = "gemini-cli[acp]"
	if err := validateRuntimeContract(manifest); err == nil {
		t.Fatal("validateRuntimeContract(unversioned uv package) error = nil")
	}
}

func TestValidateRuntimeContractAcceptsPinnedSignedBinaryArtifacts(t *testing.T) {
	manifest := testManifest()
	manifest.Runtime.Install.Runner = "binary"
	manifest.Runtime.Install.Args = nil
	manifest.Runtime.Install.Artifacts = []RuntimeBinaryArtifact{{
		Kind: "executable", Platform: "darwin-arm64", Version: "0.2.103",
		URL:       "https://x.ai/cli/grok-0.2.103-macos-aarch64",
		SHA256:    "1be9de92f31566f2d38992125f902220b022f4f1e3fb7330532a0513d1d6f0f2",
		SizeBytes: 121600480,
	}}
	manifest.Runtime.Install.Artifacts[0].Provenance.Kind = "official-release"
	manifest.Runtime.Install.Artifacts[0].Provenance.URL = "https://x.ai/cli/install.sh"
	manifest.Runtime.Launch.Executable = "${installRoot}/grok"
	publish := false
	manifest.Runtime.Launch.PublishUserCommand = &publish
	if err := validateRuntimeContract(manifest); err != nil {
		t.Fatalf("validateRuntimeContract(binary) error = %v", err)
	}

	invalid := manifest
	invalid.Runtime.Install.Artifacts = append([]RuntimeBinaryArtifact(nil), manifest.Runtime.Install.Artifacts...)
	invalid.Runtime.Install.Artifacts[0].URL = "http://example.com/grok"
	if err := validateRuntimeContract(invalid); err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("insecure artifact URL error = %v", err)
	}
	invalid = manifest
	invalid.Runtime.Install.Artifacts = append(invalid.Runtime.Install.Artifacts, invalid.Runtime.Install.Artifacts[0])
	if err := validateRuntimeContract(invalid); err == nil || !strings.Contains(err.Error(), "duplicated") {
		t.Fatalf("duplicate artifact platform error = %v", err)
	}
}

func TestBuildInstallPlanFailsClosedOnUnsupportedBinaryPlatform(t *testing.T) {
	manifest := testManifest()
	manifest.Runtime.Install.Runner = "binary"
	manifest.Runtime.Install.Args = nil
	manifest.Runtime.Install.Artifacts = []RuntimeBinaryArtifact{{
		Kind: "executable", Platform: "unsupported-platform", Version: "0.2.103",
		URL: "https://example.com/grok-0.2.103", SHA256: strings.Repeat("a", 64), SizeBytes: 10,
	}}
	manifest.Runtime.Install.Artifacts[0].Provenance.Kind = "official-release"
	manifest.Runtime.Install.Artifacts[0].Provenance.URL = "https://example.com/releases/0.2.103"
	manifest.Runtime.Launch.Executable = "${installRoot}/grok"
	installation := Installation{AgentKey: "grok", Manifest: manifest, PackageDir: t.TempDir()}
	if _, err := buildInstallPlan("extension:grok", t.TempDir(), installation); !errors.Is(err, ErrUnsupportedInstallTarget) {
		t.Fatalf("unsupported binary platform error = %v", err)
	}
}
