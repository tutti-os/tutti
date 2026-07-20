package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

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
	serverInfo := a.appServerInfo(initializeResult)
	a.storeSession(session.AgentSessionID, &codexAppServerSession{
		client:          client,
		serverInfo:      serverInfo,
		acpLiveState:    newACPLiveState(),
		pendingRequests: make(map[string]*pendingInteractiveRequest),
	})

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
	serverInfo := a.appServerInfo(initializeResult)

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
	command := append([]string(nil), a.config.command...)
	spawnEnv := append(codexACPEnv(session, a.host), session.Env...)
	if a.commandResolver != nil {
		resolved, err := a.commandResolver(ctx, a.config.provider)
		if err != nil {
			return nil, nil, err
		}
		if len(resolved.Command) > 0 {
			command = append([]string(nil), resolved.Command...)
		}
		spawnEnv = append(spawnEnv, resolved.Env...)
	}
	spec, cleanup, err := prepareProviderLaunch(ctx, a.preparer, session, ProcessSpec{
		Provider:       a.config.provider,
		AgentSessionID: session.AgentSessionID,
		RoomID:         session.RoomID,
		CWD:            a.sessionCWD(session),
		Command:        command,
		Env:            spawnEnv,
	})
	if err != nil {
		trace.Log("process.prepare.failed", map[string]any{
			"error": err.Error(),
		})
		return nil, nil, err
	}
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
		return nil, nil, err
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
