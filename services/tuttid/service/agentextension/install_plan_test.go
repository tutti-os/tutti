package agentextension

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"runtime"
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
	runtimeInstallDir := filepath.Join(t.TempDir(), ".local", "share", "tutti", "agent-runtimes")
	store := &targetStoreStub{targets: map[string]agenttargetbiz.Target{}}
	manager := &Manager{Installations: agentextensiondata.NewFileInstallationStore(stateDir), RuntimeInstallDir: runtimeInstallDir, Store: store}
	installation, err := manager.install(
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

func TestInstallPlanServiceReusesRuntimeIdentityAcrossExtensionVersions(t *testing.T) {
	stateDir := t.TempDir()
	runtimeInstallDir := filepath.Join(t.TempDir(), ".local", "share", "tutti", "agent-runtimes")
	manager := &Manager{Installations: agentextensiondata.NewFileInstallationStore(stateDir), RuntimeInstallDir: runtimeInstallDir}
	first, err := manager.install(Release{AgentKey: "gemini", Version: "1.0.0"}, testPackageZIP(t))
	if err != nil {
		t.Fatal(err)
	}
	nextManifest := testManifest()
	nextManifest.Version = "1.0.1"
	second, err := manager.install(Release{AgentKey: "gemini", Version: "1.0.1"}, testPackageZIPFor(
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

func TestInstallPlanServiceUsesValidatedPackageManifest(t *testing.T) {
	store := &targetStoreStub{targets: map[string]agenttargetbiz.Target{}}
	manager := &Manager{Installations: agentextensiondata.NewFileInstallationStore(t.TempDir()), RuntimeInstallDir: t.TempDir(), Store: store}
	installation, err := manager.install(Release{AgentKey: "gemini", Version: "1.0.0"}, testPackageZIP(t))
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
	if err != nil {
		t.Fatal(err)
	}
	if got := loaded.Manifest.Runtime.Install.Args[3]; got != "@google/gemini-cli@0.50.0" {
		t.Fatalf("loaded runtime package = %q, want signed package manifest value", got)
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
	manifest.Runtime.Install.Args = []string{"tool", "install", "gemini-cli==1.2.3", "--target", "${installRoot}"}
	manifest.Runtime.Launch.Executable = "${installRoot}/bin/gemini"
	if err := validateRuntimeContract(manifest); err != nil {
		t.Fatalf("validateRuntimeContract(exact uv package) error = %v", err)
	}
	manifest.Runtime.Install.Args[2] = "gemini-cli"
	if err := validateRuntimeContract(manifest); err == nil {
		t.Fatal("validateRuntimeContract(unversioned uv package) error = nil")
	}
}
