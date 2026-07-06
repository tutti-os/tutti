//revive:disable:file-length-limit
package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

// Codex app-server JSON-RPC methods used by the adapter. The app-server
// protocol is the official first-party integration surface for Codex; it
// replaces the previous codex-acp (ACP) bridge for the "codex" provider.
const (
	codexAppServerCommand = "codex"
	codexAppServerSubcmd  = "app-server"

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

const codexAppServerAuthRequiredMessage = "Codex requires authentication. " +
	"Run `codex login` on the host (or sync Codex credentials), then retry this session."

// defaultCodexAppServerCancelGraceWindow is how long Cancel waits for codex to
// honor turn/interrupt gracefully before force-closing the app-server process.
const defaultCodexAppServerCancelGraceWindow = 3 * time.Second
const defaultCodexAppServerGoalContinuationGraceWindow = 100 * time.Millisecond

// defaultCodexAppServerTurnSteerTimeout bounds turn/steer, the RPC that
// appends a new submission's input into an already-running turn instead of
// starting a fresh one. turn/steer is meant to be a quick acknowledgment, not
// a call that lives for the turn's whole duration like turn/start — so unlike
// turn/start (unbounded), this must time out. Without a bound, a submission
// steered at the exact moment the running turn completes server-side (codex
// no longer has a turn matching expectedTurnId) can leave codex silently
// never answering, and the unbounded RPC then wedges that submission's own
// turn record forever: the composer stays blocked and every subsequent Exec
// fails with ErrSessionActiveTurn until the daemon restarts.
const defaultCodexAppServerTurnSteerTimeout = 10 * time.Second

// startupModelSteadyRetryCount is how many 30s-spaced model/list retries follow
// the initial fast ramp before the background refresh gives up (~18 minutes
// total), bounding the goroutine while covering realistic transient outages.
const startupModelSteadyRetryCount = 36

type CodexAppServerAdapter struct {
	transport   ProcessTransport
	host        HostMetadata
	mu          sync.Mutex
	sessions    map[string]*codexAppServerSession
	commandSink CommandSnapshotSink
	eventSink   SessionEventSink
	configSink  ConfigOptionsUpdateSink
	// lifecycleMu guards lifecycleLocks; the per-session locks serialize
	// Start/Resume/Close/ReleaseLiveSession per agent session so concurrent
	// lifecycle calls can never leave two live app-server processes for the
	// same session. Different sessions never contend.
	lifecycleMu    sync.Mutex
	lifecycleLocks map[string]*codexAppServerSessionLock
	// cancelGraceWindow bounds the graceful-interrupt wait in Cancel before the
	// process is force-closed. Zero falls back to the default.
	cancelGraceWindow time.Duration
	// startupModelRetryBackoffs is the wait schedule between background model/list
	// refetches when the initial probe came back empty; the slice length bounds
	// the number of retries. Nil falls back to defaultStartupModelRetryBackoffs.
	// Overridable in tests to drive the loop without real delays.
	startupModelRetryBackoffs []time.Duration
	// turnSteerTimeout bounds the turn/steer RPC steerActiveTurn issues when a
	// submission arrives while another turn is already running. Zero falls
	// back to the default. Overridable in tests to drive the timeout without
	// real delays.
	turnSteerTimeout time.Duration
}

type codexAppServerSessionLock struct {
	mu   sync.Mutex
	refs int
}

type codexAppServerSession struct {
	client                 *codexAppServerClient
	threadID               string
	serverInfo             map[string]any
	account                map[string]any
	rateLimits             map[string]any
	goal                   map[string]any
	startupModelsReady     bool
	startupRateLimitsReady bool
	// Collaboration mode masks come from collaborationMode/list. The app-server
	// expects the active mode settings, including developer_instructions, on
	// every turn/start request.
	planModeMask    map[string]any
	defaultModeMask map[string]any
	defaultModel    string
	authState       string
	authMessage     string
	activeTurnID    string
	// lastTurnID survives turn settlement so post-turn child lifecycle
	// markers can carry a turn id (the activity store rejects turnless
	// message updates).
	lastTurnID   string
	activeTurn   *codexAppServerActiveTurn
	childThreads map[string]*codexAppServerThreadContext
	// recentForeignDrops remembers recently dropped unknown thread ids so a
	// late registration can report how many events the ordering gap lost.
	recentForeignDrops map[string]int
	acpLiveState
	pendingRequests map[string]*pendingACPRequest
}

type codexAppServerThreadContext struct {
	parentThreadID string
	parentItemID   string
	normalizer     *acpTurnNormalizer
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
	turnID       string
	session      Session
	ctx          context.Context
	normalizer   *acpTurnNormalizer
	emit         func([]activityshared.Event)
	emitCommands CommandSnapshotSink
	kind         codexAppServerTurnKind
	phase        codexAppServerTurnPhase
	terminal     chan codexAppServerTurnTerminal
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
	return &CodexAppServerAdapter{
		transport:         transport,
		host:              host,
		sessions:          make(map[string]*codexAppServerSession),
		lifecycleLocks:    make(map[string]*codexAppServerSessionLock),
		cancelGraceWindow: defaultCodexAppServerCancelGraceWindow,
		turnSteerTimeout:  defaultCodexAppServerTurnSteerTimeout,
	}
}

// codexOfficialOriginator is the client identifier the first-party Codex CLI
// presents to the backend. Codex derives the outbound request `originator`
// header and User-Agent verbatim from the app-server clientInfo.name, so
// presenting this value (paired with the real codex binary version) makes
// Tutti's request byte-identical to the genuine client and keeps it accepted
// by upstreams that gate on an "official Codex client" allowlist.
const codexOfficialOriginator = "codex_cli_rs"

var (
	codexCLIVersionMu     sync.Mutex
	codexCLIVersionCached string
)

// resolveCodexCLIVersion returns the version of the codex binary that serves
// the app-server (e.g. "0.142.1"), resolved with the same env (PATH) the
// app-server is spawned with so the two agree. The result is cached after the
// first successful lookup; an empty string signals "unknown" so callers can
// fall back.
func resolveCodexCLIVersion(env []string) string {
	codexCLIVersionMu.Lock()
	defer codexCLIVersionMu.Unlock()
	if codexCLIVersionCached != "" {
		return codexCLIVersionCached
	}
	cmd := exec.Command(codexAppServerCommand, "--version")
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
	codexCLIVersionCached = strings.TrimSpace(fields[len(fields)-1])
	return codexCLIVersionCached
}

// codexClientInfoParams builds the app-server initialize clientInfo so the
// outbound originator/User-Agent match the official Codex CLI, resolving the
// codex binary version from the spawn env.
func codexClientInfoParams(host HostMetadata, env []string) map[string]any {
	return codexClientInfoParamsForVersion(host, resolveCodexCLIVersion(env))
}

// codexClientInfoParamsForVersion composes the clientInfo for a known codex
// version, falling back to the host-provided version when it is empty.
func codexClientInfoParamsForVersion(host HostMetadata, version string) map[string]any {
	if strings.TrimSpace(version) == "" {
		version = strings.TrimSpace(host.ClientInfo.Version)
	}
	return map[string]any{
		"name":    codexOfficialOriginator,
		"title":   host.ClientInfo.Title,
		"version": version,
	}
}

func (*CodexAppServerAdapter) Provider() string {
	return ProviderCodex
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

func (a *CodexAppServerAdapter) SetConfigOptionsUpdateSink(sink ConfigOptionsUpdateSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.configSink = sink
	a.mu.Unlock()
}

func (*CodexAppServerAdapter) ValidatePromptContent(Session, []PromptContentBlock) error {
	// Codex app-server accepts text, image, and localImage user input items.
	return nil
}

func (*CodexAppServerAdapter) commandString() string {
	return codexAppServerCommand + " " + codexAppServerSubcmd
}

func (a *CodexAppServerAdapter) Start(ctx context.Context, session Session) (events []activityshared.Event, err error) {
	unlockLifecycle := a.lockSessionLifecycle(session.AgentSessionID)
	defer unlockLifecycle()
	trace := newCodexAppServerStartupTrace(session)
	defer func() {
		trace.Finish(err)
	}()
	// One session owns at most one live app-server process. Starting over a
	// session that already holds a live client replaces it: stop the old
	// client first, then spawn the new process.
	if existing := a.getSession(session.AgentSessionID); existing != nil && existing.client != nil {
		a.rejectPendingRequests(session.AgentSessionID, errPermissionRequestCanceled)
		_ = a.closeLiveSession(session.AgentSessionID)
	}
	client, initializeResult, err := a.startInitializedClient(ctx, session, trace)
	if err != nil {
		return nil, err
	}
	started := false
	keepSession := false
	defer func() {
		if !started {
			_ = client.Close()
		}
		if !keepSession {
			a.removeSession(session.AgentSessionID)
		}
	}()
	serverInfo := appServerInfo(initializeResult)
	a.storeSession(session.AgentSessionID, &codexAppServerSession{
		client:          client,
		serverInfo:      serverInfo,
		acpLiveState:    newACPLiveState(),
		pendingRequests: make(map[string]*pendingACPRequest),
	})

	account, authRequired := a.fetchAccount(ctx, client, session, trace)
	if authRequired {
		a.storeSession(session.AgentSessionID, &codexAppServerSession{
			serverInfo:      serverInfo,
			account:         account,
			authState:       "auth_required",
			authMessage:     codexAppServerAuthRequiredMessage,
			acpLiveState:    newACPLiveState(),
			pendingRequests: make(map[string]*pendingACPRequest),
		})
		keepSession = true
		return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, map[string]any{
			"adapter":          a.commandString(),
			"command":          a.commandString(),
			"agent":            serverInfo,
			"permissionModeId": session.PermissionModeID,
			"authState":        "auth_required",
			"authMessage":      codexAppServerAuthRequiredMessage,
		})}, nil
	}
	models := []map[string]any(nil)
	if codexAppServerNeedsSynchronousModels(session) {
		models = a.fetchModels(ctx, client, session, trace)
	}
	planModeMask, defaultModeMask := a.fetchCollaborationModeMasks(ctx, client, session, trace)

	threadParams := appServerThreadStartParams(session, a.sessionCWD(session))
	trace.Log("thread.start.params", codexAppServerTraceThreadStartParams(session, threadParams, false))
	threadResult, err := trace.TypedCall(acpStartCallTimeout, appServerMethodThreadStart, func() (json.RawMessage, error) {
		return client.ThreadStart(ctx, acpStartCallTimeout, threadParams,
			func(ctx context.Context, message acpMessage) error {
				trace.LogMessage(message.Method, len(message.ID) > 0, len(message.Params))
				_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
				return err
			})
	})
	if err != nil {
		var callErr *acpCallError
		if errors.As(err, &callErr) && callErr.AuthRequired() {
			a.storeSession(session.AgentSessionID, &codexAppServerSession{
				serverInfo:      serverInfo,
				account:         account,
				authState:       "auth_required",
				authMessage:     codexAppServerAuthRequiredMessage,
				acpLiveState:    newACPLiveState(),
				pendingRequests: make(map[string]*pendingACPRequest),
			})
			keepSession = true
			return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, map[string]any{
				"adapter":          a.commandString(),
				"command":          a.commandString(),
				"agent":            serverInfo,
				"permissionModeId": session.PermissionModeID,
				"authState":        "auth_required",
				"authMessage":      codexAppServerAuthRequiredMessage,
			})}, nil
		}
		return nil, err
	}
	threadID, err := appServerThreadID(threadResult)
	if err != nil {
		return nil, err
	}
	session.ProviderSessionID = threadID
	trace.Log("thread.id.resolved", map[string]any{
		"thread_id": threadID,
	})
	slog.Info("agent session app-server thread started",
		"event", "agent_session.app_server.thread_start.succeeded",
		"provider", ProviderCodex,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", threadID,
	)

	liveState := newACPLiveState()
	liveState.currentMode = codexACPEffectiveModeID(session)
	liveState.availableCommands = codexAppServerCommands()
	liveState.commandsKnown = true
	applyACPConfigOptionDescriptors(&liveState, codexAppServerConfigOptionDescriptors(models, session, threadResult))

	started = true
	keepSession = true
	a.storeSession(session.AgentSessionID, &codexAppServerSession{
		client:                 client,
		threadID:               threadID,
		serverInfo:             serverInfo,
		account:                account,
		startupModelsReady:     len(models) > 0,
		startupRateLimitsReady: false,
		planModeMask:           planModeMask,
		defaultModeMask:        defaultModeMask,
		defaultModel:           codexAppServerSessionDefaultModel(session, models),
		authState:              "authenticated",
		acpLiveState:           liveState,
		pendingRequests:        make(map[string]*pendingACPRequest),
	})
	a.refreshStartupMetadataAsync(session, threadResult, len(models) == 0, true, trace)
	a.emitCommandSnapshot(AgentSessionCommandSnapshot{
		AgentSessionID: strings.TrimSpace(session.AgentSessionID),
		Commands:       codexAppServerCommands(),
	})
	return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, map[string]any{
		"adapter":          a.commandString(),
		"command":          a.commandString(),
		"agent":            serverInfo,
		"permissionModeId": session.PermissionModeID,
	})}, nil
}

