package daemon

import (
	"errors"
	"testing"
)

func TestImplementationRegistryValidatesSupportedManifest(t *testing.T) {
	registry := NewImplementationRegistry(map[string]ImplementationValidator{
		ImplementationKindManagedStdio: func(implementation Implementation) error {
			if implementation.ManagedStdio == nil {
				return errors.New("managed stdio is required")
			}
			return nil
		},
	})

	err := registry.Validate(Manifest{
		SchemaVersion: "1",
		DisplayName:   "GitHub",
		Permissions:   []string{"repository.read"},
		Implementation: Implementation{
			Kind: ImplementationKindManagedStdio,
			ManagedStdio: &ManagedStdioImplementation{
				Runtime:                  RuntimeRequirement{Language: "node", Profile: "connector-node-static", ABI: "node20-darwin-arm64"},
				MCP:                      &ManagedMCPInterface{Entrypoint: "bin/github-mcp.js"},
				CredentialBrokerProtocol: CredentialBrokerProtocolV1,
			},
		},
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
		DisplayName:       "GitHub",
		Implementation:    Implementation{Kind: "unknown", Builtin: &BuiltinImplementation{ProviderID: "github", MCP: true}},
		AuthorizationKind: "none",
	})
	var domainError *DomainError
	if !errors.As(err, &domainError) {
		t.Fatalf("error = %v, want DomainError", err)
	}
	if domainError.Code != ErrorCodeInvalidManifest {
		t.Fatalf("code = %q", domainError.Code)
	}
}

func testArtifact() Artifact {
	return Artifact{
		Key:       "connectors/github/1.0.0.tgz",
		SHA256:    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		SizeBytes: 1024,
		MediaType: "application/vnd.tutti.connector+tar+gzip",
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
