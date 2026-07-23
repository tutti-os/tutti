package agentruntime

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

// Codex app-server JSON-RPC methods used by the adapter. The app-server
// protocol is the official first-party integration surface for Codex; it
// replaces the previous codex-acp (ACP) bridge for the "codex" provider.
const (
	appServerMethodInitialize     = "initialize"
	appServerMethodInitialized    = "initialized"
	appServerMethodAccountRead    = "account/read"
	appServerMethodRateLimitsRead = "account/rateLimits/read"
	appServerMethodModelList      = "model/list"
	// Experimental: collaboration mode presets (plan/pair/execute). Absence of
	// the method on older binaries downgrades planMode capability gracefully.
	appServerMethodCollaborationModeList = "collaborationMode/list"
	appServerMethodThreadStart           = "thread/start"
	appServerMethodThreadResume          = "thread/resume"
	appServerMethodThreadFork            = "thread/fork"
	appServerMethodThreadRollback        = "thread/rollback"
	appServerMethodThreadRead            = "thread/read"
	appServerMethodThreadCompact         = "thread/compact/start"
	appServerMethodThreadGoalSet         = "thread/goal/set"
	appServerMethodThreadGoalGet         = "thread/goal/get"
	appServerMethodThreadGoalClear       = "thread/goal/clear"
	appServerMethodTurnStart             = "turn/start"
	appServerMethodTurnSteer             = "turn/steer"
	appServerMethodTurnInterrupt         = "turn/interrupt"
	appServerMethodReviewStart           = "review/start"
	appServerMethodFeedbackUpload        = "feedback/upload"
	appServerMethodAccountLoginStart     = "account/login/start"

	// Server -> client requests.
	appServerMethodCommandApproval     = "item/commandExecution/requestApproval"
	appServerMethodFileChangeApproval  = "item/fileChange/requestApproval"
	appServerMethodPermissionsApproval = "item/permissions/requestApproval"
	appServerMethodRequestUserInput    = "item/tool/requestUserInput"
	appServerMethodExecApprovalV1      = "execCommandApproval"
	appServerMethodPatchApprovalV1     = "applyPatchApproval"

	// Server -> client notifications.
	appServerNotifyThreadStarted         = "thread/started"
	appServerNotifyTurnStarted           = "turn/started"
	appServerNotifyTurnCompleted         = "turn/completed"
	appServerNotifyAgentMessageDelta     = "item/agentMessage/delta"
	appServerNotifyReasoningDelta        = "item/reasoning/textDelta"
	appServerNotifyReasoningSummary      = "item/reasoning/summaryTextDelta"
	appServerNotifyReasoningSummaryPart  = "item/reasoning/summaryPartAdded"
	appServerNotifyThreadSettingsUpdated = "thread/settings/updated"
	appServerNotifyItemStarted           = "item/started"
	appServerNotifyItemCompleted         = "item/completed"
	appServerNotifyTokenUsage            = "thread/tokenUsage/updated"
	appServerNotifyPlanUpdated           = "turn/plan/updated"
	appServerNotifyThreadNameUpdated     = "thread/name/updated"
	appServerNotifyRateLimitsUpdated     = "account/rateLimits/updated"
	appServerNotifyAccountUpdated        = "account/updated"
	appServerNotifyError                 = "error"
	appServerNotifyWarning               = "warning"
	appServerNotifyDeprecation           = "deprecationNotice"
	appServerNotifyModelRerouted         = "model/rerouted"
	appServerNotifyThreadCompacted       = "thread/compacted"
	appServerNotifyServerRequestResolved = "serverRequest/resolved"
	appServerNotifyThreadGoalUpdated     = "thread/goal/updated"
	appServerNotifyThreadGoalCleared     = "thread/goal/cleared"
)

const (
	appServerSlashCompact = "/compact"
	appServerSlashGoal    = "/goal"
	appServerSlashReview  = "/review"
	appServerSlashUndo    = "/undo"
)

// appServerAdapterConfig captures the provider-specific identity of an
// app-server CLI so a single adapter implementation can serve Codex and
// Codex-compatible forks (Tutti Agent) without sharing brand, command, or
// auth assumptions.
type appServerAdapterConfig struct {
	provider             string
	runtimeName          string
	displayName          string
	command              []string
	clientInfoName       string
	authRequiredMessage  string
	commandNetworkAccess bool
}

