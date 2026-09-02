package agentstatus

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
)

func codexRuntimeSelectionNeedsUserInput(runtime providerRuntimeResolution) bool {
	return runtime.CodexSelectionState == CodexRuntimeSelectionSelectionRequired ||
		runtime.CodexSelectionState == CodexRuntimeSelectionStale
}

func (s Service) resolveProviderRuntime(ctx context.Context, spec ProviderSpec) providerRuntimeResolution {
	resolver := s.commandResolver()
	env := resolver.Env(spec.AdapterEnv)
	if strings.TrimSpace(os.Getenv("TUTTI_MOCK_AGENT_UNBOUND")) == "1" && isCodexStatusSpec(spec) {
		return providerRuntimeResolution{Env: env}
	}
	if strings.TrimSpace(spec.ExternalRegistryID) != "" {
		return s.resolveExternalProviderRuntime(ctx, spec, resolver, env)
	}
	if isCodexStatusSpec(spec) && s.CodexRuntimeSelectionStore != nil {
		selection, err := s.resolveCodexRuntimeSelection(ctx, spec)
		result := providerRuntimeResolution{
			AdapterEnv: cloneStrings(spec.AdapterEnv),
			Env:        env,
		}
		if err != nil {
			result.ReasonCode = "codex_runtime_selection_unavailable"
			return result
		}
		result.ReasonCode = selection.ReasonCode
		result.CodexSelectionExplicit = selection.Explicit
		result.CodexSelectionState = selection.State
		candidate, found := selection.candidate()
		if !found {
			return result
		}
		result.CLIPath = candidate.Candidate.LauncherPath
		if !selection.Launchable {
			return result
		}
		result.AdapterPath = candidate.Candidate.LauncherPath
		result.AdapterCommand = cloneStrings(spec.AdapterCommand)
		if len(result.AdapterCommand) > 0 {
			result.AdapterCommand[0] = candidate.Candidate.LauncherPath
		}
		return result
	}
	cliPath := ""
	if isClaudeStatusSpec(spec) {
		cliPath = s.managedClaudeCodeExecutable()
	}
	if strings.TrimSpace(cliPath) == "" {
		cliPath = resolveBinaryWithResolver(resolver, spec.BinaryNames, nil)
	}
	adapterPath := resolveBinaryWithResolver(resolver, adapterBinaryNames(spec), spec.AdapterEnv)
	if isStandardACPStatusSpec(spec) && len(spec.AdapterCommand) > 0 && s.executableFile(spec.AdapterCommand[0]) {
		cliPath = spec.AdapterCommand[0]
		adapterPath = spec.AdapterCommand[0]
	}
	if isCodexStatusSpec(spec) && len(spec.AdapterCommand) > 0 && s.executableFile(spec.AdapterCommand[0]) {
		if cliPath == "" {
			cliPath = spec.AdapterCommand[0]
		}
		if adapterPath == "" {
			adapterPath = spec.AdapterCommand[0]
		}
	}
	return providerRuntimeResolution{
		CLIPath:        cliPath,
		AdapterPath:    adapterPath,
		AdapterVersion: resolveAdapterPackageVersion(adapterPath, spec.AdapterPackage),
		AdapterCommand: cloneStrings(spec.AdapterCommand),
		AdapterEnv:     cloneStrings(spec.AdapterEnv),
		Env:            env,
	}
}

func (s Service) resolveExternalProviderRuntime(
	_ context.Context,
	spec ProviderSpec,
	resolver runtimecmd.Resolver,
	env []string,
) providerRuntimeResolution {
	result := providerRuntimeResolution{
		CLIPath:        resolveBinaryWithResolver(resolver, spec.BinaryNames, nil),
		AdapterCommand: cloneStrings(spec.AdapterCommand),
		AdapterEnv:     cloneStrings(spec.AdapterEnv),
		ReasonCode:     spec.AdapterUnavailableReasonCode,
		Env:            env,
	}
	if spec.AdapterInstall.RegistryNPM != nil {
		npm := spec.AdapterInstall.RegistryNPM
		result.AdapterPath = strings.TrimSpace(npm.PackageDir)
		result.AdapterVersion = installedNPMPackageVersion(npm.PackageDir, spec.AdapterPackage.Name)
		if result.AdapterVersion == "" || len(spec.AdapterCommand) == 0 {
			result.AdapterPath = ""
		}
		return result
	}
	if len(spec.AdapterCommand) > 0 {
		path := strings.TrimSpace(spec.AdapterCommand[0])
		if path != "" && s.executableFile(path) {
			result.AdapterPath = path
			result.AdapterVersion = spec.AdapterPackage.Version
		}
	}
	return result
}

func resolveAdapterPackageVersion(adapterPath string, requirement AdapterPackageRequirement) string {
	if strings.TrimSpace(adapterPath) == "" || strings.TrimSpace(requirement.Name) == "" {
		return ""
	}
	packageJSONPath := findAdapterPackageJSON(adapterPath, requirement.Name)
	if packageJSONPath == "" {
		return ""
	}
	content, err := os.ReadFile(packageJSONPath)
	if err != nil {
		return ""
	}
	var manifest struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(content, &manifest); err != nil {
		return ""
	}
	if strings.TrimSpace(manifest.Name) != strings.TrimSpace(requirement.Name) {
		return ""
	}
	return strings.TrimSpace(manifest.Version)
}

func findAdapterPackageJSON(adapterPath string, packageName string) string {
	resolvedPath := strings.TrimSpace(adapterPath)
	if resolved, err := filepath.EvalSymlinks(resolvedPath); err == nil {
		resolvedPath = resolved
	}
	if runtime.GOOS == "windows" {
		// Windows npm puts the .cmd/.ps1 shim beside the global
		// node_modules tree. The shim itself is not inside the package, so
		// ancestor walking cannot find package.json as it does for Unix symlinks.
		candidate := filepath.Join(filepath.Dir(resolvedPath), "node_modules", packageName, "package.json")
		if packageJSONHasName(candidate, packageName) {
			return candidate
		}
	}
	dir := filepath.Dir(resolvedPath)
	for range 8 {
		candidate := filepath.Join(dir, "package.json")
		if packageJSONHasName(candidate, packageName) {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

func packageJSONHasName(path string, packageName string) bool {
	content, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var manifest struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(content, &manifest); err != nil {
		return false
	}
	return strings.TrimSpace(manifest.Name) == strings.TrimSpace(packageName)
}

func resolveBinaryWithResolver(resolver runtimecmd.Resolver, binaryNames []string, overrides []string) string {
	if runtime.GOOS == "windows" {
		// npm prefixes can contain both a POSIX shell shim (`opencode`) and
		// Windows launchers (`opencode.cmd`/`.ps1`). Prefer the Windows
		// launcher before LookPath, whose fallback may select the extensionless
		// POSIX file.
		expanded := make([]string, 0, len(binaryNames)*5)
		for _, binaryName := range binaryNames {
			if filepath.Ext(strings.TrimSpace(binaryName)) != "" {
				expanded = append(expanded, binaryName)
				continue
			}
			expanded = append(expanded,
				binaryName+".cmd",
				binaryName+".exe",
				binaryName+".bat",
				binaryName+".ps1",
				binaryName,
			)
		}
		binaryNames = expanded
	}
	return resolver.ResolveBinary(binaryNames, overrides)
}

func adapterBinaryNames(spec ProviderSpec) []string {
	if len(spec.AdapterBinaryNames) > 0 {
		return cloneStrings(spec.AdapterBinaryNames)
	}
	return cloneStrings(spec.BinaryNames)
}
