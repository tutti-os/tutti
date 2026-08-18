package agentextension

import (
	"os"
	"path/filepath"
	"testing"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func TestLocalAccountUsageExecutableRequiresLocalPackageProvenance(t *testing.T) {
	t.Parallel()
	manager := &Manager{Sources: []tuttitypes.AgentExtensionSource{{
		Key:                         "gemini",
		LocalPackageDir:             "/local/package",
		LocalAccountUsageExecutable: "/local/account-usage",
	}}}
	remote := Installation{AgentKey: "gemini", Version: "1.0.0"}
	if got := manager.localAccountUsageExecutable(remote); got != "" {
		t.Fatalf("remote installation local executable = %q", got)
	}
	local := Installation{AgentKey: "gemini", Version: "1.0.0+local.0123456789ab"}
	if got := manager.localAccountUsageExecutable(local); got != "/local/account-usage" {
		t.Fatalf("local installation executable = %q", got)
	}
}

func TestResolvedLocalAccountUsageRuntimeBindingRejectsSymlink(t *testing.T) {
	t.Parallel()
	root := testResolvedTempDir(t)
	target := filepath.Join(root, "target")
	link := filepath.Join(root, "link")
	if err := os.WriteFile(target, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	profile := &AccountUsageProfile{SchemaVersion: "tutti.agent.account-usage-probe.v1"}
	profile.Runtime.Args = []string{"--output", "json"}
	profile.Runtime.TimeoutMS = 10_000
	if _, err := (&Manager{}).resolvedLocalAccountUsageRuntimeBinding(link, profile); err == nil {
		t.Fatal("resolvedLocalAccountUsageRuntimeBinding() accepted symlink")
	}
}

func TestFingerprintAccountUsageScriptAcceptsNonExecutableJavaScript(t *testing.T) {
	script := filepath.Join(t.TempDir(), "cli.cjs")
	if err := os.WriteFile(script, []byte("process.stdout.write('{}')\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fingerprint, err := fingerprintAccountUsageScript(script)
	if err != nil {
		t.Fatal(err)
	}
	if fingerprint.SHA256 == "" || fingerprint.Size == 0 {
		t.Fatalf("script fingerprint = %#v", fingerprint)
	}
}