func (a *CodexAppServerAdapter) Resume(ctx context.Context, session Session) (err error) {
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		return missingProviderSessionResumeError(session)
	}
	unlockLifecycle := a.lockSessionLifecycle(session.AgentSessionID)
	defer unlockLifecycle()
	// Resume may run over a session that still holds a live client. Unlike
	// Start, the old client is kept alive until the replacement has resumed
	// successfully (storeSession closes it on replace): if the new spawn or
	// thread/resume fails, the previous session must remain usable.
	trace := newCodexAppServerStartupTrace(session)
	defer func() {
		trace.Finish(err)
	}()
	trace.Log("resume.begin", map[string]any{
		"thread_id": strings.TrimSpace(session.ProviderSessionID),
	})
	client, initializeResult, err := a.startInitializedClient(ctx, session, trace)
	if err != nil {
		return err
	}
	started := false
	keepSession := false
	previousSession := a.getSession(session.AgentSessionID)
	defer func() {
		if !started {
			_ = client.Close()
		}
		if !keepSession {
			if previousSession != nil {
				a.storeSession(session.AgentSessionID, previousSession)
			} else {
				a.removeSession(session.AgentSessionID)
			}
		}
	}()
	serverInfo := appServerInfo(initializeResult)

	account, authRequired := a.fetchAccount(ctx, client, session, trace)
	if authRequired {
		a.storeSession(session.AgentSessionID, &codexAppServerSession{
			threadID:        session.ProviderSessionID,
			serverInfo:      serverInfo,
			account:         account,
			authState:       "auth_required",
			authMessage:     codexAppServerAuthRequiredMessage,
			acpLiveState:    newACPLiveState(),
			pendingRequests: make(map[string]*pendingACPRequest),
		})
		keepSession = true
		return nil
	}
	models := []map[string]any(nil)
	if codexAppServerNeedsSynchronousModels(session) {
		models = a.fetchModels(ctx, client, session, trace)
	}
	planModeMask, defaultModeMask := a.fetchCollaborationModeMasks(ctx, client, session, trace)

	params := appServerThreadStartParams(session, a.sessionCWD(session))
	params["threadId"] = strings.TrimSpace(session.ProviderSessionID)
	trace.Log("thread.start.params", codexAppServerTraceThreadStartParams(session, params, true))
	// codex replays thread/tokenUsage/updated during thread/resume so the GUI
	// can show context fill before a new turn runs. The resumed session is not
	// stored yet, so applyTokenUsage cannot reach it; capture the replayed
	// usage here and fold it into the live state below.
	var replayedUsage acpUsageState
	replayedUsageKnown := false
	threadResult, err := trace.TypedCall(acpStartCallTimeout, appServerMethodThreadResume, func() (json.RawMessage, error) {
		return client.ThreadResume(ctx, acpStartCallTimeout, params,
			func(ctx context.Context, message acpMessage) error {
				trace.LogMessage(message.Method, len(message.ID) > 0, len(message.Params))
				if message.Method == appServerNotifyTokenUsage && len(message.Params) > 0 {
					tokenParams := map[string]any{}
					if json.Unmarshal(message.Params, &tokenParams) == nil {
						if usage, ok := appServerTokenUsageState(tokenParams); ok {
							replayedUsage = usage
							replayedUsageKnown = true
						}
					}
				}
				_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
				return err
			})
	})
	if err != nil {
		return classifyACPResumeError(session, appServerMethodThreadResume, err)
	}
	liveState := newACPLiveState()
	liveState.currentMode = codexACPEffectiveModeID(session)
	liveState.availableCommands = codexAppServerCommands()
	liveState.commandsKnown = true
	applyACPConfigOptionDescriptors(&liveState, codexAppServerConfigOptionDescriptors(models, session, threadResult))
	if replayedUsageKnown {
		liveState.usage = mergeACPUsageState(liveState.usage, replayedUsage)
	}

	started = true
	keepSession = true
	a.storeSession(session.AgentSessionID, &codexAppServerSession{
		client:                 client,
		threadID:               strings.TrimSpace(session.ProviderSessionID),
		serverInfo:             serverInfo,
		account:                account,
		startupModelsReady:     len(models) > 0,
		startupRateLimitsReady: false,
		planModeMask:           planModeMask,
		defaultModeMask:        defaultModeMask,
		defaultModel:           codexAppServerSessionDefaultModel(session, models),
		authState:              "authenticated",
		acpLiveState:           liveState,
		pendingRequests:        make(map[string]*pendingACPRequest),
	})
	a.refreshStartupMetadataAsync(session, threadResult, len(models) == 0, true, trace)
	// Mirror Start: push the command snapshot so a resumed session advertises
	// review/compact/undo to the GUI (otherwise the slash palette and the
	// review picker only work on freshly created sessions).
	a.emitCommandSnapshot(AgentSessionCommandSnapshot{
		AgentSessionID: strings.TrimSpace(session.AgentSessionID),
		Commands:       codexAppServerCommands(),
	})
	return nil
}

func (*CodexAppServerAdapter) CanResume(session Session) bool {
	return strings.TrimSpace(session.ProviderSessionID) != ""
}

func (a *CodexAppServerAdapter) HasLiveSession(session Session) bool {
	appSession := a.getSession(session.AgentSessionID)
	return appSession != nil && appSession.client != nil
}

