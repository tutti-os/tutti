package agentstatus

import (
	"context"
	"strings"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func agentProviderCLINPMPackage(provider string) string {
	switch provider {
	case agentprovider.Codex:
		return "@openai/codex"
	case agentprovider.ClaudeCode:
		return "@anthropic-ai/claude-code"
	default:
		return ""
	}
}

func providerSupportsCLIUpdate(provider string) bool {
	return agentProviderCLINPMPackage(provider) != ""
}

// runUpdateAction updates an already-installed first-party CLI using the
// provider-specific safe path. Both providers get the resolved CLI's official
// self-updater first so native, Homebrew, and npm installations keep their own
// update semantics. Older Codex versions that lack the update command fall back
// to Tutti's managed npm installer and its registry/prefix safeguards.
func (s Service) runUpdateAction(
	ctx context.Context,
	spec ProviderSpec,
	result RunActionResult,
) (RunActionResult, error) {
	if result, ok := unsupportedProviderRunActionResult(spec, result); ok {
		return result, nil
	}
	if !providerSupportsCLIUpdate(spec.Provider) {
		result.Status = RunActionFailed
		result.ReasonCode = "cli_update_unsupported"
		result.Message = "Provider CLI update is unsupported"
		return result, nil
	}

	runtimeResolution := s.resolveProviderRuntime(ctx, spec)
	if strings.TrimSpace(runtimeResolution.CLIPath) == "" {
		result.Status = RunActionFailed
		result.ReasonCode = "cli_not_found"
		result.Message = "CLI binary not found"
		return result, nil
	}

	updateCtx := withActiveActionToken(baseContext(ctx), nextActiveActionToken())
	claimActiveAction(updateCtx, spec.Provider, ActiveAction{
		ID:     ActionUpdate,
		Status: "running",
		Step:   "update",
	})
	defer clearActiveAction(updateCtx, spec.Provider)

	command, commandResult, err := s.executeCLIUpdateInstaller(
		updateCtx,
		spec,
		&runtimeResolution,
	)
	result.Command = command
	result.ExitCode = intPointer(commandResult.ExitCode)
	result.Stdout = trimActionOutput(commandResult.Stdout)
	result.Stderr = trimActionOutput(commandResult.Stderr)
	if err != nil {
		return updateActionErrorResult(result, err, s.installTimeout()), nil
	}
	if commandResult.ExitCode != 0 {
		result.Status = RunActionFailed
		result.ReasonCode = "update_command_failed"
		result.Message = firstNonBlank(result.Stderr, result.Stdout, "CLI update command failed")
		return result, nil
	}

	setActiveAction(updateCtx, spec.Provider, ActiveAction{
		ID:     ActionUpdate,
		Status: "running",
		Step:   "verify",
		Stdout: commandResult.Stdout,
	})
	probe, err := s.Probe(ctx, ProbeInput{Provider: spec.Provider})
	if err != nil {
		return RunActionResult{}, err
	}
	result.Probe = &probe
	if probe.Status == ProbeFailed {
		result.Status = RunActionFailed
		result.ReasonCode = "post_update_probe_failed"
		result.Message = firstNonBlank(probe.Message, probe.ReasonCode, "Agent provider runtime probe failed after CLI update")
		return result, nil
	}
	result.Status = RunActionCompleted
	return result, nil
}

func (s Service) executeCLIUpdateInstaller(
	ctx context.Context,
	spec ProviderSpec,
	runtimeResolution *providerRuntimeResolution,
) (string, InstallCommandResult, error) {
	nativeCommand := joinShellCommand([]string{runtimeResolution.CLIPath, "update"})
	nativeInstaller := InstallerSpec{
		Kind:           InstallerKindShellCommand,
		DisplayCommand: nativeCommand,
		ShellCommand:   nativeCommand,
	}
	command, result, err := s.executeInstaller(ctx, spec.Provider, nativeInstaller, runtimeResolution)
	if spec.Provider != agentprovider.Codex || (err == nil && result.ExitCode == 0) || spec.Install.Kind == "" {
		return command, result, err
	}

	fallbackCommand, fallbackResult, fallbackErr := s.executeInstaller(
		ctx,
		spec.Provider,
		spec.Install,
		runtimeResolution,
	)
	fallbackResult.Stdout = joinUpdateOutputs(result.Stdout, fallbackResult.Stdout)
	fallbackResult.Stderr = joinUpdateOutputs(result.Stderr, fallbackResult.Stderr)
	return command + " || " + fallbackCommand, fallbackResult, fallbackErr
}

func joinUpdateOutputs(outputs ...string) string {
	nonEmpty := make([]string, 0, len(outputs))
	for _, output := range outputs {
		if trimmed := strings.TrimSpace(output); trimmed != "" {
			nonEmpty = append(nonEmpty, trimmed)
		}
	}
	return strings.Join(nonEmpty, "\n")
}

func updateActionErrorResult(result RunActionResult, err error, timeout time.Duration) RunActionResult {
	// Keep the user-facing action result aligned with install failures while
	// retaining update-specific reason codes for telemetry and diagnostics.
	installResult := installActionErrorResult(result, err, timeout)
	switch installResult.ReasonCode {
	case "install_timed_out":
		installResult.ReasonCode = "update_timed_out"
	case "install_canceled":
		installResult.ReasonCode = "update_canceled"
	case "install_start_failed":
		installResult.ReasonCode = "update_start_failed"
	}
	return installResult
}
