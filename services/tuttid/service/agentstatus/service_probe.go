package agentstatus

import (
	"context"
)

func (s Service) Probe(ctx context.Context, input ProbeInput) (ProbeResult, error) {
	now := s.now()
	specs, err := s.selectProviderSpecs(ctx, []string{input.Provider}, true)
	if err != nil {
		return ProbeResult{}, err
	}
	spec := specs[0]
	if result, ok := unsupportedProviderProbeResult(spec, now); ok {
		return result, nil
	}
	runtimeResolution := s.resolveProviderRuntime(ctx, spec)
	status := s.statusForSpec(ctx, spec, now, statusDetectionOptions{
		forceRefresh:     true,
		skipAdapterProbe: true,
	})
	result := ProbeResult{
		Provider:   spec.Provider,
		CheckedAt:  now,
		BinaryPath: status.Adapter.BinaryPath,
		Command:    cloneStrings(spec.AdapterCommand),
		Checks:     cloneProviderChecks(status.Checks),
		LastError:  cloneProviderLastError(status.LastError),
	}
	if !status.CLI.Installed {
		result.Status = ProbeFailed
		result.ReasonCode = "cli_not_found"
		result.Message = "CLI binary not found"
		return result, nil
	}
	if !status.Adapter.Installed {
		if status.Availability.ReasonCode == "acp_adapter_launch_failed" {
			return s.probeAdapterRuntimeCommand(ctx, spec, runtimeResolution, now), nil
		}
		result.Status = ProbeFailed
		result.ReasonCode = firstNonBlank(status.Availability.ReasonCode, "acp_adapter_not_found")
		result.Message = agentProviderProbeAdapterUnavailableMessage(result.ReasonCode)
		return result, nil
	}
	// Codex availability is established by its formal app-server handshake. Do
	// not let a preliminary structural diagnostic (or a version floor) return
	// before we collect that primary runtime evidence.
	if isCodexStatusSpec(spec) {
		probed := s.probeAdapterRuntimeCommand(ctx, spec, runtimeResolution, now)
		assessment := s.assessCodexRuntime(spec, runtimeResolution.CLIPath, probed, true, false)
		if probed.Status == ProbeFailed && assessment.RepairPlan.Allowed {
			probed.ReasonCode = assessment.RepairPlan.ReasonCode
			probed.LastError = &ProviderLastError{Code: string(CodexErrPlatformPkgIncomplete), Message: probed.Message}
		}
		return probed, nil
	}
	if !providerCLIVersionMeetsMinimum(spec, status.CLI.Version) {
		result.Status = ProbeFailed
		result.ReasonCode = providerCLIVersionUnsupportedReasonCode(spec)
		result.Message = "CLI version is below " + spec.MinVersion
		return result, nil
	}

	probed := s.probeAdapterRuntimeCommand(ctx, spec, runtimeResolution, now)
	probed.Checks = cloneProviderChecks(status.Checks)
	return probed, nil
}
