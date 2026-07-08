package agentstatus

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	externalagentregistry "github.com/tutti-os/tutti/services/tuttid/service/externalagentregistry"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
)

type AvailabilityStatus string

const (
	AvailabilityReady        AvailabilityStatus = "ready"
	AvailabilityNotInstalled AvailabilityStatus = "not_installed"
	AvailabilityAuthRequired AvailabilityStatus = "auth_required"
	AvailabilityUnsupported  AvailabilityStatus = "unsupported"
	AvailabilityUnknown      AvailabilityStatus = "unknown"
)

type AuthStatus string

const (
	AuthAuthenticated AuthStatus = "authenticated"
	AuthRequired      AuthStatus = "required"
	AuthUnknown       AuthStatus = "unknown"
)

type ActionKind string

const (
	ActionKindDaemonAction    ActionKind = "daemon_action"
	ActionKindTerminalCommand ActionKind = "terminal_command"
	ActionKindRefresh         ActionKind = "refresh"
)

type ActionID string

const (
	ActionInstall ActionID = "install"
	ActionLogin   ActionID = "login"
	ActionRefresh ActionID = "refresh"
)

type ProbeStatus string

const (
	ProbeReady   ProbeStatus = "ready"
	ProbeFailed  ProbeStatus = "failed"
	ProbeSkipped ProbeStatus = "skipped"
)

type RunActionStatus string

const (
	RunActionCompleted RunActionStatus = "completed"
	RunActionFailed    RunActionStatus = "failed"
)

type ListInput struct {
	Providers []string
	// IncludeNetwork opts into the network connectivity probe (registry / provider
	// API / proxy reachability). It is OFF by default so the common detection path
	// — the dock, startup, polling, provider-availability — stays purely local and
	// never blocks on the network. Only the agent-env wizard, which renders the
	// network diagnostic, sets this.
	IncludeNetwork bool
}

type ProbeInput struct {
	Provider string
}

type RunActionInput struct {
	Provider string
	ActionID ActionID
}

type Snapshot struct {
	CapturedAt time.Time
	Providers  []ProviderStatus
}

type ProbeResult struct {
	Provider   string
	Status     ProbeStatus
	CheckedAt  time.Time
	ReasonCode string
	Message    string
	BinaryPath string
	Command    []string
	Checks     []ProviderCheck
	LastError  *ProviderLastError
}

type RunActionResult struct {
	Provider    string
	ActionID    ActionID
	Status      RunActionStatus
	CompletedAt time.Time
	ReasonCode  string
	Message     string
	Command     string
	ExitCode    *int
	Stdout      string
	Stderr      string
	Probe       *ProbeResult
}

type ProviderStatus struct {
	Provider     string
	Availability Availability
	CLI          CLIStatus
	Adapter      AdapterStatus
	Auth         AuthInfo
	Actions      []Action
	Network      *NetworkStatus
	Checks       []ProviderCheck
	LastError    *ProviderLastError
	ActiveAction *ActiveAction
}

type ProviderCheck struct {
	Name   string
	Passed bool
	Detail string
}

type ProviderLastError struct {
	Code    string
	Message string
}

type ActiveAction struct {
	ID         ActionID
	Status     string
	Step       string
	Registry   string
	NodeTarget string
	Stdout     string
}

type Availability struct {
	Status     AvailabilityStatus
	ReasonCode string
	CheckedAt  *time.Time
}

type CLIStatus struct {
	Installed  bool
	BinaryPath string
	Version    string
	// MinVersion is the lowest CLI version this provider supports, when it
	// enforces a floor (codex). Empty for providers with no version gate. Lets
	// the UI surface "current X, requires Y" from the same constant the gate uses.
	MinVersion string
}

type AdapterStatus struct {
	Installed  bool
	BinaryPath string
	Command    []string
	// Version is the installed adapter package version (when resolvable);
	// RequiredVersion is the version this provider requires. Exposed so the UI
	// can show "current X, requires Y" on an adapter version mismatch and so
	// telemetry can surface the drift — the same data the readiness gate uses.
	Version         string
	RequiredVersion string
}