func (a *CodexAppServerAdapter) Close(_ context.Context, session Session) error {
	if a == nil {
		return nil
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	unlockLifecycle := a.lockSessionLifecycle(agentSessionID)
	defer unlockLifecycle()
	a.rejectPendingRequests(agentSessionID, errPermissionRequestCanceled)
	return a.closeLiveSession(agentSessionID)
}

func (a *CodexAppServerAdapter) ReleaseLiveSession(_ context.Context, session Session) error {
	if a == nil {
		return nil
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	unlockLifecycle := a.lockSessionLifecycle(agentSessionID)
	defer unlockLifecycle()
	if a.hasLiveSessionWork(agentSessionID) {
		return ErrLiveSessionBusy
	}
	return a.closeLiveSession(agentSessionID)
}

func (a *CodexAppServerAdapter) closeLiveSession(agentSessionID string) error {
	a.mu.Lock()
	appSession := a.sessions[agentSessionID]
	delete(a.sessions, agentSessionID)
	a.mu.Unlock()
	if appSession != nil && appSession.client != nil {
		return appSession.client.Close()
	}
	return nil
}

func (a *CodexAppServerAdapter) startInitializedClient(
	ctx context.Context,
	session Session,
	trace *codexAppServerStartupTrace,
) (*codexAppServerClient, json.RawMessage, error) {
	if a == nil || a.transport == nil {
		return nil, nil, errors.New("app-server process transport is unavailable")
	}
	trace.Log("process.start.begin", map[string]any{
		"command": strings.Join([]string{codexAppServerCommand, codexAppServerSubcmd}, " "),
		"cwd":     a.sessionCWD(session),
	})
	processStartedAt := time.Now()
	spawnEnv := append(codexACPEnv(session, a.host), session.Env...)
	conn, err := a.transport.Start(ctx, ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: session.AgentSessionID,
		RoomID:         session.RoomID,
		CWD:            a.sessionCWD(session),
		Command:        []string{codexAppServerCommand, codexAppServerSubcmd},
		Env:            spawnEnv,
	})
	if err != nil {
		trace.Log("process.start.failed", map[string]any{
			"duration_ms": time.Since(processStartedAt).Milliseconds(),
			"error":       err.Error(),
		})
		return nil, nil, err
	}
	trace.Log("process.start.succeeded", map[string]any{
		"duration_ms": time.Since(processStartedAt).Milliseconds(),
	})
	client := newCodexAppServerClient(conn)
	client.SetStderrSink(trace.LogStderr)
	// The session-level handler receives every message that arrives outside
	// an in-flight RPC. Because turn/start responds immediately while the
	// turn keeps streaming, this is the main delivery path for turn output:
	// resolve the active turn context so notifications keep producing
	// activity events after the RPC has returned.
	client.SetMessageHandler(func(ctx context.Context, message acpMessage) error {
		turnSession := session
		turnID := ""
		var normalizer *acpTurnNormalizer
		var turnEmit func([]activityshared.Event)
		var turnEmitCommands CommandSnapshotSink
		if activeTurn := a.sessionActiveTurn(session.AgentSessionID); activeTurn != nil {
			turnSession = activeTurn.session
			turnID = activeTurn.turnID
			normalizer = activeTurn.normalizer
			turnEmit = activeTurn.emit
			turnEmitCommands = activeTurn.emitCommands
		}
		events, err := a.handleAppServerMessage(ctx, client, turnSession, turnID, message, normalizer, turnEmit, turnEmitCommands)
		if turnEmit != nil {
			turnEmit(events)
		}
		return err
	})
	started := false
	defer func() {
		if !started {
			_ = client.Close()
		}
	}()

	initializeResult, err := trace.TypedCall(acpStartCallTimeout, appServerMethodInitialize, func() (json.RawMessage, error) {
		return client.Initialize(ctx, acpStartCallTimeout, map[string]any{
			"clientInfo": codexClientInfoParams(a.host, spawnEnv),
			"capabilities": map[string]any{
				"experimentalApi": true,
			},
		}, func(ctx context.Context, message acpMessage) error {
			trace.LogMessage(message.Method, len(message.ID) > 0, len(message.Params))
			_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
			return err
		})
	})
	if err != nil {
		slog.Warn("agent session app-server initialize failed",
			"event", "agent_session.app_server.initialize.failed",
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"error", err.Error(),
		)
		return nil, nil, err
	}
	trace.Log("initialized.notify.begin", nil)
	notifyStartedAt := time.Now()
	if err := client.Initialized(ctx); err != nil {
		trace.Log("initialized.notify.failed", map[string]any{
			"duration_ms": time.Since(notifyStartedAt).Milliseconds(),
			"error":       err.Error(),
		})
		return nil, nil, err
	}
	trace.Log("initialized.notify.succeeded", map[string]any{
		"duration_ms": time.Since(notifyStartedAt).Milliseconds(),
	})
	started = true
	return client, initializeResult, nil
}

func (a *CodexAppServerAdapter) fetchAccount(
	ctx context.Context,
	client *codexAppServerClient,
	session Session,
	trace *codexAppServerStartupTrace,
) (map[string]any, bool) {
	result, err := trace.TypedCall(acpStartCallTimeout, appServerMethodAccountRead, func() (json.RawMessage, error) {
		return client.AccountRead(ctx, acpStartCallTimeout, map[string]any{},
			func(ctx context.Context, message acpMessage) error {
				trace.LogMessage(message.Method, len(message.ID) > 0, len(message.Params))
				_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
				return err
			})
	})
	if err != nil {
		// Account introspection is best-effort; authentication problems will
		// surface from thread/start instead.
		return nil, false
	}
	var payload struct {
		Account            map[string]any `json:"account"`
		RequiresOpenaiAuth bool           `json:"requiresOpenaiAuth"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil, false
	}
	trace.Log("account.parsed", map[string]any{
		"has_account":          payload.Account != nil,
		"requires_openai_auth": payload.RequiresOpenaiAuth,
	})
	return payload.Account, payload.RequiresOpenaiAuth && payload.Account == nil
}

func (a *CodexAppServerAdapter) fetchModels(
	ctx context.Context,
	client *codexAppServerClient,
	session Session,
	trace *codexAppServerStartupTrace,
) []map[string]any {
	result, err := trace.TypedCall(acpStartCallTimeout, appServerMethodModelList, func() (json.RawMessage, error) {
		return client.ModelList(ctx, acpStartCallTimeout, map[string]any{},
			func(ctx context.Context, message acpMessage) error {
				trace.LogMessage(message.Method, len(message.ID) > 0, len(message.Params))
				_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
				return err
			})
	})
	if err != nil {
		return nil
	}
	var payload struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil
	}
	trace.Log("models.parsed", map[string]any{
		"count": len(payload.Data),
	})
	return payload.Data
}

func (*CodexAppServerAdapter) fetchModelsNoHandler(
	ctx context.Context,
	client *codexAppServerClient,
	trace *codexAppServerStartupTrace,
) []map[string]any {
	result, err := trace.TypedCallNoHandler(acpStartCallTimeout, appServerMethodModelList, func() (json.RawMessage, error) {
		return client.ModelListNoHandler(ctx, acpStartCallTimeout, map[string]any{})
	})
	if err != nil {
		return nil
	}
	var payload struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil
	}
	trace.Log("background_models.parsed", map[string]any{
		"count": len(payload.Data),
	})
	return payload.Data
}

func (*CodexAppServerAdapter) fetchRateLimitsNoHandler(
	ctx context.Context,
	client *codexAppServerClient,
	trace *codexAppServerStartupTrace,
) map[string]any {
	result, err := trace.TypedCallNoHandler(acpStartCallTimeout, appServerMethodRateLimitsRead, func() (json.RawMessage, error) {
		return client.AccountRateLimitsReadNoHandler(ctx, acpStartCallTimeout)
	})
	if err != nil {
		return nil
	}
	var payload struct {
		RateLimits map[string]any `json:"rateLimits"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil
	}
	trace.Log("background_rate_limits.parsed", map[string]any{
		"has_rate_limits": payload.RateLimits != nil,
	})
	return payload.RateLimits
}

// fetchCollaborationModeMasks probes the experimental collaboration mode list
// and returns the Plan and Default preset masks. The turn/start payload is
// assembled per turn because the schema requires a concrete settings.model.
// Best effort: any error means the capability stays off.
func (a *CodexAppServerAdapter) fetchCollaborationModeMasks(
	ctx context.Context,
	client *codexAppServerClient,
	session Session,
	trace *codexAppServerStartupTrace,
) (map[string]any, map[string]any) {
	result, err := trace.TypedCall(acpStartCallTimeout, appServerMethodCollaborationModeList, func() (json.RawMessage, error) {
		return client.CollaborationModeList(ctx, acpStartCallTimeout,
			func(ctx context.Context, message acpMessage) error {
				trace.LogMessage(message.Method, len(message.ID) > 0, len(message.Params))
				_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
				return err
			})
	})
	if err != nil {
		return nil, nil
	}
	var payload struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil, nil
	}
	trace.Log("collaboration_modes.parsed", map[string]any{
		"count": len(payload.Data),
	})
	var planModeMask map[string]any
	var defaultModeMask map[string]any
	for _, preset := range payload.Data {
		mode := strings.ToLower(strings.TrimSpace(firstNonEmpty(asString(preset["mode"]), asString(preset["name"]))))
		switch mode {
		case "plan":
			trace.Log("plan_collaboration_mode.found", nil)
			planModeMask = clonePayload(preset)
		case "default":
			trace.Log("default_collaboration_mode.found", nil)
			defaultModeMask = clonePayload(preset)
		}
	}
	if planModeMask == nil {
		trace.Log("plan_collaboration_mode.missing", nil)
	}
	if defaultModeMask == nil {
		trace.Log("default_collaboration_mode.missing", nil)
	}
	return planModeMask, defaultModeMask
}

// codexAppServerDefaultModel resolves the default model id from model/list,
// used to satisfy the required CollaborationMode.settings.model field.
func codexAppServerDefaultModel(models []map[string]any) string {
	for _, model := range models {
		if isDefault, _ := model["isDefault"].(bool); isDefault {
			if id := strings.TrimSpace(firstNonEmpty(asString(model["id"]), asString(model["model"]))); id != "" {
				return id
			}
		}
	}
	for _, model := range models {
		if id := strings.TrimSpace(firstNonEmpty(asString(model["id"]), asString(model["model"]))); id != "" {
			return id
		}
	}
	return ""
}

func codexAppServerNeedsSynchronousModels(session Session) bool {
	return strings.TrimSpace(session.SettingsValue().Model) == ""
}

func codexAppServerSessionDefaultModel(session Session, models []map[string]any) string {
	return firstNonEmpty(strings.TrimSpace(session.SettingsValue().Model), codexAppServerDefaultModel(models))
}

func codexAppServerTraceThreadStartParams(session Session, params map[string]any, resume bool) map[string]any {
	settings := session.SettingsValue()
	fields := map[string]any{
		"resume":             resume,
		"cwd":                asString(params["cwd"]),
		"has_thread_id":      strings.TrimSpace(asString(params["threadId"])) != "",
		"model":              asString(params["model"]),
		"settings_model":     settings.Model,
		"settings_plan_mode": settings.PlanMode,
		"permission_mode_id": session.PermissionModeID,
		"approval_policy":    asString(params["approvalPolicy"]),
		"sandbox":            asString(params["sandbox"]),
		"env_count":          len(session.Env),
	}
	if config := payloadObject(params["config"]); len(config) > 0 {
		fields["config_keys"] = sortedMapKeys(config)
		fields["reasoning_effort"] = asString(config["model_reasoning_effort"])
		fields["service_tier"] = asString(config["service_tier"])
		fields["reasoning_summary"] = asString(config[codexACPConfigModelReasoningSummary])
	}
	return fields
}

func codexAppServerTraceTurnStartParams(session Session, params map[string]any, content []PromptContentBlock) map[string]any {
	settings := session.SettingsValue()
	fields := map[string]any{
		"thread_id":          asString(params["threadId"]),
		"has_thread_id":      strings.TrimSpace(asString(params["threadId"])) != "",
		"model":              asString(params["model"]),
		"effort":             asString(params["effort"]),
		"summary":            asString(params["summary"]),
		"settings_model":     settings.Model,
		"settings_plan_mode": settings.PlanMode,
		"permission_mode_id": session.PermissionModeID,
		"approval_policy":    asString(params["approvalPolicy"]),
		"content":            codexAppServerTracePromptContent(content),
	}
	if sandboxPolicy := payloadObject(params["sandboxPolicy"]); len(sandboxPolicy) > 0 {
		fields["sandbox_policy_keys"] = sortedMapKeys(sandboxPolicy)
	}
	if collaborationMode := payloadObject(params["collaborationMode"]); len(collaborationMode) > 0 {
		fields["collaboration_mode_keys"] = sortedMapKeys(collaborationMode)
		fields["collaboration_mode"] = firstNonEmpty(asString(collaborationMode["mode"]), asString(collaborationMode["name"]))
	}
	return fields
}

func codexAppServerTracePromptContent(content []PromptContentBlock) map[string]any {
	typeCounts := map[string]int{}
	textBytes := 0
	dataBytes := 0
	attachments := 0
	paths := 0
	for _, block := range content {
		blockType := strings.TrimSpace(block.Type)
		if blockType == "" {
			blockType = "unknown"
		}
		typeCounts[blockType]++
		textBytes += len(block.Text)
		dataBytes += len(block.Data)
		if strings.TrimSpace(block.AttachmentID) != "" {
			attachments++
		}
		if strings.TrimSpace(block.Path) != "" {
			paths++
		}
	}
	return map[string]any{
		"block_count":      len(content),
		"type_counts":      typeCounts,
		"text_bytes":       textBytes,
		"data_bytes":       dataBytes,
		"attachment_count": attachments,
		"path_count":       paths,
	}
}

func sortedMapKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (a *CodexAppServerAdapter) refreshStartupMetadataAsync(
	session Session,
	threadResult json.RawMessage,
	fetchModels bool,
	fetchRateLimits bool,
	trace *codexAppServerStartupTrace,
) {
	if a == nil || (!fetchModels && !fetchRateLimits) {
		return
	}
	a.mu.Lock()
	hasEventSink := a.eventSink != nil
	a.mu.Unlock()
	if !hasEventSink {
		return
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	if agentSessionID == "" {
		return
	}
	threadResult = append(json.RawMessage(nil), threadResult...)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				trace.Log("background_metadata.panic", map[string]any{
					"panic": fmt.Sprint(recovered),
				})
			}
		}()
		ctx := context.Background()
		if fetchRateLimits {
			if appSession := a.getSession(agentSessionID); appSession != nil && appSession.client != nil {
				rateLimits := a.fetchRateLimitsNoHandler(ctx, appSession.client, trace)
				if a.applyRateLimits(agentSessionID, rateLimits) {
					a.emitStartupMetadataRefreshEvent(session, agentSessionID)
				}
			}
		}
		if fetchModels {
			// fetchModels re-resolves the session each attempt so the loop keeps
			// working against a live client and stops once the session is gone.
			fetch := func(ctx context.Context) []map[string]any {
				appSession := a.getSession(agentSessionID)
				if appSession == nil || appSession.client == nil {
					return nil
				}
				return a.fetchModelsNoHandler(ctx, appSession.client, trace)
			}
			sleep := func(ctx context.Context, d time.Duration) bool {
				return sleepWithContext(ctx, d) == nil
			}
			if a.retryStartupModels(ctx, agentSessionID, session, threadResult, fetch, sleep) {
				a.emitStartupMetadataRefreshEvent(session, agentSessionID)
			}
		}
	}()
}

