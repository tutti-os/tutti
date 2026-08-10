package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *standardACPAdapter) startupCallTimeout() time.Duration {
	if a != nil && a.config.startupTimeout > 0 {
		return a.config.startupTimeout
	}
	return acpStartCallTimeout
}

func (a *standardACPAdapter) Start(ctx context.Context, session Session) ([]activityshared.Event, error) {
	unlockLifecycle := a.lockSessionLifecycle(session.AgentSessionID)
	defer unlockLifecycle()
	if err := a.admitReplacementLocked(session.AgentSessionID); err != nil {
		return nil, err
	}
	previousSession := a.getSession(session.AgentSessionID)
	a.logStandardACPStartupDiagnostics("start.enter", map[string]any{
		"room_id":            session.RoomID,
		"agent_session_id":   session.AgentSessionID,
		"cwd":                session.CWD,
		"permission_mode_id": session.PermissionModeID,
		"has_settings":       session.Settings != nil,
	})
	client, initializeResult, err := a.startInitializedClient(ctx, session)
	if err != nil {
		a.logStandardACPStartupDiagnostics("start.initialized_client_failed", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"error":            err.Error(),
		})
		return nil, err
	}
	started := false
	keepSession := false
	var acpSession *standardACPSession
	defer func() {
		if !started && acpSession != nil {
			a.closeOrRetainSession(session, acpSession)
		}
		if !keepSession {
			if previousSession != nil {
				a.storeSession(session.AgentSessionID, previousSession)
			} else {
				a.removeSession(session.AgentSessionID)
			}
		}
	}()
	initialPromptContext, err := a.resolveInitialPromptContext(session)
	if err != nil {
		return nil, err
	}
	acpSession = &standardACPSession{
		client:               client,
		agentInfo:            acpAgentInfo(initializeResult),
		promptImage:          standardACPProviderPromptImageSupported(a.config.provider, initializeResult),
		sessionClose:         standardACPSessionCloseSupported(initializeResult),
		resumeMethod:         acpResumeMethod(initializeResult),
		acpLiveState:         standardACPInitialLiveState(),
		pendingApprovals:     make(map[string]*pendingACPApproval),
		permissionModeID:     strings.TrimSpace(session.PermissionModeID),
		planMode:             session.SettingsValue().PlanMode,
		lifecycleSeq:         session.LifecycleSeq,
		initialPromptContext: initialPromptContext,
	}
	a.storeSession(session.AgentSessionID, acpSession)

	newSessionParams := map[string]any{
		"cwd":        firstNonEmpty(session.CWD, "/"),
		"mcpServers": []any{},
	}
	if err := a.applyProviderSessionMeta(newSessionParams, session); err != nil {
		return nil, err
	}
	newSessionStartedAt := time.Now()
	a.logStandardACPStartupDiagnostics("session_new.start", map[string]any{
		"room_id":          session.RoomID,
		"agent_session_id": session.AgentSessionID,
		"cwd":              firstNonEmpty(session.CWD, "/"),
		"timeout_ms":       a.startupCallTimeout().Milliseconds(),
	})
	newSessionResult, err := client.CallWithTimeout(ctx, a.startupCallTimeout(), acpMethodNewSession, newSessionParams, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	if err != nil {
		a.logStandardACPStartupDiagnostics("session_new.failed", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"elapsed_ms":       time.Since(newSessionStartedAt).Milliseconds(),
			"error":            err.Error(),
		})
		var callErr *acpCallError
		if errors.As(err, &callErr) && callErr.AuthRequired() {
			return nil, fmt.Errorf("%s: %w", a.config.authRequiredMessage, err)
		}
		return nil, err
	}
	providerSessionID, err := acpSessionID(newSessionResult)
	if err != nil {
		a.logStandardACPStartupDiagnostics("session_new.invalid_result", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"elapsed_ms":       time.Since(newSessionStartedAt).Milliseconds(),
			"error":            err.Error(),
		})
		return nil, err
	}
	a.logStandardACPStartupDiagnostics("session_new.succeeded", map[string]any{
		"room_id":             session.RoomID,
		"agent_session_id":    session.AgentSessionID,
		"provider_session_id": providerSessionID,
		"elapsed_ms":          time.Since(newSessionStartedAt).Milliseconds(),
		"config_option_ids":   acpConfigOptionIDList(newSessionResult),
	})
	session.ProviderSessionID = providerSessionID
	acpSession.providerSessionID = providerSessionID
	applyACPConfigOptionsResult(&acpSession.acpLiveState, newSessionResult)
	applyACPModelsResult(&acpSession.acpLiveState, newSessionResult)
	applyACPModesResult(&acpSession.acpLiveState, newSessionResult)
	if a.config.validateNewSessionResult != nil {
		if err := a.config.validateNewSessionResult(newSessionResult); err != nil {
			a.logStandardACPStartupDiagnostics("session_new.validation_failed", map[string]any{
				"room_id":             session.RoomID,
				"agent_session_id":    session.AgentSessionID,
				"provider_session_id": session.ProviderSessionID,
				"error":               err.Error(),
			})
			return nil, err
		}
	}
	if err := a.applySessionConfigOptions(ctx, client, session, newSessionResult); err != nil {
		a.logStandardACPStartupDiagnostics("config_options.failed", map[string]any{
			"room_id":             session.RoomID,
			"agent_session_id":    session.AgentSessionID,
			"provider_session_id": session.ProviderSessionID,
			"error":               err.Error(),
		})
		return nil, err
	}
	if err := a.applyACPMode(ctx, client, session, a.startupModeID(session)); err != nil {
		a.logStandardACPStartupDiagnostics("session_mode.failed", map[string]any{
			"room_id":             session.RoomID,
			"agent_session_id":    session.AgentSessionID,
			"provider_session_id": session.ProviderSessionID,
			"permission_mode_id":  session.PermissionModeID,
			"error":               err.Error(),
		})
		return nil, err
	}

	started = true
	keepSession = true
	a.closeReplacedSession(session.AgentSessionID, previousSession, client)
	a.logStandardACPStartupDiagnostics("start.succeeded", map[string]any{
		"room_id":             session.RoomID,
		"agent_session_id":    session.AgentSessionID,
		"provider_session_id": session.ProviderSessionID,
	})
	return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, map[string]any{
		"adapter":          a.config.adapterName,
		"command":          strings.Join(a.config.command, " "),
		"agent":            acpAgentInfo(initializeResult),
		"permissionModeId": session.PermissionModeID,
	})}, nil
}

