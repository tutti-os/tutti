package agentstatus

import (
	"context"
	"log/slog"
	"net/url"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
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
	_ string,
) (InstallCommandResult, error) {
	if spec.CodexCLI == nil {
		return InstallCommandResult{ExitCode: 1, Stderr: "codex CLI latest installer config is required"}, nil
	}
	resolver := s.commandResolver()
	npmPath := firstNonBlank(resolveBinaryWithResolver(resolver, []string{npmBinaryName()}, nil), npmBinaryName())
	nodeTarget := firstNonBlank(resolveBinaryWithResolver(resolver, []string{nodeBinaryName()}, nil), nodeBinaryName())
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
	command := joinShellCommand([]string{npmPath, "install", "-g", "--prefix", installPrefix, "@openai/codex", "--include=optional"})
	baseEnv := s.commandResolver().Env(nil)
	// Pin a dedicated, tutti-owned npm cache instead of the user's global ~/.npm,
	// which on some machines holds root-owned files that make every user-mode npm
	// install fail with EACCES before any registry is hit.
	baseEnv = withAgentNPMCache(baseEnv, filepath.Join(installPrefix, agentNPMCacheDirName))
	registries := s.agentNPMRegistries()
	var result InstallCommandResult
	for i, registry := range registries {
		registryDisplay := displayNPMRegistry(registry)
		setActiveAction(ctx, "codex", ActiveAction{
			ID:         ActionInstall,
			Status:     "running",
			Step:       "install",
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