// retryStartupModels re-fetches the codex model/list until it returns a
// non-empty list (and the startup state resolves to "ready"), the session is
// torn down, the context is canceled, or the bounded backoff budget is
// exhausted. A single transient empty/slow response therefore no longer pins
// the composer's model options at "loading" forever — the previous code fetched
// exactly once and silently left the state stuck on failure.
func (a *CodexAppServerAdapter) retryStartupModels(
	ctx context.Context,
	agentSessionID string,
	session Session,
	threadResult json.RawMessage,
	fetch func(context.Context) []map[string]any,
	sleep func(context.Context, time.Duration) bool,
) bool {
	if a == nil || fetch == nil {
		return false
	}
	backoffs := a.startupModelRetryBackoffs
	if backoffs == nil {
		backoffs = defaultStartupModelRetryBackoffs()
	}
	for attempt := 0; attempt <= len(backoffs); attempt++ {
		if a.getSession(agentSessionID) == nil {
			return false
		}
		models := fetch(ctx)
		if a.applyStartupModels(agentSessionID, session, threadResult, models) {
			if attempt > 0 {
				slog.Info("agent session app-server model list resolved after retry",
					"agent_session_id", agentSessionID,
					"attempts", attempt+1,
				)
			}
			return true
		}
		if attempt == len(backoffs) {
			break
		}
		if sleep != nil && !sleep(ctx, backoffs[attempt]) {
			return false
		}
	}
	slog.Warn("agent session app-server model list never resolved",
		"agent_session_id", agentSessionID,
		"attempts", len(backoffs)+1,
	)
	return false
}

func (a *CodexAppServerAdapter) emitStartupMetadataRefreshEvent(session Session, agentSessionID string) {
	a.emitSessionEvents(agentSessionID, []activityshared.Event{
		newSessionActivityEvent(session, EventSessionUpdated, SessionStatusReady, map[string]any{
			"appServerMetadataRefresh": true,
		}),
	})
}

// defaultStartupModelRetryBackoffs ramps quickly then settles at a steady 30s
// cadence, giving codex time to recover from transient hiccups (rate limits,
// a still-materializing platform package, a slow first model/list) while
// keeping the background goroutine bounded.
func defaultStartupModelRetryBackoffs() []time.Duration {
	backoffs := []time.Duration{
		time.Second,
		2 * time.Second,
		5 * time.Second,
		10 * time.Second,
	}
	for i := 0; i < startupModelSteadyRetryCount; i++ {
		backoffs = append(backoffs, 30*time.Second)
	}
	return backoffs
}

func (a *CodexAppServerAdapter) applyStartupModels(
	agentSessionID string,
	session Session,
	threadResult json.RawMessage,
	models []map[string]any,
) bool {
	if len(models) == 0 {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return false
	}
	applyACPConfigOptionDescriptors(&appSession.acpLiveState, codexAppServerConfigOptionDescriptors(models, session, threadResult))
	appSession.defaultModel = codexAppServerSessionDefaultModel(session, models)
	appSession.startupModelsReady = true
	return true
}

func (a *CodexAppServerAdapter) emitSessionEvents(agentSessionID string, events []activityshared.Event) {
	if a == nil || len(events) == 0 {
		return
	}
	a.mu.Lock()
	sink := a.eventSink
	a.mu.Unlock()
	if sink == nil {
		return
	}
	sink(agentSessionID, events)
}

func (a *CodexAppServerAdapter) Exec(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) ([]activityshared.Event, error) {
	return a.execBlocking(ctx, session, content, displayPrompt, turnID, emit, emitCommands)
}

func (a *CodexAppServerAdapter) ExecAsync(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) error {
	go func() {
		if _, err := a.execBlocking(ctx, session, content, displayPrompt, turnID, emit, emitCommands); err != nil {
			if emit == nil {
				return
			}
			if errors.Is(err, context.Canceled) {
				emit([]activityshared.Event{newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
					"error": err.Error(),
				})})
				return
			}
			emit([]activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(err))})
		}
	}()
	return nil
}

func (appTurn *codexAppServerActiveTurn) markTerminated() {
	appTurn.terminatedOnce.Do(func() { close(appTurn.terminated) })
}

// markTurnSettleEmits flips the turn to settle-path terminal emission just
// before the provider turn is submitted, under the adapter mutex so the
// notification loop observes it consistently.
func (a *CodexAppServerAdapter) markTurnSettleEmits(appTurn *codexAppServerActiveTurn) {
	if a == nil || appTurn == nil {
		return
	}
	a.mu.Lock()
	appTurn.settleEmits = true
	a.mu.Unlock()
}

// finalizeSettledTurn produces the settled turn's terminal events from the
// notification path, releases the active-turn slot, and signals terminated —
// terminal production no longer depends on a parked goroutine (ADR 0005 C).
// Classification mirrors the blocking shell exactly; the shell's turnClosed
// guard drops any duplicate.
func (a *CodexAppServerAdapter) finalizeSettledTurn(agentSessionID string, appTurn *codexAppServerActiveTurn, terminal codexAppServerTurnTerminal) {
	if a == nil || appTurn == nil || appTurn.emitTerminal == nil {
		return
	}
	appTurn.settleFinalized.Store(true)
	session := appTurn.session
	turnID := appTurn.turnID
	if terminal.err != nil {
		if errors.Is(terminal.err, context.Canceled) ||
			errors.Is(terminal.err, errPermissionRequestCanceled) ||
			a.turnForceCanceled(appTurn) ||
			terminal.phase == codexAppServerTurnPhaseCanceled {
			terminalEvents := a.pendingRequestFailureEvents(session, turnID, errPermissionRequestCanceled)
			terminalEvents = append(terminalEvents, appTurn.normalizer.FinishInterrupted(session, turnID, "interrupted")...)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
				"error": terminal.err.Error(),
			}))
			appTurn.emitTerminal(terminalEvents)
		} else {
			terminalEvents := appTurn.normalizer.FinishFailed(session, turnID)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(terminal.err)))
			appTurn.emitTerminal(terminalEvents)
		}
	} else {
		appTurn.normalizer.ApplyAssistantFinalText(appServerTurnFinalAssistantText(terminal.turn))
		appTurn.emitTerminal(appServerTurnTerminalEvents(session, turnID, terminal.turn, appTurn.normalizer))
	}
	a.endActiveTurn(agentSessionID, appTurn)
	appTurn.markTerminated()
}

// settleTurnExternal settles THIS turn (pointer match) from an external
// death signal — context cancellation or client death — as a first-class
// machine transition instead of a parked-goroutine select arm.
func (a *CodexAppServerAdapter) settleTurnExternal(agentSessionID string, appTurn *codexAppServerActiveTurn, terminal codexAppServerTurnTerminal) {
	if a == nil || appTurn == nil {
		return
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	settled := false
	if appSession != nil && appSession.activeTurn == appTurn && !appTurn.phase.terminal() {
		appTurn.phase = terminal.phase
		appSession.activeTurnID = ""
		settled = true
	}
	emits := settled && appTurn.settleEmits
	a.mu.Unlock()
	if !settled {
		return
	}
	select {
	case appTurn.terminal <- terminal:
	default:
	}
	if emits {
		a.finalizeSettledTurn(agentSessionID, appTurn, terminal)
	}
}

// watchTurnExternalTermination translates external death signals (context
// cancellation, client death) into turn-machine transitions. It exits as
// soon as the turn terminates through any path.
func (a *CodexAppServerAdapter) watchTurnExternalTermination(appSession *codexAppServerSession, appTurn *codexAppServerActiveTurn) {
	select {
	case <-appTurn.terminated:
	case <-appTurn.ctx.Done():
		a.settleTurnExternal(appTurn.session.AgentSessionID, appTurn, codexAppServerTurnTerminal{
			err: appTurn.ctx.Err(), phase: codexAppServerTurnPhaseCanceled,
		})
	case <-appSession.client.Done():
		err := appSession.client.Err()
		if err == nil {
			err = ErrSessionDisconnected
		}
		a.settleTurnExternal(appTurn.session.AgentSessionID, appTurn, codexAppServerTurnTerminal{
			err: err, phase: codexAppServerTurnPhaseFailed,
		})
	}
}

func (a *CodexAppServerAdapter) execBlocking(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) ([]activityshared.Event, error) {
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return nil, ErrSessionDisconnected
	}
	session.ProviderSessionID = appSession.threadID
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	mentionRoutingApplied, mentionRoutingSkills := tuttiMentionRoutingSkills(visibleText)
	providerContent := content
	if mentionRoutingApplied {
		providerContent = appendTuttiMentionRoutingContent(providerContent, mentionRoutingSkills)
	}

	if activeTurnID := a.sessionActiveTurnID(session.AgentSessionID); activeTurnID != "" {
		return a.steerActiveTurn(ctx, appSession, session, content, providerContent, explicitDisplayPrompt, visibleText, turnID, activeTurnID, emit)
	}

	normalizer := newACPTurnNormalizer()
	// The emit mutex is held across the sink callback: after `turn/start`
	// responds, streaming notifications are emitted from the client read
	// loop while this goroutine waits, so emissions must be serialized.
	// Terminal events close the turn: anything a handler emits afterwards
	// (for example a rejected approval resolving during cancel) is dropped,
	// so the turn outcome event is always the last one the controller sees.
	var eventsMu sync.Mutex
	var events []activityshared.Event
	turnClosed := false
	emitLocked := func(next []activityshared.Event) {
		events = append(events, next...)
		if emit != nil {
			emit(next)
		}
	}
	emitEvents := func(next []activityshared.Event) {
		if len(next) == 0 {
			return
		}
		eventsMu.Lock()
		defer eventsMu.Unlock()
		if turnClosed {
			return
		}
		emitLocked(next)
	}
	emitTerminal := func(next []activityshared.Event) {
		eventsMu.Lock()
		defer eventsMu.Unlock()
		if turnClosed {
			return
		}
		turnClosed = true
		if len(next) > 0 {
			emitLocked(next)
		}
	}
	snapshotEvents := func() []activityshared.Event {
		eventsMu.Lock()
		defer eventsMu.Unlock()
		return append([]activityshared.Event(nil), events...)
	}
	startEvents := make([]activityshared.Event, 0, 3)
	if fallbackTitle := fallbackACPFamilySessionTitle(session.Title, visibleText, "", ProviderCodex); fallbackTitle != "" {
		startEvents = append(startEvents, newSessionTitleActivityEvent(session, fallbackTitle))
		session.Title = fallbackTitle
	}
	startEvents = append(startEvents,
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, visibleText, userPromptActivityPayload(content, explicitDisplayPrompt, userPromptActivityPayloadExtraFromExecMetadata(ctx, nil))),
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
	)
	emitEvents(startEvents)

	appTurn := &codexAppServerActiveTurn{
		turnID:       turnID,
		session:      session,
		ctx:          ctx,
		normalizer:   normalizer,
		emit:         emitEvents,
		emitCommands: emitCommands,
		kind:         codexAppServerTurnKindNormal,
		phase:        codexAppServerTurnPhaseRunning,
		terminal:     make(chan codexAppServerTurnTerminal, 1),
		terminated:   make(chan struct{}),
	}
	appTurn.emitTerminal = emitTerminal
	// Signal turn termination once this goroutine returns (after terminal events
	// are emitted), so a concurrent Cancel only responds after the turn stopped.
	// The settle path may finalize first; the Once keeps the close single.
	defer appTurn.markTerminated()
	if !a.beginActiveTurn(session.AgentSessionID, appTurn) {
		return nil, ErrSessionActiveTurn
	}
	defer a.endActiveTurn(session.AgentSessionID, appTurn)

	if handled, err := a.execSlashCommand(ctx, appSession, session, visibleText, turnID, appTurn, normalizer, emitEvents, emitTerminal, emitCommands); handled {
		return snapshotEvents(), err
	}

	// From here on the settle path (notification loop) owns terminal event
	// production; the blocking shell below only waits and returns.
	a.markTurnSettleEmits(appTurn)

	trace := newCodexAppServerTurnTrace(session, turnID, execMetadataFromContext(ctx))
	turnParams := appServerTurnStartParams(session, appSession.threadID, providerContent, appSession.planModeMask, appSession.defaultModeMask, appSession.defaultModel)
	trace.Log("turn.start.params", codexAppServerTraceTurnStartParams(session, turnParams, providerContent))
	turnStartedAt := time.Now()
	result, err := appSession.client.TurnStart(ctx, turnParams,
		func(ctx context.Context, message acpMessage) error {
			trace.LogMessage(message.Method, len(message.ID) > 0, len(message.Params))
			next, err := a.handleAppServerMessage(ctx, appSession.client, session, turnID, message, normalizer, emitEvents, emitCommands)
			emitEvents(next)
			return err
		})
	if err != nil {
		trace.Log("turn.start.failed", map[string]any{
			"duration_ms": time.Since(turnStartedAt).Milliseconds(),
			"error":       err.Error(),
		})
		a.endActiveTurn(session.AgentSessionID, appTurn)
		if errors.Is(err, context.Canceled) || errors.Is(err, errPermissionRequestCanceled) {
			terminalEvents := a.pendingRequestFailureEvents(session, turnID, errPermissionRequestCanceled)
			terminalEvents = append(terminalEvents, normalizer.FinishInterrupted(session, turnID, "interrupted")...)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
				"error": err.Error(),
			}))
			emitTerminal(terminalEvents)
		} else {
			terminalEvents := normalizer.FinishFailed(session, turnID)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(err)))
			emitTerminal(terminalEvents)
		}
		return snapshotEvents(), nil
	}
	trace.Log("turn.start.succeeded", map[string]any{
		"duration_ms": time.Since(turnStartedAt).Milliseconds(),
		"result_size": len(result),
	})

	// The app-server responds to turn/start immediately with the inProgress
	// turn; the real output streams as notifications and the final turn
	// arrives with the turn/completed notification.
	initialTurn := appServerTurnFromResult(result)
	if providerTurnID := asString(initialTurn["id"]); providerTurnID != "" {
		if a.setSessionActiveTurnID(session.AgentSessionID, providerTurnID) {
			a.interruptActiveTurnAsync(appSession, session, appTurn, providerTurnID, "queued cancel")
		}
	}
	go a.watchTurnExternalTermination(appSession, appTurn)
	finalTurn, finishErr := a.awaitTurnCompletion(ctx, appSession, appTurn, initialTurn)
	// The settle path finalizes AFTER delivering the terminal channel value:
	// wait for terminated (closed at the end of finalize) so the snapshot
	// includes the terminal events. The timeout is a safety net for any
	// settle hole; the shell classification below then covers it.
	select {
	case <-appTurn.terminated:
	case <-time.After(2 * time.Second):
	}
	a.endActiveTurn(session.AgentSessionID, appTurn)
	if appTurn.settleFinalized.Load() {
		// The settle path already produced the terminal events.
		return snapshotEvents(), nil
	}
	slog.Warn(
		"agent session app-server turn terminal produced by blocking shell (settle shadow miss)",
		"agent_session_id", session.AgentSessionID,
		"turn_id", turnID,
	)
	if finishErr != nil {
		if errors.Is(finishErr, context.Canceled) || errors.Is(finishErr, errPermissionRequestCanceled) || a.turnForceCanceled(appTurn) {
			terminalEvents := a.pendingRequestFailureEvents(session, turnID, errPermissionRequestCanceled)
			terminalEvents = append(terminalEvents, normalizer.FinishInterrupted(session, turnID, "interrupted")...)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
				"error": finishErr.Error(),
			}))
			emitTerminal(terminalEvents)
		} else {
			terminalEvents := normalizer.FinishFailed(session, turnID)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(finishErr)))
			emitTerminal(terminalEvents)
		}
		return snapshotEvents(), nil
	}
	normalizer.ApplyAssistantFinalText(appServerTurnFinalAssistantText(finalTurn))
	emitTerminal(appServerTurnTerminalEvents(session, turnID, finalTurn, normalizer))
	return snapshotEvents(), nil
}

