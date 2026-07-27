package agentstatus

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerstatus"
	"golang.org/x/sync/errgroup"

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

type AuthStatus = providerstatus.AuthStatus

const (
	AuthAuthenticated = providerstatus.AuthAuthenticated
	AuthRequired      = providerstatus.AuthRequired
	AuthUnknown       = providerstatus.AuthUnknown
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
	ActionUpdate  ActionID = "update"
	ActionLogin   ActionID = "login"
	ActionRefresh ActionID = "refresh"
)

type UpdateCapability string

const (
	UpdateCapabilitySupported   UpdateCapability = "supported"
	UpdateCapabilityUnsupported UpdateCapability = "unsupported"
)

type UpdateSource string

const UpdateSourceNPM UpdateSource = "npm"

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
	// IncludeUpdates explicitly opts into remote provider CLI update discovery.
	// It is OFF by default so readiness/status reads remain purely local.
	IncludeUpdates bool
	// ForceRefresh bypasses the application readiness cache. Interactive refresh,
	// install, and login flows use it; ordinary startup and dock reads do not.
	ForceRefresh bool
	// RefreshUpdates bypasses only the remote update-metadata cache when
	// IncludeUpdates is true. It never forces local readiness detection.
	RefreshUpdates bool
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
	Provider            string
	Status              ProbeStatus
	CheckedAt           time.Time
	ReasonCode          string
	Message             string
	BinaryPath          string
	Command             []string
	Checks              []ProviderCheck
	LastError           *ProviderLastError
	CommandStarted      bool
	ProtocolReady       bool
	CommandCategory     string
	ProtocolCategory    string
	ProtocolPackageName string
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
	Update       UpdateStatus
	Actions      []Action
	Network      *NetworkStatus
	Checks       []ProviderCheck
	LastError    *ProviderLastError
	ActiveAction *ActiveAction
	// CodexDiagnostics is populated only for Codex. It is additive so existing
	// providers and callers retain their status contract during migration.
	CodexDiagnostics *CodexDiagnosticSnapshot
}

