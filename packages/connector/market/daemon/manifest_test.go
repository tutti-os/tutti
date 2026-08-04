package daemon

import (
	"errors"
	"testing"
)

func TestImplementationRegistryValidatesSupportedManifest(t *testing.T) {
	registry := NewImplementationRegistry(map[string]ImplementationValidator{
		"mcp_stdio": func(config map[string]any) error {
			if config["command"] == "" {
				return errors.New("command is required")
			}
			return nil
		},
	})

	err := registry.Validate(Manifest{
		SchemaVersion:     "1",
		Key:               "github",
		Version:           "1.0.0",
		DisplayName:       "GitHub",
		Permissions:       []string{"repository.read"},
		Artifact:          testArtifact(),
		Implementation:    Implementation{Kind: "mcp_stdio", Config: map[string]any{"command": "github-mcp"}},
		AuthorizationKind: "oauth2",
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestImplementationRegistryRejectsUnknownImplementation(t *testing.T) {
	registry := NewImplementationRegistry(nil)
	err := registry.Validate(Manifest{
		SchemaVersion:     "1",
		Key:               "github",
		Version:           "1.0.0",
		DisplayName:       "GitHub",
		Artifact:          testArtifact(),
		Implementation:    Implementation{Kind: "unknown"},
		AuthorizationKind: "none",
	})
	var domainError *DomainError
	if !errors.As(err, &domainError) {
		t.Fatalf("error = %v, want DomainError", err)
	}
	if domainError.Code != ErrorCodeUnsupportedImplementation {
		t.Fatalf("code = %q", domainError.Code)
	}
}

func testArtifact() Artifact {
	return Artifact{
		Key:       "connectors/github/1.0.0.tgz",
		SHA256:    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		SizeBytes: 1024,
	}
}

func TestInstallationTransitionsRejectSkippedActivation(t *testing.T) {
	if !CanTransitionInstallation(InstallationStateInstalling, InstallationStateInstalled) {
		t.Fatal("installing -> installed should be allowed")
	}
	if CanTransitionInstallation(InstallationStateNotInstalled, InstallationStateInstalled) {
		t.Fatal("not_installed -> installed should be rejected")
	}
}

func TestAuthorizationTransitionsKeepNotRequiredTerminal(t *testing.T) {
	if CanTransitionAuthorization(AuthorizationStateNotRequired, AuthorizationStatePending) {
		t.Fatal("not_required -> pending should be rejected")
	}
	if !CanTransitionAuthorization(AuthorizationStateExpired, AuthorizationStatePending) {
		t.Fatal("expired -> pending should be allowed")
	}
}