// pendingRequestFailureEvents resolves any still-pending approval or
// interactive requests as failed, so a canceled turn does not leave
// dangling approval cards. The handlers waiting on those requests emit
// their own resolution later, but the turn is closed by then and the
// duplicate emission is dropped.
func (a *CodexAppServerAdapter) pendingRequestFailureEvents(
	session Session,
	turnID string,
	cause error,
) []activityshared.Event {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	pendings := make([]*pendingACPRequest, 0)
	if appSession != nil {
		for _, pending := range appSession.pendingRequests {
			pendings = append(pendings, pending)
		}
	}
	a.mu.Unlock()
	var events []activityshared.Event
	for _, pending := range pendings {
		events = append(events, acpPermissionResolvedEvents(session, turnID, pending, pendingACPResponse{}, cause)...)
	}
	return events
}

// awaitTurnCompletion blocks until the turn finishes. When the turn/start
// (or review/start) response already reports a terminal status it is used
// directly; otherwise the final turn payload comes from the turn/completed
// notification via the active turn context.
func (a *CodexAppServerAdapter) awaitTurnCompletion(
	ctx context.Context,
	appSession *codexAppServerSession,
	appTurn *codexAppServerActiveTurn,
	initialTurn map[string]any,
) (map[string]any, error) {
	if appServerTurnStatusTerminal(initialTurn) {
		a.completeActiveTurn(appTurn.session.AgentSessionID, initialTurn)
	}
	select {
	case terminal := <-appTurn.terminal:
		return terminal.turn, terminal.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-appSession.client.Done():
		err := appSession.client.Err()
		if err == nil {
			err = ErrSessionDisconnected
		}
		return nil, err
	}
}

func appServerTurnStatusTerminal(turn map[string]any) bool {
	switch asString(turn["status"]) {
	case "completed", "failed", "interrupted", "canceled":
		return true
	default:
		return false
	}
}

func (a *CodexAppServerAdapter) steerActiveTurn(
	ctx context.Context,
	appSession *codexAppServerSession,
	session Session,
	content []PromptContentBlock,
	providerContent []PromptContentBlock,
	explicitDisplayPrompt string,
	displayPrompt string,
	turnID string,
	activeTurnID string,
	emit EventSink,
) ([]activityshared.Event, error) {
	timeout := a.turnSteerTimeout
	if timeout <= 0 {
		timeout = defaultCodexAppServerTurnSteerTimeout
	}
	_, err := appSession.client.TurnSteerNoHandler(ctx, timeout, map[string]any{
		"threadId":       appSession.threadID,
		"expectedTurnId": activeTurnID,
		"input":          appServerUserInput(providerContent),
	})
	if err != nil {
		// A codex that no longer has a turn matching expectedTurnId (for
		// example this steer raced the running turn's own completion) may
		// never answer turn/steer at all; TurnSteerNoHandler's bounded
		// timeout turns that into a plain error here instead of hanging
		// forever. The caller (execBlocking) surfaces this as a normal turn
		// failure for THIS submission's own turn id, so ExecAsync's error
		// path emits turn.failed and the controller's existing
		// turnHasTerminalEvent check settles the record — the composer
		// unblocks instead of staying wedged until a daemon restart.
		return nil, err
	}
	events := []activityshared.Event{
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, displayPrompt, userPromptActivityPayload(content, explicitDisplayPrompt, userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
			"steered": true,
		}))),
	}
	if emit != nil {
		emit(events)
	}
	return events, nil
}

func (a *CodexAppServerAdapter) execSlashCommand(
	ctx context.Context,
	appSession *codexAppServerSession,
	session Session,
	displayPrompt string,
	turnID string,
	appTurn *codexAppServerActiveTurn,
	normalizer *acpTurnNormalizer,
	emitEvents func([]activityshared.Event),
	emitTerminal func([]activityshared.Event),
	emitCommands CommandSnapshotSink,
) (bool, error) {
	command, args := splitSlashCommand(displayPrompt)
	switch command {
	case appServerSlashCompact:
		a.transitionActiveTurnPhase(session.AgentSessionID, appTurn, codexAppServerTurnPhaseCompacting)
		_, err := appSession.client.ThreadCompactStart(ctx, map[string]any{
			"threadId": appSession.threadID,
		}, a.appServerMessageHandler(appSession, session, turnID, normalizer, emitEvents, emitCommands))
		if err != nil {
			emitTerminal([]activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(err))})
			return true, nil
		}
		// Block until the App Server signals turn/completed. The session-level
		// handler keeps activeTurn alive during this wait, so the
		// contextCompaction item/completed notification fires appServerItemEvents
		// and emits the "Context compacted." banner through emitEvents before we
		// close the turn.
		_, finishErr := a.awaitTurnCompletion(ctx, appSession, appTurn, nil)
		if finishErr != nil {
			if errors.Is(finishErr, context.Canceled) || errors.Is(finishErr, errPermissionRequestCanceled) || a.turnForceCanceled(appTurn) {
				emitTerminal(append(
					normalizer.FinishInterrupted(session, turnID, "interrupted"),
					newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
						"error": finishErr.Error(),
					}),
				))
			} else {
				emitTerminal(append(
					normalizer.FinishFailed(session, turnID),
					newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(finishErr)),
				))
			}
			return true, nil
		}
		emitTerminal(append(
			normalizer.FinishCompleted(session, turnID),
			newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", map[string]any{
				"stopReason":             "end_turn",
				"completedCommandKind":   "compact",
				"completedCommandStatus": "completed",
			}),
		))
		return true, nil
	case appServerSlashGoal:
		method, params := appServerGoalSlashRequest(args, appSession.threadID)
		goalObjective := strings.TrimSpace(asString(params["objective"]))
		result, err := appSession.callGoal(ctx, method, params,
			a.appServerMessageHandler(appSession, session, turnID, normalizer, emitEvents, emitCommands))
		if err != nil {
			emitTerminal([]activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(err))})
			return true, nil
		}
		if method == appServerMethodThreadGoalClear {
			a.applyGoalClear(session.AgentSessionID)
		} else if goal := appServerGoalFromResult(result); len(goal) > 0 {
			a.applyGoalUpdate(session.AgentSessionID, goal)
		}
		if method == appServerMethodThreadGoalSet && goalObjective != "" {
			initialTurn := appServerTurnFromResult(result)
			if providerTurnID := asString(initialTurn["id"]); providerTurnID != "" {
				if a.setSessionActiveTurnID(session.AgentSessionID, providerTurnID) {
					a.interruptActiveTurnAsync(appSession, session, appTurn, providerTurnID, "queued cancel")
				}
			}
			finalTurn, finishErr := a.awaitGoalOperationCompletion(
				ctx,
				appSession,
				session,
				turnID,
				appTurn,
				initialTurn,
				normalizer,
				emitEvents,
				emitCommands,
			)
			a.endActiveTurn(session.AgentSessionID, appTurn)
			if finishErr != nil {
				if errors.Is(finishErr, context.Canceled) || errors.Is(finishErr, errPermissionRequestCanceled) || a.turnForceCanceled(appTurn) {
					terminalEvents := a.pendingRequestFailureEvents(session, turnID, errPermissionRequestCanceled)
					terminalEvents = append(terminalEvents, normalizer.FinishInterrupted(session, turnID, "interrupted")...)
					terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
						"error": finishErr.Error(),
					}))
					emitTerminal(terminalEvents)
				} else {
					terminalEvents := normalizer.FinishFailed(session, turnID)
					terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(finishErr)))
					emitTerminal(terminalEvents)
				}
				return true, nil
			}
			normalizer.ApplyAssistantFinalText(appServerTurnFinalAssistantText(finalTurn))
			emitTerminal(appServerTurnTerminalEvents(session, turnID, finalTurn, normalizer))
			return true, nil
		}
		terminalEvents := []activityshared.Event{}
		if notice := appServerGoalNoticeEvent(session, turnID, method, result); notice != nil {
			terminalEvents = append(terminalEvents, *notice)
		}
		terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", map[string]any{
			"stopReason": "end_turn",
		}))
		emitTerminal(terminalEvents)
		return true, nil
	case appServerSlashReview:
		return a.execReviewSlashCommand(ctx, appSession, session, args, turnID, appTurn, normalizer, emitEvents, emitTerminal, emitCommands)
	case appServerSlashUndo:
		_, err := appSession.client.ThreadRollback(ctx, map[string]any{
			"threadId": appSession.threadID,
			"numTurns": 1,
		}, a.appServerMessageHandler(appSession, session, turnID, normalizer, emitEvents, emitCommands))
		if err != nil {
			emitTerminal([]activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(err))})
			return true, nil
		}
		emitTerminal([]activityshared.Event{
			appServerSystemNoticeEvent(session, turnID, "system_notice", "Removed the last turn from the conversation. Local file changes are not reverted.", ""),
			newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", map[string]any{
				"stopReason": "end_turn",
			}),
		})
		return true, nil
	default:
		return false, nil
	}
}