type UpdateStatus struct {
	Capability        UpdateCapability
	Source            UpdateSource
	CurrentVersion    string
	LatestVersion     string
	UpdateAvailable   *bool
	UnsupportedReason string
	LastCheckedAt     *time.Time
	ReasonCode        string
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
	// enforces a floor. Empty for providers with no version gate. Lets
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

type AuthInfo = providerstatus.AuthInfo

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
	runCursorAuthStatusCommand  func(context.Context, string, []string) (AuthInfo, string, bool)
	AuthStatusCommandRetryDelay time.Duration
	IsExecutableFile            func(string) bool
	Now                         func() time.Time
	ProbeReadyAfter             time.Duration
	ProbeTimeout                time.Duration
	Registry                    Registry
	ExternalAgentRegistry       externalagentregistry.Store
	ManagedRuntime              managedruntime.Resolver
	// ClaudeCodeStateDir overrides the tutti state root that hosts the managed
	// binary pointer (tests); empty uses DefaultStateDir.
	ClaudeCodeStateDir string
	// ClaudeCodeRuntimeDir is the user-local root that hosts provisioned Claude
	// binaries. It is required for Claude Code runtime provisioning.
	ClaudeCodeRuntimeDir string
	AnalyticsReporter    reporterservice.Reporter
	// RunOutcomes lets a runtime auth failure override a stale "logged in" marker
	// so the dock/wizard surface that login dropped. Shared pointer across copies.
	RunOutcomes *RunOutcomeStore
	// StatusCache is shared by the daemon API and agent session service so local
	// readiness probes run once per provider instead of once per caller/window.
	StatusCache    *ProviderStatusCache
	StatusCacheTTL time.Duration
	// CLIVersionCache and AdapterProbeCache keep stable executable facts across
	// forced auth refreshes. DetectionCommands bounds actual subprocess fan-out
	// across concurrent requests.
	CLIVersionCache   *CLIVersionCache
	AdapterProbeCache *AdapterProbeCache
	BunGlobalBinCache *BunGlobalBinCache
	DetectionCommands *DetectionCommandLimiter
	// UpdateCache is separate from readiness caching because remote release
	// discovery is opt-in and must never make ordinary local status reads touch
	// the network.
	UpdateCache    *ProviderUpdateCache
	UpdateCacheTTL time.Duration
	// CodexProtocolProbe is injectable for deterministic status tests. Nil uses
	// the production app-server transport and formal initialize handshake.
	CodexProtocolProbe func(context.Context, []string, []string) CodexProbeEvidence
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

// statusDetectionConcurrency bounds how many providers are detected at once.
// Per-provider detection is dominated by short-lived subprocesses (auth status
// command, `--version`, adapter probe), so running providers concurrently drops
// snapshot latency from the serial sum to roughly the slowest provider. The
// bound keeps the subprocess fan-out small on constrained machines.
const statusDetectionConcurrency = 4

func (s Service) List(ctx context.Context, input ListInput) (snapshot Snapshot, err error) {
	startedAt := time.Now()
	defer func() {
		slog.Info(
			"agent provider status list completed",
			"event", "tutti.agent_provider.status_list.completed",
			"durationMs", time.Since(startedAt).Milliseconds(),
			"includeNetwork", input.IncludeNetwork,
			"includeUpdates", input.IncludeUpdates,
			"forceRefresh", input.ForceRefresh,
			"refreshUpdates", input.RefreshUpdates,
			"providerCount", len(snapshot.Providers),
			"requestedProviderCount", len(input.Providers),
			"requestedProviders", input.Providers,
			"success", err == nil,
		)
	}()

	now := s.now()
	specs, err := s.selectProviderSpecs(ctx, input.Providers, false)
	if err != nil {
		return Snapshot{}, err
	}

	// Detect providers concurrently; each writes only its own slot so the
	// response order stays the registry selection order.
	statuses := make([]ProviderStatus, len(specs))
	var group errgroup.Group
	group.SetLimit(statusDetectionConcurrency)
	for i, spec := range specs {
		group.Go(func() error {
			statuses[i] = s.cachedStatusForSpec(ctx, spec, input.ForceRefresh || input.IncludeNetwork)
			return nil
		})
	}
	_ = group.Wait() // statusForSpec never returns an error
	for i := range statuses {
		statuses[i].Update = baseProviderUpdateStatus(specs[i], statuses[i].CLI.Version, statuses[i].CLI.BinaryPath)
	}

	// Remote update discovery is a separate, explicit opt-in. It never runs for
	// ordinary readiness/status requests, and each provider records a cached,
	// non-fatal outcome rather than failing the whole snapshot.
	if input.IncludeUpdates {
		var updateGroup errgroup.Group
		updateGroup.SetLimit(statusDetectionConcurrency)
		for i, spec := range specs {
			updateGroup.Go(func() error {
				statuses[i].Update = s.updateStatusForSpec(ctx, spec, statuses[i].CLI.Version, statuses[i].CLI.BinaryPath, input.RefreshUpdates)
				if statuses[i].Update.UpdateAvailable != nil && *statuses[i].Update.UpdateAvailable {
					statuses[i].Actions = appendProviderAction(statuses[i].Actions, daemonAction(ActionUpdate))
				}
				return nil
			})
		}
		_ = updateGroup.Wait()
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

	capturedAt := now
	for i := range statuses {
		if checkedAt := statuses[i].Availability.CheckedAt; checkedAt != nil && checkedAt.After(capturedAt) {
			capturedAt = *checkedAt
		}
	}
	snapshot = Snapshot{
		CapturedAt: capturedAt,
		Providers:  statuses,
	}
	return snapshot, nil
}

func (s Service) cachedStatusForSpec(ctx context.Context, spec ProviderSpec, forceRefresh bool) ProviderStatus {
	cache := s.StatusCache
	if cache == nil {
		return s.detectStatusForSpec(ctx, spec, forceRefresh)
	}
	if !forceRefresh {
		runtimeFingerprint := s.providerRuntimeFingerprint(ctx, spec)
		if cached, cachedAt, credentialFingerprint, cachedRuntimeFingerprint, ok := cache.get(spec.Provider, s.now(), s.providerStatusCacheTTL()); ok &&
			s.cachedProviderStatusStillValid(spec, cachedAt, credentialFingerprint, cachedRuntimeFingerprint, runtimeFingerprint) {
			return cached
		}
	}

	value, _, _ := cache.group.Do(spec.Provider, func() (any, error) {
		if !forceRefresh {
			runtimeFingerprint := s.providerRuntimeFingerprint(ctx, spec)
			if cached, cachedAt, credentialFingerprint, cachedRuntimeFingerprint, ok := cache.get(spec.Provider, s.now(), s.providerStatusCacheTTL()); ok &&
				s.cachedProviderStatusStillValid(spec, cachedAt, credentialFingerprint, cachedRuntimeFingerprint, runtimeFingerprint) {
				return cached, nil
			}
		}
		status := s.detectStatusForSpec(ctx, spec, forceRefresh)
		completedAt := s.now()
		status.Availability.CheckedAt = &completedAt
		// Codex repair authorization is deliberately derived from a fresh failed
		// protocol probe plus a fresh layout scan. Keep the application cache
		// positive-only for Codex so a previous failure cannot keep presenting a
		// stale RepairPlan to either the renderer or a later action request.
		if isCodexStatusSpec(spec) && (status.CodexDiagnostics == nil || !status.CodexDiagnostics.Diagnosis.RuntimeReady) {
			cache.invalidate(spec.Provider)
			return status, nil
		}
		cache.set(spec.Provider, completedAt, s.providerCredentialFingerprint(spec), s.providerRuntimeFingerprint(ctx, spec), status)
		return status, nil
	})
	return cloneProviderStatus(value.(ProviderStatus))
}

func (s Service) detectStatusForSpec(ctx context.Context, spec ProviderSpec, forceRefresh bool) ProviderStatus {
	status := s.statusForSpec(ctx, spec, s.now(), statusDetectionOptions{
		forceRefresh: forceRefresh,
	})
	completedAt := s.now()
	status.Availability.CheckedAt = &completedAt
	return status
}

func (s Service) providerStatusCacheTTL() time.Duration {
	if s.StatusCacheTTL != 0 {
		return s.StatusCacheTTL
	}
	return defaultProviderStatusCacheTTL
}

func (s Service) cachedProviderStatusStillValid(spec ProviderSpec, cachedAt time.Time, credentialFingerprint, cachedRuntimeFingerprint, runtimeFingerprint string) bool {
	failedAt, invalidated := s.RunOutcomes.AuthInvalidatedSince(spec.Provider)
	if invalidated && failedAt.After(cachedAt) {
		return false
	}
	return credentialFingerprint == s.providerCredentialFingerprint(spec) &&
		cachedRuntimeFingerprint == runtimeFingerprint
}

func (s Service) invalidateProviderStatus(provider string) {
	s.StatusCache.invalidate(provider)
}

// Invalidate drops one provider's application readiness snapshot after the
// real runtime proves that cached launch assumptions are no longer reliable.
func (s Service) Invalidate(provider string) {
	s.invalidateProviderStatus(strings.TrimSpace(provider))
}

func (s Service) RunAction(ctx context.Context, input RunActionInput) (RunActionResult, error) {
	now := s.now()
	specs, err := s.selectProviderSpecs(ctx, []string{input.Provider}, false)
	if err != nil {
		return RunActionResult{}, err
	}
	spec := specs[0]
	defer s.invalidateProviderStatus(spec.Provider)
	defer s.UpdateCache.invalidate(spec.Provider)
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
	case ActionUpdate:
		return s.runUpdateAction(ctx, spec, result)
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
	if isCodexStatusSpec(spec) && strings.TrimSpace(runtimeResolution.CLIPath) != "" {
		probe := s.probeAdapterRuntimeCommand(installCtx, spec, runtimeResolution, s.now())
		if probe.Status == ProbeReady && !s.providerCLIRequiresInstall(spec, runtimeResolution) {
			result.Probe = &probe
			result.Status = RunActionCompleted
			s.reportProviderSetupNodeResult(ctx, providerSetupNodeResultInput{
				Node:      "install_post_probe",
				Provider:  spec.Provider,
				Result:    RunActionResult{Status: RunActionCompleted},
				StartedAt: s.now(),
			})
			return result, nil
		}
		if probe.Status == ProbeReady {
			// A present, protocol-capable Codex below Tutti's support floor needs
			// an upgrade decision, never an install/repair action that could
			// overwrite a user-managed Bun, pnpm, Homebrew, or standalone runtime.
			result.Probe = &probe
			result.Status = RunActionFailed
			result.ReasonCode = "codex_version_unsupported"
			result.Message = "Codex CLI version is below the supported version; upgrade it before retrying"
			return result, nil
		}
		if probe.Status == ProbeFailed {
			runtimeResolution.ReasonCode = firstNonBlank(probe.ReasonCode, "acp_adapter_launch_failed")
			// A failed probe is not itself permission to overwrite a user-managed
			// Codex installation. Re-evaluate the structured snapshot and only pass
			// an explicit planner authorization into the installer.
			status := s.statusForSpec(ctx, spec, s.now(), statusDetectionOptions{forceRefresh: true})
			if status.CodexDiagnostics != nil && status.CodexDiagnostics.RepairPlan.Allowed {
				plan := status.CodexDiagnostics.RepairPlan
				runtimeResolution.CodexRepairPlan = &plan
			}
			if status.CodexDiagnostics != nil {
				slog.Info(
					"codex install action authorization evaluated",
					"provider", spec.Provider,
					"repairAllowed", status.CodexDiagnostics.RepairPlan.Allowed,
					"repairReason", status.CodexDiagnostics.RepairPlan.ReasonCode,
					"primaryDiagnosticCode", status.CodexDiagnostics.Diagnosis.PrimaryDiagnosticCode,
				)
			}
		}
	}
	summary, updatedRuntime, err := s.installMissingProviderRuntime(installCtx, spec, runtimeResolution)
	result = applyInstallerExecutionSummary(result, summary)
	if err != nil {
		return installActionErrorResult(result, err, s.installTimeout(), spec.Install), nil
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
			if !isCodexStatusSpec(spec) {
				repairStatus := s.statusForSpec(ctx, spec, s.now(), statusDetectionOptions{
					forceRefresh: true,
				})
				if repairStatus.Availability.ReasonCode == "acp_adapter_launch_failed" {
					runtimeResolution.ReasonCode = "acp_adapter_launch_failed"
					summary, updatedRuntime, err = s.installMissingProviderRuntime(installCtx, spec, runtimeResolution)
					result = applyInstallerExecutionSummary(result, summary)
					result.Probe = nil
					if err != nil {
						return installActionErrorResult(result, err, s.installTimeout(), spec.Install), nil
					}
					if len(summary.Commands) > 0 {
						goto postInstallProbe
					}
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
		result.Message = firstNonBlank(result.Stderr, result.Stdout, "Install command failed")
		result.ReasonCode = installerFailureReasonCode(spec.Install, result.Message, "install_command_failed")
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

func installActionErrorResult(result RunActionResult, err error, timeout time.Duration, installer InstallerSpec) RunActionResult {
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
	result.Message = err.Error()
	result.ReasonCode = installerFailureReasonCode(installer, result.Message, "install_start_failed")
	return result
}

func installerFailureReasonCode(installer InstallerSpec, message string, fallback string) string {
	normalized := strings.ToLower(message)
	for reasonCode, markers := range installer.FailureReasonMarkers {
		for _, marker := range markers {
			if normalizedMarker := strings.ToLower(strings.TrimSpace(marker)); normalizedMarker != "" && strings.Contains(normalized, normalizedMarker) {
				return reasonCode
			}
		}
	}
	return fallback
}
