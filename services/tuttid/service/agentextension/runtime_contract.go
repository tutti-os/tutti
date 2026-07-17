package agentextension

import (
	"errors"
	"regexp"
	"strings"
)

var runtimeBinaryNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
var runtimeConstraintPartPattern = regexp.MustCompile(`^(?:>=|>|<=|<)[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)

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
		for _, argument := range append(append([]string(nil), candidate.Version.Args...), candidate.LaunchArgs...) {
			if strings.TrimSpace(argument) == "" || strings.ContainsAny(argument, "|;&`\n\r<>") || strings.Contains(argument, "$(") {
				return errors.New("extension discovery argument contains forbidden syntax")
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

func validateRuntimeContract(manifest Manifest) error {
	if manifest.Runtime.Install.Runner != "npm" && manifest.Runtime.Install.Runner != "pnpm" && manifest.Runtime.Install.Runner != "uv" {
		return errors.New("extension runtime install runner is unsupported")
	}
	allArguments := append(append([]string(nil), manifest.Runtime.Install.Args...), manifest.Runtime.Launch.Args...)
	allArguments = append(allArguments, manifest.Runtime.Launch.Executable)
	for _, argument := range allArguments {
		if strings.TrimSpace(argument) == "" || strings.ContainsAny(argument, "|;&`\n\r<>") || strings.Contains(argument, "$(") {
			return errors.New("extension runtime argument contains forbidden shell syntax")
		}
		for _, match := range regexp.MustCompile(`\$\{[^}]+\}`).FindAllString(argument, -1) {
			if match != "${projectRoot}" && match != "${installRoot}" && match != "${platform}" {
				return errors.New("extension runtime argument contains unsupported placeholder")
			}
		}
	}
	for _, argument := range manifest.Runtime.Install.Args {
		if strings.Contains(argument, "${projectRoot}") {
			return errors.New("extension runtime install cannot depend on a project root")
		}
	}
	if !strings.Contains(strings.Join(manifest.Runtime.Install.Args, "\x00"), "${installRoot}") || !strings.HasPrefix(manifest.Runtime.Launch.Executable, "${installRoot}/") {
		return errors.New("extension runtime install and launch must stay under installRoot")
	}
	if manifest.Runtime.Install.Runner == "npm" || manifest.Runtime.Install.Runner == "pnpm" {
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
	if manifest.Runtime.Install.Runner == "uv" {
		packagePattern := regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*==[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
		count := 0
		for _, argument := range manifest.Runtime.Install.Args {
			if packagePattern.MatchString(argument) {
				count++
			}
		}
		if count != 1 {
			return errors.New("extension runtime install must name exactly one package at an exact version")
		}
	}
	return nil
}