// CodexAppServerAdapterOptions controls host-owned app-server execution policy
// without changing the provider-native permission-mode mapping.
type CodexAppServerAdapterOptions struct {
	// CommandNetworkAccess enables network access for commands and subprocesses
	// in the read-only and workspace-write sandboxes. Filesystem access,
	// approval policy, and approval reviewer remain owned by the selected
	// permission mode. Network proxy configuration remains a separate concern.
	CommandNetworkAccess bool
}

// defaultCodexAppServerCancelGraceWindow is how long Cancel waits for codex to
// honor turn/interrupt gracefully before force-closing the app-server process.
const defaultCodexAppServerCancelGraceWindow = 3 * time.Second

// defaultCodexAppServerTurnStartAckTimeout only bounds the immediate
// turn/start acknowledgement. Turn output continues through notifications
// without this deadline after the acknowledgement arrives.
const defaultCodexAppServerTurnStartAckTimeout = acpStartCallTimeout

// defaultCodexAppServerTurnSteerTimeout bounds guidance delivery to a running
// turn so a missing app-server response cannot block the caller forever.
const defaultCodexAppServerTurnSteerTimeout = 10 * time.Second

// startupModelSteadyRetryCount is how many 30s-spaced model/list retries follow
// the initial fast ramp before the background refresh gives up (~18 minutes
// total), bounding the goroutine while covering realistic transient outages.
const startupModelSteadyRetryCount = 36

// defaultCodexAppServerGoalContinuationGraceWindow is how long the adapter
// waits after a goal turn settles for codex to auto-start the next turn
// before nudging it with a thread/goal/set re-send.
const defaultCodexAppServerGoalContinuationGraceWindow = 1500 * time.Millisecond

// defaultCodexAppServerGoalProvenanceGraceWindow bounds how long an
// unowned provider turn may wait for exact turn-scoped goal evidence or an
// operation-scoped continuation claim. turn/started alone carries no Goal
// generation and must never inherit the session's latest desired Goal identity.
const defaultCodexAppServerGoalProvenanceGraceWindow = 250 * time.Millisecond

type CodexAppServerAdapter struct {
	transport                  ProcessTransport
	host                       HostMetadata
	config                     appServerAdapterConfig
	preparer                   ProviderLaunchPreparer
	commandResolver            ProviderCommandResolver
	mu                         sync.Mutex
	sessions                   map[string]*codexAppServerSession
	terminalInteractions       terminalInteractiveDispositionStore
	interactiveDispositionSink InteractiveDispositionSink
	commandSink                CommandSnapshotSink
	eventSink                  SessionEventSink
	goalReconcileSink          GoalReconcileDurableSink
	goalProvenanceSink         GoalProvenanceDurableSink
	goalReconcileAckTimeout    time.Duration
	configSink                 ConfigOptionsUpdateSink
	// lifecycleMu guards lifecycleLocks; the per-session locks serialize
	// Start/Resume/Close/ReleaseLiveSession per agent session so concurrent
	// lifecycle calls can never leave two live app-server processes for the
	// same session. Different sessions never contend.
	lifecycleMu    sync.Mutex
	lifecycleLocks map[string]*codexAppServerSessionLock
	// cancelGraceWindow bounds the graceful-interrupt wait in Cancel before the
	// process is force-closed. Zero falls back to the default.
	cancelGraceWindow time.Duration
	// turnStartAckTimeout bounds only the immediate turn/start RPC response.
	// Zero falls back to the default.
	turnStartAckTimeout time.Duration
	// turnSteerTimeout bounds turn/steer guidance delivery. Zero falls back to
	// the default.
	turnSteerTimeout time.Duration
	// cliVersionMu/cliVersionCached memoize the served CLI's --version result
	// per adapter instance (each instance owns one command).
	cliVersionMu     sync.Mutex
	cliVersionCached string
	// startupModelRetryBackoffs is the wait schedule between background model/list
	// refetches when the initial probe came back empty; the slice length bounds
	// the number of retries. Nil falls back to defaultStartupModelRetryBackoffs.
	// Overridable in tests to drive the loop without real delays.
	startupModelRetryBackoffs []time.Duration
	// goalContinuationGraceWindow is how long a settled goal turn waits for
	// codex to auto-start the next turn before the adapter nudges it. Zero
	// falls back to the default.
	goalContinuationGraceWindow time.Duration
	// goalProvenanceGraceWindow gives a turn-scoped goal update (or the
	// matching goal/set response) a bounded window to establish immutable
	// provider-turn provenance. Zero falls back to the default.
	goalProvenanceGraceWindow time.Duration
	// goalHandoffCommittedHook is test-only synchronization injected after the
	// atomic pending->adopting commit and before TurnStarted/drain.
	goalHandoffCommittedHook func()
	goalBeforeAdoptHook      func()
	goalHandoffDrainHook     func()
}

