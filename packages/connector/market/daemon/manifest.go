package daemon

import (
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	ImplementationKindBuiltin              = "builtin"
	ImplementationKindManagedStdio         = "managed_stdio"
	ImplementationKindRemoteStreamableHTTP = "remote_streamable_http"
	CredentialBrokerProtocolV1             = "tutti.connector.credentials.v1"
)

var connectorKeyPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$`)
var artifactSHA256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var manifestIdentifierPattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,127}$`)

type ImplementationValidator func(Implementation) error

type ImplementationRegistry struct {
	validators map[string]ImplementationValidator
}

func NewImplementationRegistry(validators map[string]ImplementationValidator) ImplementationRegistry {
	cloned := make(map[string]ImplementationValidator, len(validators))
	for kind, validator := range validators {
		cloned[kind] = validator
	}
	return ImplementationRegistry{validators: cloned}
}

func (registry ImplementationRegistry) Supports(kind string) bool {
	_, ok := registry.validators[kind]
	return ok
}

func (registry ImplementationRegistry) Validate(manifest Manifest) error {
	if err := ValidateManifestShape(manifest); err != nil {
		return err
	}
	validator, ok := registry.validators[manifest.Implementation.Kind]
	if !ok {
		return NewDomainError(
			ErrorCodeUnsupportedImplementation,
			fmt.Sprintf("implementation %q is not supported", manifest.Implementation.Kind),
			false,
			nil,
		)
	}
	if validator != nil {
		if err := validator(manifest.Implementation); err != nil {
			return invalidManifest("implementation is invalid", err)
		}
	}
	return nil
}

func ValidateReleaseShape(release Release) error {
	if release.SchemaVersion != "1" {
		return invalidManifest("schemaVersion must be 1", nil)
	}
	if strings.TrimSpace(release.ReleaseID) == "" {
		return invalidManifest("releaseId is required", nil)
	}
	if !connectorKeyPattern.MatchString(release.ConnectorKey) {
		return invalidManifest("connectorKey must be a stable lowercase connector identifier", nil)
	}
	if strings.TrimSpace(release.Version) == "" {
		return invalidManifest("version is required", nil)
	}
	if !artifactSHA256Pattern.MatchString(release.ReleaseDigest) {
		return invalidManifest("releaseDigest must be a lowercase SHA-256", nil)
	}
	if !artifactSHA256Pattern.MatchString(release.ManifestDigest) {
		return invalidManifest("manifestDigest must be a lowercase SHA-256", nil)
	}
	switch release.Status {
	case ReleaseStatusAvailable, ReleaseStatusSuperseded:
	default:
		return invalidManifest("status must be available or superseded", nil)
	}
	if release.PublishedAt.IsZero() {
		return invalidManifest("publishedAt is required", nil)
	}
	if strings.TrimSpace(release.Artifact.Key) == "" ||
		!artifactSHA256Pattern.MatchString(release.Artifact.SHA256) ||
		release.Artifact.SizeBytes <= 0 ||
		strings.TrimSpace(release.Artifact.MediaType) == "" {
		return invalidManifest("artifact key, lowercase SHA-256, positive sizeBytes, and mediaType are required", nil)
	}
	return ValidateManifestShape(release.Manifest)
}

func ValidateManifestShape(manifest Manifest) error {
	if manifest.SchemaVersion != "1" {
		return invalidManifest("manifest schemaVersion must be 1", nil)
	}
	if strings.TrimSpace(manifest.DisplayName) == "" {
		return invalidManifest("displayName is required", nil)
	}
	if err := validateUniqueIdentifiers("permission", manifest.Permissions); err != nil {
		return err
	}
	switch manifest.AuthorizationKind {
	case "none", "oauth2", "api_key":
	default:
		return invalidManifest("authorizationKind must be none, oauth2, or api_key", nil)
	}
	implementation := manifest.Implementation
	branches := 0
	if implementation.Builtin != nil {
		branches++
	}
	if implementation.ManagedStdio != nil {
		branches++
	}
	if implementation.RemoteStreamableHTTP != nil {
		branches++
	}
	if branches != 1 {
		return invalidManifest("implementation must select exactly one typed branch", nil)
	}
	switch implementation.Kind {
	case ImplementationKindBuiltin:
		if implementation.Builtin == nil {
			return invalidManifest("builtin implementation requires builtin config", nil)
		}
		if strings.TrimSpace(implementation.Builtin.ProviderID) == "" ||
			(!implementation.Builtin.MCP && !implementation.Builtin.CLI) {
			return invalidManifest("builtin providerId and at least one interface are required", nil)
		}
	case ImplementationKindManagedStdio:
		managed := implementation.ManagedStdio
		if managed == nil {
			return invalidManifest("managed_stdio implementation requires managedStdio config", nil)
		}
		if err := validateManagedStdio(*managed, manifest.AuthorizationKind); err != nil {
			return err
		}
	case ImplementationKindRemoteStreamableHTTP:
		remote := implementation.RemoteStreamableHTTP
		if remote == nil {
			return invalidManifest("remote_streamable_http implementation requires remoteStreamableHttp config", nil)
		}
		if err := validateRemoteStreamableHTTP(*remote); err != nil {
			return err
		}
	default:
		return invalidManifest("implementation.kind is unsupported", nil)
	}
	return nil
}