func (a *standardACPAdapter) Resume(ctx context.Context, session Session) error {
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		return missingProviderSessionResumeError(session)
	}
	unlockLifecycle := a.lockSessionLifecycle(session.AgentSessionID)
	defer unlockLifecycle()
	if err := a.admitReplacementLocked(session.AgentSessionID); err != nil {
		return err
	}
	return a.resumeLocked(ctx, session)
}

// resumeLocked reconnects a provider process while the caller owns the
// per-session lifecycle lock. ApplySessionSettings uses it when a launch-time
// Plan setting must replace an already usable process without re-entering the
// same lock.
func (a *standardACPAdapter) resumeLocked(ctx context.Context, session Session) error {
	previousSession := a.getSession(session.AgentSessionID)
	client, initializeResult, attachedCheckpoint, err := a.startClient(ctx, session, true)
	if err != nil {
		return err
	}
	started := false
	keepSession := false
	var acpSession *standardACPSession
	defer func() {
		if !started && acpSession != nil {
			a.closeOrRetainSession(session, acpSession)
		}
		if !keepSession {
			if previousSession != nil {
				a.storeSession(session.AgentSessionID, previousSession)
			} else {
				a.removeSession(session.AgentSessionID)
			}
		}
	}()
	initialPromptContext, err := a.resolveInitialPromptContext(session)
	if err != nil {
		return err
	}
	if attachedCheckpoint {
		liveState := standardACPInitialLiveState()
		liveState.currentMode = firstNonEmpty(
			asString(session.RuntimeContext["mode"]),
			a.startupModeID(session),
		)
		agentInfo, _ := session.RuntimeContext["agent"].(map[string]any)
		acpSession = &standardACPSession{
			client:               client,
			providerSessionID:    session.ProviderSessionID,
			resumeRuntimeContext: clonePayload(session.RuntimeContext),
			agentInfo:            clonePayload(agentInfo),
			acpLiveState:         liveState,
			pendingApprovals:     make(map[string]*pendingACPApproval),
			permissionModeID:     strings.TrimSpace(session.PermissionModeID),
			planMode:             session.SettingsValue().PlanMode,
			lifecycleSeq:         session.LifecycleSeq,
			initialPromptContext: initialPromptContext,
		}
		started = true
		keepSession = true
		a.storeSession(session.AgentSessionID, acpSession)
		a.closeReplacedSession(session.AgentSessionID, previousSession, client)
		return nil
	}
	acpSession = &standardACPSession{
		client:               client,
		providerSessionID:    session.ProviderSessionID,
		agentInfo:            acpAgentInfo(initializeResult),
		promptImage:          standardACPProviderPromptImageSupported(a.config.provider, initializeResult),
		sessionClose:         standardACPSessionCloseSupported(initializeResult),
		resumeMethod:         acpResumeMethod(initializeResult),
		acpLiveState:         standardACPInitialLiveState(),
		pendingApprovals:     make(map[string]*pendingACPApproval),
		permissionModeID:     strings.TrimSpace(session.PermissionModeID),
		planMode:             session.SettingsValue().PlanMode,
		lifecycleSeq:         session.LifecycleSeq,
		initialPromptContext: initialPromptContext,
	}
	if previousSession != nil {
		acpSession.acpLiveState = cloneACPLiveState(previousSession.acpLiveState)
	}
	a.storeSession(session.AgentSessionID, acpSession)

	method := acpSession.resumeMethod
	if method == "" {
		return unsupportedACPResumeError(session)
	}
	resumeParams := map[string]any{
		"sessionId":  session.ProviderSessionID,
		"cwd":        firstNonEmpty(session.CWD, "/"),
		"mcpServers": []any{},
	}
	if err := a.applyProviderSessionMeta(resumeParams, session); err != nil {
		return err
	}
	loadSessionResult, err := client.CallWithTimeout(ctx, acpStartCallTimeout, method, resumeParams, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	if err != nil {
		return classifyACPResumeError(session, method, err)
	}
	applyACPConfigOptionsResult(&acpSession.acpLiveState, loadSessionResult)
	applyACPModelsResult(&acpSession.acpLiveState, loadSessionResult)
	applyACPModesResult(&acpSession.acpLiveState, loadSessionResult)
	if err := a.applySessionConfigOptions(ctx, client, session, loadSessionResult); err != nil {
		return err
	}
	if err := a.applyACPMode(ctx, client, session, a.startupModeID(session)); err != nil {
		return err
	}
	started = true
	keepSession = true
	a.closeReplacedSession(session.AgentSessionID, previousSession, client)
	return nil
}

func (*standardACPAdapter) CanResume(session Session) bool {
	return strings.TrimSpace(session.ProviderSessionID) != ""
}

func (a *standardACPAdapter) HasLiveSession(session Session) bool {
	if a == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	acpSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	return acpSession != nil && acpSession.client != nil && !acpSession.releasing && !acpSession.releaseFailed
}

func (a *standardACPAdapter) hasTrackedLiveSession(session Session) bool {
	if a == nil {
		return false
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	a.mu.Lock()
	defer a.mu.Unlock()
	current := a.sessions[agentSessionID]
	return (current != nil && current.client != nil) || len(a.retiredSessions[agentSessionID]) > 0
}

func (a *standardACPAdapter) CanReleaseLiveSession(session Session) bool {
	if a == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	acpSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	// Let the live-session probe classify an already released session as not
	// live. A live process is releasable only when its handshake proved that
	// the provider session can be restored by a replacement process.
	return acpSession == nil || acpSession.client == nil || strings.TrimSpace(acpSession.resumeMethod) != ""
}

func (a *standardACPAdapter) ReleaseLiveSession(_ context.Context, session Session) error {
	if a == nil || a.transport == nil {
		return nil
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	unlockLifecycle := a.lockSessionLifecycle(agentSessionID)
	defer unlockLifecycle()

	a.mu.Lock()
	acpSession := a.sessions[agentSessionID]
	if acpSession == nil || acpSession.client == nil {
		a.mu.Unlock()
		return nil
	}
	if strings.TrimSpace(acpSession.resumeMethod) == "" {
		a.mu.Unlock()
		return errors.New("ACP live session cannot be released without resume support")
	}
	for _, approval := range acpSession.pendingApprovals {
		state := approval.disposition()
		if state == pendingInteractiveRequestStatePending || state == pendingInteractiveRequestStateResolving {
			a.mu.Unlock()
			return ErrLiveSessionBusy
		}
	}
	acpSession.releasing = true
	acpSession.client.SetMessageHandler(nil)
	a.mu.Unlock()

	// Do not send session/close here: the durable provider session id must stay
	// valid so the next Exec can start a new CLI process and load/resume it.
	if err := acpSession.client.Close(); err != nil {
		a.mu.Lock()
		if a.sessions[agentSessionID] == acpSession {
			acpSession.releasing = false
			acpSession.releaseFailed = true
		}
		a.mu.Unlock()
		a.logACPCloseDiagnostics("live_release.transport_close.failed", session, acpSession, err)
		return err
	}
	a.mu.Lock()
	if a.sessions[agentSessionID] == acpSession {
		delete(a.sessions, agentSessionID)
	}
	a.mu.Unlock()
	a.logACPCloseDiagnostics("live_release.succeeded", session, acpSession, nil)
	return nil
}

func (a *standardACPAdapter) Close(ctx context.Context, session Session) error {
	if a == nil || a.transport == nil {
		return nil
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	unlockLifecycle := a.lockSessionLifecycle(agentSessionID)
	defer unlockLifecycle()
	a.rejectPendingApprovals(agentSessionID, errPermissionRequestCanceled)
	a.mu.Lock()
	acpSession := a.sessions[agentSessionID]
	delete(a.sessions, agentSessionID)
	a.mu.Unlock()
	if acpSession != nil && acpSession.client != nil {
		a.closeProviderSession(ctx, session, acpSession)
		acpSession.client.SetMessageHandler(nil)
		closeErr := acpSession.client.Close()
		if closeErr != nil {
			a.logACPCloseDiagnostics("transport_close.failed", session, acpSession, closeErr)
			a.retainRetiredSession(agentSessionID, acpSession)
		} else {
			a.logACPCloseDiagnostics("closed", session, acpSession, nil)
		}
		return closeErr
	}
	return nil
}

func (a *standardACPAdapter) closeProviderSession(ctx context.Context, session Session, acpSession *standardACPSession) {
	if a == nil || acpSession == nil || acpSession.client == nil || !acpSession.sessionClose {
		return
	}
	providerSessionID := strings.TrimSpace(firstNonEmptyString(acpSession.providerSessionID, session.ProviderSessionID))
	if providerSessionID == "" {
		a.logACPCloseDiagnostics("protocol_close.skipped_missing_session_id", session, acpSession, nil)
		return
	}
	params := map[string]any{"sessionId": providerSessionID}
	if _, err := acpSession.client.CallNoHandlerWithTimeout(ctx, acpCloseCallTimeout, acpMethodCloseSession, params); err != nil {
		a.logACPCloseDiagnostics("protocol_close.failed", session, acpSession, err)
		return
	}
	a.logACPCloseDiagnostics("protocol_close.succeeded", session, acpSession, nil)
	a.waitForACPClientDone(acpSession.client, acpCloseGraceTimeout)
}

func (a *standardACPAdapter) closeReplacedSession(agentSessionID string, previousSession *standardACPSession, currentClient *acpClient) {
	if previousSession == nil || previousSession.client == nil || previousSession.client == currentClient {
		return
	}
	previousSession.client.SetMessageHandler(nil)
	if err := previousSession.client.Close(); err != nil {
		a.retainRetiredSession(agentSessionID, previousSession)
		slog.Warn("agent session ACP replaced client close failed",
			"event", "agent_session.acp.replaced_client.close_failed",
			"provider", a.config.provider,
			"error", err.Error(),
		)
	}
}

func (a *standardACPAdapter) retryOneTrackedSession(agentSessionID string) (bool, error) {
	if a == nil {
		return false, nil
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	a.mu.Lock()
	if agentSessionID == "" {
		for candidate, session := range a.sessions {
			if session != nil && session.client != nil && session.releaseFailed && !session.releasing {
				agentSessionID = candidate
				break
			}
		}
		if agentSessionID == "" {
			for candidate, sessions := range a.retiredSessions {
				if len(sessions) > 0 {
					agentSessionID = candidate
					break
				}
			}
		}
	}
	a.mu.Unlock()
	if agentSessionID == "" {
		return false, nil
	}
	unlockLifecycle := a.lockSessionLifecycle(agentSessionID)
	defer unlockLifecycle()
	return a.retryOneTrackedSessionLocked(agentSessionID)
}

func (a *standardACPAdapter) retryOneTrackedSessionLocked(agentSessionID string) (bool, error) {
	a.mu.Lock()
	current := a.sessions[agentSessionID]
	if current != nil && current.client != nil && current.releaseFailed && !current.releasing {
		current.releasing = true
		current.client.SetMessageHandler(nil)
		a.mu.Unlock()
		if err := current.client.Close(); err != nil {
			a.mu.Lock()
			if a.sessions[agentSessionID] == current {
				current.releasing = false
			}
			a.mu.Unlock()
			return true, err
		}
		a.mu.Lock()
		if a.sessions[agentSessionID] == current {
			delete(a.sessions, agentSessionID)
		}
		a.mu.Unlock()
		return true, nil
	}
	retired := a.retiredSessions[agentSessionID]
	var session *standardACPSession
	for _, candidate := range retired {
		if candidate != nil && !candidate.releasing {
			session = candidate
			break
		}
	}
	if session == nil {
		a.mu.Unlock()
		return false, nil
	}
	session.releasing = true
	if session.client != nil {
		session.client.SetMessageHandler(nil)
	}
	a.mu.Unlock()
	if session.client == nil {
		a.removeRetiredSession(agentSessionID, session)
		return true, nil
	}
	if err := session.client.Close(); err != nil {
		a.mu.Lock()
		session.releasing = false
		a.mu.Unlock()
		return true, err
	}
	a.removeRetiredSession(agentSessionID, session)
	return true, nil
}

func (a *standardACPAdapter) removeRetiredSession(agentSessionID string, target *standardACPSession) {
	a.mu.Lock()
	defer a.mu.Unlock()
	retired := a.retiredSessions[agentSessionID]
	for index, session := range retired {
		if session != target {
			continue
		}
		retired = append(retired[:index], retired[index+1:]...)
		if len(retired) == 0 {
			delete(a.retiredSessions, agentSessionID)
		} else {
			a.retiredSessions[agentSessionID] = retired
		}
		return
	}
}

func (a *standardACPAdapter) CleanupLiveSessionResources(ctx context.Context, limit int) LiveSessionResourceCleanupResult {
	var result LiveSessionResourceCleanupResult
	if limit <= 0 {
		return result
	}
	select {
	case <-ctx.Done():
		return result
	default:
	}
	attempted, err := a.retryOneTrackedSession("")
	if !attempted {
		return result
	}
	result.Attempted = 1
	if err != nil {
		result.Failed = 1
	} else {
		result.Cleaned = 1
	}
	return result
}

func (*standardACPAdapter) waitForACPClientDone(client *acpClient, timeout time.Duration) {
	if client == nil {
		return
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-client.Done():
	case <-timer.C:
	}
}

func (a *standardACPAdapter) logACPCloseDiagnostics(stage string, session Session, acpSession *standardACPSession, err error) {
	if a == nil || acpSession == nil || acpSession.client == nil {
		return
	}
	diag := acpSession.client.Diagnostics()
	args := []any{
		"event", "agent_session.acp.close",
		"provider", a.config.provider,
		"stage", stage,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", firstNonEmptyString(acpSession.providerSessionID, session.ProviderSessionID),
		"stdout_tail", truncateACPLogValue(diag.StdoutTail, 1200),
		"stderr_tail", truncateACPLogValue(diag.StderrTail, 1200),
	}
	if diag.ExitCode != nil {
		args = append(args, "exit_code", *diag.ExitCode)
	}
	if err != nil {
		args = append(args, "error", err.Error())
		slog.Warn("agent session ACP close diagnostic", args...)
		return
	}
	slog.Info("agent session ACP close diagnostic", args...)
}

func (a *standardACPAdapter) startInitializedClient(
	ctx context.Context,
	session Session,
) (*acpClient, json.RawMessage, error) {
	client, initializeResult, _, err := a.startClient(ctx, session, false)
	return client, initializeResult, err
}

func (a *standardACPAdapter) startClient(
	ctx context.Context,
	session Session,
	allowAttachedCheckpoint bool,
) (*acpClient, json.RawMessage, bool, error) {
	if a == nil || a.transport == nil {
		return nil, nil, false, errors.New("ACP process transport is unavailable")
	}
	command := append([]string(nil), a.config.command...)
	env := append(a.config.env(session), session.Env...)
	if a.config.commandResolver != nil {
		resolved, err := a.config.commandResolver(ctx, a.config.provider)
		if err != nil {
			return nil, nil, false, err
		}
		if len(resolved.Command) > 0 {
			command = append([]string(nil), resolved.Command...)
		}
		env = append(env, resolved.Env...)
	}
	if a.config.commandWithSettings != nil {
		command = a.config.commandWithSettings(command, session)
	}
	var err error
	if a.config.planModeUsesLaunchPermission && session.SettingsValue().PlanMode {
		command, err = applyStandardACPLaunchPermissionValue(command, a.config.launchPermission, a.config.planModeRuntimeID)
	} else {
		command, err = applyStandardACPLaunchPermission(command, a.config.launchPermission, session.PermissionModeID)
	}
	if err != nil {
		return nil, nil, false, err
	}
	spec, cleanup, err := prepareProviderLaunch(ctx, a.preparer, session, ProcessSpec{
		Provider:           a.config.provider,
		AgentSessionID:     session.AgentSessionID,
		RootAgentSessionID: session.RootAgentSessionID,
		RoomID:             session.RoomID,
		CWD:                session.CWD,
		ProtocolCWD:        firstNonEmpty(session.CWD, "/"),
		Command:            command,
		Env:                env,
		DirectStart:        false,
		ExecutableIdentity: cloneExecutableIdentity(a.config.executableIdentity),
	})
	if err != nil {
		a.logStandardACPStartupDiagnostics("process_prepare.failed", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"error":            err.Error(),
		})
		return nil, nil, false, err
	}
	if a.config.finalizeEnv != nil {
		spec.Env, err = a.config.finalizeEnv(spec.Env, session)
		if err != nil {
			cleanupPreparedLaunch(cleanup)
			return nil, nil, false, err
		}
	}
	processStartedAt := time.Now()
	a.logStandardACPStartupDiagnostics("process_start.start", map[string]any{
		"room_id":          session.RoomID,
		"agent_session_id": session.AgentSessionID,
		"cwd":              spec.CWD,
		"command":          spec.Command,
		"direct_start":     spec.DirectStart,
	})
	conn, err := a.transport.Start(ctx, spec)
	if err != nil {
		cleanupPreparedLaunch(cleanup)
		a.logStandardACPStartupDiagnostics("process_start.failed", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"elapsed_ms":       time.Since(processStartedAt).Milliseconds(),
			"error":            err.Error(),
		})
		return nil, nil, false, err
	}
	conn = wrapProviderLaunchCleanup(conn, cleanup)
	a.logStandardACPStartupDiagnostics("process_start.succeeded", map[string]any{
		"room_id":          session.RoomID,
		"agent_session_id": session.AgentSessionID,
		"elapsed_ms":       time.Since(processStartedAt).Milliseconds(),
	})
	client := newACPClientWithStderrMessageMapper(conn, a.config.stderrMessageMapper)
	client.SetMessageHandler(func(ctx context.Context, message acpMessage) error {
		if !a.isUsableCurrentClient(session.AgentSessionID, client) {
			return nil
		}
		endInputUnit := a.inputUnits.begin(ctx, session.AgentSessionID)
		defer endInputUnit()
		turnSession := session
		turnID := a.sessionRecentTurnID(session.AgentSessionID)
		if acpSession := a.getSession(session.AgentSessionID); acpSession != nil {
			turnSession.ProviderSessionID = firstNonEmptyString(acpSession.providerSessionID, turnSession.ProviderSessionID)
		}
		_, err := a.handleACPMessage(ctx, client, turnSession, turnID, message, nil, nil, nil)
		return err
	})
	started := false
	failedSession := &standardACPSession{
		client:           client,
		pendingApprovals: make(map[string]*pendingACPApproval),
	}
	defer func() {
		if !started {
			a.closeOrRetainSession(session, failedSession)
		}
	}()
	captureOrigin := processCassetteCaptureOrigin(conn)
	if captureOrigin == ProcessCassetteCaptureOriginAttachedLiveConnection {
		if !allowAttachedCheckpoint {
			return nil, nil, false, errors.New(
				"attached live provider checkpoint cannot start a new ACP session",
			)
		}
		started = true
		return client, nil, true, nil
	}

	initializeParams := defaultACPInitializeParams(a.host)
	if a.config.initializeParams != nil {
		initializeParams = a.config.initializeParams()
	}
	initializeStartedAt := time.Now()
	a.logStandardACPStartupDiagnostics("initialize.start", map[string]any{
		"room_id":          session.RoomID,
		"agent_session_id": session.AgentSessionID,
		"timeout_ms":       a.startupCallTimeout().Milliseconds(),
	})
	initializeResult, err := client.CallWithTimeout(ctx, a.startupCallTimeout(), acpMethodInitialize, initializeParams, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	if err != nil {
		a.logStandardACPStartupDiagnostics("initialize.failed", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"elapsed_ms":       time.Since(initializeStartedAt).Milliseconds(),
			"error":            err.Error(),
		})
		return nil, nil, false, err
	}
	a.logStandardACPStartupDiagnostics("initialize.succeeded", map[string]any{
		"room_id":          session.RoomID,
		"agent_session_id": session.AgentSessionID,
		"elapsed_ms":       time.Since(initializeStartedAt).Milliseconds(),
		"agent_info":       acpAgentInfo(initializeResult),
	})

	if a.config.beforeNewSession != nil {
		beforeNewSessionStartedAt := time.Now()
		a.logStandardACPStartupDiagnostics("before_new_session.start", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
		})
		if err := a.config.beforeNewSession(ctx, client, session, initializeResult); err != nil {
			a.logStandardACPStartupDiagnostics("before_new_session.failed", map[string]any{
				"room_id":          session.RoomID,
				"agent_session_id": session.AgentSessionID,
				"elapsed_ms":       time.Since(beforeNewSessionStartedAt).Milliseconds(),
				"error":            err.Error(),
			})
			var callErr *acpCallError
			if errors.As(err, &callErr) && callErr.AuthRequired() {
				return nil, nil, false, fmt.Errorf("%s: %w", a.config.authRequiredMessage, err)
			}
			return nil, nil, false, err
		}
		a.logStandardACPStartupDiagnostics("before_new_session.succeeded", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"elapsed_ms":       time.Since(beforeNewSessionStartedAt).Milliseconds(),
		})
	}

	started = true
	return client, initializeResult, false, nil
}
