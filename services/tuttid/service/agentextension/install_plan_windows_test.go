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
