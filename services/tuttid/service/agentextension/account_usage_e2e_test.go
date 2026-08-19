package agentextension

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	agentextensiondata "github.com/tutti-os/tutti/services/tuttid/data/agentextension"
)

func TestAccountUsageProbeE2EInstallsActualNPMPackage(t *testing.T) {
	if os.Getenv("TUTTI_RUN_NPM_ACCOUNT_USAGE_E2E") != "1" {
		t.Skip("set TUTTI_RUN_NPM_ACCOUNT_USAGE_E2E=1 to run the npm account usage E2E")
	}
	npmPath, err := exec.LookPath("npm")
	if err != nil {
		t.Skip("npm is unavailable")
	}
	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is unavailable")
	}
	nodePath, err = filepath.EvalSymlinks(nodePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("TUTTI_APP_NODE", nodePath)

	manifest := testManifest()
	manifest.Profiles.AccountUsage = "profiles/account-usage.json"
	store := &targetStoreStub{targets: map[string]agenttargetbiz.Target{}}
	manager := &Manager{
		RuntimeInstallDir: filepath.Join(testResolvedTempDir(t), "agent-runtimes"),
		Installations:     agentextensiondata.NewFileInstallationStore(t.TempDir()),
		Store:             store,
	}
	installation, err := installTestPackage(
		t, manager, Release{AgentKey: manifest.AgentKey, Version: manifest.Version},
		testPackageZIPFor(t, manifest, `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["gemini"],"version":{"args":["--version"],"constraint":">=0.50.0 <1.0.0"},"launchArgs":["--acp"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := buildInstallPlan("extension:gemini", manager.RuntimeInstallDir, installation)
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := filepath.Abs("testdata/account-usage-node-package")
	if err != nil {
		t.Fatal(err)
	}
	packDir := t.TempDir()
	pack := exec.Command(npmPath, "pack", "--pack-destination", packDir, fixture)
	pack.Env = cleanInstallEnvironment(packDir)
	if output, err := pack.CombinedOutput(); err != nil {
		t.Fatalf("npm pack: %v: %s", err, output)
	}
	archives, err := filepath.Glob(filepath.Join(packDir, "*.tgz"))
	if err != nil || len(archives) != 1 {
		t.Fatalf("npm pack archives = %#v, error = %v", archives, err)
	}
	plan.AccountUsage.InstallCommand[len(plan.AccountUsage.InstallCommand)-1] = archives[0]
	setup := &SetupService{Plans: InstallPlanService{Manager: manager}}
	if err := setup.installAccountUsageCompanion(context.Background(), installation, plan); err != nil {
		t.Fatal(err)
	}
	launchRef, err := agenttargetbiz.CanonicalLaunchRefJSON(installation.Provider, agenttargetbiz.LaunchRef{
		Type: agenttargetbiz.LaunchRefTypeAgentExtension, ExtensionInstallationID: installation.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	const targetID = "extension:gemini"
	store.targets[targetID] = agenttargetbiz.Target{
		ID: targetID, Provider: installation.Provider, LaunchRefJSON: launchRef,
		Name: "Gemini CLI", Enabled: true, Source: agenttargetbiz.SourceSystem,
	}
	result, err := (AccountUsageService{Manager: manager, Targets: store}).Probe(context.Background(), targetID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != "available" || result.BillingMode != "api" {
		t.Fatalf("account usage E2E result = %#v", result)
	}
}