func (a *CodexAppServerAdapter) awaitGoalOperationCompletion(
	ctx context.Context,
	appSession *codexAppServerSession,
	session Session,
	turnID string,
	appTurn *codexAppServerActiveTurn,
	initialTurn map[string]any,
	normalizer *acpTurnNormalizer,
	emitEvents func([]activityshared.Event),
	emitCommands CommandSnapshotSink,
) (map[string]any, error) {
	nextInitialTurn := initialTurn
	for {
		finalTurn, err := a.awaitTurnCompletion(ctx, appSession, appTurn, nextInitialTurn)
		if err != nil {
			return nil, err
		}
		if !a.shouldContinueActiveGoalAfterTurn(session.AgentSessionID, finalTurn) {
			return finalTurn, nil
		}
		normalizer.ApplyAssistantFinalText(appServerTurnFinalAssistantText(finalTurn))
		emitEvents(normalizer.FinishCompleted(session, turnID))
		nextTurn, continued, err := a.waitForAutomaticGoalContinuation(ctx, session.AgentSessionID, appTurn)
		if err != nil {
			return nil, err
		}
		if continued {
			nextInitialTurn = nextTurn
			continue
		}
		continued, err = a.requestActiveGoalContinuation(ctx, appSession, session, turnID, normalizer, emitEvents, emitCommands)
		if err != nil {
			return nil, err
		}
		if !continued {
			return finalTurn, nil
		}
		nextInitialTurn = nil
	}
}

func (a *CodexAppServerAdapter) waitForAutomaticGoalContinuation(
	ctx context.Context,
	agentSessionID string,
	appTurn *codexAppServerActiveTurn,
) (map[string]any, bool, error) {
	timer := time.NewTimer(defaultCodexAppServerGoalContinuationGraceWindow)
	defer timer.Stop()
	select {
	case terminal := <-appTurn.terminal:
		return terminal.turn, true, terminal.err
	case <-ctx.Done():
		return nil, false, ctx.Err()
	case <-timer.C:
		if a.sessionActiveTurnID(agentSessionID) != "" {
			return nil, true, nil
		}
		return nil, false, nil
	}
}

func (a *CodexAppServerAdapter) shouldContinueActiveGoalAfterTurn(agentSessionID string, turn map[string]any) bool {
	if strings.TrimSpace(asString(turn["status"])) != "completed" {
		return false
	}
	return strings.TrimSpace(asString(a.sessionGoal(agentSessionID)["status"])) == "active"
}

func (a *CodexAppServerAdapter) sessionGoal(agentSessionID string) map[string]any {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return nil
	}
	return clonePayload(appSession.goal)
}

func (a *CodexAppServerAdapter) requestActiveGoalContinuation(
	ctx context.Context,
	appSession *codexAppServerSession,
	session Session,
	turnID string,
	normalizer *acpTurnNormalizer,
	emitEvents func([]activityshared.Event),
	emitCommands CommandSnapshotSink,
) (bool, error) {
	goal := a.sessionGoal(session.AgentSessionID)
	if strings.TrimSpace(asString(goal["status"])) != "active" {
		return false, nil
	}
	params := map[string]any{
		"threadId": appSession.threadID,
		"status":   "active",
	}
	if objective := strings.TrimSpace(asStringRaw(goal["objective"])); objective != "" {
		params["objective"] = objective
	}
	result, err := appSession.client.ThreadGoalSet(
		ctx,
		params,
		a.appServerMessageHandler(appSession, session, turnID, normalizer, emitEvents, emitCommands),
	)
	if err != nil {
		return true, err
	}
	if nextGoal := appServerGoalFromResult(result); len(nextGoal) > 0 {
		a.applyGoalUpdate(session.AgentSessionID, nextGoal)
	}
	return true, nil
}

func (a *CodexAppServerAdapter) Cancel(ctx context.Context, session Session, reason string) ([]activityshared.Event, error) {
	reason = strings.TrimSpace(reason)
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return nil, ErrSessionDisconnected
	}
	childEvents := a.interruptLinkedChildThreads(session, appSession, a.sessionMarkerTurnID(session.AgentSessionID), reason)
	activeTurnID, queued := a.requestActiveTurnCancel(session.AgentSessionID)
	// Unblock any handler waiting on an approval answer first: the message
	// read loop is parked inside that handler, so the interrupt response
	// could never be dispatched otherwise.
	a.rejectPendingRequests(session.AgentSessionID, errPermissionRequestCanceled)
	if activeTurnID == "" {
		if queued {
			return childEvents, nil
		}
		if len(childEvents) > 0 {
			return childEvents, nil
		}
		return nil, ErrSessionNoActiveTurn
	}
	appTurn := a.sessionActiveTurn(session.AgentSessionID)
	return childEvents, a.interruptActiveTurn(ctx, appSession, session, appTurn, activeTurnID, reason)
}

// interruptActiveTurn stops the active turn. It first asks codex to cancel
// gracefully via turn/interrupt; if the turn has not terminated within the
// grace window it force-closes the app-server process so the turn can never
// hang forever. It returns only after the turn has actually terminated
// (terminate-then-respond), so the caller's UI can clear its stopping state
// against a real outcome.
func (a *CodexAppServerAdapter) interruptActiveTurn(
	ctx context.Context,
	appSession *codexAppServerSession,
	session Session,
	appTurn *codexAppServerActiveTurn,
	activeTurnID string,
	reason string,
) error {
	// Best-effort graceful interrupt, sent asynchronously: a wedged codex may
	// never answer turn/interrupt, and a synchronous call would burn the whole
	// acpPermissionModeTimeout before the grace window even starts. Firing it in
	// the background keeps time-to-force bounded by cancelGraceWindow.
	go a.sendTurnInterrupt(appSession, session, activeTurnID, reason)

	// Without a turn handle we cannot wait for termination or force-close.
	if appTurn == nil {
		return nil
	}

	grace := a.cancelGraceWindow
	if grace <= 0 {
		grace = defaultCodexAppServerCancelGraceWindow
	}
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-appTurn.terminated:
		// codex honored the interrupt; the turn finished gracefully.
		return nil
	case <-timer.C:
	}

	// codex did not stop in time — force-close the app-server process. The torn
	// down connection unblocks awaitTurnCompletion via client.Done(), and the
	// force-canceled flag makes Exec surface the outcome as canceled.
	a.markTurnForceCanceled(appTurn)
	slog.Warn("agent session app-server force-closing wedged turn",
		"event", "agent_session.app_server.interrupt.forced",
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", appSession.threadID,
		"turn_id", activeTurnID,
		"reason", reason,
		"grace_ms", grace.Milliseconds(),
	)
	_ = appSession.client.Close()

	// Wait for the turn goroutine to finalize so we respond after it stopped.
	select {
	case <-appTurn.terminated:
	case <-ctx.Done():
	}
	return nil
}

// sendTurnInterrupt issues a best-effort turn/interrupt. It is called in the
// background so a hung interrupt RPC cannot delay the force-close grace window.
func (a *CodexAppServerAdapter) sendTurnInterrupt(
	appSession *codexAppServerSession,
	session Session,
	activeTurnID string,
	reason string,
) {
	a.sendThreadInterrupt(appSession.client, session, appSession.threadID, activeTurnID, reason)
}

// scheduleChildNicknameFetches resolves spawned sub-agents' display names.
// codex assigns each spawned agent an agentNickname on its Thread object but
// never pushes it (no thread/name/updated for children), so - like traycer -
// we fetch it asynchronously via thread/read and emit a subAgentName marker.
func (a *CodexAppServerAdapter) scheduleChildNicknameFetches(session Session, childThreadIDs []string) {
	if a == nil || len(childThreadIDs) == 0 {
		return
	}
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return
	}
	client := appSession.client
	for _, childThreadID := range childThreadIDs {
		go a.fetchChildThreadNickname(client, session, childThreadID)
	}
}

func (a *CodexAppServerAdapter) fetchChildThreadNickname(client *codexAppServerClient, session Session, childThreadID string) {
	childThreadID = strings.TrimSpace(childThreadID)
	if client == nil || childThreadID == "" {
		return
	}
	// The nickname can be assigned slightly after the spawn item announces the
	// thread; retry a few times before giving up (numbered fallback remains).
	for attempt := 0; attempt < 5; attempt++ {
		if attempt > 0 {
			select {
			case <-client.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), acpStartCallTimeout)
		raw, err := client.ThreadReadNoHandler(ctx, acpStartCallTimeout, map[string]any{
			"threadId": childThreadID,
		})
		cancel()
		if err != nil {
			continue
		}
		result := map[string]any{}
		_ = json.Unmarshal(raw, &result)
		thread := payloadObject(result["thread"])
		nickname := firstNonEmpty(asString(thread["agentNickname"]), asString(thread["name"]))
		if nickname == "" {
			continue
		}
		event := appServerSubAgentNameEvent(session, childThreadID, nickname)
		if event.Type == "" {
			return
		}
		if child, ok := a.appServerChildThread(session.AgentSessionID, childThreadID); ok {
			event.OwnerCallID = child.parentItemID
		}
		if event.Payload.TurnID == "" {
			// The activity store rejects turnless message updates.
			event.Payload.TurnID = a.sessionMarkerTurnID(session.AgentSessionID)
		}
		a.emitSessionEvents(session.AgentSessionID, []activityshared.Event{event})
		return
	}
}

