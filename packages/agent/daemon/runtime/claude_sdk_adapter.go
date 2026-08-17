package agentruntime

import (
	"context"
	"sync"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

const (
	claudeSDKSidecarCommandEnv     = "TUTTI_CLAUDE_SDK_SIDECAR_COMMAND"
	claudeSDKSidecarEntryPathEnv   = "TUTTI_CLAUDE_SDK_SIDECAR_ENTRY_PATH"
	claudeSDKSidecarTestDriverEnv  = "TUTTI_CLAUDE_SDK_SIDECAR_TEST_DRIVER"
	claudeSDKAppNodeEnv            = "TUTTI_APP_NODE"
	claudeSDKAppRuntimeRootEnv     = "TUTTI_APP_RUNTIME_ROOT"
	claudeSDKAppRuntimeCacheEnv    = "TUTTI_APP_RUNTIME_CACHE_ROOT"
	claudeSDKSidecarAdapterName    = "claude-agent-sdk"
	claudeSDKSidecarDefaultNodeArg = "--experimental-strip-types"
	claudeSDKAuthRefreshLogPrefix  = "CLAUDE_CODE_AUTH_REFRESH_DEBUG"
	claudeSDKCancelLogPrefix       = "CLAUDE_CODE_CANCEL_DIAGNOSTIC"
	claudeSDKProviderTurnLogPrefix = "CLAUDE_CODE_PROVIDER_TURN_DIAGNOSTIC"
)

type ClaudeCodeSDKAdapter struct {
	transport ProcessTransport
	preparer  ProviderLaunchPreparer

	mu                         sync.Mutex
	sessions                   map[string]*claudeSDKAdapterSession
	retiredSessions            map[string][]*claudeSDKAdapterSession
	terminalInteractions       terminalInteractiveDispositionStore
	interactiveDispositionSink InteractiveDispositionSink
	commandSink                CommandSnapshotSink
	eventSink                  SessionEventSink
	promptImageMaterializer    providerPromptImageMaterializer
	interactiveAckTimeout      time.Duration
	inputUnits                 *providerInputUnitTracker
	lifecycleMu                sync.Mutex
	lifecycleLocks             map[string]*claudeSDKSessionLock
}

type claudeSDKSessionLock struct {
	mu   sync.Mutex
	refs int
}

type claudeSDKAdapterSession struct {
	// dispatchMu is the exact-session commit axis. Event projection may run
	// before it, but canonical publication and registry replacement must hold
	// this mutex so a stale reader cannot commit after a new generation wins.
	dispatchMu        sync.Mutex
	conn              ProcessConnection
	reader            *claudeSDKLineReader
	session           Session
	providerSessionID string
	resumeCursor      map[string]any
	childSessions     map[string]claudeSDKChildSession
	assistantMessages map[string]string
	thinkingMessages  map[string]string
	compactMessages   map[string]claudeSDKCompactMessage
	pendingRequests   map[string]*pendingInteractiveRequest
	pendingResponses  map[string]chan claudeSDKSidecarEvent
	turns             map[string]*claudeSDKTurnWaiter
	// turnNormalizers owns each Claude turn's event lifecycle the same way
	// Codex/ACP use acpTurnNormalizer: track open tool calls while the turn is
	// live, and Finish* closes dangling calls when the turn reaches a terminal
	// state. Guarded by the adapter mutex.
	turnNormalizers map[string]*acpTurnNormalizer
	liveState       claudeSDKLiveState
	sendMu          sync.Mutex
	readerStarted   bool
	// invalid is guarded by the adapter mutex. Once set, a stale Resume
	// attempt must never put this session back into the live registry.
	invalid bool
	// lifecycleSeq numbers the adapter's TurnLifecycle snapshots (ADR 0008):
	// monotonically increasing per session so consumers receiving snapshots
	// over different channels (the Exec emit closure and the session event
	// sink) can drop stale ones. Guarded by the adapter mutex.
	lifecycleSeq uint64
	// diagnosticEventSeq orders the bounded Claude SDK lifecycle diagnostics
	// written by the Go adapter. It never participates in event projection or
	// durable turn state. Guarded by the adapter mutex.
	diagnosticEventSeq uint64
	// settledTurns remembers turn IDs whose terminal event already left this
	// adapter, so a late Cancel re-states the settled snapshot instead of
	// fabricating a competing terminal transition. Guarded by the adapter
	// mutex.
	settledTurns map[string]string
	// rootTurnID remains the canonical WorkspaceAgentTurn across SDK-native
	// synthetic continuations. Provider turn ids are aliases, never new root
	// WorkspaceAgentTurn ids.
	rootTurnID        string
	rootProviderTurns map[string]struct{}
	// providerAcceptanceOutcomes retains the durable Host acceptance result by
	// exact canonical Turn. Cancel dispatches to the provider first and consults
	// this latch only when the sidecar confirms a provider-active cancellation.
	// Guarded by the adapter mutex.
	providerAcceptanceOutcomes map[string]*claudeSDKProviderAcceptanceOutcome
	// goalArmTurnID is the sidecar turn carrying a queued /goal set command
	// that has not settled yet; until it does, other turns settling must not
	// be read as goal completion. Guarded by the adapter mutex.
	goalArmTurnID string
	// goalClearControlTurns identifies the provider turns created only to carry
	// a native /goal clear command. Claude emits an assistant acknowledgement
	// for those turns, but goal control is thread metadata rather than
	// transcript content, so their assistant/thinking projection is suppressed
	// before persistence. Guarded by the adapter mutex.
	goalClearControlTurns map[string]struct{}
	// Durable goal identity associated with the arm/continuation lifecycle.
	// It is deliberately independent of goalArmTurnID.
	goalOperationID      string
	goalRevision         int64
	goalRepairEpoch      int64
	fencedGoalIdentities map[goalOperationIdentity]struct{}
	fencedGoalTurns      map[string]claudeSDKGoalTurnFenceState
	goalTurnBindings     map[string]claudeSDKGoalTurnBinding
	pendingGoalCommands  map[string]claudeSDKPendingGoalCommand
}

type claudeSDKProviderAcceptanceOutcome struct {
	done chan struct{}
	once sync.Once
	err  error
}

type claudeSDKGoalTurnFenceState uint8

const (
	claudeSDKGoalTurnFenceSuppress claudeSDKGoalTurnFenceState = iota + 1
	claudeSDKGoalTurnFenceSettle
)

type claudeSDKGoalTurnBinding struct {
	turnID          string
	providerTurnID  string
	origin          string
	identity        goalOperationIdentity
	published       bool
	publicationDone chan struct{}
}

type claudeSDKPendingGoalCommand struct {
	identity     goalOperationIdentity
	action       string
	previousGoal map[string]any
	started      bool
}

type claudeSDKCompactMessage struct {
	messageID string
	active    bool
	// terminalStatus makes the first explicit or synthesized terminal update
	// authoritative. A late sidecar result must not overwrite a canceled turn.
	// Guarded by the adapter mutex.
	terminalStatus string
}

type claudeSDKChildSession struct {
	Key                  string
	AgentSessionID       string
	ParentToolUseID      string
	TurnID               string
	RootAgentSessionID   string
	RootTurnID           string
	ParentAgentSessionID string
	ParentTurnID         string
	TaskID               string
	AgentID              string
	Description          string
	Status               string
	Summary              string
	LastToolName         string
	Async                bool
	StartedAtUnixMS      int64
	UpdatedAtUnixMS      int64
	CompletedAtUnixMS    int64
}

type claudeSDKTurnWaiter struct {
	mu        sync.Mutex
	turnID    string
	emit      EventSink
	events    []activityshared.Event
	done      chan claudeSDKTurnResult
	completed bool
}

type claudeSDKTurnResult struct {
	events []activityshared.Event
	err    error
}

type claudeSDKLineReader struct {
	conn                   ProcessConnection
	buffer                 string
	stderrDiagnosticBuffer string
	trackInputUnits        bool
	lines                  []claudeSDKBufferedLine
	// stderrTail keeps only a bounded, sanitized classification of sidecar
	// diagnostics. Raw stderr may contain prompts, paths, credentials, or stack
	// traces and must never enter durable activity or user-visible errors.
	stderrTail []byte
}

type claudeSDKBufferedLine struct {
	value string
	unit  ProviderInputUnit
}

func providerInputUnitsEnabled(conn ProcessConnection) bool {
	_, ok := conn.(ProviderInputUnitCompletion)
	return ok
}

func newClaudeSDKLineReader(
	conn ProcessConnection,
	trackInputUnits bool,
) *claudeSDKLineReader {
	return &claudeSDKLineReader{
		conn:            conn,
		trackInputUnits: trackInputUnits,
	}
}

func NewClaudeCodeSDKAdapter(transport ProcessTransport) *ClaudeCodeSDKAdapter {
	return &ClaudeCodeSDKAdapter{
		transport:             transport,
		sessions:              make(map[string]*claudeSDKAdapterSession),
		retiredSessions:       make(map[string][]*claudeSDKAdapterSession),
		interactiveAckTimeout: claudeSDKInteractiveAckTimeout,
		inputUnits:            providerInputUnitTrackerForTransport(transport),
		lifecycleLocks:        make(map[string]*claudeSDKSessionLock),
	}
}

func (*ClaudeCodeSDKAdapter) Provider() string {
	return ProviderClaudeCode
}

func (*ClaudeCodeSDKAdapter) ConnectorCapabilities(
	context.Context,
	Session,
) (ConnectorCapabilities, error) {
	return ConnectorCapabilities{HTTPMCP: true}, nil
}

func (*ClaudeCodeSDKAdapter) UsesRootProviderTurnLifecycle() bool {
	return true
}

func (a *ClaudeCodeSDKAdapter) SetProviderLaunchPreparer(preparer ProviderLaunchPreparer) {
	if a == nil {
		return
	}
	a.preparer = preparer
}

func (a *ClaudeCodeSDKAdapter) SessionState(session Session) SessionStateSnapshot {
	adapterSession := a.getSession(session.AgentSessionID)
	return SessionStateSnapshot{
		RoomID:             session.RoomID,
		AgentSessionID:     session.AgentSessionID,
		Provider:           session.Provider,
		ProviderSessionID:  session.ProviderSessionID,
		Status:             session.Status,
		TurnLifecycle:      cloneRuntimeTurnLifecycle(session.TurnLifecycle),
		SubmitAvailability: cloneRuntimeSubmitAvailability(session.SubmitAvailability),
		PermissionModeID:   session.PermissionModeID,
		Settings:           cloneOptionalSessionSettings(session.Settings),
		Capabilities:       canonical.NewCapabilitySnapshot(claudeSDKCapabilities(session)),
		RuntimeContext:     claudeSDKRuntimeContext(session, adapterSession),
		PendingInteractive: a.claudeSDKPendingInteractive(adapterSession),
		UpdatedAtUnixMS:    session.UpdatedAtUnixMS,
	}
}

func (a *ClaudeCodeSDKAdapter) SetCommandSnapshotSink(sink CommandSnapshotSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.commandSink = sink
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) SetSessionEventSink(sink SessionEventSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.eventSink = sink
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) SessionCommandSnapshot(session Session) (AgentSessionCommandSnapshot, bool) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return AgentSessionCommandSnapshot{}, false
	}
	return adapterSession.commandSnapshot(session.AgentSessionID)
}
