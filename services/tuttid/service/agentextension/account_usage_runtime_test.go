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
	if _, err := resolvedLocalAccountUsageRuntimeBinding(link, profile); err == nil {
		t.Fatal("resolvedLocalAccountUsageRuntimeBinding() accepted symlink")
	}
}

func TestStagedAccountUsageActivationFingerprintsCompanion(t *testing.T) {
	staging := testResolvedTempDir(t)
	realStaging, err := filepath.EvalSymlinks(staging)
	if err != nil {
		t.Fatal(err)
	}
	installRoot := filepath.Join(string(filepath.Separator), "managed", "runtime")
	executable := filepath.Join(installRoot, "node_modules", "probe", "cli.mjs")
	stagedExecutable, err := stagedRuntimePath(installRoot, executable, staging)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(stagedExecutable), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stagedExecutable, []byte("#!/usr/bin/env node\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	activation, err := stagedAccountUsageActivation(
		InstallPlan{
			InstallRoot: installRoot,
			AccountUsage: &AccountUsageInstall{
				Package:    "@example/probe@1.0.0",
				Executable: executable,
			},
		},
		staging,
		realStaging,
	)
	if err != nil {
		t.Fatal(err)
	}
	if activation == nil || activation.Package != "@example/probe@1.0.0" ||
		activation.ExecutableRelativePath != "node_modules/probe/cli.mjs" ||
		activation.ExecutableFingerprint.SHA256 == "" ||
		activation.ExecutableFingerprint.Size == 0 {
		t.Fatalf("account usage activation = %#v", activation)
	}
}
