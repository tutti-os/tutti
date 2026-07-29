package agentstatus

import (
	"context"
	"strings"
	"time"
)

func (s Service) probeAdapterRuntimeCommand(
	ctx context.Context,
	spec ProviderSpec,
	runtimeResolution providerRuntimeResolution,
	now time.Time,
) ProbeResult {
	result := ProbeResult{
		Provider:   spec.Provider,
		CheckedAt:  now,
		BinaryPath: runtimeResolution.AdapterPath,
		Command:    cloneStrings(spec.AdapterCommand),
	}
	command := cloneStrings(spec.AdapterCommand)
	if len(command) == 0 {
		command = cloneStrings(spec.BinaryNames)
	}
	if len(command) == 0 || strings.TrimSpace(command[0]) == "" {
		result.Status = ProbeSkipped
		result.ReasonCode = "probe_command_unavailable"
		result.Message = "Provider probe command is unavailable"
		return result
	}

	env := s.commandResolver().Env(s.adapterCommandEnv(ctx, spec))
	command[0] = s.commandResolver().Resolve(command[0], env)
	result.Command = cloneStrings(command)
	if strings.TrimSpace(runtimeResolution.AdapterPath) != "" {
		result.BinaryPath = runtimeResolution.AdapterPath
	} else {
		result.BinaryPath = command[0]
	}
	release, acquired := s.DetectionCommands.acquire(ctx)
	if !acquired {
		result.Status = ProbeFailed
		result.ReasonCode = "probe_canceled"
		result.Message = context.Cause(ctx).Error()
		return result
	}
	defer release()
	if isCodexStatusSpec(spec) && sameResolvedBinary(runtimeResolution.AdapterPath, runtimeResolution.CLIPath) {
		// Codex has no separate adapter binary in production: `codex app-server`
		// IS the CLI, so a real ACP handshake here directly answers "can Tutti
		// actually launch this" instead of only checking the process didn't
		// exit. Providers with a distinct adapter binary (e.g. the synthetic
		// specs used to test that generic mechanism) keep the liveness probe.
		result = s.probeCodexAppServerHandshake(ctx, result, command, env)
	} else if isStandardACPStatusSpec(spec) && sameResolvedBinary(runtimeResolution.AdapterPath, runtimeResolution.CLIPath) {
		// cursor-agent and opencode have the same "CLI is the adapter" shape as
		// Codex (invoked as `<binary> acp`), so they get the same real
		// initialize handshake instead of only checking the process didn't
		// exit.
		result = s.probeStandardACPHandshake(ctx, result, command, env)
	} else {
		result = s.probeCommandWithReadyAfter(ctx, result, command, env, s.probeReadyAfterForSpec(spec))
	}
	if result.Status == ProbeReady {
		s.AdapterProbeCache.markReady(
			adapterProbeCacheKey(spec, runtimeResolution),
			result.BinaryPath,
		)
	}
	if isCodexStatusSpec(spec) && result.Status == ProbeFailed {
		if code, ok := classifyCodexRuntimeError(result.Message); ok {
			result.LastError = &ProviderLastError{Code: string(code), Message: result.Message}
			result.ReasonCode = codexReasonCodeFromErrorCode(string(code))
		}
	}
	return result
}

// sameResolvedBinary reports whether two resolved binary paths point at the
// same on-disk binary. Empty paths never match: an unresolved binary must not
// be treated as "same as" another unresolved one.
func sameResolvedBinary(a string, b string) bool {
	a = strings.TrimSpace(a)
	b = strings.TrimSpace(b)
	return a != "" && a == b
}

func adapterProbeCacheKey(spec ProviderSpec, runtimeResolution providerRuntimeResolution) string {
	command := runtimeResolution.AdapterCommand
	if len(command) == 0 {
		command = spec.AdapterCommand
	}
	return spec.Provider + "\x00" + strings.Join(command, "\x00")
}
