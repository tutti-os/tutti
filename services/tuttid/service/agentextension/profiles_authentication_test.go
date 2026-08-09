package agentextension

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadAuthenticationMethods(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	profilePath := filepath.Join(root, "profiles", "authentication.json")
	if err := os.MkdirAll(filepath.Dir(profilePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(profilePath, []byte(`{
		"schemaVersion": "tutti.agent.authentication.v1",
		"methods": [{
			"id": "login",
			"name": "Set up Example Agent",
			"description": "Open the runtime to choose an authentication method.",
			"type": "terminal",
			"command": {
				"strategy": "runtime-slash-command",
				"args": ["login"],
				"readyText": "Example Agent is ready"
			}
		}]
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	installation := Installation{PackageDir: root}
	installation.Manifest.Profiles.Authentication = "profiles/authentication.json"

	methods, err := loadAuthenticationMethods(installation)
	if err != nil {
		t.Fatal(err)
	}
	method := methods["login"]
	if method.Name != "Set up Example Agent" || method.Description != "Open the runtime to choose an authentication method." ||
		method.Type != "terminal" || method.Command.Strategy != "runtime-slash-command" ||
		len(method.Command.Args) != 1 || method.Command.Args[0] != "login" ||
		method.Command.ReadyText != "Example Agent is ready" {
		t.Fatalf("authentication method = %#v", method)
	}
}

func TestValidateAuthenticationProfileRejectsUnsafeDeclarations(t *testing.T) {
	t.Parallel()

	valid := func() AuthenticationProfile {
		var profile AuthenticationProfile
		profile.SchemaVersion = "tutti.agent.authentication.v1"
		var method AuthenticationMethodProfile
		method.ID = "login"
		method.Type = "terminal"
		method.Command.Strategy = "runtime-subcommand"
		method.Command.Args = []string{"login"}
		profile.Methods = []AuthenticationMethodProfile{method}
		return profile
	}
	tests := map[string]func(*AuthenticationProfile){
		"unknown schema": func(profile *AuthenticationProfile) {
			profile.SchemaVersion = "tutti.agent.authentication.v2"
		},
		"duplicate method": func(profile *AuthenticationProfile) {
			profile.Methods = append(profile.Methods, profile.Methods[0])
		},
		"unsupported type": func(profile *AuthenticationProfile) {
			profile.Methods[0].Type = "browser"
		},
		"unsupported strategy": func(profile *AuthenticationProfile) {
			profile.Methods[0].Command.Strategy = "shell"
		},
		"control character in name": func(profile *AuthenticationProfile) {
			profile.Methods[0].Name = "Set up\nAgent"
		},
		"leading whitespace in description": func(profile *AuthenticationProfile) {
			profile.Methods[0].Description = " Open the runtime"
		},
		"control character": func(profile *AuthenticationProfile) {
			profile.Methods[0].Command.Args = []string{"login\nnext"}
		},
		"subcommand ready text": func(profile *AuthenticationProfile) {
			profile.Methods[0].Command.ReadyText = "Unexpected"
		},
		"slash command without ready text": func(profile *AuthenticationProfile) {
			profile.Methods[0].Command.Strategy = "runtime-slash-command"
			profile.Methods[0].Command.ReadyText = ""
		},
		"unsafe slash command name": func(profile *AuthenticationProfile) {
			profile.Methods[0].Command.Strategy = "runtime-slash-command"
			profile.Methods[0].Command.Args = []string{"login now"}
			profile.Methods[0].Command.ReadyText = "Example Agent is ready"
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			profile := valid()
			mutate(&profile)
			if err := validateAuthenticationProfile(profile); err == nil {
				t.Fatal("validateAuthenticationProfile() error = nil")
			}
		})
	}
}

func TestValidateInstalledPackageAcceptsAuthenticationProfile(t *testing.T) {
	t.Parallel()

	manifest := testManifest()
	manifest.Profiles.Authentication = "profiles/authentication.json"
	root := t.TempDir()
	if err := extractPackage(testPackageZIPFor(t, manifest, `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["gemini"],"version":{"args":["--version"],"constraint":">=0.50.0 <1.0.0"},"launchArgs":["--acp"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`), root); err != nil {
		t.Fatal(err)
	}
	installed, err := validateInstalledPackage(root, manifest.AgentKey, manifest.Version)
	if err != nil {
		t.Fatal(err)
	}
	if installed.Profiles.Authentication != manifest.Profiles.Authentication {
		t.Fatalf("authentication profile = %q", installed.Profiles.Authentication)
	}
}