type codexAppServerSessionLock struct {
	mu   sync.Mutex
	refs int
}

type codexAppServerSession struct {
	client     *codexAppServerClient
	threadID   string
	serverInfo map[string]any
	account    map[string]any
	rateLimits map[string]any
	goal       map[string]any
	// goalOperationID/revision identify the latest durable desired-goal write.
	// They gate future scheduling; accepted Turns retain their own identity.
	goalOperationID string
	goalRevision    int64
	goalRepairEpoch int64
	// Goal provenance is deliberately separate from the mutable desired Goal
	// identity above. A provider turn may only consume an immutable association
	// established by matching a provider Goal generation observed in both a
	// successful goal/set response and a turn-scoped goal/updated notification,
	// or by consuming the bounded continuation claim for versions that omit
	// notification.turnId.
	goalGenerationBindings           map[string]codexGoalGenerationBinding
	goalGenerationOrder              []string
	currentGoalGenerationFingerprint string
	goalTurnEvidence                 map[string]*codexGoalTurnEvidence
	pendingGoalTurns                 map[string]*codexPendingGoalTurn
	// goalContinuationClaim is an in-process, single-use compatibility fence
	// for Codex versions whose thread/goal/updated notification omits turnId.
	// A successful Goal RPC seeds the first claim; each adopted Goal turn may
	// seed the next one after settlement. The claim is usable only while its
	// immutable operation identity is still current, so a newer set/clear
	// invalidates delayed work without rebinding it to the latest Goal.
	goalContinuationClaim *codexGoalContinuationClaim
	// provenanceDegraded is fail-closed for the lifetime of this provider
	// session. Once bounded evidence can no longer preserve ambiguity, no later
	// notification may rebuild a partial cache and become adoptable.
	provenanceDegraded bool
	// goalMutationMu is the provider-side half of the Host goal mutation lane. It serializes
	// direct control, reconcile and delayed continuation nudges for this thread.
	goalMutationMu         sync.Mutex
	models                 []map[string]any
	startupModelsReady     bool
	startupRateLimitsReady bool
	// lifecycleSeq numbers the adapter's TurnLifecycle snapshots (ADR 0008):
	// monotonically increasing per session so consumers receiving snapshots
	// over different channels can drop stale ones. Guarded by the adapter
	// mutex.
	lifecycleSeq uint64
	// Collaboration mode masks come from collaborationMode/list. The app-server
	// expects the active mode settings, including developer_instructions, on
	// every turn/start request.
	planModeMask    map[string]any
	defaultModeMask map[string]any
	defaultModel    string
	authState       string
	authMessage     string
	activeTurnID    string
	// activeTurnStartConfirmed reports whether a turn/started notification
	// confirmed activeTurnID. A turn/start issued while another turn is
	// already running responds with a stub turn id that codex never starts
	// (live-verified: TestLiveProtocolTurnStartDuringActiveTurn) — the input
	// is steered into the running turn instead. An unconfirmed id therefore
	// must not veto the running turn's terminal in settleActiveTurn. Guarded
	// by the adapter mutex.
	activeTurnStartConfirmed bool
	// lastCanonicalTurnID survives provider-turn settlement so provider-native
	// child registrations can still resolve the canonical root turn while they
	// drain. It must never contain an app-server provider turn id.
	lastCanonicalTurnID string
	// canceledRootTurnID is an adapter-local execution boundary. Once the user
	// cancels a canonical root turn, server-initiated root turns and child
	// threads discovered after the durable cancel target snapshot are stopped
	// instead of being adopted or projected as new canonical work. A later
	// explicit canonical turn clears the boundary in beginActiveTurn.
	canceledRootTurnID string
	// canceledProviderThreads remembers late child provider threads that were
	// discovered behind canceledRootTurnID. They never receive canonical child
	// session identities; the set only lets later provider notifications be
	// interrupted and dropped consistently.
	canceledProviderThreads map[string]struct{}
	activeTurn              *codexAppServerActiveTurn
	childThreads            map[string]*codexAppServerThreadContext
	// recentForeignDrops remembers recently dropped unknown thread ids so a
	// late registration can report how many events the ordering gap lost.
	recentForeignDrops map[string]int
	acpLiveState
	pendingRequests map[string]*pendingInteractiveRequest
}

