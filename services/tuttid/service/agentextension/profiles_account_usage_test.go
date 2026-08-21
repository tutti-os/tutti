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
