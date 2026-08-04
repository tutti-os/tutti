package daemon

import (
	"fmt"
	"regexp"
	"strings"
)

var connectorKeyPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$`)
var artifactSHA256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type ImplementationValidator func(config map[string]any) error

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
		if err := validator(manifest.Implementation.Config); err != nil {
			return invalidManifest("implementation config is invalid", err)
		}
	}
	return nil
}

func ValidateManifestShape(manifest Manifest) error {
	if manifest.SchemaVersion != "1" {
		return invalidManifest("schemaVersion must be 1", nil)
	}
	if !connectorKeyPattern.MatchString(manifest.Key) {
		return invalidManifest("key must be a stable lowercase connector identifier", nil)
	}
	if strings.TrimSpace(manifest.Version) == "" {
		return invalidManifest("version is required", nil)
	}
	if strings.TrimSpace(manifest.DisplayName) == "" {
		return invalidManifest("displayName is required", nil)
	}
	if strings.TrimSpace(manifest.Artifact.Key) == "" ||
		!artifactSHA256Pattern.MatchString(manifest.Artifact.SHA256) ||
		manifest.Artifact.SizeBytes <= 0 {
		return invalidManifest("artifact key, lowercase SHA-256, and positive sizeBytes are required", nil)
	}
	if strings.TrimSpace(manifest.Implementation.Kind) == "" {
		return invalidManifest("implementation.kind is required", nil)
	}
	if strings.TrimSpace(manifest.AuthorizationKind) == "" {
		return invalidManifest("authorizationKind is required", nil)
	}
	return nil
}

func invalidManifest(message string, cause error) error {
	return NewDomainError(ErrorCodeInvalidManifest, message, false, cause)
}