func validateManagedStdio(managed ManagedStdioImplementation, authorizationKind string) error {
	if managed.Runtime.Language != "node" && managed.Runtime.Language != "python" {
		return invalidManifest("managed runtime language must be node or python", nil)
	}
	if !manifestIdentifierPattern.MatchString(managed.Runtime.Profile) || strings.TrimSpace(managed.Runtime.ABI) == "" {
		return invalidManifest("managed runtime profile and exact ABI are required", nil)
	}
	if managed.MCP == nil && managed.CLI == nil {
		return invalidManifest("managed_stdio requires an MCP or CLI interface", nil)
	}
	if managed.MCP != nil && !safeRelativeEntrypoint(managed.MCP.Entrypoint) {
		return invalidManifest("managed MCP entrypoint must be a safe relative path", nil)
	}
	if managed.CLI != nil {
		if !safeRelativeEntrypoint(managed.CLI.Entrypoint) || len(managed.CLI.Commands) == 0 {
			return invalidManifest("managed CLI entrypoint and commands are required", nil)
		}
		names := make([]string, 0, len(managed.CLI.Commands))
		for _, command := range managed.CLI.Commands {
			names = append(names, command.Name)
			if command.InputSchema == nil || command.InputSchema["type"] != "object" || command.TimeoutMS < 100 || command.TimeoutMS > 120_000 {
				return invalidManifest("managed CLI commands require an object inputSchema and timeoutMs between 100 and 120000", nil)
			}
			for _, argument := range command.Arguments {
				if strings.ContainsRune(argument, '\x00') {
					return invalidManifest("managed CLI command arguments must not contain NUL", nil)
				}
			}
		}
		if err := validateUniqueIdentifiers("CLI command", names); err != nil {
			return err
		}
	}
	if authorizationKind != "none" && managed.CredentialBrokerProtocol != CredentialBrokerProtocolV1 {
		return invalidManifest("authorized managed_stdio connectors require the v1 credential broker", nil)
	}
	if authorizationKind == "none" && managed.CredentialBrokerProtocol != "" {
		return invalidManifest("credential broker must not be requested when authorization is none", nil)
	}
	return nil
}

func validateRemoteStreamableHTTP(remote RemoteStreamableHTTPImplementation) error {
	endpoint, err := url.Parse(strings.TrimSpace(remote.Endpoint))
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.Fragment != "" {
		return invalidManifest("remote endpoint must be an absolute https URL without userinfo or fragment", nil)
	}
	host := strings.ToLower(endpoint.Hostname())
	if net.ParseIP(host) != nil || len(remote.AllowedHosts) == 0 {
		return invalidManifest("remote endpoint must use an allowlisted DNS hostname", nil)
	}
	found := false
	for _, allowed := range remote.AllowedHosts {
		if strings.ToLower(strings.TrimSpace(allowed)) == host {
			found = true
		}
		if net.ParseIP(strings.TrimSpace(allowed)) != nil {
			return invalidManifest("remote allowedHosts must not contain IP literals", nil)
		}
	}
	if !found {
		return invalidManifest("remote endpoint hostname must appear exactly in allowedHosts", nil)
	}
	return nil
}

func validateUniqueIdentifiers(label string, values []string) error {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if !manifestIdentifierPattern.MatchString(value) {
			return invalidManifest(label+" must be a lowercase stable identifier", nil)
		}
		if _, exists := seen[value]; exists {
			return invalidManifest(label+" values must be unique", nil)
		}
		seen[value] = struct{}{}
	}
	return nil
}

func safeRelativeEntrypoint(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || filepath.IsAbs(value) || strings.Contains(value, "\\") {
		return false
	}
	cleaned := filepath.ToSlash(filepath.Clean(value))
	return cleaned == value && cleaned != "." && cleaned != ".." && !strings.HasPrefix(cleaned, "../")
}

func invalidManifest(message string, cause error) error {
	return NewDomainError(ErrorCodeInvalidManifest, message, false, cause)
}
