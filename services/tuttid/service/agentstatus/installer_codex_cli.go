package agentstatus

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/runtimecmd"
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
	spec InstallerSpec,
	existingCLIPath string,
) (InstallCommandResult, error) {
	if spec.CodexCLI == nil {
		return InstallCommandResult{ExitCode: 1, Stderr: "codex CLI latest installer config is required"}, nil
	}
	resolver := s.commandResolver()
	npmPath, nodeTarget, baseEnv, err := s.resolveCodexInstallerNodeRuntime(ctx, resolver)
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
	installBinDir, err := s.selectInstallDir()
	if err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
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
	if repairPrefix, ok := codexRepairInstallPrefix(existingCLIPath); ok {
		installPrefix = repairPrefix
		step = "repair"
		slog.Info(
			"agent provider codex npm install repairing in place",
			"existingCLIPath", existingCLIPath,
			"prefix", installPrefix,
		)
	}
	command := joinShellCommand([]string{npmPath, "install", "-g", "--prefix", installPrefix, "@openai/codex", "--include=optional"})
	// Pin a dedicated, tutti-owned npm cache instead of the user's global ~/.npm,
	// which on some machines holds root-owned files that make every user-mode npm
	// install fail with EACCES before any registry is hit.
	baseEnv = withAgentNPMCache(baseEnv, filepath.Join(installPrefix, agentNPMCacheDirName))
	registries := s.rankedAgentNPMRegistries(ctx, "@openai/codex")
	var result InstallCommandResult
	for i, registry := range registries {
		registryDisplay := displayNPMRegistry(registry)
		setActiveAction(ctx, "codex", ActiveAction{
			ID:         ActionInstall,
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
				appendActiveActionStdout(ctx, "codex", output)
			},
		})
		cancel()
		if err == nil && result.ExitCode == 0 {
			setActiveAction(ctx, "codex", ActiveAction{
				ID:         ActionInstall,
				Status:     "running",
				Step:       "verify",
				Registry:   registryDisplay,
				NodeTarget: nodeTarget,
				Stdout:     result.Stdout,
			})
			return result, nil
		}
		if i < len(registries)-1 {
			slog.Warn(
				"agent provider codex npm install failed on registry, trying next",
				"registry", registryDisplay,
				"exitCode", result.ExitCode,
				"error", err,
			)
		}
	}
	return result, err
}

func (s Service) resolveCodexInstallerNodeRuntime(
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
