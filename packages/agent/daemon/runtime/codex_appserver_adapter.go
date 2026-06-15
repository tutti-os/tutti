//revive:disable:file-length-limit
package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"

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
	appServerMethodThreadCompact         = "thread/compact/start"
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
	appServerNotifyThreadStarted     = "thread/started"
	appServerNotifyTurnStarted       = "turn/started"
	appServerNotifyTurnCompleted     = "turn/completed"
	appServerNotifyAgentMessageDelta = "item/agentMessage/delta"
	appServerNotifyReasoningDelta    = "item/reasoning/textDelta"
	appServerNotifyReasoningSummary  = "item/reasoning/summaryTextDelta"
	appServerNotifyItemStarted       = "item/started"
	appServerNotifyItemCompleted     = "item/completed"
	appServerNotifyTokenUsage        = "thread/tokenUsage/updated"
	appServerNotifyPlanUpdated       = "turn/plan/updated"
	appServerNotifyThreadNameUpdated = "thread/name/updated"
	appServerNotifyRateLimitsUpdated = "account/rateLimits/updated"
	appServerNotifyAccountUpdated    = "account/updated"
	appServerNotifyError             = "error"
	appServerNotifyWarning           = "warning"
	appServerNotifyDeprecation       = "deprecationNotice"
	appServerNotifyModelRerouted     = "model/rerouted"
	appServerNotifyThreadCompacted   = "thread/compacted"
)

const (
	appServerSlashCompact = "/compact"
	appServerSlashReview  = "/review"
	appServerSlashUndo    = "/undo"
)

const codexAppServerAuthRequiredMessage = "Codex requires authentication. " +
	"Run `codex login` on the host (or sync Codex credentials), then retry this session."

type CodexAppServerAdapter struct {
	transport   ProcessTransport
	host        HostMetadata
	mu          sync.Mutex
	sessions    map[string]*codexAppServerSession
	commandSink CommandSnapshotSink
	configSink  ConfigOptionsUpdateSink
}

type codexAppServerSession struct {
	client     *acpClient
	threadID   string
	serverInfo map[string]any
	account    map[string]any
	rateLimits map[string]any
	// planModeMask is the Plan preset mask from collaborationMode/list
	// (flat name/mode/model/reasoning_effort fields); nil when the binary
	// does not expose collaboration modes. defaultModel backs the required
	// CollaborationMode.settings.model when no session override is set.
	planModeMask map[string]any
	defaultModel string
	authState    string
	authMessage  string
	activeTurnID string
	activeTurn   *codexAppServerActiveTurn
	acpLiveState
	pendingRequests map[string]*pendingACPRequest
}

// codexAppServerActiveTurn carries the streaming context of an in-flight
// turn. The app-server `turn/start` RPC responds immediately with the
// inProgress turn; all output arrives as notifications afterwards, so the
// session-level message handler resolves this context to keep translating
// notifications into activity events after the RPC has returned. The turn
// finishes when the `turn/completed` notification delivers the final turn
// payload through done.
type codexAppServerActiveTurn struct {
	turnID       string
	session      Session
	ctx          context.Context
	normalizer   *acpTurnNormalizer
	emit         func([]activityshared.Event)
	emitCommands CommandSnapshotSink
	done         chan map[string]any

	cancelRequested     bool
	cancelInterruptSent bool
}

func NewCodexAppServerAdapter(transport ProcessTransport) *CodexAppServerAdapter {
	return NewCodexAppServerAdapterWithHostMetadata(transport, LegacyHostMetadata())
}

func NewCodexAppServerAdapterWithHostMetadata(transport ProcessTransport, host HostMetadata) *CodexAppServerAdapter {
	return &CodexAppServerAdapter{
		transport: transport,
		host:      host,
		sessions:  make(map[string]*codexAppServerSession),
	}
}

func (a *CodexAppServerAdapter) Provider() string {
	return ProviderCodex
}

