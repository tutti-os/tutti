package agentstatus

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"golang.org/x/sync/errgroup"
)

// statusForSpec computes one provider's detection snapshot. It is safe to call
// concurrently for different specs: it only reads Service configuration, and
// the shared stores it touches (RunOutcomes, the active-action table) are
// internally synchronized.
func (s Service) statusForSpec(ctx context.Context, spec ProviderSpec, now time.Time) (status ProviderStatus) {
	startedAt := time.Now()
	var runtimeResolutionDuration time.Duration
	var adapterProbeDuration time.Duration
	var authDuration time.Duration
	var cliVersionDuration time.Duration
	var postChecksDuration time.Duration
	adapterProbeRan := false
	cliVersionRan := false
	unsupported := false
	defer func() {
		slog.Info(
			"agent provider status detection completed",
			"event", "tutti.agent_provider.status_detection.completed",
			"provider", spec.Provider,
			"availability", status.Availability.Status,
			"reasonCode", status.Availability.ReasonCode,
			"durationMs", time.Since(startedAt).Milliseconds(),
			"runtimeResolutionMs", runtimeResolutionDuration.Milliseconds(),
			"adapterProbeRan", adapterProbeRan,
			"adapterProbeMs", adapterProbeDuration.Milliseconds(),
			"authMs", authDuration.Milliseconds(),
			"cliVersionRan", cliVersionRan,
			"cliVersionMs", cliVersionDuration.Milliseconds(),
			"postChecksMs", postChecksDuration.Milliseconds(),
			"unsupported", unsupported,
		)
	}()

	if unsupportedStatus, ok := unsupportedProviderStatus(spec, now); ok {
		unsupported = true
		return unsupportedStatus
	}
	runtimeResolutionStartedAt := time.Now()
	runtimeResolution := s.resolveProviderRuntime(ctx, spec)
	runtimeResolutionDuration = time.Since(runtimeResolutionStartedAt)
	installed := strings.TrimSpace(runtimeResolution.CLIPath) != ""
	adapterInstalled := strings.TrimSpace(runtimeResolution.AdapterPath) != ""
	adapterReady := adapterInstalled && adapterPackageRequirementSatisfied(spec.AdapterPackage, runtimeResolution.AdapterVersion)
	adapterLaunchFailed := false

	// The adapter launch probe, the auth status command, and `--version` are
	// independent and each can spawn a short-lived subprocess, so run them
	// concurrently: the per-provider cost becomes the slowest step instead of
	// the sum. Each goroutine writes distinct variables read only after Wait.
	var auth AuthInfo
	cliVersion := ""
	var checks errgroup.Group
	if installed && adapterReady && s.shouldProbeAdapterCommandForStatus(spec, runtimeResolution) {
		adapterProbeRan = true
		checks.Go(func() error {
			probeStartedAt := time.Now()
			if probe := s.probeAdapterRuntimeCommand(ctx, spec, runtimeResolution, now); probe.Status == ProbeFailed {
				adapterReady = false
				adapterLaunchFailed = true
			}
			adapterProbeDuration = time.Since(probeStartedAt)
			return nil
		})
	}
	checks.Go(func() error {
		authStartedAt := time.Now()
		auth = s.resolveAuth(ctx, spec, installed, runtimeResolution.CLIPath)
		authDuration = time.Since(authStartedAt)
		return nil
	})
	if installed {
		cliVersionRan = true
		checks.Go(func() error {
			cliVersionStartedAt := time.Now()
			cliVersion = s.cliVersion(ctx, runtimeResolution.CLIPath, runtimeResolution.Env)
			cliVersionDuration = time.Since(cliVersionStartedAt)
			return nil
		})
	}
	_ = checks.Wait()
	postChecksStartedAt := time.Now()

	codexPlatformOK := true
	if isCodexStatusSpec(spec) && installed {
		codexPlatformOK = s.codexPlatformBinaryOK(runtimeResolution.CLIPath)
	}
	availability := Availability{
		CheckedAt: &now,
		Status:    AvailabilityReady,
	}
	actions := []Action{}

	if !installed {
		availability.Status = AvailabilityNotInstalled
		availability.ReasonCode = "cli_not_found"
		actions = append(actions, daemonAction(ActionInstall))
	} else if !adapterInstalled {
		availability.Status = AvailabilityNotInstalled
		availability.ReasonCode = firstNonBlank(runtimeResolution.ReasonCode, spec.AdapterUnavailableReasonCode, "acp_adapter_not_found")
		actions = append(actions, daemonAction(ActionInstall))
	} else if adapterLaunchFailed {
		availability.Status = AvailabilityNotInstalled
		availability.ReasonCode = "acp_adapter_launch_failed"
		actions = append(actions, daemonAction(ActionInstall))
	} else if !adapterReady {
		availability.Status = AvailabilityNotInstalled
		availability.ReasonCode = "acp_adapter_version_mismatch"
		actions = append(actions, daemonAction(ActionInstall))
	} else if isCodexStatusSpec(spec) && !codexPlatformOK {
		availability.Status = AvailabilityNotInstalled
		availability.ReasonCode = codexReasonCodeFromErrorCode(string(CodexErrPlatformPkgIncomplete))
		actions = append(actions, daemonAction(ActionInstall))
	} else if isCodexStatusSpec(spec) && !cliVersionMeetsMinimum(cliVersion, spec.MinVersion) {
		availability.Status = AvailabilityNotInstalled
		availability.ReasonCode = codexReasonCodeFromErrorCode(string(CodexErrVersionTooOld))
		actions = append(actions, daemonAction(ActionInstall))
	} else {
		if spec.LoginActionKind == ActionKindDaemonAction {
			actions = append(actions, daemonAction(ActionLogin))
		} else {
			actions = append(actions, terminalAction(ActionLogin, loginCommandForRuntime(spec, runtimeResolution)))
		}

		// Claude Code can run in API Usage Billing mode — an API key, an auth
		// token, or an apiKeyHelper — which bills usage to an API account and
		// overrides any stored OAuth/subscription session. `claude auth status`
		// only reflects the stored session, so it is blind to these env/settings
		// credentials; detect them directly and prefer that signal over whatever
		// the CLI reports, so the wizard shows "已配置 API 计费" instead of a
		// stale OAuth label or "未登录". A bare custom endpoint without a
		// credential is NOT API billing (the user may still be on an OAuth
		// session), so it does not trigger this override.
		if isClaudeStatusSpec(spec) && s.providerHasAPICredential(spec.Provider) {
			auth.Status = AuthAuthenticated
			auth.AccountLabel = "API Usage Billing"
			auth.AuthMethod = "apiKey"
		} else {
			switch auth.Status {
			case AuthAuthenticated:
				// already ready
			case AuthRequired:
				availability.Status = AvailabilityAuthRequired
				availability.ReasonCode = "auth_required"
				actions = append(actions, Action{ID: ActionRefresh, Kind: ActionKindRefresh})
			case AuthUnknown:
				availability.Status = AvailabilityAuthRequired
				availability.ReasonCode = "auth_unknown"
				actions = append(actions, Action{ID: ActionRefresh, Kind: ActionKindRefresh})
			}
		}
	}

	status = ProviderStatus{
		Provider:     spec.Provider,
		Availability: availability,
		CLI: CLIStatus{
			Installed:  installed,
			BinaryPath: runtimeResolution.CLIPath,
			Version:    cliVersion,
		},
		Adapter: AdapterStatus{
			Installed:       adapterReady,
			BinaryPath:      runtimeResolution.AdapterPath,
			Command:         cloneStrings(runtimeResolution.AdapterCommand),
			Version:         runtimeResolution.AdapterVersion,
			RequiredVersion: spec.AdapterPackage.Version,
		},
		Auth:    auth,
		Actions: actions,
	}
	status.ActiveAction = activeActionForProvider(spec.Provider)
	if status.ActiveAction != nil {
		bytes, lines := activeActionOutputStats(status.ActiveAction.Stdout)
		slog.Info(
			"agent provider status attached active action",
			"event", "tutti.agent_provider.status.active_action_attached",
			"provider", spec.Provider,
			"availability", status.Availability.Status,
			"reasonCode", status.Availability.ReasonCode,
			"step", status.ActiveAction.Step,
			"registryPresent", strings.TrimSpace(status.ActiveAction.Registry) != "",
			"stdoutBytes", bytes,
			"stdoutLines", lines,
		)
	}
	if isClaudeStatusSpec(spec) {
		slog.Info(
			"claude-code agent provider status checked",
			"event", "tutti.agent_provider.status.checked",
			"provider", spec.Provider,
			"availability", status.Availability.Status,
			"reasonCode", status.Availability.ReasonCode,
			"authStatus", status.Auth.Status,
			"authMethod", status.Auth.AuthMethod,
			"cliInstalled", status.CLI.Installed,
			"cliVersion", status.CLI.Version,
			"sdkSidecarInstalled", status.Adapter.Installed,
		)
	}
	if isCodexStatusSpec(spec) {
		status.CLI.MinVersion = spec.MinVersion
		status.Checks = codexProviderChecks(status, codexPlatformOK, s.codexNodeRuntimeCheck(spec))
		status.LastError = codexProviderLastError(status)
		slog.Info(
			"codex agent provider status checked",
			"availability", status.Availability.Status,
			"reasonCode", status.Availability.ReasonCode,
			"version", status.CLI.Version,
			"lastErrorCode", providerLastErrorCode(status.LastError),
			"missingPlatformPath", s.codexPlatformPackageMissingPath(runtimeResolution.CLIPath),
		)
	}
	postChecksDuration = time.Since(postChecksStartedAt)
	return status
}

