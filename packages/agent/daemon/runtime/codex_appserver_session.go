package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func (a *CodexAppServerAdapter) Start(ctx context.Context, session Session) (events []activityshared.Event, err error) {
	unlockLifecycle := a.lockSessionLifecycle(session.AgentSessionID)
	defer unlockLifecycle()
	if err := a.admitCodexReplacementLocked(session.AgentSessionID); err != nil {
		return nil, err
	}
	trace := newCodexAppServerStartupTrace(session, a.startupSpanObserver, a.startupObserver)
	defer func() {
		trace.Finish(err)
	}()
	extraSkillRoots, err := tuttiAgentExtraSkillRoots(a.config.skillRootsStrategy, session.Env)
	if err != nil {
		return nil, err
	}
	stableSystemSkillsRoot, err := tuttiAgentStableSystemSkillsRoot(a.config.skillRootsStrategy, session.Env)
	if err != nil {
		return nil, err
	}
	// One session owns at most one live app-server process. Starting over a
	// session that already holds a live client replaces it: stop the old
	// client first, then spawn the new process.
	if existing := a.getSession(session.AgentSessionID); existing != nil && existing.client != nil {
		a.rejectPendingRequests(session.AgentSessionID, errPermissionRequestCanceled)
		_ = a.closeLiveSession(session.AgentSessionID)
	}
	client, initializeResult, _, err := a.startClient(ctx, session, trace, false)
	if err != nil {
		return nil, err
	}
	started := false
	keepSession := false
	startedSession := &codexAppServerSession{
		client:          client,
		pendingRequests: make(map[string]*pendingInteractiveRequest),
	}
	defer func() {
		if !started {
			a.closeOrRetainCodexSession(session.AgentSessionID, startedSession)
		}
		if !keepSession {
			a.removeSession(session.AgentSessionID)
		}
	}()
	serverInfo := a.appServerInfo(initializeResult)
	a.storeSession(session.AgentSessionID, &codexAppServerSession{
		client:          client,
		serverInfo:      serverInfo,
		acpLiveState:    newACPLiveState(),
		pendingRequests: make(map[string]*pendingInteractiveRequest),
	})
	if err := a.stabilizeSystemSkillPaths(session, stableSystemSkillsRoot, trace); err != nil {
		return nil, err
	}
	if err := a.configureExtraSkillRoots(ctx, client, session, extraSkillRoots, trace); err != nil {
		return nil, err
	}

	account, authRequired := a.fetchAccount(ctx, client, session, trace)
	if authRequired {
		a.storeSession(session.AgentSessionID, &codexAppServerSession{
			serverInfo:      serverInfo,
			account:         account,
			authState:       "auth_required",
			authMessage:     a.config.authRequiredMessage,
			acpLiveState:    newACPLiveState(),
			pendingRequests: make(map[string]*pendingInteractiveRequest),
		})
		keepSession = true
		return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, map[string]any{
			"adapter":          a.commandString(),
			"command":          a.commandString(),
			"agent":            serverInfo,
			"permissionModeId": session.PermissionModeID,
			"authState":        "auth_required",
			"authMessage":      a.config.authRequiredMessage,
		})}, nil
	}
	models := []map[string]any(nil)
	if codexAppServerNeedsSynchronousModels(session) {
		models = a.fetchModels(ctx, client, session, trace)
	}
	if len(models) > 0 {
		effectiveSettings := codexAppServerEffectiveSettings(models, session, nil)
		session.Settings = &effectiveSettings
	}
	planModeMask, defaultModeMask := a.fetchCollaborationModeMasks(ctx, client, session, trace)

	threadParams := appServerThreadStartParams(session, a.sessionCWD(session))
	trace.Log("thread.start.params", codexAppServerTraceThreadStartParams(session, threadParams, false))
	callbackSession := session
	threadResult, err := trace.TypedCall(acpStartCallTimeout, appServerMethodThreadStart, func() (json.RawMessage, error) {
		return client.ThreadStart(ctx, acpStartCallTimeout, threadParams,
			func(ctx context.Context, message acpMessage) error {
				trace.LogMessage(message.Method, len(message.ID) > 0, len(message.Params))
				_, err := a.handleAppServerMessage(ctx, client, callbackSession, "", message, nil, nil, nil)
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
				authMessage:     a.config.authRequiredMessage,
				acpLiveState:    newACPLiveState(),
				pendingRequests: make(map[string]*pendingInteractiveRequest),
			})
			keepSession = true
			return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, map[string]any{
				"adapter":          a.commandString(),
				"command":          a.commandString(),
				"agent":            serverInfo,
				"permissionModeId": session.PermissionModeID,
				"authState":        "auth_required",
				"authMessage":      a.config.authRequiredMessage,
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
		"provider", a.config.provider,
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
		runtimeSession:         session,
		serverInfo:             serverInfo,
		account:                account,
		models:                 cloneCodexAppServerModels(models),
		startupModelsReady:     len(models) > 0,
		startupRateLimitsReady: false,
		planModeMask:           planModeMask,
		defaultModeMask:        defaultModeMask,
		defaultModel:           codexAppServerSessionDefaultModel(session, models),
		authState:              "authenticated",
		acpLiveState:           liveState,
		pendingRequests:        make(map[string]*pendingInteractiveRequest),
	})
	a.refreshStartupMetadataAsync(session, threadResult, len(models) == 0, a.config.rateLimits, trace)
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
	if err := a.admitCodexReplacementLocked(session.AgentSessionID); err != nil {
		return err
	}
	// Resume may run over a session that still holds a live client. Unlike
	// Start, the old client is kept alive until the replacement has resumed
	// successfully (storeSession closes it on replace): if the new spawn or
	// thread/resume fails, the previous session must remain usable.
	trace := newCodexAppServerStartupTrace(session, a.startupSpanObserver, a.startupObserver)
	defer func() {
		trace.Finish(err)
	}()
	trace.Log("resume.begin", map[string]any{
		"thread_id": strings.TrimSpace(session.ProviderSessionID),
	})
	extraSkillRoots, err := tuttiAgentExtraSkillRoots(a.config.skillRootsStrategy, session.Env)
	if err != nil {
		return err
	}
	stableSystemSkillsRoot, err := tuttiAgentStableSystemSkillsRoot(a.config.skillRootsStrategy, session.Env)
	if err != nil {
		return err
	}
	client, initializeResult, attachedCheckpoint, err := a.startClient(ctx, session, trace, true)
	if err != nil {
		return err
	}
	started := false
	keepSession := false
	previousSession := a.getSession(session.AgentSessionID)
	startedSession := &codexAppServerSession{
		client:          client,
		pendingRequests: make(map[string]*pendingInteractiveRequest),
	}
	defer func() {
		if !started {
			a.closeOrRetainCodexSession(session.AgentSessionID, startedSession)
		}
		if !keepSession {
			if previousSession != nil {
				a.storeSession(session.AgentSessionID, previousSession)
			} else {
				a.removeSession(session.AgentSessionID)
			}
		}
	}()
	if attachedCheckpoint {
		planModeMask, defaultModeMask, defaultModel, checkpointFound :=
			codexAppServerProtocolCheckpointFromRuntimeContext(session.RuntimeContext)
		if !checkpointFound {
			return errors.New(
				"attached live Codex replay is missing provider resume checkpoint; record a new cassette",
			)
		}
		liveState := newACPLiveState()
		liveState.currentMode = codexACPEffectiveModeID(session)
		liveState.availableCommands = codexAppServerCommands()
		liveState.commandsKnown = true
		applyACPConfigOptionDescriptors(
			&liveState,
			codexAppServerConfigOptionDescriptors(nil, session, nil),
		)
		started = true
		keepSession = true
		a.storeSession(session.AgentSessionID, &codexAppServerSession{
			client:               client,
			threadID:             strings.TrimSpace(session.ProviderSessionID),
			resumeRuntimeContext: clonePayload(session.RuntimeContext),
			planModeMask:         planModeMask,
			defaultModeMask:      defaultModeMask,
			defaultModel: firstNonEmpty(
				strings.TrimSpace(session.SettingsValue().Model),
				defaultModel,
			),
			authState:       "authenticated",
			acpLiveState:    liveState,
			pendingRequests: make(map[string]*pendingInteractiveRequest),
		})
		a.emitCommandSnapshot(AgentSessionCommandSnapshot{
			AgentSessionID: strings.TrimSpace(session.AgentSessionID),
			Commands:       codexAppServerCommands(),
		})
		return nil
	}
	serverInfo := a.appServerInfo(initializeResult)
	if err := a.stabilizeSystemSkillPaths(session, stableSystemSkillsRoot, trace); err != nil {
		return err
	}
	if err := a.configureExtraSkillRoots(ctx, client, session, extraSkillRoots, trace); err != nil {
		return err
	}

	account, authRequired := a.fetchAccount(ctx, client, session, trace)
	if authRequired {
		a.storeSession(session.AgentSessionID, &codexAppServerSession{
			threadID:        session.ProviderSessionID,
			serverInfo:      serverInfo,
			account:         account,
			authState:       "auth_required",
			authMessage:     a.config.authRequiredMessage,
			acpLiveState:    newACPLiveState(),
			pendingRequests: make(map[string]*pendingInteractiveRequest),
		})
		keepSession = true
		return nil
	}
	models := []map[string]any(nil)
	if codexAppServerNeedsSynchronousModels(session) {
		models = a.fetchModels(ctx, client, session, trace)
	}
	if len(models) > 0 && strings.TrimSpace(session.SettingsValue().ReasoningEffort) != "" {
		hasExplicitModel := strings.TrimSpace(session.SettingsValue().Model) != ""
		effectiveSettings := codexAppServerEffectiveSettings(models, session, nil)
		// The catalog default is needed to validate an effort-only persisted
		// setting, but it must not become a thread/resume model override. The
		// existing thread remains authoritative until the resume result reports
		// its actual model.
		if !hasExplicitModel {
			effectiveSettings.Model = ""
		}
		session.Settings = &effectiveSettings
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
	callbackSession := session
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
				_, err := a.handleAppServerMessage(ctx, client, callbackSession, "", message, nil, nil, nil)
				return err
			})
	})
	if err != nil {
		return classifyACPResumeError(session, appServerMethodThreadResume, err)
	}
	if len(models) > 0 {
		effectiveSettings := codexAppServerEffectiveSettings(models, session, threadResult)
		session.Settings = &effectiveSettings
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
		runtimeSession:         session,
		serverInfo:             serverInfo,
		account:                account,
		models:                 cloneCodexAppServerModels(models),
		startupModelsReady:     len(models) > 0,
		startupRateLimitsReady: false,
		planModeMask:           planModeMask,
		defaultModeMask:        defaultModeMask,
		defaultModel:           codexAppServerSessionDefaultModel(session, models),
		authState:              "authenticated",
		acpLiveState:           liveState,
		pendingRequests:        make(map[string]*pendingInteractiveRequest),
	})
	a.refreshStartupMetadataAsync(session, threadResult, len(models) == 0, a.config.rateLimits, trace)
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
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	if appSession == nil || appSession.client == nil || appSession.releasing || appSession.releaseFailed {
		a.mu.Unlock()
		return false
	}
	client := appSession.client
	a.mu.Unlock()
	select {
	case <-client.Done():
		return false
	default:
		return true
	}
}