func (a *CodexAppServerAdapter) sessionCWD(session Session) string {
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

func (a *CodexAppServerAdapter) commandString() string {
	return codexAppServerCommand + " " + codexAppServerSubcmd
}

func (a *CodexAppServerAdapter) Start(ctx context.Context, session Session) ([]activityshared.Event, error) {
	client, initializeResult, err := a.startInitializedClient(ctx, session)
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

	account, authRequired := a.fetchAccount(ctx, client, session)
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
	models := a.fetchModels(ctx, client, session)
	rateLimits := a.fetchRateLimits(ctx, client, session)
	planModeMask := a.fetchPlanCollaborationMode(ctx, client, session)

	threadResult, err := client.CallWithTimeout(ctx, acpStartCallTimeout, appServerMethodThreadStart,
		appServerThreadStartParams(session, a.sessionCWD(session)),
		func(ctx context.Context, message acpMessage) error {
			_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
			return err
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
		client:          client,
		threadID:        threadID,
		serverInfo:      serverInfo,
		account:         account,
		rateLimits:      rateLimits,
		planModeMask:    planModeMask,
		defaultModel:    codexAppServerDefaultModel(models),
		authState:       "authenticated",
		acpLiveState:    liveState,
		pendingRequests: make(map[string]*pendingACPRequest),
	})
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

func (a *CodexAppServerAdapter) Resume(ctx context.Context, session Session) error {
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		return missingProviderSessionResumeError(session)
	}
	client, initializeResult, err := a.startInitializedClient(ctx, session)
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

	account, authRequired := a.fetchAccount(ctx, client, session)
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
	models := a.fetchModels(ctx, client, session)
	rateLimits := a.fetchRateLimits(ctx, client, session)
	planModeMask := a.fetchPlanCollaborationMode(ctx, client, session)

	params := appServerThreadStartParams(session, a.sessionCWD(session))
	params["threadId"] = strings.TrimSpace(session.ProviderSessionID)
	threadResult, err := client.CallWithTimeout(ctx, acpStartCallTimeout, appServerMethodThreadResume, params,
		func(ctx context.Context, message acpMessage) error {
			_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
			return err
		})
	if err != nil {
		return classifyACPResumeError(session, appServerMethodThreadResume, err)
	}
	liveState := newACPLiveState()
	liveState.currentMode = codexACPEffectiveModeID(session)
	liveState.availableCommands = codexAppServerCommands()
	liveState.commandsKnown = true
	applyACPConfigOptionDescriptors(&liveState, codexAppServerConfigOptionDescriptors(models, session, threadResult))

	started = true
	keepSession = true
	a.storeSession(session.AgentSessionID, &codexAppServerSession{
		client:          client,
		threadID:        strings.TrimSpace(session.ProviderSessionID),
		serverInfo:      serverInfo,
		account:         account,
		rateLimits:      rateLimits,
		planModeMask:    planModeMask,
		defaultModel:    codexAppServerDefaultModel(models),
		authState:       "authenticated",
		acpLiveState:    liveState,
		pendingRequests: make(map[string]*pendingACPRequest),
	})
	return nil
}

func (*CodexAppServerAdapter) CanResume(session Session) bool {
	return strings.TrimSpace(session.ProviderSessionID) != ""
}

func (a *CodexAppServerAdapter) Close(_ context.Context, session Session) error {
	if a == nil {
		return nil
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	a.rejectPendingRequests(agentSessionID, errPermissionRequestCanceled)
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
) (*acpClient, json.RawMessage, error) {
	if a == nil || a.transport == nil {
		return nil, nil, errors.New("app-server process transport is unavailable")
	}
	conn, err := a.transport.Start(ctx, ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: session.AgentSessionID,
		RoomID:         session.RoomID,
		CWD:            a.sessionCWD(session),
		Command:        []string{codexAppServerCommand, codexAppServerSubcmd},
		Env:            append(codexACPEnv(session, a.host), session.Env...),
	})
	if err != nil {
		return nil, nil, err
	}
	client := newAppServerJSONRPCClient(conn)
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

	initializeResult, err := client.CallWithTimeout(ctx, acpStartCallTimeout, appServerMethodInitialize, map[string]any{
		"clientInfo": a.host.clientInfoParams(),
		"capabilities": map[string]any{
			"experimentalApi": true,
		},
	}, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
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
	if err := client.Notify(ctx, appServerMethodInitialized, nil); err != nil {
		return nil, nil, err
	}
	started = true
	return client, initializeResult, nil
}

func (a *CodexAppServerAdapter) fetchAccount(
	ctx context.Context,
	client *acpClient,
	session Session,
) (map[string]any, bool) {
	result, err := client.CallWithTimeout(ctx, acpStartCallTimeout, appServerMethodAccountRead, map[string]any{},
		func(ctx context.Context, message acpMessage) error {
			_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
			return err
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
	return payload.Account, payload.RequiresOpenaiAuth && payload.Account == nil
}

func (a *CodexAppServerAdapter) fetchModels(
	ctx context.Context,
	client *acpClient,
	session Session,
) []map[string]any {
	result, err := client.CallWithTimeout(ctx, acpStartCallTimeout, appServerMethodModelList, map[string]any{},
		func(ctx context.Context, message acpMessage) error {
			_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
			return err
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
	return payload.Data
}

func (a *CodexAppServerAdapter) fetchRateLimits(
	ctx context.Context,
	client *acpClient,
	session Session,
) map[string]any {
	result, err := client.CallWithTimeout(ctx, acpStartCallTimeout, appServerMethodRateLimitsRead, nil,
		func(ctx context.Context, message acpMessage) error {
			_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
			return err
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
	return payload.RateLimits
}

// fetchPlanCollaborationMode probes the experimental collaboration mode list
// and returns the Plan preset mask (flat CollaborationModeMask fields). The
// turn/start payload is assembled per turn because the schema requires a
// concrete settings.model. Best effort: any error means the capability stays
// off.
func (a *CodexAppServerAdapter) fetchPlanCollaborationMode(
	ctx context.Context,
	client *acpClient,
	session Session,
) map[string]any {
	result, err := client.CallWithTimeout(ctx, acpStartCallTimeout, appServerMethodCollaborationModeList, map[string]any{},
		func(ctx context.Context, message acpMessage) error {
			_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
			return err
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
	for _, preset := range payload.Data {
		mode := strings.ToLower(strings.TrimSpace(firstNonEmpty(asString(preset["mode"]), asString(preset["name"]))))
		if mode != "plan" {
			continue
		}
		return clonePayload(preset)
	}
	return nil
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

func (a *CodexAppServerAdapter) Exec(
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

	if activeTurnID := a.sessionActiveTurnID(session.AgentSessionID); activeTurnID != "" {
		return a.steerActiveTurn(ctx, appSession, session, content, explicitDisplayPrompt, visibleText, turnID, activeTurnID, emit)
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
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, visibleText, userPromptActivityPayload(content, explicitDisplayPrompt, nil)),
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
		done:         make(chan map[string]any, 1),
	}
	if !a.beginActiveTurn(session.AgentSessionID, appTurn) {
		return nil, ErrSessionActiveTurn
	}
	defer a.endActiveTurn(session.AgentSessionID, appTurn)

	if handled, err := a.execSlashCommand(ctx, appSession, session, visibleText, turnID, appTurn, normalizer, emitEvents, emitTerminal, emitCommands); handled {
		return snapshotEvents(), err
	}

	result, err := appSession.client.Call(ctx, appServerMethodTurnStart, appServerTurnStartParams(session, appSession.threadID, content, appSession.planModeMask, appSession.defaultModel),
		func(ctx context.Context, message acpMessage) error {
			next, err := a.handleAppServerMessage(ctx, appSession.client, session, turnID, message, normalizer, emitEvents, emitCommands)
			emitEvents(next)
			return err
		})
	if err != nil {
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

	// The app-server responds to turn/start immediately with the inProgress
	// turn; the real output streams as notifications and the final turn
	// arrives with the turn/completed notification.
	initialTurn := appServerTurnFromResult(result)
	if providerTurnID := asString(initialTurn["id"]); providerTurnID != "" {
		if a.setSessionActiveTurnID(session.AgentSessionID, providerTurnID) {
			a.interruptActiveTurnAsync(appSession, session, providerTurnID, "queued cancel")
		}
	}
	finalTurn, finishErr := a.awaitTurnCompletion(ctx, appSession, appTurn, initialTurn)
	a.endActiveTurn(session.AgentSessionID, appTurn)
	if finishErr != nil {
		if errors.Is(finishErr, context.Canceled) || errors.Is(finishErr, errPermissionRequestCanceled) {
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
		return initialTurn, nil
	}
	select {
	case finalTurn := <-appTurn.done:
		return finalTurn, nil
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
	case "completed", "failed", "interrupted":
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
	explicitDisplayPrompt string,
	displayPrompt string,
	turnID string,
	activeTurnID string,
	emit EventSink,
) ([]activityshared.Event, error) {
	_, err := appSession.client.CallNoHandler(ctx, appServerMethodTurnSteer, map[string]any{
		"threadId":       appSession.threadID,
		"expectedTurnId": activeTurnID,
		"input":          appServerUserInput(content),
	})
	if err != nil {
		return nil, err
	}
	events := []activityshared.Event{
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, displayPrompt, userPromptActivityPayload(content, explicitDisplayPrompt, map[string]any{
			"steered": true,
		})),
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
		_, err := appSession.client.Call(ctx, appServerMethodThreadCompact, map[string]any{
			"threadId": appSession.threadID,
		}, func(ctx context.Context, message acpMessage) error {
			next, err := a.handleAppServerMessage(ctx, appSession.client, session, turnID, message, normalizer, emitEvents, emitCommands)
			emitEvents(next)
			return err
		})
		if err != nil {
			emitTerminal([]activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(err))})
			return true, nil
		}
		emitTerminal(append(
			normalizer.FinishCompleted(session, turnID),
			appServerSystemNoticeEvent(session, turnID, "system_notice", "Context compaction started.", ""),
			newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", map[string]any{
				"stopReason": "end_turn",
			}),
		))
		return true, nil
	case appServerSlashReview:
		params := map[string]any{
			"threadId": appSession.threadID,
			"target":   appServerReviewTarget(args),
			"delivery": "inline",
		}
		result, err := appSession.client.Call(ctx, appServerMethodReviewStart, params,
			func(ctx context.Context, message acpMessage) error {
				next, err := a.handleAppServerMessage(ctx, appSession.client, session, turnID, message, normalizer, emitEvents, emitCommands)
				emitEvents(next)
				return err
			})
		if err != nil {
			emitTerminal([]activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(err))})
			return true, nil
		}
		initialTurn := appServerTurnFromResult(result)
		if providerTurnID := asString(initialTurn["id"]); providerTurnID != "" {
			a.setSessionActiveTurnID(session.AgentSessionID, providerTurnID)
		}
		finalTurn, finishErr := a.awaitTurnCompletion(ctx, appSession, appTurn, initialTurn)
		if finishErr != nil {
			terminalEvents := normalizer.FinishFailed(session, turnID)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(finishErr)))
			emitTerminal(terminalEvents)
			return true, nil
		}
		normalizer.ApplyAssistantFinalText(appServerTurnFinalAssistantText(finalTurn))
		emitTerminal(appServerTurnTerminalEvents(session, turnID, finalTurn, normalizer))
		return true, nil
	case appServerSlashUndo:
		_, err := appSession.client.Call(ctx, appServerMethodThreadRollback, map[string]any{
			"threadId": appSession.threadID,
			"numTurns": 1,
		}, func(ctx context.Context, message acpMessage) error {
			next, err := a.handleAppServerMessage(ctx, appSession.client, session, turnID, message, normalizer, emitEvents, emitCommands)
			emitEvents(next)
			return err
		})
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

func (a *CodexAppServerAdapter) Cancel(ctx context.Context, session Session, reason string) ([]activityshared.Event, error) {
	reason = strings.TrimSpace(reason)
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return nil, ErrSessionDisconnected
	}
	activeTurnID, queued := a.requestActiveTurnCancel(session.AgentSessionID)
	// Unblock any handler waiting on an approval answer first: the message
	// read loop is parked inside that handler, so the interrupt response
	// could never be dispatched otherwise.
	a.rejectPendingRequests(session.AgentSessionID, errPermissionRequestCanceled)
	if activeTurnID == "" {
		if queued {
			return nil, nil
		}
		return nil, ErrSessionNoActiveTurn
	}
	return nil, a.interruptActiveTurn(ctx, appSession, session, activeTurnID, reason)
}

func (a *CodexAppServerAdapter) interruptActiveTurn(
	ctx context.Context,
	appSession *codexAppServerSession,
	session Session,
	activeTurnID string,
	reason string,
) error {
	cancelCtx, cancel := context.WithTimeout(ctx, acpPermissionModeTimeout)
	defer cancel()
	if _, err := appSession.client.CallNoHandler(cancelCtx, appServerMethodTurnInterrupt, map[string]any{
		"threadId": appSession.threadID,
		"turnId":   activeTurnID,
	}); err != nil {
		slog.Warn("agent session app-server interrupt failed",
			"event", "agent_session.app_server.interrupt.failed",
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", appSession.threadID,
			"turn_id", activeTurnID,
			"reason", reason,
			"error", err.Error(),
		)
		return err
	}
	return nil
}

func (a *CodexAppServerAdapter) interruptActiveTurnAsync(
	appSession *codexAppServerSession,
	session Session,
	activeTurnID string,
	reason string,
) {
	go func() {
		if err := a.interruptActiveTurn(context.Background(), appSession, session, activeTurnID, reason); err != nil {
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
	snapshot.RuntimeContext["capabilities"] = codexAppServerCapabilities(state.planModeSupported)
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
		snapshot.RuntimeContext["planMode"] = snapshot.Settings.PlanMode
	}
	if state.pendingPrompt != nil {
		snapshot.PendingInteractive = state.pendingPrompt
	}
	return snapshot
}

type codexAppServerSessionStateSnapshot struct {
	serverInfo        map[string]any
	account           map[string]any
	rateLimits        map[string]any
	authState         string
	authMessage       string
	planModeSupported bool
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
		serverInfo:           clonePayload(appSession.serverInfo),
		account:              clonePayload(appSession.account),
		rateLimits:           clonePayload(appSession.rateLimits),
		authState:            strings.TrimSpace(appSession.authState),
		authMessage:          strings.TrimSpace(appSession.authMessage),
		planModeSupported:    appSession.planModeMask != nil,
		acpLiveStateSnapshot: snapshotACPLiveState(appSession.acpLiveState),
		pendingPrompt:        prompt,
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
	a.sessions[strings.TrimSpace(agentSessionID)] = session
	a.mu.Unlock()
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

// completeActiveTurn delivers the final turn payload from the
// `turn/completed` notification to the goroutine waiting in Exec.
func (a *CodexAppServerAdapter) completeActiveTurn(agentSessionID string, turn map[string]any) {
	if a == nil {
		return
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	var activeTurn *codexAppServerActiveTurn
	if appSession != nil {
		activeTurn = appSession.activeTurn
		appSession.activeTurnID = ""
	}
	a.mu.Unlock()
	if activeTurn == nil {
		return
	}
	select {
	case activeTurn.done <- turn:
	default:
	}
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
		return activeTurnID, false
	}
	if appSession.activeTurn == nil {
		return "", false
	}
	if appSession.activeTurn.ctx != nil && appSession.activeTurn.ctx.Err() != nil {
		return "", false
	}
	appSession.activeTurn.cancelRequested = true
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