type codexAppServerThreadContext struct {
	agentSessionID       string
	turnID               string
	rootAgentSessionID   string
	rootTurnID           string
	parentAgentSessionID string
	parentTurnID         string
	parentThreadID       string
	parentItemID         string
	normalizer           *acpTurnNormalizer
	// droppedBeforeRegistration counts events for this thread that arrived
	// (and were dropped as unknown) before its receiverThreadIds registration
	// - permanent telemetry for ADR 0003's ordering question.
	droppedBeforeRegistration int
}

// codexAppServerActiveTurn carries the streaming context of an in-flight
// turn. The app-server `turn/start` RPC responds immediately with the
// inProgress turn; all output arrives as notifications afterwards, so the
// session-level message handler resolves this context to keep translating
// notifications into activity events after the RPC has returned. The turn
// finishes when the `turn/completed` notification delivers the final turn
// payload through the reducer-owned terminal projection.
type codexAppServerActiveTurn struct {
	processMu      sync.Mutex
	turnID         string
	providerTurnID string
	session        Session
	ctx            context.Context
	normalizer     *acpTurnNormalizer
	emit           func([]activityshared.Event)
	emitCommands   CommandSnapshotSink
	kind           codexAppServerTurnKind
	phase          codexAppServerTurnPhase
	goalIdentity   goalOperationIdentity
	goalProvenance string
	terminal       chan codexAppServerTurnTerminal
	// terminated is closed exactly once when the Exec goroutine for this turn
	// returns (turn fully finalized). Cancel waits on it so it only responds
	// after the turn has actually stopped.
	terminated chan struct{}
	// terminatedOnce closes terminated exactly once regardless of which path
	// finalizes the turn (settle path or the blocking shell).
	terminatedOnce sync.Once
	// emitTerminal delivers the turn's final events through the turn's own
	// single-shot emission chain (the shell's turnClosed guard dedupes).
	emitTerminal func([]activityshared.Event)
	// settleEmits marks turns whose terminal events are produced by the
	// settle path (notification loop) instead of a parked goroutine
	// (ADR 0005 C inversion). Guarded by the adapter mutex.
	settleEmits bool
	// settleFinalized records that finalizeSettledTurn produced the terminal
	// events; the blocking shell logs a shadow miss if it ever has to.
	settleFinalized atomic.Bool

	cancelRequested     bool
	cancelInterruptSent bool
	// forceCanceled is set (under the adapter mutex) when Cancel force-closed
	// the app-server process because codex did not honor turn/interrupt. It
	// makes the turn's terminal classification surface as canceled, not failed.
	forceCanceled bool
}

func NewCodexAppServerAdapter(transport ProcessTransport) *CodexAppServerAdapter {
	return NewCodexAppServerAdapterWithHostMetadata(transport, LegacyHostMetadata())
}

func NewCodexAppServerAdapterWithHostMetadata(transport ProcessTransport, host HostMetadata) *CodexAppServerAdapter {
	return NewCodexAppServerAdapterWithHostMetadataAndCommandResolver(transport, host, nil)
}

func NewCodexAppServerAdapterWithHostMetadataAndOptions(
	transport ProcessTransport,
	host HostMetadata,
	options CodexAppServerAdapterOptions,
) *CodexAppServerAdapter {
	adapter := NewCodexAppServerAdapterWithHostMetadataAndCommandResolver(transport, host, nil)
	adapter.config.commandNetworkAccess = options.CommandNetworkAccess
	return adapter
}

func NewCodexAppServerAdapterWithHostMetadataAndCommandResolver(
	transport ProcessTransport,
	host HostMetadata,
	commandResolver ProviderCommandResolver,
) *CodexAppServerAdapter {
	descriptor, ok := providerregistry.Find(providerregistry.CodexProviderID)
	if !ok {
		panic("migrated Codex provider descriptor is missing")
	}
	if err := providerregistry.Validate(descriptor); err != nil {
		panic(fmt.Sprintf("invalid migrated Codex provider descriptor: %v", err))
	}
	adapter := newAdapterFromProviderDescriptor(
		descriptor,
		transport,
		host,
		commandResolver,
	)
	codexAdapter, ok := adapter.(*CodexAppServerAdapter)
	if !ok {
		panic(fmt.Sprintf("Codex provider descriptor constructed %T", adapter))
	}
	return codexAdapter
}

