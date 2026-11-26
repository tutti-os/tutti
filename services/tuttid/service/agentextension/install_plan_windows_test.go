//go:build windows

package agentextension

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBuildInstallPlanUsesNativeWindowsNPMLauncher(t *testing.T) {
	manifest := testManifest()
	packageDir := t.TempDir()
	discoveryPath := filepath.Join(packageDir, filepath.FromSlash(manifest.Profiles.Discovery))
	if err := os.MkdirAll(filepath.Dir(discoveryPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(discoveryPath, []byte(`{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["gemini"],"version":{"args":["--version"],"constraint":">=0.50.0 <1.0.0"},"launchArgs":["--acp"]}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	installation := Installation{
		ID:         "gemini@1.0.0",
		AgentKey:   "gemini",
		Version:    "1.0.0",
		PackageDir: packageDir,
		Manifest:   manifest,
	}
	plan, err := buildInstallPlan("extension:gemini", t.TempDir(), installation)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := filepath.Ext(plan.Executable), ".cmd"; got != want {
		t.Fatalf("Windows npm executable extension = %q, want %q", got, want)
	}
}

func TestBuildInstallPlanUsesNativeWindowsNPMLauncherForUnscopedEmptyLaunchArgs(t *testing.T) {
	manifest := testManifest()
	manifest.AgentKey = "pi"
	manifest.Name = "Pi"
	manifest.Runtime.Install.Runner = "npm"
	manifest.Runtime.Install.Args = []string{"install", "--prefix", "${installRoot}", "pi-acp@0.0.35"}
	manifest.Runtime.Launch.Executable = "${installRoot}/node_modules/.bin/pi-acp"
	manifest.Runtime.Launch.Args = []string{}
	packageDir := t.TempDir()
	discoveryPath := filepath.Join(packageDir, filepath.FromSlash(manifest.Profiles.Discovery))
	if err := os.MkdirAll(filepath.Dir(discoveryPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(discoveryPath, []byte(`{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["pi-acp"],"version":{"source":"acp-initialize","constraint":">=0.0.35 <1.0.0"},"launchArgs":[],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	installation := Installation{
		ID:         "pi@0.1.0",
		AgentKey:   "pi",
		Version:    "0.1.0",
		PackageDir: packageDir,
		Manifest:   manifest,
	}
	plan, err := buildInstallPlan("extension:pi", t.TempDir(), installation)
	if err != nil {
		t.Fatal(err)
	}
	if plan.PackageName != "pi-acp" || plan.PackageVersion != "0.0.35" {
		t.Fatalf("plan package = (%q, %q), want (pi-acp, 0.0.35)", plan.PackageName, plan.PackageVersion)
	}
	if got, want := filepath.Ext(plan.Executable), ".cmd"; got != want {
		t.Fatalf("Windows npm executable extension = %q, want %q", got, want)
	}
	if len(plan.LaunchArgs) != 0 {
		t.Fatalf("plan.LaunchArgs = %#v, want empty slice", plan.LaunchArgs)
	}
}