type AuthInfo struct {
	Status       AuthStatus
	AccountLabel string
	AuthMethod   string
}

type Action struct {
	ID      ActionID
	Kind    ActionKind
	Command *TerminalCommand
}

type TerminalCommand struct {
	Input string
	CWD   string
}

type InstallCommandInput struct {
	Command  string
	CWD      string
	Env      []string
	OnStdout func(string)
}

type InstallCommandResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

type Service struct {
	Environ                     func() []string
	FileExists                  func(string) bool
	FileModTime                 func(string) (time.Time, bool)
	HomeDir                     func() (string, error)
	HTTPClient                  *http.Client
	ResolveProxy                func(*http.Request) (*url.URL, error)
	LookPath                    func(string) (string, error)
	InstallCommand              func(context.Context, InstallCommandInput) (InstallCommandResult, error)
	InstallTimeout              time.Duration
	RunAuthStatusCommand        func(context.Context, ProviderSpec, string) (AuthInfo, bool)
	AuthStatusCommandRetryDelay time.Duration
	IsExecutableFile            func(string) bool
	Now                         func() time.Time
	ProbeReadyAfter             time.Duration
	ProbeTimeout                time.Duration
	Registry                    Registry
	ExternalAgentRegistry       externalagentregistry.Store
	ManagedRuntime              managedruntime.Resolver
	AnalyticsReporter           reporterservice.Reporter
	// RunOutcomes lets a runtime auth failure override a stale "logged in" marker
	// so the dock/wizard surface that login dropped. Shared pointer across copies.
	RunOutcomes *RunOutcomeStore
}

const authStatusCommandTimeout = 5 * time.Second
const authStatusCommandAttempts = 2
const defaultAuthStatusCommandRetryDelay = 150 * time.Millisecond

// defaultInstallTimeout caps a whole install action. It must leave room for the
// npm registry chain to fail over a few times at perRegistryInstallTimeout each
// (e.g. a slow npmjs before a fast CN mirror) without prematurely killing a
// registry that would have succeeded.
const defaultInstallTimeout = 8 * time.Minute
const defaultProbeReadyAfter = 600 * time.Millisecond
const defaultProbeTimeout = 3 * time.Second
const defaultProbeWaitDelay = 500 * time.Millisecond
const externalRegistryNPMProbeTimeoutPadding = 100 * time.Millisecond

