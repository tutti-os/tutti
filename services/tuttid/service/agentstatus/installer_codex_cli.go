package agentstatus

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/managednpm"
	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

// displayNPMRegistry returns a registry URL safe to surface in status and logs.
// A custom registry override (agentNPMRegistryEnv) can embed credentials as
// userinfo (https://user:token@host); strip them so they never reach the wizard
// UI, telemetry, or log lines. The raw URL is still used for the npm env.
func displayNPMRegistry(registry string) string {
	trimmed := strings.TrimSpace(registry)
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.User == nil {
		return trimmed
	}
	parsed.User = nil
	return parsed.String()
}

func (s Service) runCodexCLILatestInstaller(
	ctx context.Context,
	provider string,
	spec InstallerSpec,
	existingCLIPath string,
) (InstallCommandResult, error) {
	if spec.CodexCLI == nil {
		return InstallCommandResult{ExitCode: 1, Stderr: "codex CLI latest installer config is required"}, nil
	}
	return s.runManagedNPMPackageInstaller(ctx, provider, ManagedNPMPackageInstallerSpec{
		PackageName:     spec.CodexCLI.PackageName,
		BinaryName:      spec.CodexCLI.BinaryName,
		IncludeOptional: spec.CodexCLI.IncludeOptional,
		InstallDir:      spec.CodexCLI.InstallDir,
	}, existingCLIPath)
}

func (s Service) runManagedNPMPackageInstaller(
	ctx context.Context,
	provider string,
	spec ManagedNPMPackageInstallerSpec,
	existingCLIPath string,
) (InstallCommandResult, error) {
	return s.runManagedNPMPackageAction(ctx, provider, ActionInstall, spec, existingCLIPath)
}

// runManagedNPMPackageAction is the controlled npm execution primitive shared
// by install and update. The workflows that decide whether and why it runs are
// separate; the action id keeps progress ownership and reporting distinct.
func (s Service) runManagedNPMPackageAction(
	ctx context.Context,
	provider string,
	actionID ActionID,
	spec ManagedNPMPackageInstallerSpec,
	existingCLIPath string,
) (InstallCommandResult, error) {
	packageName := strings.TrimSpace(spec.PackageName)
	binaryName := strings.TrimSpace(spec.BinaryName)
	if packageName == "" {
		return InstallCommandResult{ExitCode: 1, Stderr: "managed npm package name is required"}, nil
	}
	if binaryName == "" {
		return InstallCommandResult{ExitCode: 1, Stderr: "managed npm package binary name is required"}, nil
	}
	resolver := s.commandResolver()
	npmPath, nodeTarget, baseEnv, err := s.resolveManagedNPMInstallerNodeRuntime(ctx, resolver)
	if err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	// A bare `npm install -g` lands the launcher in whichever npm's global prefix
	// runs the install. In the desktop app that npm can be the bundled app-runtime
	// node, whose prefix (~/.tutti/app-runtimes/.../node) is NOT on the binary
	// resolver's search path — so the install succeeds but `codex` is never found
	// and the wizard reports "provider CLI is still unavailable after install".
	// Pin the global prefix to the same stable, always-searched dir the
	// release-binary installer uses (selectInstallDir -> ~/.local/bin) so the
	// launcher stays discoverable regardless of which npm executes the install.
	installBinDir := strings.TrimSpace(spec.InstallDir)
	if installBinDir == "" {
		installBinDir, err = s.selectInstallDir()
		if err != nil {
			return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
		}
	}
	installPrefix := filepath.Dir(installBinDir)
	step := "install"
	// Repair-in-place: when an existing @openai/codex launcher is already on
	// PATH but its platform subpackage is missing (or it is outdated), installing
	// a SECOND copy in ~/.local does not help — the resolver prefers the
	// version-manager dir that already holds the broken copy, so the new copy in
	// ~/.local/bin is never selected and the wizard loops on "platform package
	// incomplete". Derive the npm global prefix that owns the existing package and
	// reinstall there with --include=optional so the missing platform binary is
	// restored in place. Falls back to the ~/.local install above when no existing
	// install can be located.
	if repairPrefix, ok := managedNPMRepairInstallPrefix(existingCLIPath, packageName); ok {
		installPrefix = repairPrefix
		step = "repair"
		slog.Info(
			"agent provider managed npm install repairing in place",
			"provider", provider,
			"package", packageName,
			"binary", binaryName,
			"existingCLIPath", existingCLIPath,
			"prefix", installPrefix,
		)
	}
	commandArgs := []string{npmPath, "install", "-g", "--prefix", installPrefix, managedNPMPackageSpec(spec)}
	if spec.IncludeOptional {
		commandArgs = append(commandArgs, "--include=optional")
	}
	command := joinShellCommand(commandArgs)
	// Pin a dedicated, tutti-owned npm cache instead of the user's global ~/.npm,
	// which on some machines holds root-owned files that make every user-mode npm
	// install fail with EACCES before any registry is hit.
	baseEnv = withAgentNPMCache(baseEnv, filepath.Join(installPrefix, agentNPMCacheDirName))
	registries := s.rankedManagedNPMRegistries(ctx, spec)
	var result InstallCommandResult
	binConflictRepaired := false
	for i, registry := range registries {
		registryDisplay := displayNPMRegistry(registry)
		setActiveAction(ctx, provider, ActiveAction{
			ID:         actionID,
			Status:     "running",
			Step:       step,
			Registry:   registryDisplay,
			NodeTarget: nodeTarget,
		})
		attemptCtx, cancel := context.WithTimeout(ctx, perRegistryInstallTimeout)
		result, err = s.installCommand(attemptCtx, InstallCommandInput{
			Command: command,
			Env:     withAgentNPMRegistry(slices.Clone(baseEnv), registry),
			OnStdout: func(output string) {
				appendActiveActionStdout(ctx, provider, output)
			},
		})
		cancel()
		if err == nil && result.ExitCode == 0 {
			setActiveAction(ctx, provider, ActiveAction{
				ID:         actionID,
				Status:     "running",
				Step:       "verify",
				Registry:   registryDisplay,
				NodeTarget: nodeTarget,
				Stdout:     result.Stdout,
			})
			return result, nil
		}
		if !binConflictRepaired && s.repairManagedNPMBinEEXIST(ctx, result, installPrefix, binaryName, spec.PackageVersion, baseEnv) {
			binConflictRepaired = true
			setActiveAction(ctx, provider, ActiveAction{
				ID:         actionID,
				Status:     "running",
				Step:       "repair",
				Registry:   registryDisplay,
				NodeTarget: nodeTarget,
				Stdout:     result.Stdout,
			})
			attemptCtx, cancel = context.WithTimeout(ctx, perRegistryInstallTimeout)
			result, err = s.installCommand(attemptCtx, InstallCommandInput{
				Command: command,
				Env:     withAgentNPMRegistry(slices.Clone(baseEnv), registry),
				OnStdout: func(output string) {
					appendActiveActionStdout(ctx, provider, output)
				},
			})
			cancel()
			if err == nil && result.ExitCode == 0 {
				setActiveAction(ctx, provider, ActiveAction{
					ID:         actionID,
					Status:     "running",
					Step:       "verify",
					Registry:   registryDisplay,
					NodeTarget: nodeTarget,
					Stdout:     result.Stdout,
				})
				return result, nil
			}
		}
		if i < len(registries)-1 {
			slog.Warn(
				"agent provider managed npm install failed on registry, trying next",
				"provider", provider,
				"package", packageName,
				"registry", registryDisplay,
				"exitCode", result.ExitCode,
				"error", err,
			)
		}
	}
	return result, err
}

