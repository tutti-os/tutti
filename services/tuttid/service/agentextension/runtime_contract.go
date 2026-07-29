package agentextension

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	agentextensionbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentextension"
)

var runtimeBinaryNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
var runtimeSearchPathPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$`)
var runtimeConstraintPartPattern = regexp.MustCompile(`^(?:>=|>|<=|<)[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
var runtimeArgumentPlaceholderPattern = regexp.MustCompile(`\$\{[^}]+\}`)
var runtimeArtifactPlatformPattern = regexp.MustCompile(`^[a-z0-9]+-[a-z0-9_]+$`)
var runtimeArtifactSHA256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

const maxRuntimeBinaryArtifactBytes = int64(1 << 30)

func validateDiscoveryProfile(profile DiscoveryProfile) error {
	if profile.SchemaVersion != "tutti.agent.discovery.v1" || len(profile.Candidates) == 0 {
		return errors.New("extension discovery profile requires candidates")
	}
	for _, candidate := range profile.Candidates {
		if len(candidate.BinaryNames) == 0 || len(candidate.Version.Args) == 0 || len(candidate.LaunchArgs) == 0 {
			return errors.New("extension discovery candidate is incomplete")
		}
		for _, name := range candidate.BinaryNames {
			if !runtimeBinaryNamePattern.MatchString(name) {
				return errors.New("extension discovery binary name is invalid")
			}
		}
		if len(candidate.SearchPaths) > 16 {
			return errors.New("extension discovery has too many search paths")
		}
		for _, searchPath := range candidate.SearchPaths {
			if searchPath.Scope != "user" || len(searchPath.Path) > 256 || !runtimeSearchPathPattern.MatchString(searchPath.Path) {
				return errors.New("extension discovery search path is invalid")
			}
			for _, component := range strings.Split(searchPath.Path, "/") {
				if component == "." || component == ".." {
					return errors.New("extension discovery search path is invalid")
				}
			}
		}
		for _, argument := range append(append([]string(nil), candidate.Version.Args...), candidate.LaunchArgs...) {
			if strings.TrimSpace(argument) == "" || strings.ContainsAny(argument, "|;&`\n\r<>") || strings.Contains(argument, "$(") {
				return errors.New("extension discovery argument contains forbidden syntax")
			}
		}
		for _, argument := range candidate.Version.Args {
			if strings.Contains(argument, "$") {
				return errors.New("extension discovery version argument contains unsupported placeholder")
			}
		}
		parts := strings.Fields(candidate.Version.Constraint)
		if len(parts) == 0 {
			return errors.New("extension discovery version constraint is required")
		}
		for _, part := range parts {
			if !runtimeConstraintPartPattern.MatchString(part) {
				return errors.New("extension discovery version constraint is invalid")
			}
		}
		if candidate.Probe.Kind != "acp-initialize" || candidate.Probe.TimeoutMS < 100 || candidate.Probe.TimeoutMS > 30000 {
			return errors.New("extension discovery ACP probe is invalid")
		}
	}
	return nil
}

func validateDiscoveryLaunchPlaceholders(profile DiscoveryProfile, composer ComposerProfile) error {
	setting := composer.LaunchPermissionSetting()
	for _, candidate := range profile.Candidates {
		if err := validatePermissionLaunchPlaceholders(candidate.LaunchArgs, setting, false); err != nil {
			return fmt.Errorf("extension discovery launch: %w", err)
		}
	}
	return nil
}

func validateManifestLaunchPlaceholders(manifest Manifest, composer ComposerProfile) error {
	if err := validatePermissionLaunchPlaceholders(manifest.Runtime.Launch.Args, composer.LaunchPermissionSetting(), true); err != nil {
		return fmt.Errorf("extension runtime launch: %w", err)
	}
	return nil
}

func validatePermissionLaunchPlaceholders(
	arguments []string,
	setting *ComposerLaunchPermissionSetting,
	allowRuntimePlaceholders bool,
) error {
	permissionPlaceholders := 0
	for _, argument := range arguments {
		for _, match := range runtimeArgumentPlaceholderPattern.FindAllString(argument, -1) {
			if allowRuntimePlaceholders && (match == "${projectRoot}" || match == "${installRoot}" || match == "${platform}") {
				continue
			}
			if setting == nil || match != setting.Placeholder || argument != match {
				return errors.New("argument contains unsupported placeholder")
			}
			permissionPlaceholders++
		}
		withoutKnown := runtimeArgumentPlaceholderPattern.ReplaceAllString(argument, "")
		if strings.Contains(withoutKnown, "$") {
			return errors.New("argument contains unsupported placeholder")
		}
	}
	if setting != nil && permissionPlaceholders != 1 {
		return errors.New("permission placeholder must appear exactly once")
	}
	return nil
}

func validateRuntimeContract(manifest Manifest) error {
	runner := manifest.Runtime.Install.Runner
	if runner != "npm" && runner != "pnpm" && runner != "uv" && runner != "binary" {
		return errors.New("extension runtime install runner is unsupported")
	}
	for _, argument := range append(append([]string(nil), manifest.Runtime.Install.Args...), manifest.Runtime.Launch.Executable) {
		if strings.TrimSpace(argument) == "" || strings.ContainsAny(argument, "|;&`\n\r<>") || strings.Contains(argument, "$(") {
			return errors.New("extension runtime argument contains forbidden shell syntax")
		}
		for _, match := range runtimeArgumentPlaceholderPattern.FindAllString(argument, -1) {
			if match != "${projectRoot}" && match != "${installRoot}" && match != "${platform}" {
				return errors.New("extension runtime argument contains unsupported placeholder")
			}
		}
		withoutPlaceholders := runtimeArgumentPlaceholderPattern.ReplaceAllString(argument, "")
		if strings.Contains(withoutPlaceholders, "$") {
			return errors.New("extension runtime argument contains unsupported placeholder")
		}
	}
	for _, argument := range manifest.Runtime.Launch.Args {
		if strings.TrimSpace(argument) == "" || strings.ContainsAny(argument, "|;&`\n\r<>") || strings.Contains(argument, "$(") {
			return errors.New("extension runtime argument contains forbidden shell syntax")
		}
		for _, match := range runtimeArgumentPlaceholderPattern.FindAllString(argument, -1) {
			if match != "${projectRoot}" && match != "${installRoot}" && match != "${platform}" &&
				(match != composerPermissionLaunchPlaceholder || argument != match) {
				return errors.New("extension runtime argument contains unsupported placeholder")
			}
		}
		withoutPlaceholders := runtimeArgumentPlaceholderPattern.ReplaceAllString(argument, "")
		if strings.Contains(withoutPlaceholders, "$") {
			return errors.New("extension runtime argument contains unsupported placeholder")
		}
	}
	for _, argument := range manifest.Runtime.Install.Args {
		if strings.Contains(argument, "${projectRoot}") {
			return errors.New("extension runtime install cannot depend on a project root")
		}
	}
	if !strings.HasPrefix(manifest.Runtime.Launch.Executable, "${installRoot}/") {
		return errors.New("extension runtime launch must stay under installRoot")
	}
	if runner != "binary" && runner != "uv" && !strings.Contains(strings.Join(manifest.Runtime.Install.Args, "\x00"), "${installRoot}") {
		return errors.New("extension runtime install and launch must stay under installRoot")
	}
	if runner == "binary" {
		if len(manifest.Runtime.Install.Args) != 0 {
			return errors.New("extension binary runtime cannot declare installer arguments")
		}
		return validateRuntimeBinaryArtifacts(manifest.Runtime.Install.Artifacts)
	}
	if len(manifest.Runtime.Install.Artifacts) != 0 {
		return errors.New("extension package-manager runtime cannot declare binary artifacts")
	}
	if runner == "npm" || runner == "pnpm" {
		packagePattern := regexp.MustCompile(`^@[a-z0-9._-]+/[a-z0-9._-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
		count := 0
		for _, argument := range manifest.Runtime.Install.Args {
			if strings.HasPrefix(argument, "@") {
				if !packagePattern.MatchString(argument) {
					return errors.New("extension runtime package must use an exact scoped version")
				}
				count++
			}
		}
		if count != 1 {
			return errors.New("extension runtime install must name exactly one scoped package")
		}
	}
	if runner == "uv" {
		packagePattern := regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*(?:\[[a-z0-9._-]+(?:,[a-z0-9._-]+)*\])?==[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$`)
		count := 0
		for _, argument := range manifest.Runtime.Install.Args {
			if packagePattern.MatchString(argument) {
				count++
			}
		}
		if count != 1 {
			return errors.New("extension runtime install must name exactly one package at an exact version")
		}
		if len(manifest.Runtime.Install.Args) != 3 || manifest.Runtime.Install.Args[0] != "tool" || manifest.Runtime.Install.Args[1] != "install" || !packagePattern.MatchString(manifest.Runtime.Install.Args[2]) {
			return errors.New("extension uv runtime install must use the constrained tool install form")
		}
	}
	return nil
}

func validateRuntimeBinaryArtifacts(artifacts []agentextensionbiz.RuntimeBinaryArtifact) error {
	if len(artifacts) == 0 || len(artifacts) > 16 {
		return errors.New("extension binary runtime requires a bounded artifact catalog")
	}
	platforms := make(map[string]struct{}, len(artifacts))
	for _, artifact := range artifacts {
		if artifact.Kind != "executable" || !runtimeArtifactPlatformPattern.MatchString(artifact.Platform) {
			return errors.New("extension binary artifact identity is invalid")
		}
		if _, exists := platforms[artifact.Platform]; exists {
			return errors.New("extension binary artifact platform is duplicated")
		}
		platforms[artifact.Platform] = struct{}{}
		if !validSemver(artifact.Version) || !runtimeArtifactSHA256Pattern.MatchString(artifact.SHA256) {
			return errors.New("extension binary artifact version or SHA-256 is invalid")
		}
		if artifact.SizeBytes <= 0 || artifact.SizeBytes > maxRuntimeBinaryArtifactBytes {
			return errors.New("extension binary artifact size is invalid")
		}
		if err := validateRuntimeArtifactHTTPSURL(artifact.URL); err != nil {
			return fmt.Errorf("extension binary artifact URL: %w", err)
		}
		if artifact.Provenance.Kind != "official-release" {
			return errors.New("extension binary artifact provenance is invalid")
		}
		if err := validateRuntimeArtifactHTTPSURL(artifact.Provenance.URL); err != nil {
			return fmt.Errorf("extension binary artifact provenance URL: %w", err)
		}
	}
	return nil
}

func validateRuntimeArtifactHTTPSURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return errors.New("must be an HTTPS URL without credentials or fragment")
	}
	return nil
}
