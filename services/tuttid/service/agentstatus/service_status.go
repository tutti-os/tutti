package agentstatus

import (
	"context"
	"log/slog"
	"path/filepath"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerstatus"
	"golang.org/x/sync/errgroup"
)

const statusDetectionTimeout = 45 * time.Second

// statusForSpec computes one provider's detection snapshot. It is safe to call
// concurrently for different specs: it only reads Service configuration, and
// the shared stores it touches (RunOutcomes, the active-action table) are
// internally synchronized.
type statusDetectionOptions struct {
	forceRefresh     bool
	skipAdapterProbe bool
}

func (s Service) statusForSpec(
	ctx context.Context,
	spec ProviderSpec,
	now time.Time,
	options statusDetectionOptions,
) (status ProviderStatus) {
	startedAt := time.Now()
	detectionCtx, cancel := context.WithTimeout(baseContext(ctx), statusDetectionTimeout)
	defer cancel()
	var runtimeResolutionDuration time.Duration
	var adapterProbeDuration time.Duration
	var authDuration time.Duration
	var remoteAuthDuration time.Duration
	var cliVersionDuration time.Duration
	var postChecksDuration time.Duration
	adapterProbeRan := false
	adapterProbeCacheHit := false
	adapterProbeCacheAge := time.Duration(0)
	remoteAuthProbeRan := false
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
			"adapterProbeCacheHit", adapterProbeCacheHit,
			"adapterProbeCacheAgeMs", adapterProbeCacheAge.Milliseconds(),
			"adapterProbeMs", adapterProbeDuration.Milliseconds(),
			"authMs", authDuration.Milliseconds(),
			"remoteAuthProbeRan", remoteAuthProbeRan,
			"remoteAuthMs", remoteAuthDuration.Milliseconds(),
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
	runtimeResolution := s.resolveProviderRuntime(detectionCtx, spec)
	runtimeResolutionDuration = time.Since(runtimeResolutionStartedAt)
	if isCodexStatusSpec(spec) && codexRuntimeSelectionNeedsUserInput(runtimeResolution) {
		return ProviderStatus{
			Provider: spec.Provider,
			Availability: Availability{
				CheckedAt:  &now,
				ReasonCode: runtimeResolution.ReasonCode,
				Status:     AvailabilityUnknown,
			},
			CLI: CLIStatus{
				Installed:  strings.TrimSpace(runtimeResolution.CLIPath) != "",
				BinaryPath: runtimeResolution.CLIPath,
				MinVersion: spec.MinVersion,
			},
			Adapter: AdapterStatus{
				BinaryPath: runtimeResolution.AdapterPath,
				Command:    cloneStrings(runtimeResolution.AdapterCommand),
			},
		}
	}
	installed := strings.TrimSpace(runtimeResolution.CLIPath) != ""
	adapterInstalled := strings.TrimSpace(runtimeResolution.AdapterPath) != ""
	adapterReady := adapterInstalled && adapterPackageRequirementSatisfied(spec.AdapterPackage, runtimeResolution.AdapterVersion)
	adapterLaunchFailed := false

	// The adapter launch probe, the auth status command, and `--version` are
	// independent and each can spawn a short-lived subprocess, so run them
	// concurrently: the per-provider cost becomes the slowest step instead of
	// the sum. Each goroutine writes distinct variables read only after Wait.
	var auth AuthInfo
	authCLIVersion := ""
	authEvidenceAuthority := providerstatus.AuthEvidenceAuthorityNone
	var remoteAuthEvidence providerstatus.AuthEvidence
	remoteAuthEvidencePresent := false
	cliVersion := ""
	reuseCursorAboutVersion := installed && isCursorAuthCommandSpec(spec) && s.RunAuthStatusCommand == nil
	var checks errgroup.Group
	// adapterProbe captures the full probe result so availability can surface a
	// probe-classified failure reason, rather than only a boolean result.
	var adapterProbe ProbeResult
	hasAPICredential := (isCodexStatusSpec(spec) || isClaudeStatusSpec(spec) || isOpenCodeStatusSpec(spec)) &&
		s.providerHasAPICredential(spec.Provider)
	if installed && adapterReady && !options.skipAdapterProbe &&
		s.shouldProbeAdapterCommandForStatus(spec, runtimeResolution) {
		probeCacheKey := s.adapterProbeCacheKey(detectionCtx, spec, runtimeResolution)
		if !options.forceRefresh &&
			s.AdapterProbeCache.readyWithin(probeCacheKey, runtimeResolution.AdapterPath, now, s.providerStatusCacheTTL()) {
			adapterProbeCacheHit = true
			adapterProbeCacheAge, _ = s.AdapterProbeCache.age(probeCacheKey, runtimeResolution.AdapterPath, now)
		} else {
			adapterProbeRan = true
			checks.Go(func() error {
				probeStartedAt := time.Now()
				adapterProbe = s.probeAdapterRuntimeCommand(detectionCtx, spec, runtimeResolution, now)
				if adapterProbe.Status == ProbeFailed {
					adapterReady = false
					adapterLaunchFailed = true
				}
				adapterProbeDuration = time.Since(probeStartedAt)
				return nil
			})
		}
	}
	checks.Go(func() error {
		authStartedAt := time.Now()
		auth, authCLIVersion, authEvidenceAuthority = s.resolveAuthAndCLIVersion(detectionCtx, spec, installed, runtimeResolution.CLIPath)
		authDuration = time.Since(authStartedAt)
		return nil
	})
	if installed && !hasAPICredential && spec.RemoteAuthProbe.Kind != "" {
		remoteAuthProbeRan = true
		checks.Go(func() error {
			remoteStartedAt := time.Now()
			remoteAuthEvidence, remoteAuthEvidencePresent = s.resolveRemoteAuthEvidence(
				detectionCtx,
				spec,
				runtimeResolution.CLIPath,
				runtimeResolution.Env,
			)
			remoteAuthDuration = time.Since(remoteStartedAt)
			return nil
		})
	}
	if installed && !reuseCursorAboutVersion {
		cliVersionRan = true
		checks.Go(func() error {
			cliVersionStartedAt := time.Now()
			cliVersion = s.providerCLIVersion(detectionCtx, spec, runtimeResolution.CLIPath, runtimeResolution.Env)
			cliVersionDuration = time.Since(cliVersionStartedAt)
			return nil
		})
	}
	_ = checks.Wait()
	if reuseCursorAboutVersion {
		cliVersion = authCLIVersion
		if cliVersion == "" {
			cliVersionRan = true
			cliVersionStartedAt := time.Now()
			cliVersion = s.cliVersion(detectionCtx, runtimeResolution.CLIPath, runtimeResolution.Env)
			cliVersionDuration = time.Since(cliVersionStartedAt)
		}
	}
	postChecksStartedAt := time.Now()

	availability := Availability{
		CheckedAt: &now,
		Status:    AvailabilityReady,
	}
	actions := []Action{}
	cliBelowFloor := installed && !providerCLIVersionMeetsMinimum(spec, cliVersion)
	// Codex, Claude Code, and OpenCode can run in API Usage Billing mode. Their
	// auth status commands report stored sessions and may not reflect an API key,
	// auth token, apiKeyHelper, or OpenCode provider apiKey. Configuration is
	// launchable, but it is not provider-backed authentication evidence.
	if hasAPICredential {
		auth.Status = AuthAuthenticated
		auth.AccountLabel = "API Usage Billing"
		auth.AuthMethod = "apiKey"
	}
	auth = s.reduceProviderAuthWithRemote(
		spec,
		auth,
		hasAPICredential,
		authEvidenceAuthority,
		remoteAuthEvidence,
		remoteAuthEvidencePresent,
	)

	if !installed {
		availability.Status = AvailabilityNotInstalled
		availability.ReasonCode = firstNonBlank(runtimeResolution.ReasonCode, "cli_not_found")
		actions = append(actions, daemonAction(ActionInstall))
	} else if !isCodexStatusSpec(spec) && cliBelowFloor {
		// Descriptor-owned version floors are a CLI capability gate. Surface
		// that repair before any downstream adapter failure so callers retain
		// the current/minimum version evidence and run the CLI installer first.
		availability.Status = AvailabilityNotInstalled
		availability.ReasonCode = providerCLIVersionUnsupportedReasonCode(spec)
		actions = append(actions, daemonAction(ActionInstall))
	} else if !adapterInstalled {
		availability.Status = AvailabilityNotInstalled
		availability.ReasonCode = firstNonBlank(runtimeResolution.ReasonCode, spec.AdapterUnavailableReasonCode, "acp_adapter_not_found")
		actions = append(actions, daemonAction(ActionInstall))
	} else if adapterLaunchFailed {
		if installed && adapterInstalled {
			// The CLI and adapter are present, but the runtime probe failed. This
			// is normally a transient provider/runtime problem (for example an
			// orphaned Windows child holding OpenCode's database), not an install
			// problem. Do not send the UI into an install loop.
			availability.Status = AvailabilityUnknown
			availability.ReasonCode = adapterLaunchFailureReasonCode(adapterProbe)
			actions = append(actions, Action{ID: ActionRefresh, Kind: ActionKindRefresh})
		} else {
			availability.Status = AvailabilityNotInstalled
			// When the adapter probe classified its failure (e.g. a Codex launch
			// failed because the @openai/codex-<platform> subpackage was missing,
			// reported as an ENOENT), surface that precise reason code instead of
			// the generic launch-failed label. Unclassified failures — including
			// all non-codex providers and any error the probe did not match — keep
			// the generic code, preserving prior behavior.
			availability.ReasonCode = adapterLaunchFailureReasonCode(adapterProbe)
			actions = append(actions, daemonAction(ActionInstall))
		}
	} else if !adapterReady {
		availability.Status = AvailabilityNotInstalled
		availability.ReasonCode = "acp_adapter_version_mismatch"
		actions = append(actions, daemonAction(ActionInstall))
	} else if cliBelowFloor {
		availability.Status = AvailabilityNotInstalled
		availability.ReasonCode = providerCLIVersionUnsupportedReasonCode(spec)
		actions = append(actions, daemonAction(ActionInstall))
	} else {
		if spec.LoginActionKind == ActionKindDaemonAction {
			actions = append(actions, daemonAction(ActionLogin))
		} else {
			actions = append(actions, terminalAction(ActionLogin, loginCommandForRuntime(spec, runtimeResolution)))
		}

		switch auth.Status {
		case AuthAuthenticated, AuthConfigured:
			// Configured credentials are launchable but remain distinct from a
			// provider-backed authenticated request.
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

	status = ProviderStatus{
		Provider:     spec.Provider,
		Availability: availability,
		CLI: CLIStatus{
			Installed:  installed,
			BinaryPath: runtimeResolution.CLIPath,
			Version:    cliVersion,
			MinVersion: spec.MinVersion,
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
			"resolvedCLIPath", status.CLI.BinaryPath,
			"cliVersion", status.CLI.Version,
			"resolvedAdapterPath", status.Adapter.BinaryPath,
			"sdkSidecarInstalled", status.Adapter.Installed,
		)
	}
	if isCodexStatusSpec(spec) && status.CLI.Installed && adapterInstalled {
		assessment := s.assessCodexRuntime(spec, runtimeResolution.CLIPath, adapterProbe, adapterProbeRan, adapterProbeCacheHit)
		switch {
		case assessment.RuntimeReady &&
			(status.Auth.Status == AuthAuthenticated || status.Auth.Status == AuthConfigured) &&
			!cliBelowFloor:
			status.Availability = Availability{Status: AvailabilityReady, CheckedAt: &now}
			status.Actions = []Action{terminalAction(ActionLogin, loginCommandForRuntime(spec, runtimeResolution))}
		case assessment.RuntimeReady && cliBelowFloor:
			status.Availability = Availability{Status: AvailabilityUnsupported, ReasonCode: "codex_version_unsupported", CheckedAt: &now}
			status.Actions = []Action{daemonAction(ActionUpdate)}
		case assessment.RuntimeReady:
			reason := "auth_required"
			if status.Auth.Status == AuthUnknown {
				reason = "auth_unknown"
			}
			status.Availability = Availability{Status: AvailabilityAuthRequired, ReasonCode: reason, CheckedAt: &now}
			status.Actions = []Action{terminalAction(ActionLogin, loginCommandForRuntime(spec, runtimeResolution)), {ID: ActionRefresh, Kind: ActionKindRefresh}}
		case assessment.ReasonCode == "app_server_unsupported":
			status.Availability = Availability{Status: AvailabilityUnsupported, ReasonCode: assessment.ReasonCode, CheckedAt: &now}
			status.Actions = []Action{daemonAction(ActionUpdate)}
		default:
			status.Availability = Availability{Status: AvailabilityNotInstalled, ReasonCode: assessment.ReasonCode, CheckedAt: &now}
			if assessment.RepairPlan.Allowed {
				status.Actions = []Action{daemonAction(ActionInstall)}
			} else {
				status.Actions = []Action{{ID: ActionRefresh, Kind: ActionKindRefresh}}
			}
		}
		status.LastError = codexProviderLastError(status)
		resolvedRealPath := runtimeResolution.CLIPath
		if realPath, err := filepath.EvalSymlinks(runtimeResolution.CLIPath); err == nil {
			resolvedRealPath = realPath
		}
		slog.Info(
			"codex agent provider status checked",
			"provider", spec.Provider,
			"availability", status.Availability.Status,
			"reasonCode", status.Availability.ReasonCode,
			"resolvedCLIPath", runtimeResolution.CLIPath,
			"resolvedRealPath", resolvedRealPath,
			"version", status.CLI.Version,
			"lastErrorCode", providerLastErrorCode(status.LastError),
			"runtimeVerified", assessment.RuntimeReady,
			"commandProbeResult", adapterProbe.CommandCategory,
			"protocolProbeResult", adapterProbe.ProtocolCategory,
			"probeCacheHit", adapterProbeCacheHit,
			"probeCacheAgeMs", adapterProbeCacheAge.Milliseconds(),
			"repairAllowed", assessment.RepairPlan.Allowed,
			"repairReason", assessment.RepairPlan.ReasonCode,
		)
	}
	postChecksDuration = time.Since(postChecksStartedAt)
	return status
}

func providerCLIVersionUnsupportedReasonCode(spec ProviderSpec) string {
	if isCodexStatusSpec(spec) {
		return codexReasonCodeFromErrorCode(string(CodexErrVersionTooOld))
	}
	return "cli_version_unsupported"
}

func (s Service) shouldProbeAdapterCommandForStatus(spec ProviderSpec, runtimeResolution providerRuntimeResolution) bool {
	if strings.TrimSpace(spec.ExternalRegistryID) != "" {
		return true
	}
	if isCodexStatusSpec(spec) {
		// The resolver can return a symlinked launcher whose target is executable
		// even when a shallow stat hook cannot prove it. Codex command capability is
		// determined by the real protocol probe, not a pre-flight file-mode guess.
		return strings.TrimSpace(runtimeResolution.AdapterPath) != ""
	}
	if isStandardACPStatusSpec(spec) && sameResolvedBinary(runtimeResolution.AdapterPath, runtimeResolution.CLIPath) {
		return s.executableFile(runtimeResolution.AdapterPath)
	}
	return false
}

// adapterLaunchFailureReasonCode surfaces a probe-classified failure reason
// when the adapter probe identified a specific provider error (e.g. a Codex
// launch failed because the @openai/codex-<platform> subpackage was missing,
// classified from an ENOENT message), and otherwise falls back to the generic
// adapter-launch-failed code. The probe sets LastError only when it matched a
// known error pattern, so unclassified failures and all non-codex providers
// are unaffected.
func adapterLaunchFailureReasonCode(probe ProbeResult) string {
	if probe.LastError != nil && strings.TrimSpace(probe.ReasonCode) != "" {
		return probe.ReasonCode
	}
	return "acp_adapter_launch_failed"
}

func (s Service) probeReadyAfterForSpec(spec ProviderSpec) time.Duration {
	if strings.TrimSpace(spec.ExternalRegistryID) != "" && spec.AdapterInstall.RegistryNPM != nil {
		return externalRegistryNPMProbeReadyAfter(s.probeTimeout())
	}
	return s.probeReadyAfter()
}

// Standard ACP CLIs may need to initialize their config, plugin registry, and
// model catalog before they can answer the first JSON-RPC request. The generic
// three-second probe is enough for most providers but is too aggressive for
// Windows npm shims such as OpenCode and Cursor Agent. Cursor's PowerShell +
// Node launcher can take more than twenty seconds on a cold start, so give it
// a larger but still bounded probe window; this turns a false "stuck" status
// into the real auth/runtime state.
func (s Service) probeTimeoutForSpec(spec ProviderSpec) time.Duration {
	timeout := s.probeTimeout()
	if strings.EqualFold(strings.TrimSpace(spec.Provider), "cursor") && timeout < 35*time.Second {
		return 35 * time.Second
	}
	if isStandardACPStatusSpec(spec) && timeout < 15*time.Second {
		return 15 * time.Second
	}
	return timeout
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
