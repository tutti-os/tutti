package host

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	ImplementationKindBuiltin                = "builtin"
	ImplementationKindManagedStdio           = "managed_stdio"
	ImplementationKindRemoteStreamableHTTP   = "remote_streamable_http"
	CredentialBrokerProtocolV1               = "tutti.connector.credentials.v1"
	CLIArtifactLaunchKindNative              = "artifact_native"
	CredentialBrokerPresentationEmbeddedPage = "embedded_page"
	CredentialBrokerPresentationQRCode       = "qr_code"
	AuthorizationInteractionModeManaged      = "managed"
	maxAgentRoutingAliases                   = 12
	maxAgentRoutingAliasRunes                = 48
)

var connectorKeyPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$`)
var artifactSHA256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var remoteBindingRefPattern = regexp.MustCompile(`^[a-z0-9]+(?:[.-][a-z0-9]+)*$`)
var remoteBindingContractHashPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var manifestIdentifierPattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,127}$`)
var permissionScopePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$`)
var nodePackageNamePattern = regexp.MustCompile(`^(?:@[a-z0-9][a-z0-9._-]{0,126}/)?[a-z0-9][a-z0-9._-]{0,126}$`)
var exactPackageVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
var nodeVersionRangePattern = regexp.MustCompile(`^(?:[<>]=?\s*[0-9]+\.[0-9]+\.[0-9]+(?:\s+|$))+$`)

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
	return validateReleaseShape(release, true)
}

// ValidateRuntimeReleaseShape validates the durable execution contract while
// deliberately excluding icon presentation policy. Installed releases may
// predate the current icon requirements, but runtime identity, artifact,
// permission, authorization, and implementation checks must remain strict.
func ValidateRuntimeReleaseShape(release Release) error {
	return validateReleaseShape(release, false)
}

func validateReleaseShape(release Release, validateIcon bool) error {
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
	if err := validateManifestShape(release.Manifest, validateIcon); err != nil {
		return err
	}
	return validateLegacyCredentialBrokerPresentation(release)
}

func validateLegacyCredentialBrokerPresentation(release Release) error {
	managed := release.Manifest.Implementation.ManagedStdio
	if managed == nil || managed.CredentialBroker == nil ||
		managed.CredentialBroker.Presentation != CredentialBrokerPresentationEmbeddedPage {
		return nil
	}
	if release.ConnectorKey == "wecom-cli" && release.Version == "0.1.4" {
		return nil
	}
	return invalidManifest("embedded_page presentation is reserved for the legacy wecom-cli 0.1.4 release", nil)
}

func ValidateManifestShape(manifest Manifest) error {
	return validateManifestShape(manifest, true)
}

func validateManifestShape(manifest Manifest, validateIcon bool) error {
	if manifest.SchemaVersion != "1" {
		return invalidManifest("manifest schemaVersion must be 1", nil)
	}
	if strings.TrimSpace(manifest.DisplayName) == "" {
		return invalidManifest("displayName is required", nil)
	}
	if validateIcon && !isSafeConnectorIconURL(manifest.IconURL) {
		return invalidManifest("iconUrl must be a PNG, WebP, or SVG data URL", nil)
	}
	if err := validateAgentRouting(manifest.AgentRouting); err != nil {
		return err
	}
	if err := validateUniquePermissions(manifest.Permissions); err != nil {
		return err
	}
	switch manifest.AuthorizationKind {
	case "none", "oauth2", "api_key":
	default:
		return invalidManifest("authorizationKind must be none, oauth2, or api_key", nil)
	}
	if len(manifest.AuthorizationInteraction) > 64<<10 ||
		(len(manifest.AuthorizationInteraction) > 0 && !json.Valid(manifest.AuthorizationInteraction)) {
		return invalidManifest("authorizationInteraction must be valid bounded JSON", nil)
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
		if len(manifest.RequiredCapabilities) != 1 || manifest.RequiredCapabilities[0] != "tools" {
			return invalidManifest("remote_streamable_http requiredCapabilities must be exactly [tools]", nil)
		}
	default:
		return invalidManifest("implementation.kind is unsupported", nil)
	}
	return nil
}

func validateAgentRouting(routing *AgentRouting) error {
	if routing == nil {
		return nil
	}
	if len(routing.Aliases) == 0 || len(routing.Aliases) > maxAgentRoutingAliases {
		return invalidManifest("agentRouting.aliases must contain between 1 and 12 aliases", nil)
	}
	seen := make(map[string]struct{}, len(routing.Aliases))
	for _, alias := range routing.Aliases {
		if alias == "" || alias != strings.TrimSpace(alias) || !utf8.ValidString(alias) ||
			utf8.RuneCountInString(alias) > maxAgentRoutingAliasRunes || !safeAgentRoutingAlias(alias) {
			return invalidManifest("agentRouting.aliases must be safe brand aliases of at most 48 characters", nil)
		}
		key := strings.ToLower(alias)
		if _, duplicate := seen[key]; duplicate {
			return invalidManifest("agentRouting.aliases must be unique ignoring case", nil)
		}
		seen[key] = struct{}{}
	}
	return nil
}

func safeAgentRoutingAlias(alias string) bool {
	for _, character := range alias {
		if unicode.IsLetter(character) || unicode.IsNumber(character) || unicode.IsMark(character) || character == ' ' ||
			strings.ContainsRune("-_.+&/()", character) {
			continue
		}
		return false
	}
	return true
}

func isSafeConnectorIconURL(value string) bool {
	value = strings.TrimSpace(value)
	for _, prefix := range []string{"data:image/png;base64,", "data:image/webp;base64,", "data:image/svg+xml;base64,"} {
		if !strings.HasPrefix(value, prefix) {
			continue
		}
		encoded := strings.TrimPrefix(value, prefix)
		if encoded == "" || base64.StdEncoding.DecodedLen(len(encoded)) > 128*1024 {
			return false
		}
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		return err == nil && len(decoded) > 0 && len(decoded) <= 128*1024
	}
	return false
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
	if managed.MCP != nil {
		if !safeRelativeEntrypoint(managed.MCP.Entrypoint) {
			return invalidManifest("managed MCP entrypoint must be a safe relative path", nil)
		}
	}
	if managed.CLI != nil {
		if managed.Runtime.Language != "node" || managed.Runtime.Profile != "connector-node-static" {
			return invalidManifest("managed CLI requires the shared connector-node-static runtime", nil)
		}
		if !nodeVersionRangePattern.MatchString(strings.TrimSpace(managed.Runtime.VersionRange)) {
			return invalidManifest("managed CLI requires an explicit comparator-based Node versionRange", nil)
		}
		if !safeRelativeEntrypoint(managed.CLI.Entrypoint) {
			return invalidManifest("managed CLI entrypoint is required", nil)
		}
		if !manifestIdentifierPattern.MatchString(ManagedCLICommandName(*managed.CLI)) {
			return invalidManifest("managed CLI command must be a safe identifier", nil)
		}
		for _, argument := range managed.CLI.Arguments {
			if strings.ContainsRune(argument, '\x00') {
				return invalidManifest("managed CLI arguments must not contain NUL", nil)
			}
		}
		if err := validateCLIReadinessProbe(managed.CLI.ReadinessProbe); err != nil {
			return err
		}
		if managed.CLI.Launch != nil {
			if managed.CLI.Install != nil || len(managed.CLI.Commands) != 0 {
				return invalidManifest("artifact-native CLI launch cannot declare install or command mappings", nil)
			}
			if strings.TrimSpace(managed.CLI.Command) == "" || managed.CLI.Launch.Kind != CLIArtifactLaunchKindNative ||
				!artifactSHA256Pattern.MatchString(managed.CLI.Launch.SHA256) || managed.CLI.Launch.SizeBytes <= 0 ||
				managed.CLI.Launch.SizeBytes > 64*1024*1024 {
				return invalidManifest("artifact-native CLI launch requires an explicit command and bounded executable identity", nil)
			}
		}
		if managed.CLI.Install != nil {
			if err := validateCLIInstallation(*managed.CLI.Install, managed.Runtime, managed.CLI.Entrypoint); err != nil {
				return err
			}
		}
		if len(managed.CLI.Commands) == 0 {
			if managed.CLI.TimeoutMS < 100 || managed.CLI.TimeoutMS > 120_000 {
				return invalidManifest("managed CLI without command mappings requires timeoutMs between 100 and 120000", nil)
			}
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
	if authorizationKind != "none" {
		if err := validateManagedCredentialBroker(managed.CredentialBroker, managed.CLI != nil); err != nil {
			return err
		}
	}
	if authorizationKind == "none" && managed.CredentialBroker != nil {
		return invalidManifest("credential broker must not be declared when authorization is none", nil)
	}
	return nil
}

func validateCLIReadinessProbe(probe *CLIReadinessProbe) error {
	if probe == nil {
		return nil
	}
	if len(probe.Arguments) == 0 || len(probe.Arguments) > 32 || probe.TimeoutMS < 100 || probe.TimeoutMS > 30_000 {
		return invalidManifest("readinessProbe requires between 1 and 32 arguments and timeoutMs between 100 and 30000", nil)
	}
	totalBytes := 0
	for _, argument := range probe.Arguments {
		totalBytes += len(argument)
		if strings.ContainsRune(argument, '\x00') || totalBytes > 16*1024 {
			return invalidManifest("readinessProbe arguments are invalid", nil)
		}
	}
	return nil
}

func validateManagedCredentialBroker(broker *ManagedCredentialBroker, hasCLI bool) error {
	if broker == nil || !hasCLI {
		return invalidManifest("authorized managed_stdio connectors require a CLI credential broker", nil)
	}
	if broker.Protocol != CredentialBrokerProtocolV1 || !safeRelativeEntrypoint(broker.Entrypoint) {
		return invalidManifest("credential broker requires the v1 protocol and a safe connector-relative entrypoint", nil)
	}
	if broker.TimeoutMS < 1_000 || broker.TimeoutMS > 10*60*1_000 {
		return invalidManifest("credential broker timeoutMs must be between 1000 and 600000", nil)
	}
	// Manifest-only validation has no connector identity or release version.
	// Release validation restricts embedded_page to the legacy wecom-cli 0.1.4
	// compatibility case; hosts deliberately project it as an external link.
	if broker.Presentation != "" &&
		broker.Presentation != CredentialBrokerPresentationEmbeddedPage &&
		broker.Presentation != CredentialBrokerPresentationQRCode {
		return invalidManifest("credential broker presentation is unsupported", nil)
	}
	if len(broker.AllowedHosts) == 0 {
		return invalidManifest("credential broker requires at least one allowed authorization host", nil)
	}
	seen := make(map[string]struct{}, len(broker.AllowedHosts))
	for _, rawHost := range broker.AllowedHosts {
		host := strings.ToLower(strings.TrimSpace(rawHost))
		parsed, err := url.Parse("https://" + host)
		if err != nil || host == "" || parsed.Host != host || parsed.Hostname() != host || net.ParseIP(host) != nil {
			return invalidManifest("credential broker allowedHosts must contain exact DNS hostnames", nil)
		}
		if _, exists := seen[host]; exists {
			return invalidManifest("credential broker allowedHosts must be unique", nil)
		}
		seen[host] = struct{}{}
	}
	return nil
}

func validateCLIInstallation(install CLIInstallation, runtime RuntimeRequirement, executable string) error {
	if install.Kind != "node_package" || install.NodePackage == nil {
		return invalidManifest("managed CLI install must select the node_package branch", nil)
	}
	if runtime.Language != "node" || runtime.Profile != "connector-node-static" {
		return invalidManifest("node package CLI installation requires the shared connector-node-static runtime", nil)
	}
	if !nodeVersionRangePattern.MatchString(strings.TrimSpace(runtime.VersionRange)) {
		return invalidManifest("node package CLI installation requires an explicit comparator-based Node versionRange", nil)
	}
	if !manifestIdentifierPattern.MatchString(executable) {
		return invalidManifest("installed CLI entrypoint must be a stable executable name", nil)
	}
	request := install.NodePackage
	if !nodePackageNamePattern.MatchString(request.Package) {
		return invalidManifest("node package install package name is invalid", nil)
	}
	if !exactPackageVersionPattern.MatchString(request.Version) {
		return invalidManifest("node package install requires an exact semantic version", nil)
	}
	encodedIntegrity, ok := strings.CutPrefix(request.Integrity, "sha512-")
	decodedIntegrity, decodeErr := base64.StdEncoding.DecodeString(encodedIntegrity)
	if !ok || decodeErr != nil || len(decodedIntegrity) != 64 {
		return invalidManifest("node package install requires an exact sha512 integrity", nil)
	}
	switch request.Launch.Kind {
	case "node_script":
		if strings.TrimSpace(request.Launch.Entrypoint) != "" || strings.TrimSpace(request.Launch.SHA256) != "" {
			return invalidManifest("node_script package launch uses the declared package bin entrypoint", nil)
		}
	case "native":
		if !safeRelativeEntrypoint(request.Launch.Entrypoint) || !artifactSHA256Pattern.MatchString(request.Launch.SHA256) {
			return invalidManifest("native node package launch requires a safe package-relative entrypoint and lowercase SHA-256", nil)
		}
	default:
		return invalidManifest("node package launch kind must be node_script or native", nil)
	}
	seenEvents := make(map[string]struct{}, len(request.Lifecycle))
	for _, lifecycle := range request.Lifecycle {
		if lifecycle.Event != "postinstall" || !safeRelativeEntrypoint(lifecycle.Entrypoint) {
			return invalidManifest("node package lifecycle only supports a safe postinstall Node entrypoint", nil)
		}
		if _, exists := seenEvents[lifecycle.Event]; exists {
			return invalidManifest("node package lifecycle events must be unique", nil)
		}
		seenEvents[lifecycle.Event] = struct{}{}
		for _, argument := range lifecycle.Arguments {
			if strings.ContainsRune(argument, '\x00') {
				return invalidManifest("node package lifecycle arguments must not contain NUL", nil)
			}
		}
	}
	return nil
}

func validateRemoteStreamableHTTP(remote RemoteStreamableHTTPImplementation) error {
	if remote.ProtocolVersion != "2026-07-28" {
		return invalidManifest("remote protocolVersion must be 2026-07-28", nil)
	}
	if !remoteBindingRefPattern.MatchString(remote.BindingRef) {
		return invalidManifest("remote bindingRef must be a stable lowercase identifier", nil)
	}
	if remote.ContractVersion != 1 {
		return invalidManifest("remote contractVersion must be 1", nil)
	}
	if !remoteBindingContractHashPattern.MatchString(remote.BindingContractHash) {
		return invalidManifest("remote bindingContractHash must be a prefixed lowercase SHA-256", nil)
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

func validateUniquePermissions(values []string) error {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		permission, scope, scoped := strings.Cut(value, ":")
		if !manifestIdentifierPattern.MatchString(permission) {
			return invalidManifest("permission must start with a lowercase stable identifier", nil)
		}
		if scoped && (strings.Contains(scope, ":") || (scope != "*" && !permissionScopePattern.MatchString(scope))) {
			return invalidManifest("permission scope must be * or a lowercase stable scope", nil)
		}
		if _, exists := seen[value]; exists {
			return invalidManifest("permission values must be unique", nil)
		}
		seen[value] = struct{}{}
	}
	return nil
}

func safeRelativeEntrypoint(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || filepath.IsAbs(value) || strings.ContainsAny(value, "\\:") {
		return false
	}
	cleaned := filepath.ToSlash(filepath.Clean(value))
	if cleaned != value || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return false
	}
	for _, segment := range strings.Split(cleaned, "/") {
		trimmed := strings.TrimRight(segment, ". ")
		base := strings.ToLower(strings.SplitN(trimmed, ".", 2)[0])
		if trimmed != segment || base == "con" || base == "prn" || base == "aux" || base == "nul" ||
			(len(base) == 4 && (strings.HasPrefix(base, "com") || strings.HasPrefix(base, "lpt")) && base[3] >= '1' && base[3] <= '9') {
			return false
		}
	}
	return true
}

func invalidManifest(message string, cause error) error {
	return NewDomainError(ErrorCodeInvalidManifest, message, false, cause)
}
