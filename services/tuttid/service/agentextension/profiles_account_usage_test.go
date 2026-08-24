package agentextension

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateAccountUsageProfileRejectsUnsafeDeclarations(t *testing.T) {
	t.Parallel()

	valid := func() AccountUsageProfile {
		var profile AccountUsageProfile
		profile.SchemaVersion = "tutti.agent.account-usage-probe.v1"
		profile.Runtime.Package = "@example/agent-account-usage@1.2.3"
		profile.Runtime.Kind = "node-script"
		profile.Runtime.Script = "${installRoot}/node_modules/@example/agent-account-usage/dist/cli.cjs"
		profile.Runtime.Args = []string{"--output", "json"}
		profile.Runtime.TimeoutMS = 10_000
		return profile
	}
	tests := map[string]func(*AccountUsageProfile){
		"unknown schema": func(profile *AccountUsageProfile) {
			profile.SchemaVersion = "tutti.agent.account-usage-probe.v2"
		},
		"unscoped package": func(profile *AccountUsageProfile) {
			profile.Runtime.Package = "agent-account-usage@1.2.3"
		},
		"version range": func(profile *AccountUsageProfile) {
			profile.Runtime.Package = "@example/agent-account-usage@^1.2.3"
		},
		"foreign script": func(profile *AccountUsageProfile) {
			profile.Runtime.Script = "/tmp/agent-account-usage"
		},
		"extra placeholder": func(profile *AccountUsageProfile) {
			profile.Runtime.Script = "${installRoot}/${projectRoot}/agent-account-usage"
		},
		"shell argument": func(profile *AccountUsageProfile) {
			profile.Runtime.Args = []string{"json;curl"}
		},
		"unbounded timeout": func(profile *AccountUsageProfile) {
			profile.Runtime.TimeoutMS = 60_000
		},
		"independent installer unsafe runner": func(profile *AccountUsageProfile) {
			profile.Runtime.Install = &AccountUsageInstallProfile{Runner: "pip", Args: []string{"install", "@example/agent-account-usage@1.2.3"}}
		},
		"independent installer omits package": func(profile *AccountUsageProfile) {
			profile.Runtime.Install = &AccountUsageInstallProfile{Runner: "npm", Args: []string{"install", "--prefix", "${installRoot}"}}
		},
		"independent installer shell argument": func(profile *AccountUsageProfile) {
			profile.Runtime.Install = &AccountUsageInstallProfile{Runner: "npm", Args: []string{"install", "--prefix", "${installRoot}", "x;y"}}
		},
		"independent installer unknown placeholder": func(profile *AccountUsageProfile) {
			profile.Runtime.Install = &AccountUsageInstallProfile{Runner: "npm", Args: []string{"install", "--prefix", "${agentRoot}", "@example/agent-account-usage@1.2.3"}}
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			profile := valid()
			mutate(&profile)
			if err := validateAccountUsageProfile(profile); err == nil {
				t.Fatal("validateAccountUsageProfile() error = nil")
			}
		})
	}
}

func TestValidateAccountUsageProfileAcceptsIndependentInstaller(t *testing.T) {
	t.Parallel()

	var profile AccountUsageProfile
	profile.SchemaVersion = "tutti.agent.account-usage-probe.v1"
	profile.Runtime.Package = "@example/agent-account-usage@1.2.3"
	profile.Runtime.Kind = "node-script"
	profile.Runtime.Script = "${installRoot}/node_modules/@example/agent-account-usage/dist/cli.cjs"
	profile.Runtime.Args = []string{"--output", "json"}
	profile.Runtime.TimeoutMS = 10_000
	profile.Runtime.Install = &AccountUsageInstallProfile{
		Runner: "npm",
		Args:   []string{"install", "--prefix", "${installRoot}", "--no-save", "@example/agent-account-usage@1.2.3"},
	}
	if err := validateAccountUsageProfile(profile); err != nil {
		t.Fatalf("validateAccountUsageProfile() = %v", err)
	}
}

func TestValidateInstalledPackageRequiresIndependentInstallerForNonNpmRuntime(t *testing.T) {
	t.Parallel()

	discovery := `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["hermes"],"version":{"args":["--version"],"constraint":">=0.18.0 <0.20.0"},"launchArgs":["acp"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`
	baseManifest := func() Manifest {
		manifest := testManifest()
		manifest.AgentKey = "hermes"
		manifest.Runtime.Install.Runner = "uv"
		manifest.Runtime.Install.Args = []string{"tool", "install", "hermes-agent[acp,mcp]==0.18.2"}
		manifest.Runtime.Launch.Executable = "${installRoot}/bin/hermes"
		manifest.Runtime.Launch.Args = []string{"acp"}
		manifest.Profiles.AccountUsage = "profiles/account-usage.json"
		return manifest
	}

	t.Run("independent installer is accepted", func(t *testing.T) {
		manifest := baseManifest()
		root := t.TempDir()
		if err := extractPackage(testPackageZIPFor(t, manifest, discovery), root); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(
			filepath.Join(root, manifest.Profiles.AccountUsage),
			[]byte(`{"schemaVersion":"tutti.agent.account-usage-probe.v1","runtime":{"package":"@example/hermes-account-usage@1.0.0","kind":"node-script","script":"${installRoot}/node_modules/@example/hermes-account-usage/dist/cli.cjs","args":["--output","json"],"timeoutMs":10000,"install":{"runner":"npm","args":["install","--prefix","${installRoot}","--no-save","@example/hermes-account-usage@1.0.0"]}}}`),
			0o600,
		); err != nil {
			t.Fatal(err)
		}
		if _, err := validateInstalledPackage(root, manifest.AgentKey, manifest.Version); err != nil {
			t.Fatalf("validateInstalledPackage() = %v", err)
		}
	})

	t.Run("npm-only companion is rejected for uv runtime", func(t *testing.T) {
		manifest := baseManifest()
		root := t.TempDir()
		if err := extractPackage(testPackageZIPFor(t, manifest, discovery), root); err != nil {
			t.Fatal(err)
		}
		if _, err := validateInstalledPackage(root, manifest.AgentKey, manifest.Version); err == nil {
			t.Fatal("validateInstalledPackage() error = nil, want npm-only companion rejection")
		}
	})
}

func TestValidateInstalledPackageAcceptsAccountUsageProfile(t *testing.T) {
	t.Parallel()

	manifest := testManifest()
	manifest.Profiles.AccountUsage = "profiles/account-usage.json"
	root := t.TempDir()
	if err := extractPackage(testPackageZIPFor(t, manifest, `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["gemini"],"version":{"args":["--version"],"constraint":">=0.50.0 <1.0.0"},"launchArgs":["--acp"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`), root); err != nil {
		t.Fatal(err)
	}
	installed, err := validateInstalledPackage(root, manifest.AgentKey, manifest.Version)
	if err != nil {
		t.Fatal(err)
	}
	if installed.Profiles.AccountUsage != manifest.Profiles.AccountUsage {
		t.Fatalf("account usage profile = %q", installed.Profiles.AccountUsage)
	}
	if _, err := os.Stat(filepath.Join(root, "profiles", "account-usage.json")); err != nil {
		t.Fatal(err)
	}
}