func (*CodexAppServerAdapter) sendThreadInterrupt(
	client *codexAppServerClient,
	session Session,
	threadID string,
	turnID string,
	reason string,
) {
	threadID = strings.TrimSpace(threadID)
	if client == nil || threadID == "" {
		return
	}
	turnID = strings.TrimSpace(turnID)
	err := codexSendTurnInterruptOnce(client, threadID, turnID)
	if err != nil {
		// Our own turn bookkeeping settles a turn locally as soon as its Go
		// context is canceled (see Cancel/interruptActiveTurn), without
		// waiting for the app-server to actually confirm the turn stopped.
		// When a slow-to-terminate tool call (for example wait_agent on
		// several dispatched sub-agents) keeps the app-server's real turn
		// alive past that point, a subsequent interrupt aimed at the turn id
		// we *think* is active gets rejected with "expected active turn id X
		// but found Y". Retry once against Y so the real, still-running turn
		// actually gets interrupted instead of being abandoned to die on its
		// own — which otherwise can leave it running for minutes.
		if foundTurnID, ok := codexExpectedActiveTurnIDMismatch(err); ok && foundTurnID != turnID {
			slog.Warn("agent session app-server interrupt turn id stale, retrying",
				"event", "agent_session.app_server.interrupt.turn_id_stale",
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", threadID,
				"requested_turn_id", turnID,
				"actual_turn_id", foundTurnID,
				"reason", reason,
			)
			err = codexSendTurnInterruptOnce(client, threadID, foundTurnID)
		}
	}
	if err != nil {
		slog.Warn("agent session app-server interrupt failed",
			"event", "agent_session.app_server.interrupt.failed",
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", threadID,
			"turn_id", turnID,
			"reason", reason,
			"error", err.Error(),
		)
	}
}

func codexSendTurnInterruptOnce(client *codexAppServerClient, threadID, turnID string) error {
	interruptCtx, cancel := context.WithTimeout(context.Background(), acpPermissionModeTimeout)
	defer cancel()
	_, err := client.TurnInterruptNoHandler(interruptCtx, acpPermissionModeTimeout, map[string]any{
		"threadId": threadID,
		"turnId":   turnID,
	})
	return err
}

// codexExpectedActiveTurnIDMismatch recognizes the codex app-server's
// turn/interrupt rejection for a stale expected turn id: "expected active
// turn id <requested> but found <actual>". It reports actual so the caller
// can retry against the turn codex itself considers active. JSON-RPC -32600
// is the generic "invalid request" code the app-server reuses for several
// distinct rejections (see isACPProviderSessionNotFound), so this keys off
// the distinctive message text rather than the code.
func codexExpectedActiveTurnIDMismatch(err error) (string, bool) {
	var callErr *acpCallError
	if !errors.As(err, &callErr) || callErr == nil {
		return "", false
	}
	message := strings.TrimSpace(callErr.Err.Message)
	lower := strings.ToLower(message)
	if !strings.Contains(lower, "expected active turn id") {
		return "", false
	}
	const marker = "but found "
	idx := strings.LastIndex(lower, marker)
	if idx < 0 {
		return "", false
	}
	rest := strings.TrimSpace(message[idx+len(marker):])
	if sp := strings.IndexAny(rest, " \t\n"); sp >= 0 {
		rest = rest[:sp]
	}
	rest = strings.Trim(rest, ".,;")
	if rest == "" {
		return "", false
	}
	return rest, true
}

func (a *CodexAppServerAdapter) interruptLinkedChildThreads(
	session Session,
	appSession *codexAppServerSession,
	markerTurnID string,
	reason string,
) []activityshared.Event {
	if a == nil || appSession == nil || appSession.client == nil {
		return nil
	}
	linkedChildren := a.takeLinkedChildThreads(session.AgentSessionID)
	if len(linkedChildren) == 0 {
		return nil
	}
	events := make([]activityshared.Event, 0, len(linkedChildren))
	for _, child := range linkedChildren {
		go a.sendThreadInterrupt(appSession.client, session, child.threadID, "", reason)
		event := appServerSubAgentLifecycleEvent(session, child.threadID, markerTurnID, "canceled", reason)
		if event.Type != "" {
			event.OwnerCallID = child.parentItemID
			events = append(events, event)
		}
	}
	return events
}

type linkedChildThread struct {
	threadID     string
	parentItemID string
}

func (a *CodexAppServerAdapter) takeLinkedChildThreads(agentSessionID string) []linkedChildThread {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil || len(appSession.childThreads) == 0 {
		return nil
	}
	children := make([]linkedChildThread, 0, len(appSession.childThreads))
	for childThreadID, child := range appSession.childThreads {
		trimmed := strings.TrimSpace(childThreadID)
		if trimmed == "" {
			continue
		}
		linked := linkedChildThread{threadID: trimmed}
		if child != nil {
			linked.parentItemID = child.parentItemID
		}
		children = append(children, linked)
	}
	sort.Slice(children, func(left, right int) bool {
		return children[left].threadID < children[right].threadID
	})
	appSession.childThreads = nil
	return children
}

func (a *CodexAppServerAdapter) markTurnForceCanceled(turn *codexAppServerActiveTurn) {
	if a == nil || turn == nil {
		return
	}
	a.mu.Lock()
	turn.forceCanceled = true
	agentSessionID := turn.session.AgentSessionID
	emits := turn.settleEmits && !turn.phase.terminal()
	turn.phase = codexAppServerTurnPhaseCanceled
	a.mu.Unlock()
	terminal := codexAppServerTurnTerminal{err: errPermissionRequestCanceled, phase: codexAppServerTurnPhaseCanceled}
	select {
	case turn.terminal <- terminal:
	default:
	}
	// Force-cancel is a first-class terminal transition: finalize from here
	// so terminal events do not depend on the (possibly wedged) shell.
	if emits {
		a.finalizeSettledTurn(agentSessionID, turn, terminal)
	}
}

func (a *CodexAppServerAdapter) turnForceCanceled(turn *codexAppServerActiveTurn) bool {
	if a == nil || turn == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return turn.forceCanceled
}

func (a *CodexAppServerAdapter) interruptActiveTurnAsync(
	appSession *codexAppServerSession,
	session Session,
	appTurn *codexAppServerActiveTurn,
	activeTurnID string,
	reason string,
) {
	go func() {
		if err := a.interruptActiveTurn(context.Background(), appSession, session, appTurn, activeTurnID, reason); err != nil {
			slog.Warn("agent session app-server queued interrupt failed",
				"event", "agent_session.app_server.interrupt.queued_failed",
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", appSession.threadID,
				"turn_id", activeTurnID,
				"reason", reason,
				"error", err.Error(),
			)
		}
	}()
}

func (a *CodexAppServerAdapter) ApplyPermissionMode(_ context.Context, session Session) error {
	// The app-server protocol has no live "set mode" call; the permission mode
	// maps to approvalPolicy/sandboxPolicy overrides applied on every
	// turn/start. Record the mode so session state reflects it immediately.
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	if appSession == nil {
		return nil
	}
	if modeID := codexACPEffectiveModeID(session); modeID != "" {
		appSession.currentMode = modeID
	}
	return nil
}

func (a *CodexAppServerAdapter) ApplySessionSettings(
	_ context.Context,
	session Session,
	patch SessionSettingsPatch,
) error {
	// Model and reasoning effort are applied as per-turn overrides on the next
	// turn/start; no live RPC is required. Mirror the values into the config
	// option state so pickers stay in sync.
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	if appSession == nil {
		return nil
	}
	appSession.ensureInitialized()
	if patch.Model != nil {
		if model := strings.TrimSpace(*patch.Model); model != "" {
			appSession.configOptions["model"] = model
			updateConfigOptionDescriptorValue(appSession.configOptionDescriptors, "model", model)
		}
	}
	if patch.ReasoningEffort != nil {
		if reasoning := codexACPReasoningEffortValue(*patch.ReasoningEffort); reasoning != "" {
			appSession.configOptions["reasoning_effort"] = reasoning
			updateConfigOptionDescriptorValue(appSession.configOptionDescriptors, "reasoning_effort", reasoning)
		}
	}
	if patch.Speed != nil {
		// Speed (service_tier) is applied as a config override on the next
		// thread/start; mirror it into the picker state so the dropdown stays
		// in sync. "standard" clears the override.
		if speed := strings.TrimSpace(*patch.Speed); speed != "" {
			appSession.configOptions["service_tier"] = speed
			updateConfigOptionDescriptorValue(appSession.configOptionDescriptors, "service_tier", speed)
		}
	}
	return nil
}

func (*CodexAppServerAdapter) RequiresNewSessionForSettings(Session, SessionSettingsPatch) bool {
	// The app-server supports per-turn model/effort overrides, so settings
	// changes never require recreating the session.
	return false
}

func (a *CodexAppServerAdapter) SessionState(session Session) SessionStateSnapshot {
	snapshot := SessionStateSnapshot{
		RoomID:            session.RoomID,
		AgentSessionID:    session.AgentSessionID,
		Provider:          session.Provider,
		ProviderSessionID: session.ProviderSessionID,
		Status:            session.Status,
		PermissionModeID:  session.PermissionModeID,
		RuntimeContext: map[string]any{
			"cwd":              session.CWD,
			"title":            session.Title,
			"permissionModeId": session.PermissionModeID,
		},
		UpdatedAtUnixMS: session.UpdatedAtUnixMS,
	}
	state, ok := a.snapshotSessionState(session.AgentSessionID)
	if !ok {
		return snapshot
	}
	if len(state.serverInfo) > 0 {
		snapshot.RuntimeContext["agent"] = state.serverInfo
	}
	if len(state.account) > 0 {
		snapshot.RuntimeContext["account"] = state.account
	}
	if len(state.rateLimits) > 0 {
		snapshot.RuntimeContext["rateLimits"] = state.rateLimits
	}
	snapshot.RuntimeContext["appServerStartup"] = map[string]any{
		"models":     codexAppServerStartupStatus(state.startupModelsReady),
		"rateLimits": codexAppServerStartupStatus(state.startupRateLimitsReady),
	}
	if len(state.goal) > 0 {
		snapshot.RuntimeContext["goal"] = state.goal
	}
	if state.authState != "" {
		snapshot.AuthState = state.authState
	}
	if state.authMessage != "" {
		snapshot.RuntimeContext["authMessage"] = state.authMessage
	}
	if state.currentMode != "" {
		snapshot.RuntimeContext["mode"] = state.currentMode
	}
	if len(state.availableCommands) > 0 {
		snapshot.RuntimeContext["commands"] = agentSessionCommandNames(state.availableCommands)
	}
	if len(state.configOptions) > 0 {
		snapshot.RuntimeContext["config"] = state.configOptions
	}
	if len(state.configOptionDescriptors) > 0 {
		snapshot.RuntimeContext["configOptions"] = state.configOptionDescriptors
	}
	if providerConfig := providerRuntimeConfig(session, session.Provider); len(providerConfig) > 0 {
		snapshot.RuntimeContext["providerConfig"] = providerConfig
	}
	if usage := acpUsageRuntimeContext(state.usage); len(usage) > 0 {
		snapshot.RuntimeContext["usage"] = usage
	}
	codexCapabilities := codexAppServerCapabilities(state.planModeSupported)
	codexCapabilities = appendBrowserUseCapability(codexCapabilities, session.Env)
	codexCapabilities = appendComputerUseCapability(codexCapabilities, session.Env)
	snapshot.RuntimeContext["capabilities"] = codexCapabilities
	snapshot.Settings = sessionSettingsWithACPConfig(
		session.Settings,
		session.Provider,
		session.PermissionModeID,
		state.configOptions,
		true,
	)
	if snapshot.Settings != nil {
		snapshot.RuntimeContext["model"] = snapshot.Settings.Model
		snapshot.RuntimeContext["reasoningEffort"] = snapshot.Settings.ReasoningEffort
		snapshot.RuntimeContext["speed"] = snapshot.Settings.Speed
		snapshot.RuntimeContext["planMode"] = snapshot.Settings.PlanMode
	}
	if state.pendingPrompt != nil {
		snapshot.PendingInteractive = state.pendingPrompt
	}
	return snapshot
}

