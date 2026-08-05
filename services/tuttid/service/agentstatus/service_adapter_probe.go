package agentstatus

import (
	"context"
	"crypto/sha256"
	"fmt"
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
		Command:    cloneStrings(runtimeResolution.AdapterCommand),
	}
	command := cloneStrings(runtimeResolution.AdapterCommand)
	if len(command) == 0 {
		command = cloneStrings(spec.AdapterCommand)
	}
	if len(command) == 0 {
		command = cloneStrings(spec.BinaryNames)
	}
	if len(command) == 0 || strings.TrimSpace(command[0]) == "" {
		result.Status = ProbeSkipped
		result.ReasonCode = "probe_command_unavailable"
		result.Message = "Provider probe command is unavailable"
		return result
	}

	env := runtimeResolution.Env
	if len(env) == 0 {
		env = s.commandResolver().Env(s.adapterCommandEnv(ctx, spec))
	}
	command[0] = s.commandResolver().Resolve(command[0], env)
	if strings.TrimSpace(runtimeResolution.AdapterPath) != "" {
		command[0] = runtimeResolution.AdapterPath
	}
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
	// Codex has a real, first-party app-server JSON-RPC/stdio protocol. Unlike
	// generic adapter probes, a long-lived process alone is not readiness
	// evidence: use the runtime package's single-process initialize handshake.
	if isCodexStatusSpec(spec) {
		evidence := s.probeCodexAppServer(ctx, command, env)
		result.CommandStarted = evidence.CommandStarted
		result.ProtocolReady = evidence.ProtocolReady
		if evidence.CommandStarted {
			result.ProtocolCategory = evidence.Category
		} else {
			result.CommandCategory = evidence.Category
		}
		result.ProtocolPackageName = evidence.PlatformPackageName
		if evidence.ProtocolReady {
			result.Status = ProbeReady
			s.AdapterProbeCache.markReadyAt(
				s.adapterProbeCacheKey(ctx, spec, runtimeResolution),
				result.BinaryPath,
				now,
			)
			return result
		}
		result.Status = ProbeFailed
		result.Message = evidence.Message
		result.ReasonCode = "acp_adapter_launch_failed"
		if evidence.Category == "platform_package_enoent" {
			result.LastError = &ProviderLastError{
				Code:    string(CodexErrPlatformPkgIncomplete),
				Message: evidence.Message,
			}
			result.ReasonCode = "codex_platform_pkg_incomplete"
		}
		return result
	} else if isStandardACPStatusSpec(spec) && sameResolvedBinary(runtimeResolution.AdapterPath, runtimeResolution.CLIPath) {
		// cursor-agent and opencode have the same "CLI is the adapter" shape as
		// Codex (invoked as `<binary> acp`), so they get the same real
		// initialize handshake instead of only checking the process didn't
		// exit.
		result = s.probeStandardACPHandshake(ctx, result, command, env, s.probeTimeoutForSpec(spec))
	} else {
		result = s.probeCommandWithReadyAfter(ctx, result, command, env, s.probeReadyAfterForSpec(spec))
	}
	if result.Status == ProbeReady {
		s.AdapterProbeCache.markReady(
			s.adapterProbeCacheKey(ctx, spec, runtimeResolution),
			result.BinaryPath,
		)
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

func (s Service) adapterProbeCacheKey(
	ctx context.Context,
	spec ProviderSpec,
	runtimeResolution providerRuntimeResolution,
) string {
	command := runtimeResolution.AdapterCommand
	if len(command) == 0 {
		command = spec.AdapterCommand
	}
	// Hash the effective command environment rather than retaining it in the
	// cache key. A PATH or other launch-environment change must not reuse a
	// previously successful app-server handshake.
	env := s.commandResolver().Env(s.adapterCommandEnv(ctx, spec))
	sum := sha256.Sum256([]byte(strings.Join(env, "\x00")))
	return spec.Provider + "\x00" + strings.Join(command, "\x00") + "\x00" + fmt.Sprintf("%x", sum[:])
}