func (s Service) shouldProbeAdapterCommandForStatus(spec ProviderSpec, runtimeResolution providerRuntimeResolution) bool {
	if strings.TrimSpace(spec.ExternalRegistryID) != "" {
		return true
	}
	return isCodexStatusSpec(spec) && s.executableFile(runtimeResolution.AdapterPath)
}

func (s Service) probeReadyAfterForSpec(spec ProviderSpec) time.Duration {
	if strings.TrimSpace(spec.ExternalRegistryID) != "" && spec.AdapterInstall.RegistryNPM != nil {
		return externalRegistryNPMProbeReadyAfter(s.probeTimeout())
	}
	return s.probeReadyAfter()
}

func agentNPMRegistryProbePackage(spec ProviderSpec) string {
	if strings.TrimSpace(spec.NPMRegistryPackage) != "" {
		return strings.TrimSpace(spec.NPMRegistryPackage)
	}
	if spec.AdapterInstall.RegistryNPM != nil {
		packageName, _ := splitNPMPackageSpec(spec.AdapterInstall.RegistryNPM.Package)
		if strings.TrimSpace(packageName) != "" {
			return packageName
		}
	}
	if spec.Install.RegistryNPM != nil {
		packageName, _ := splitNPMPackageSpec(spec.Install.RegistryNPM.Package)
		if strings.TrimSpace(packageName) != "" {
			return packageName
		}
	}
	return "@openai/codex"
}

func externalRegistryNPMProbeReadyAfter(timeout time.Duration) time.Duration {
	if timeout <= 0 {
		timeout = defaultProbeTimeout
	}
	if timeout <= 200*time.Millisecond {
		return timeout / 2
	}
	return timeout - externalRegistryNPMProbeTimeoutPadding
}

func agentProviderProbeAdapterUnavailableMessage(reasonCode string) string {
	switch strings.TrimSpace(reasonCode) {
	case "acp_adapter_version_mismatch":
		return "ACP adapter version does not match the required package version"
	case "acp_adapter_launch_failed":
		return "ACP adapter command failed to start"
	case ReasonExternalAgentRegistryUnavailable:
		return "ACP external agent registry is unavailable"
	case ReasonManagedRuntimeUnavailable:
		return "Managed Node runtime is unavailable"
	case ReasonClaudeSDKSidecarUnavailable:
		return "Claude SDK sidecar not found"
	default:
		return "ACP adapter not found"
	}
}