func (Service) repairManagedNPMBinEEXIST(
	ctx context.Context,
	result InstallCommandResult,
	installPrefix string,
	binaryName string,
	requiredVersion string,
	env []string,
) bool {
	conflictPath, ok := managedNPMBinEEXISTPath(result)
	if !ok || !managedNPMBinConflictMatchesInstallTarget(conflictPath, installPrefix, binaryName) {
		return false
	}
	installedVersion, _ := managednpm.ExtractVersion(cliVersionOutput(ctx, conflictPath, env))
	if required := strings.TrimSpace(requiredVersion); required != "" && installedVersion == required {
		return false
	}
	if err := os.Remove(conflictPath); err != nil {
		slog.Warn(
			"agent provider managed npm bin conflict cleanup failed",
			"path", conflictPath,
			"installedVersion", installedVersion,
			"requiredVersion", strings.TrimSpace(requiredVersion),
			"error", err,
		)
		return false
	}
	slog.Info(
		"agent provider managed npm bin conflict cleaned for retry",
		"path", conflictPath,
		"installedVersion", installedVersion,
		"requiredVersion", strings.TrimSpace(requiredVersion),
	)
	return true
}

func (s Service) resolveManagedNPMInstallerNodeRuntime(
	ctx context.Context,
	resolver runtimecmd.Resolver,
) (string, string, []string, error) {
	appRuntime, err := s.resolveCodexManagedNodeRuntime(ctx)
	if err != nil {
		if npmPath := strings.TrimSpace(resolveBinaryWithResolver(resolver, []string{npmBinaryName()}, nil)); npmPath != "" {
			nodeTarget := firstNonBlank(resolveBinaryWithResolver(resolver, []string{nodeBinaryName()}, nil), nodeBinaryName())
			return npmPath, nodeTarget, resolver.Env(nil), nil
		}
		return "", "", nil, fmt.Errorf("tutti managed Node runtime is unavailable and npm was not found on PATH: %w", err)
	}
	npmPath := strings.TrimSpace(appRuntime.NPM)
	if npmPath == "" {
		if fallbackNPM := strings.TrimSpace(resolveBinaryWithResolver(resolver, []string{npmBinaryName()}, nil)); fallbackNPM != "" {
			nodeTarget := firstNonBlank(resolveBinaryWithResolver(resolver, []string{nodeBinaryName()}, nil), nodeBinaryName())
			return fallbackNPM, nodeTarget, resolver.Env(nil), nil
		}
		return "", "", nil, fmt.Errorf("tutti managed Node runtime did not provide npm and npm was not found on PATH")
	}
	return npmPath, firstNonBlank(appRuntime.Node, nodeBinaryName()), managedruntime.ProcessEnv(appRuntime.EnvOverrides...), nil
}