// NewTuttiAgentAppServerAdapterWithHostMetadata serves the tutti-agent
// provider through the shared app-server adapter with Tutti-branded command,
// client identity, and auth messaging.
func NewTuttiAgentAppServerAdapterWithHostMetadata(transport ProcessTransport, host HostMetadata) *CodexAppServerAdapter {
	descriptor, ok := providerregistry.Find(ProviderTuttiAgent)
	if !ok {
		panic("tutti-agent provider descriptor is missing")
	}
	adapter := newAdapterFromProviderDescriptor(descriptor, transport, host, nil)
	appServerAdapter, ok := adapter.(*CodexAppServerAdapter)
	if !ok {
		panic(fmt.Sprintf("Tutti Agent provider descriptor constructed %T", adapter))
	}
	return appServerAdapter
}

func newAppServerAdapter(
	transport ProcessTransport,
	host HostMetadata,
	config appServerAdapterConfig,
	commandResolver ProviderCommandResolver,
) *CodexAppServerAdapter {
	return &CodexAppServerAdapter{
		transport:           transport,
		host:                host,
		config:              config,
		commandResolver:     commandResolver,
		sessions:            make(map[string]*codexAppServerSession),
		lifecycleLocks:      make(map[string]*codexAppServerSessionLock),
		cancelGraceWindow:   defaultCodexAppServerCancelGraceWindow,
		turnStartAckTimeout: defaultCodexAppServerTurnStartAckTimeout,
		turnSteerTimeout:    defaultCodexAppServerTurnSteerTimeout,
	}
}

// resolveCLIVersion returns the version of the binary that serves the
// app-server (e.g. "0.142.1"), resolved with the same env (PATH) the
// app-server is spawned with so the two agree. The result is cached per
// adapter after the first successful lookup; an empty string signals
// "unknown" so callers can fall back.
func (a *CodexAppServerAdapter) resolveCLIVersion(env []string) string {
	a.cliVersionMu.Lock()
	defer a.cliVersionMu.Unlock()
	if a.cliVersionCached != "" {
		return a.cliVersionCached
	}
	cmd := exec.Command(a.config.command[0], "--version")
	if len(env) > 0 {
		cmd.Env = env
	}
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	// Output looks like "codex-cli 0.142.1"; the version is the last field.
	fields := strings.Fields(string(out))
	if len(fields) == 0 {
		return ""
	}
	a.cliVersionCached = strings.TrimSpace(fields[len(fields)-1])
	return a.cliVersionCached
}

// clientInfoParams builds the app-server initialize clientInfo. The served
// CLI derives its outbound originator/User-Agent from clientInfo.name, so the
// name comes from the adapter config: the official Codex originator for the
// codex provider, the Tutti identity for tutti-agent.
func (a *CodexAppServerAdapter) clientInfoParams(env []string) map[string]any {
	return clientInfoParamsForVersion(a.host, a.config.clientInfoName, a.resolveCLIVersion(env))
}

func clientInfoParamsForVersion(host HostMetadata, name string, version string) map[string]any {
	if strings.TrimSpace(version) == "" {
		version = strings.TrimSpace(host.ClientInfo.Version)
	}
	return map[string]any{
		"name":    name,
		"title":   host.ClientInfo.Title,
		"version": version,
	}
}

func (a *CodexAppServerAdapter) Provider() string {
	return a.config.provider
}

func (*CodexAppServerAdapter) sessionCWD(session Session) string {
	return projectCodexWorkspaceCWD(strings.TrimSpace(session.CWD), session.RoomID)
}

func (a *CodexAppServerAdapter) SetCommandSnapshotSink(sink CommandSnapshotSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.commandSink = sink
	a.mu.Unlock()
}

func (a *CodexAppServerAdapter) SetSessionEventSink(sink SessionEventSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.eventSink = sink
	a.mu.Unlock()
}

func (a *CodexAppServerAdapter) SetGoalReconcileDurableSink(sink GoalReconcileDurableSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.goalReconcileSink = sink
	a.mu.Unlock()
}

func (a *CodexAppServerAdapter) SetGoalProvenanceDurableSink(sink GoalProvenanceDurableSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.goalProvenanceSink = sink
	a.mu.Unlock()
}

func (a *CodexAppServerAdapter) SetConfigOptionsUpdateSink(sink ConfigOptionsUpdateSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.configSink = sink
	a.mu.Unlock()
}

func (a *CodexAppServerAdapter) SetProviderLaunchPreparer(preparer ProviderLaunchPreparer) {
	if a == nil {
		return
	}
	a.preparer = preparer
}

func (*CodexAppServerAdapter) ValidatePromptContent(_ Session, content []PromptContentBlock) error {
	// Codex app-server accepts text, image, and localImage user input items.
	return validatePromptContentImagesForPreflight(content)
}

func (a *CodexAppServerAdapter) commandString() string {
	return strings.Join(a.config.command, " ")
}