func (s Service) List(ctx context.Context, input ListInput) (Snapshot, error) {
	now := s.now()
	specs, err := s.selectProviderSpecs(ctx, input.Providers, false)
	if err != nil {
		return Snapshot{}, err
	}

	statuses := make([]ProviderStatus, 0, len(specs))
	for _, spec := range specs {
		statuses = append(statuses, s.statusForSpec(ctx, spec, now))
	}

	// The network connectivity probe is OPT-IN (input.IncludeNetwork). The dock /
	// startup / polling / provider-availability path leaves it off so detection is
	// purely local and never blocks on a slow or black-holed network — those
	// callers only need local availability (CLI/adapter/auth), never Network. Only
	// the wizard, which renders the network diagnostic, opts in.
	//
	// Proxy detection is provider-independent, so probe it once. Registry
	// reachability is checked per provider package so the wizard displays the same
	// ranked npm source the install path will try first. The API endpoint
	// (run/login path) also differs per provider, so probe that per status. All
	// are reported separately on each provider's Network.
	//
	// Even when opted in, skip the probe for any provider that is mid-install: the
	// network doesn't change during an install, and the per-second install-progress
	// poll would otherwise re-probe it every tick, making the network step flicker.
	// Such a provider reports no Network (the UI treats nil as "not a blocker"); a
	// full re-detect after the install refreshes it. When every requested provider
	// is installing, even the shared registry/proxy probes are skipped.
	if input.IncludeNetwork && len(statuses) > 0 {
		installing := make([]bool, len(statuses))
		anyNeedsNetwork := false
		for i := range statuses {
			installing[i] = providerInstallInFlight(statuses[i].Provider)
			if !installing[i] {
				anyNeedsNetwork = true
			}
		}
		var proxy *NetworkProxyStatus
		if anyNeedsNetwork {
			proxy = s.probeProxy(ctx)
		}
		for i := range statuses {
			if installing[i] {
				continue
			}
			registry := s.probeRegistry(ctx, agentNPMRegistryProbePackage(specs[i]))
			api := s.probeProviderAPI(ctx, statuses[i].Provider)
			statuses[i].Network = &NetworkStatus{
				Registry:    registry,
				ProviderAPI: api,
				Proxy:       proxy,
			}
			logNetworkProbe(statuses[i].Provider, registry, api, proxy)
		}
	}
	for i := range statuses {
		statuses[i].ActiveAction = activeActionForProvider(statuses[i].Provider)
	}

	return Snapshot{
		CapturedAt: now,
		Providers:  statuses,
	}, nil
}

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
	status := s.statusForSpec(ctx, spec, now)
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
	if spec.Provider == agentprovider.Codex && status.LastError != nil {
		result.Status = ProbeFailed
		result.ReasonCode = codexReasonCodeFromErrorCode(status.LastError.Code)
		result.Message = status.LastError.Message
		return result, nil
	}

	return s.probeAdapterRuntimeCommand(ctx, spec, runtimeResolution, now), nil
}

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
	result = s.probeCommandWithReadyAfter(ctx, result, command, env, s.probeReadyAfterForSpec(spec))
	if spec.Provider == agentprovider.Codex && result.Status == ProbeFailed {
		if code, ok := classifyCodexRuntimeError(result.Message); ok {
			result.LastError = &ProviderLastError{Code: string(code), Message: result.Message}
			result.ReasonCode = codexReasonCodeFromErrorCode(string(code))
		}
	}
	return result
}

func (s Service) RunAction(ctx context.Context, input RunActionInput) (RunActionResult, error) {
	now := s.now()
	specs, err := s.selectProviderSpecs(ctx, []string{input.Provider}, false)
	if err != nil {
		return RunActionResult{}, err
	}
	spec := specs[0]
	result := RunActionResult{
		Provider:    spec.Provider,
		ActionID:    input.ActionID,
		CompletedAt: now,
	}

	switch input.ActionID {
	case ActionInstall:
		startedAt := s.now()
		result, err := s.runInstallAction(ctx, spec, result)
		s.reportProviderSetupNodeResult(ctx, providerSetupNodeResultInput{
			Error:     err,
			Node:      "install_daemon_action",
			Provider:  spec.Provider,
			Result:    result,
			StartedAt: startedAt,
		})
		return result, err
	default:
		return RunActionResult{}, ErrInvalidAction
	}
}