func managedNPMPackageSpec(spec ManagedNPMPackageInstallerSpec) string {
	packageName := strings.TrimSpace(spec.PackageName)
	version := strings.TrimSpace(spec.PackageVersion)
	if version == "" {
		return packageName
	}
	return packageName + "@" + version
}

func managedNPMBinEEXISTPath(result InstallCommandResult) (string, bool) {
	output := result.Stderr + "\n" + result.Stdout
	if !strings.Contains(strings.ToLower(output), "eexist") {
		return "", false
	}
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		const npmPathPrefix = "npm error path "
		if strings.HasPrefix(trimmed, npmPathPrefix) {
			path := strings.TrimSpace(strings.TrimPrefix(trimmed, npmPathPrefix))
			if path != "" {
				return path, true
			}
		}
		const fileExistsPrefix = "File exists:"
		if idx := strings.Index(trimmed, fileExistsPrefix); idx >= 0 {
			path := strings.TrimSpace(trimmed[idx+len(fileExistsPrefix):])
			if path != "" {
				return path, true
			}
		}
	}
	return "", false
}

func managedNPMBinConflictMatchesInstallTarget(conflictPath, installPrefix, binaryName string) bool {
	conflictPath = cleanNonEmptyPath(conflictPath)
	if conflictPath == "" {
		return false
	}
	for _, candidate := range managedNPMBinPathCandidates(installPrefix, binaryName) {
		if conflictPath == cleanNonEmptyPath(candidate) {
			return true
		}
	}
	return false
}

func managedNPMBinPathCandidates(installPrefix, binaryName string) []string {
	installPrefix = strings.TrimSpace(installPrefix)
	binaryName = strings.TrimSpace(binaryName)
	if installPrefix == "" || binaryName == "" {
		return nil
	}
	if runtime.GOOS == "windows" {
		return []string{
			filepath.Join(installPrefix, binaryName),
			filepath.Join(installPrefix, binaryName+".cmd"),
			filepath.Join(installPrefix, binaryName+".ps1"),
		}
	}
	return []string{filepath.Join(installPrefix, "bin", binaryName)}
}

func cleanNonEmptyPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	return filepath.Clean(path)
}

func managedNPMRepairInstallPrefix(existingCLIPath, packageName string) (string, bool) {
	existingCLIPath = strings.TrimSpace(existingCLIPath)
	if existingCLIPath == "" {
		return "", false
	}
	packageJSONPath := findAdapterPackageJSON(existingCLIPath, packageName)
	if packageJSONPath == "" {
		return "", false
	}
	prefix := npmGlobalPrefixFromPackageDir(filepath.Dir(packageJSONPath))
	if prefix == "" {
		return "", false
	}
	return prefix, true
}

func (s Service) resolveCodexManagedNodeRuntime(ctx context.Context) (managedruntime.ResolvedRuntime, error) {
	resolver := s.managedRuntimeResolver()
	if managed, ok := resolver.(managedruntime.DefaultResolver); ok {
		root := strings.TrimSpace(managed.RuntimeRoot)
		if root == "" {
			root = managed.DefaultRoot()
		}
		if runtime, ok := resolvedExistingManagedNodeRuntime(root, s.Environ); ok {
			return runtime, nil
		}
	}
	if profileResolver, ok := resolver.(managedruntime.ProfileResolver); ok {
		return profileResolver.ResolveProfile(ctx, managedruntime.NodeStaticProfile)
	}
	return resolver.Resolve(ctx)
}

func nodeBinaryName() string {
	if runtime.GOOS == "windows" {
		return "node.exe"
	}
	return "node"
}

func npmBinaryName() string {
	if runtime.GOOS == "windows" {
		return "npm.cmd"
	}
	return "npm"
}