func codexAppServerStartupStatus(ready bool) string {
	if ready {
		return "ready"
	}
	return "loading"
}

type codexAppServerSessionStateSnapshot struct {
	serverInfo             map[string]any
	account                map[string]any
	rateLimits             map[string]any
	startupModelsReady     bool
	startupRateLimitsReady bool
	goal                   map[string]any
	authState              string
	authMessage            string
	planModeSupported      bool
	acpLiveStateSnapshot
	pendingPrompt *SessionInteractivePrompt
}

func (a *CodexAppServerAdapter) snapshotSessionState(agentSessionID string) (codexAppServerSessionStateSnapshot, bool) {
	if a == nil {
		return codexAppServerSessionStateSnapshot{}, false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return codexAppServerSessionStateSnapshot{}, false
	}
	var prompt *SessionInteractivePrompt
	for _, pending := range appSession.pendingRequests {
		prompt = pending.snapshotPrompt()
		break
	}
	return codexAppServerSessionStateSnapshot{
		serverInfo:             clonePayload(appSession.serverInfo),
		account:                clonePayload(appSession.account),
		rateLimits:             clonePayload(appSession.rateLimits),
		startupModelsReady:     appSession.startupModelsReady,
		startupRateLimitsReady: appSession.startupRateLimitsReady,
		goal:                   clonePayload(appSession.goal),
		authState:              strings.TrimSpace(appSession.authState),
		authMessage:            strings.TrimSpace(appSession.authMessage),
		planModeSupported:      appSession.planModeMask != nil,
		acpLiveStateSnapshot:   snapshotACPLiveState(appSession.acpLiveState),
		pendingPrompt:          prompt,
	}, true
}

func (a *CodexAppServerAdapter) SessionCommandSnapshot(session Session) (AgentSessionCommandSnapshot, bool) {
	if a == nil {
		return AgentSessionCommandSnapshot{}, false
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	if appSession == nil {
		a.mu.Unlock()
		return AgentSessionCommandSnapshot{}, false
	}
	snapshot, ok := commandSnapshotFromACPLiveState(session.AgentSessionID, appSession.acpLiveState)
	a.mu.Unlock()
	return snapshot, ok
}

func (a *CodexAppServerAdapter) SubmitInteractive(ctx context.Context, session Session, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
	requestID := strings.TrimSpace(input.RequestID)
	if requestID == "" {
		return SubmitInteractiveResult{}, errors.New("interactive request id is required")
	}
	pending := a.getPendingRequest(session.AgentSessionID, requestID)
	if pending == nil {
		return SubmitInteractiveResult{}, fmt.Errorf("interactive request %q is no longer live", requestID)
	}
	if pending.callType == "approval" {
		optionID := strings.TrimSpace(input.OptionID)
		if optionID == "" && input.Payload != nil {
			optionID = strings.TrimSpace(asString(input.Payload["optionId"]))
		}
		if optionID == "" {
			return SubmitInteractiveResult{}, errors.New("interactive option id is required")
		}
		resolvedOptionID, ok := pending.resolvePermissionOptionID(optionID)
		if !ok {
			return SubmitInteractiveResult{}, fmt.Errorf("permission option %q is not available for request %q", optionID, requestID)
		}
		select {
		case <-ctx.Done():
			return SubmitInteractiveResult{}, ctx.Err()
		case pending.response <- pendingACPResponse{optionID: resolvedOptionID}:
			return SubmitInteractiveResult{
				AgentSessionID: session.AgentSessionID,
				RequestID:      requestID,
				Accepted:       true,
				OptionID:       resolvedOptionID,
			}, nil
		default:
			return SubmitInteractiveResult{}, fmt.Errorf("permission request %q has already been answered", requestID)
		}
	}
	optionID := strings.TrimSpace(input.OptionID)
	action := strings.TrimSpace(input.Action)
	payload := clonePayload(input.Payload)
	select {
	case <-ctx.Done():
		return SubmitInteractiveResult{}, ctx.Err()
	case pending.response <- pendingACPResponse{
		optionID: optionID,
		action:   action,
		payload:  payload,
	}:
	default:
		return SubmitInteractiveResult{}, fmt.Errorf("interactive request %q has already been answered", requestID)
	}
	return SubmitInteractiveResult{
		AgentSessionID: session.AgentSessionID,
		RequestID:      requestID,
		Accepted:       true,
	}, nil
}

// lockSessionLifecycle serializes lifecycle operations (Start, Resume, Close,
// ReleaseLiveSession) for one agent session: any interleaving of these calls
// could otherwise spawn a second app-server process while the first is still
// live, or close the wrong process. The lock entry is refcounted so the map
// does not grow with retired session IDs.
func (a *CodexAppServerAdapter) lockSessionLifecycle(agentSessionID string) func() {
	if a == nil {
		return func() {}
	}
	key := strings.TrimSpace(agentSessionID)
	a.lifecycleMu.Lock()
	lock := a.lifecycleLocks[key]
	if lock == nil {
		lock = &codexAppServerSessionLock{}
		a.lifecycleLocks[key] = lock
	}
	lock.refs++
	a.lifecycleMu.Unlock()

	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		a.lifecycleMu.Lock()
		lock.refs--
		if lock.refs <= 0 && a.lifecycleLocks[key] == lock {
			delete(a.lifecycleLocks, key)
		}
		a.lifecycleMu.Unlock()
	}
}

func (a *CodexAppServerAdapter) storeSession(agentSessionID string, session *codexAppServerSession) {
	a.mu.Lock()
	if session != nil {
		session.ensureInitialized()
		if session.serverInfo == nil {
			session.serverInfo = map[string]any{}
		}
		if session.pendingRequests == nil {
			session.pendingRequests = make(map[string]*pendingACPRequest)
		}
	}
	key := strings.TrimSpace(agentSessionID)
	// Replacing a stored session must never orphan its app-server process:
	// when the new entry does not carry the existing client forward, that
	// client (and its OS process) would otherwise leak without an owner.
	var replacedClient *codexAppServerClient
	if existing := a.sessions[key]; existing != nil && existing != session && existing.client != nil &&
		(session == nil || existing.client != session.client) {
		replacedClient = existing.client
	}
	a.sessions[key] = session
	a.mu.Unlock()
	if replacedClient != nil {
		_ = replacedClient.Close()
	}
}

func (a *CodexAppServerAdapter) removeSession(agentSessionID string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	delete(a.sessions, strings.TrimSpace(agentSessionID))
	a.mu.Unlock()
}

func (a *CodexAppServerAdapter) getSession(agentSessionID string) *codexAppServerSession {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[strings.TrimSpace(agentSessionID)]
}

func (a *CodexAppServerAdapter) beginActiveTurn(
	agentSessionID string,
	turn *codexAppServerActiveTurn,
) bool {
	if a == nil || turn == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil || appSession.activeTurn != nil {
		return false
	}
	appSession.activeTurn = turn
	return true
}

func (a *CodexAppServerAdapter) endActiveTurn(agentSessionID string, turn *codexAppServerActiveTurn) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil || appSession.activeTurn != turn {
		return
	}
	appSession.activeTurn = nil
	appSession.activeTurnID = ""
}

func (a *CodexAppServerAdapter) sessionActiveTurn(agentSessionID string) *codexAppServerActiveTurn {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return nil
	}
	return appSession.activeTurn
}

func (a *CodexAppServerAdapter) sessionActiveTurnID(agentSessionID string) string {
	if a == nil {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return ""
	}
	return strings.TrimSpace(appSession.activeTurnID)
}

func (a *CodexAppServerAdapter) requestActiveTurnCancel(agentSessionID string) (string, bool) {
	if a == nil {
		return "", false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return "", false
	}
	if activeTurnID := strings.TrimSpace(appSession.activeTurnID); activeTurnID != "" {
		if appSession.activeTurn != nil {
			appSession.activeTurn.phase = codexAppServerTurnPhaseInterrupting
		}
		return activeTurnID, false
	}
	if appSession.activeTurn == nil {
		return "", false
	}
	if appSession.activeTurn.ctx != nil && appSession.activeTurn.ctx.Err() != nil {
		return "", false
	}
	appSession.activeTurn.cancelRequested = true
	appSession.activeTurn.phase = codexAppServerTurnPhaseInterrupting
	return "", true
}

func (a *CodexAppServerAdapter) setSessionActiveTurnID(agentSessionID string, turnID string) bool {
	if a == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession != nil {
		appSession.activeTurnID = strings.TrimSpace(turnID)
		if appSession.activeTurnID != "" {
			appSession.lastTurnID = appSession.activeTurnID
		}
		if appSession.activeTurn != nil &&
			appSession.activeTurnID != "" &&
			appSession.activeTurn.cancelRequested &&
			!appSession.activeTurn.cancelInterruptSent {
			appSession.activeTurn.cancelInterruptSent = true
			return true
		}
	}
	return false
}

// sessionMarkerTurnID resolves the turn id to stamp on child lifecycle
// markers: the active turn when one is running, else the last settled turn.
func (a *CodexAppServerAdapter) sessionMarkerTurnID(agentSessionID string) string {
	if a == nil {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return ""
	}
	return firstNonEmpty(appSession.activeTurnID, appSession.lastTurnID)
}

func (a *CodexAppServerAdapter) storePendingRequest(pending *pendingACPRequest) {
	if a == nil || pending == nil {
		return
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(pending.agentSessionID)]
	if appSession != nil {
		if appSession.pendingRequests == nil {
			appSession.pendingRequests = make(map[string]*pendingACPRequest)
		}
		pending.state = pendingACPRequestStatePending
		appSession.pendingRequests[strings.TrimSpace(pending.requestID)] = pending
	}
	a.mu.Unlock()
}

func (a *CodexAppServerAdapter) getPendingRequest(agentSessionID string, requestID string) *pendingACPRequest {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil || appSession.pendingRequests == nil {
		return nil
	}
	return appSession.pendingRequests[strings.TrimSpace(requestID)]
}

func (a *CodexAppServerAdapter) hasLiveSessionWork(agentSessionID string) bool {
	if a == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	return appSession != nil && (len(appSession.pendingRequests) > 0 ||
		appSession.activeTurn != nil ||
		strings.TrimSpace(appSession.activeTurnID) != "")
}

func (a *CodexAppServerAdapter) deletePendingRequest(agentSessionID string, requestID string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession != nil && appSession.pendingRequests != nil {
		delete(appSession.pendingRequests, strings.TrimSpace(requestID))
	}
	a.mu.Unlock()
}

func (a *CodexAppServerAdapter) rejectPendingRequests(agentSessionID string, err error) {
	if a == nil {
		return
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	pending := make([]*pendingACPRequest, 0)
	if appSession != nil && appSession.pendingRequests != nil {
		for requestID, request := range appSession.pendingRequests {
			request.state = pendingACPRequestStateInterrupted
			pending = append(pending, request)
			delete(appSession.pendingRequests, requestID)
		}
	}
	a.mu.Unlock()
	for _, request := range pending {
		request.reject(err)
	}
}

func (a *CodexAppServerAdapter) emitCommandSnapshot(snapshot AgentSessionCommandSnapshot) {
	if a == nil {
		return
	}
	a.mu.Lock()
	sink := a.commandSink
	a.mu.Unlock()
	if sink != nil {
		sink(snapshot)
	}
}