func (s Service) runInstallAction(ctx context.Context, spec ProviderSpec, result RunActionResult) (RunActionResult, error) {
	if result, ok := unsupportedProviderRunActionResult(spec, result); ok {
		return result, nil
	}
	// Tag this run's context with a unique token and claim ownership of the
	// provider's active action, so a concurrent install of the same provider
	// can't cross-contaminate stdout or have our deferred clear delete its entry.
	installCtx := withActiveActionToken(baseContext(ctx), nextActiveActionToken())
	claimActiveAction(installCtx, spec.Provider, ActiveAction{
		ID:     ActionInstall,
		Status: "running",
	})
	defer clearActiveAction(installCtx, spec.Provider)
	runtimeResolution := s.resolveProviderRuntime(ctx, spec)
	summary, updatedRuntime, err := s.installMissingProviderRuntime(installCtx, spec, runtimeResolution)
	result = applyInstallerExecutionSummary(result, summary)
	if err != nil {
		return installActionErrorResult(result, err, s.installTimeout()), nil
	}
	if len(summary.Commands) == 0 {
		probeStartedAt := s.now()
		probe, err := s.Probe(ctx, ProbeInput{Provider: spec.Provider})
		if err != nil {
			s.reportProviderSetupNodeResult(ctx, providerSetupNodeResultInput{
				Error:     err,
				Node:      "install_post_probe",
				Provider:  spec.Provider,
				StartedAt: probeStartedAt,
				Status:    "failure",
			})
			return RunActionResult{}, err
		}
		result.Probe = &probe
		if probe.Status == ProbeFailed {
			repairStatus := s.statusForSpec(ctx, spec, s.now())
			if repairStatus.Availability.ReasonCode == "acp_adapter_launch_failed" {
				runtimeResolution.ReasonCode = "acp_adapter_launch_failed"
				summary, updatedRuntime, err = s.installMissingProviderRuntime(installCtx, spec, runtimeResolution)
				result = applyInstallerExecutionSummary(result, summary)
				result.Probe = nil
				if err != nil {
					return installActionErrorResult(result, err, s.installTimeout()), nil
				}
				if len(summary.Commands) > 0 {
					goto postInstallProbe
				}
			}
			result.Status = RunActionFailed
			result.ReasonCode = "post_install_probe_failed"
			result.Message = firstNonBlank(probe.Message, probe.ReasonCode, "Agent provider runtime probe failed")
			s.reportProviderSetupNodeResult(ctx, providerSetupNodeResultInput{
				Node:      "install_post_probe",
				Provider:  spec.Provider,
				Result:    result,
				StartedAt: probeStartedAt,
			})
			return result, nil
		}
		s.reportProviderSetupNodeResult(ctx, providerSetupNodeResultInput{
			Node:      "install_post_probe",
			Provider:  spec.Provider,
			Result:    RunActionResult{Status: RunActionCompleted},
			StartedAt: probeStartedAt,
		})
		result.Status = RunActionCompleted
		return result, nil
	}
	if summary.ExitCode != nil && *summary.ExitCode != 0 {
		result.Status = RunActionFailed
		result.ReasonCode = "install_command_failed"
		result.Message = firstNonBlank(result.Stderr, result.Stdout, "Install command failed")
		return result, nil
	}

postInstallProbe:
	probeStartedAt := s.now()
	probe, err := s.Probe(ctx, ProbeInput{Provider: spec.Provider})
	if err != nil {
		s.reportProviderSetupNodeResult(ctx, providerSetupNodeResultInput{
			Error:     err,
			Node:      "install_post_probe",
			Provider:  spec.Provider,
			StartedAt: probeStartedAt,
			Status:    "failure",
		})
		return RunActionResult{}, err
	}
	result.Probe = &probe
	if probe.Status == ProbeFailed {
		result.Status = RunActionFailed
		result.ReasonCode = "post_install_probe_failed"
		result.Message = firstNonBlank(probe.Message, probe.ReasonCode, "Agent provider runtime probe failed")
		s.reportProviderSetupNodeResult(ctx, providerSetupNodeResultInput{
			Node:      "install_post_probe",
			Provider:  spec.Provider,
			Result:    result,
			StartedAt: probeStartedAt,
		})
		return result, nil
	}
	s.reportProviderSetupNodeResult(ctx, providerSetupNodeResultInput{
		Node:      "install_post_probe",
		Provider:  spec.Provider,
		Result:    RunActionResult{Status: RunActionCompleted},
		StartedAt: probeStartedAt,
	})
	if strings.TrimSpace(updatedRuntime.AdapterPath) != "" {
		result.Probe.BinaryPath = updatedRuntime.AdapterPath
	}
	result.Status = RunActionCompleted
	return result, nil
}

func applyInstallerExecutionSummary(result RunActionResult, summary installerExecutionSummary) RunActionResult {
	result.Command = strings.Join(summary.Commands, " && ")
	result.Stdout = trimActionOutput(strings.Join(summary.Stdout, "\n"))
	result.Stderr = trimActionOutput(strings.Join(summary.Stderr, "\n"))
	result.ExitCode = summary.ExitCode
	return result
}

func installActionErrorResult(result RunActionResult, err error, timeout time.Duration) RunActionResult {
	result.Status = RunActionFailed
	if errors.Is(err, context.DeadlineExceeded) {
		result.ReasonCode = "install_timed_out"
		result.Message = "Install command timed out after " + timeout.String()
		return result
	}
	if errors.Is(err, context.Canceled) {
		result.ReasonCode = "install_canceled"
		result.Message = err.Error()
		return result
	}
	result.ReasonCode = "install_start_failed"
	result.Message = err.Error()
	return result
}