func (a *CodexAppServerAdapter) Close(ctx context.Context, session Session) error {
	if a == nil {
		return nil
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	unlockLifecycle := a.lockSessionLifecycle(agentSessionID)
	defer unlockLifecycle()
	a.rejectPendingRequests(agentSessionID, errPermissionRequestCanceled)
	if appSession := a.getSession(agentSessionID); appSession != nil &&
		appSession.client != nil &&
		strings.TrimSpace(appSession.threadID) != "" {
		a.mu.Lock()
		shared := a.clientReferencedLocked(appSession.client, agentSessionID)
		a.mu.Unlock()
		if session.IsSideConversation() || shared {
			if err := appSession.client.ThreadUnsubscribeNoHandler(
				ctx,
				acpStartCallTimeout,
				appSession.threadID,
			); err != nil {
				select {
				case <-appSession.client.Done():
					// The shared process is already gone; local removal is the
					// only cleanup left and Side will be expired.
				default:
					return err
				}
			}
		}
	}
	return a.closeLiveSession(agentSessionID)
}

func (a *CodexAppServerAdapter) QuiesceForClose(
	ctx context.Context,
	session Session,
) error {
	if a == nil {
		return nil
	}
	appTurn := a.sessionActiveTurn(session.AgentSessionID)
	if appTurn == nil &&
		a.sessionActiveTurnID(session.AgentSessionID) == "" {
		return nil
	}
	appSession := a.getSession(session.AgentSessionID)
	_, err := a.Cancel(ctx, session, "session closed")
	if errors.Is(err, ErrSessionDisconnected) {
		return nil
	}
	if err != nil && !errors.Is(err, ErrSessionNoActiveTurn) {
		return err
	}
	if appTurn == nil {
		return nil
	}
	select {
	case <-appTurn.terminated:
		return nil
	default:
	}

	// Cancel queues an interrupt when turn/start has been sent but has not
	// returned the provider Turn id yet. Close must not detach the session while
	// that queued interrupt still depends on the session registry. Wait for the
	// normal binding/interrupt path, then tear down the shared transport if the
	// provider never supplies an interruptible identity within the ordinary
	// cancellation grace window.
	grace := a.cancelGraceWindow
	if grace <= 0 {
		grace = defaultCodexAppServerCancelGraceWindow
	}
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-appTurn.terminated:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
	}
	a.markTurnForceCanceled(appTurn)
	slog.Warn(
		"agent session app-server force-closing turn with unresolved provider identity",
		"event", "agent_session.app_server.close.pending_turn_start_forced",
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"turn_id", appTurn.turnID,
		"grace_ms", grace.Milliseconds(),
	)
	if appSession != nil && appSession.client != nil {
		_ = appSession.client.Close()
	}
	select {
	case <-appTurn.terminated:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
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

// DisconnectLiveSession resolves pending interactions and drops only the
// app-server transport. The Codex thread remains resumable; no provider
// thread/session deletion request is sent.
func (a *CodexAppServerAdapter) DisconnectLiveSession(_ context.Context, session Session) error {
	if a == nil {
		return nil
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	unlockLifecycle := a.lockSessionLifecycle(agentSessionID)
	defer unlockLifecycle()
	a.rejectPendingRequests(agentSessionID, ErrSessionDisconnected)
	return a.closeLiveSession(agentSessionID)
}

func (a *CodexAppServerAdapter) closeLiveSession(agentSessionID string) error {
	a.mu.Lock()
	appSession := a.sessions[agentSessionID]
	shared := appSession != nil &&
		a.clientReferencedLocked(appSession.client, agentSessionID)
	if shared {
		delete(a.sessions, agentSessionID)
		a.mu.Unlock()
		return nil
	}
	if appSession != nil && appSession.client != nil {
		appSession.releasing = true
		appSession.client.SetMessageHandler(nil)
	}
	a.mu.Unlock()
	if appSession != nil && appSession.client != nil {
		if err := appSession.client.Close(); err != nil {
			if codexSessionAlreadyGone(err) {
				a.mu.Lock()
				if a.sessions[agentSessionID] == appSession {
					delete(a.sessions, agentSessionID)
				}
				a.mu.Unlock()
				return nil
			}
			a.mu.Lock()
			if a.sessions[agentSessionID] == appSession {
				appSession.releasing = false
				appSession.releaseFailed = true
			}
			a.mu.Unlock()
			return err
		}
		a.mu.Lock()
		if a.sessions[agentSessionID] == appSession {
			delete(a.sessions, agentSessionID)
		}
		a.mu.Unlock()
	}
	return nil
}

func (a *CodexAppServerAdapter) startInitializedClient(
	ctx context.Context,
	session Session,
	trace *codexAppServerStartupTrace,
) (*codexAppServerClient, json.RawMessage, error) {
	client, initializeResult, _, err := a.startClient(ctx, session, trace, false)
	return client, initializeResult, err
}

func (a *CodexAppServerAdapter) startClient(
	ctx context.Context,
	session Session,
	trace *codexAppServerStartupTrace,
	allowAttachedCheckpoint bool,
) (*codexAppServerClient, json.RawMessage, bool, error) {
	spec, cleanup, err := a.prepareInitializedClientLaunch(ctx, session)
	if err != nil {
		trace.Log("process.prepare.failed", map[string]any{
			"error": err.Error(),
		})
		return nil, nil, false, err
	}
	return a.startClientPrepared(
		ctx,
		session,
		trace,
		spec,
		cleanup,
		allowAttachedCheckpoint,
	)
}

func (a *CodexAppServerAdapter) prepareInitializedClientLaunch(
	ctx context.Context,
	session Session,
) (ProcessSpec, func(context.Context), error) {
	if a == nil || a.transport == nil {
		return ProcessSpec{}, nil, errors.New(
			"app-server process transport is unavailable",
		)
	}
	command := append([]string(nil), a.config.command...)
	spawnEnv := append(codexACPEnv(session, a.host), session.Env...)
	if a.commandResolver != nil {
		resolved, err := a.commandResolver(ctx, a.config.provider)
		if err != nil {
			return ProcessSpec{}, nil, err
		}
		if len(resolved.Command) > 0 {
			command = append([]string(nil), resolved.Command...)
		}
		spawnEnv = append(spawnEnv, resolved.Env...)
	}
	spec, cleanup, err := prepareProviderLaunch(ctx, a.preparer, session, ProcessSpec{
		Provider:           a.config.provider,
		AgentSessionID:     session.AgentSessionID,
		RootAgentSessionID: session.RootAgentSessionID,
		RoomID:             session.RoomID,
		CWD:                a.sessionCWD(session),
		Command:            command,
		Env:                spawnEnv,
	})
	if err != nil {
		return ProcessSpec{}, nil, err
	}
	if a.config.skillRootsStrategy == providerregistry.AppServerSkillRootsStrategyTuttiStable {
		spec.Env = withoutEnvironmentKey(spec.Env, tuttiAgentExtraSkillRootsEnv)
		spec.Env = withoutEnvironmentKey(spec.Env, tuttiAgentStableSystemSkillsEnv)
	}
	spec.Env = withCodexAppServerLogging(spec.Env)
	return spec, cleanup, nil
}

func (a *CodexAppServerAdapter) startClientPrepared(
	ctx context.Context,
	session Session,
	trace *codexAppServerStartupTrace,
	spec ProcessSpec,
	cleanup func(context.Context),
	allowAttachedCheckpoint bool,
) (*codexAppServerClient, json.RawMessage, bool, error) {
	trace.Log("process.start.begin", map[string]any{
		"command": strings.Join(spec.Command, " "),
		"cwd":     spec.CWD,
	})
	processStartedAt := time.Now()
	conn, err := a.transport.Start(ctx, spec)
	if err != nil {
		cleanupPreparedLaunch(cleanup)
		trace.Log("process.start.failed", map[string]any{
			"duration_ms": time.Since(processStartedAt).Milliseconds(),
			"error":       err.Error(),
		})
		return nil, nil, false, err
	}
	conn = wrapProviderLaunchCleanup(conn, cleanup)
	trace.Log("process.start.succeeded", map[string]any{
		"duration_ms": time.Since(processStartedAt).Milliseconds(),
	})
	client := newCodexAppServerClient(conn)
	client.SetStderrSink(trace.LogStderr)
	// The session-level handler receives every message that arrives outside
	// an in-flight RPC. Because turn/start responds immediately while the
	// turn keeps streaming, this is the main delivery path for turn output:
	// resolve the active turn context so notifications keep producing
	// activity events after the RPC has returned. Child sessions may outlive
	// that root turn, so their events retain a session-level fallback below.
	client.SetMessageHandler(func(ctx context.Context, message acpMessage) error {
		endInputUnit := a.inputUnits.begin(ctx, session.AgentSessionID)
		defer endInputUnit()
		turnSession := session
		if appSession := a.getSession(session.AgentSessionID); appSession != nil {
			turnSession.ProviderSessionID = firstNonEmpty(appSession.threadID, turnSession.ProviderSessionID)
		}
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
		// Stamp the reduction while the decoder-owned provider input unit is
		// still in scope. Most turn output is stamped again by the active-turn
		// emitter, but lifecycle reductions such as turn/started can take a
		// different emission path. The tracker is idempotent, so the emitter
		// can retain its existing boundary without duplicating indexes.
		events = a.inputUnits.stamp(session.AgentSessionID, events)
		// A child may outlive its root Turn. Only child events owned by the
		// currently active canonical root Turn may enter that Turn's emitter;
		// otherwise a newer Turn's acceptance buffer or close fence can drop them.
		turnEvents, detachedChildEvents := appServerEventsForActiveRootTurn(
			session.AgentSessionID,
			turnID,
			events,
		)
		if turnEmit != nil {
			turnEmit(turnEvents)
		}
		if len(detachedChildEvents) > 0 {
			a.emitSessionEvents(
				session.AgentSessionID,
				a.stampTurnLifecycleSnapshots(session.AgentSessionID, detachedChildEvents),
			)
		}
		return err
	})
	started := false
	defer func() {
		if !started {
			a.closeOrRetainCodexSession(session.AgentSessionID, &codexAppServerSession{
				client:          client,
				pendingRequests: make(map[string]*pendingInteractiveRequest),
			})
		}
	}()
	captureOrigin := processCassetteCaptureOrigin(conn)
	if captureOrigin == ProcessCassetteCaptureOriginAttachedLiveConnection {
		if !allowAttachedCheckpoint {
			return nil, nil, false, errors.New(
				"attached live provider checkpoint cannot start a new Codex session",
			)
		}
		started = true
		return client, nil, true, nil
	}

	initializeResult, err := trace.TypedCall(acpStartCallTimeout, appServerMethodInitialize, func() (json.RawMessage, error) {
		return client.Initialize(ctx, acpStartCallTimeout, map[string]any{
			"clientInfo": a.clientInfoParams(spec.Env),
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
		return nil, nil, false, err
	}
	trace.Log("initialized.notify.begin", nil)
	notifyStartedAt := time.Now()
	if err := client.Initialized(ctx); err != nil {
		trace.Log("initialized.notify.failed", map[string]any{
			"duration_ms": time.Since(notifyStartedAt).Milliseconds(),
			"error":       err.Error(),
		})
		return nil, nil, false, err
	}
	trace.Log("initialized.notify.succeeded", map[string]any{
		"duration_ms": time.Since(notifyStartedAt).Milliseconds(),
	})
	started = true
	return client, initializeResult, false, nil
}

func appServerEventsForActiveRootTurn(
	rootAgentSessionID string,
	activeRootTurnID string,
	events []activityshared.Event,
) ([]activityshared.Event, []activityshared.Event) {
	rootAgentSessionID = strings.TrimSpace(rootAgentSessionID)
	activeRootTurnID = strings.TrimSpace(activeRootTurnID)
	turnEvents := make([]activityshared.Event, 0, len(events))
	detachedChildEvents := make([]activityshared.Event, 0, len(events))
	for _, event := range events {
		eventAgentSessionID := strings.TrimSpace(event.AgentSessionID)
		if eventAgentSessionID != "" && eventAgentSessionID != rootAgentSessionID {
			if activeRootTurnID == "" || strings.TrimSpace(event.RootTurnID) != activeRootTurnID {
				detachedChildEvents = append(detachedChildEvents, event)
				continue
			}
		}
		if activeRootTurnID != "" {
			turnEvents = append(turnEvents, event)
		}
	}
	return turnEvents, detachedChildEvents
}