func (s Service) statusForSpec(ctx context.Context, spec ProviderSpec, now time.Time) ProviderStatus {
	if status, ok := unsupportedProviderStatus(spec, now); ok {
		return status
	}
	runtimeResolution := s.resolveProviderRuntime(ctx, spec)
	installed := strings.TrimSpace(runtimeResolution.CLIPath) != ""
	adapterInstalled := strings.TrimSpace(runtimeResolution.AdapterPath) != ""
	adapterReady := adapterInstalled && adapterPackageRequirementSatisfied(spec.AdapterPackage, runtimeResolution.AdapterVersion)
	adapterLaunchFailed := false
	if installed && adapterReady && s.shouldProbeAdapterCommandForStatus(spec, runtimeResolution) {
		probe := s.probeAdapterRuntimeCommand(ctx, spec, runtimeResolution, now)
		if probe.Status == ProbeFailed {
			adapterReady = false
			adapterLaunchFailed = true
		}
	}
	auth := s.resolveAuth(ctx, spec, installed, runtimeResolution.CLIPath)
	cliVersion := ""
	if installed {
		cliVersion = s.cliVersion(ctx, runtimeResolution.CLIPath, runtimeResolution.Env)
	}
	codexPlatformOK := true
	if spec.Provider == agentprovider.Codex && installed {
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
	} else if spec.Provider == agentprovider.Codex && !codexPlatformOK {
		availability.Status = AvailabilityNotInstalled
		availability.ReasonCode = codexReasonCodeFromErrorCode(string(CodexErrPlatformPkgIncomplete))
		actions = append(actions, daemonAction(ActionInstall))
	} else if spec.Provider == agentprovider.Codex && !codexVersionMeetsMinimum(cliVersion) {
		availability.Status = AvailabilityNotInstalled
		availability.ReasonCode = codexReasonCodeFromErrorCode(string(CodexErrVersionTooOld))
		actions = append(actions, daemonAction(ActionInstall))
	} else {
		actions = append(actions, terminalAction(ActionLogin, loginCommandForRuntime(spec, runtimeResolution)))

		// Claude Code can run in API Usage Billing mode — an API key, an auth
		// token, or an apiKeyHelper — which bills usage to an API account and
		// overrides any stored OAuth/subscription session. `claude auth status`
		// only reflects the stored session, so it is blind to these env/settings
		// credentials; detect them directly and prefer that signal over whatever
		// the CLI reports, so the wizard shows "已配置 API 计费" instead of a
		// stale OAuth label or "未登录". A bare custom endpoint without a
		// credential is NOT API billing (the user may still be on an OAuth
		// session), so it does not trigger this override.
		if spec.Provider == agentprovider.ClaudeCode && s.providerHasAPICredential(agentprovider.ClaudeCode) {
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

	status := ProviderStatus{
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
	if spec.Provider == agentprovider.Codex {
		status.CLI.MinVersion = MinSupportedCodexVersion
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
	return status
}

func (s Service) shouldProbeAdapterCommandForStatus(spec ProviderSpec, runtimeResolution providerRuntimeResolution) bool {
	if strings.TrimSpace(spec.ExternalRegistryID) != "" {
		return true
	}
	return spec.Provider == agentprovider.Codex && s.executableFile(runtimeResolution.AdapterPath)
}

func (s Service) probeReadyAfterForSpec(spec ProviderSpec) time.Duration {
	if strings.TrimSpace(spec.ExternalRegistryID) != "" && spec.AdapterInstall.RegistryNPM != nil {
		return externalRegistryNPMProbeReadyAfter(s.probeTimeout())
	}
	return s.probeReadyAfter()
}

func agentNPMRegistryProbePackage(spec ProviderSpec) string {
	if spec.Provider == agentprovider.Codex {
		return "@openai/codex"
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
