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

func (a *standardACPAdapter) Start(ctx context.Context, session Session) ([]activityshared.Event, error) {
	unlockLifecycle := a.lockSessionLifecycle(session.AgentSessionID)
	defer unlockLifecycle()
	a.logHermesStartupDiagnostics("start.enter", map[string]any{
		"room_id":            session.RoomID,
		"agent_session_id":   session.AgentSessionID,
		"cwd":                session.CWD,
		"permission_mode_id": session.PermissionModeID,
		"has_settings":       session.Settings != nil,
	})
	client, initializeResult, err := a.startInitializedClient(ctx, session)
	if err != nil {
		a.logHermesStartupDiagnostics("start.initialized_client_failed", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"error":            err.Error(),
		})
		return nil, err
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
	acpSession := &standardACPSession{
		client:           client,
		agentInfo:        acpAgentInfo(initializeResult),
		promptImage:      standardACPProviderPromptImageSupported(a.config.provider, initializeResult),
		sessionClose:     standardACPSessionCloseSupported(initializeResult),
		acpLiveState:     standardACPInitialLiveState(),
		pendingApprovals: make(map[string]*pendingACPApproval),
		permissionModeID: strings.TrimSpace(session.PermissionModeID),
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
	a.logHermesStartupDiagnostics("session_new.start", map[string]any{
		"room_id":          session.RoomID,
		"agent_session_id": session.AgentSessionID,
		"cwd":              firstNonEmpty(session.CWD, "/"),
		"timeout_ms":       acpStartCallTimeout.Milliseconds(),
	})
	newSessionResult, err := client.CallWithTimeout(ctx, acpStartCallTimeout, acpMethodNewSession, newSessionParams, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	if err != nil {
		a.logHermesStartupDiagnostics("session_new.failed", map[string]any{
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
		a.logHermesStartupDiagnostics("session_new.invalid_result", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"elapsed_ms":       time.Since(newSessionStartedAt).Milliseconds(),
			"error":            err.Error(),
		})
		return nil, err
	}
	a.logHermesStartupDiagnostics("session_new.succeeded", map[string]any{
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
	if err := a.applySessionConfigOptions(ctx, client, session, newSessionResult); err != nil {
		a.logHermesStartupDiagnostics("config_options.failed", map[string]any{
			"room_id":             session.RoomID,
			"agent_session_id":    session.AgentSessionID,
			"provider_session_id": session.ProviderSessionID,
			"error":               err.Error(),
		})
		return nil, err
	}
	if err := a.applyACPMode(ctx, client, session, a.effectiveModeID(session)); err != nil {
		a.logHermesStartupDiagnostics("session_mode.failed", map[string]any{
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
	a.closeReplacedSession(previousSession, client)
	a.logHermesStartupDiagnostics("start.succeeded", map[string]any{
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
	acpSession := &standardACPSession{
		client:            client,
		providerSessionID: session.ProviderSessionID,
		agentInfo:         acpAgentInfo(initializeResult),
		promptImage:       standardACPProviderPromptImageSupported(a.config.provider, initializeResult),
		sessionClose:      standardACPSessionCloseSupported(initializeResult),
		acpLiveState:      standardACPInitialLiveState(),
		pendingApprovals:  make(map[string]*pendingACPApproval),
		permissionModeID:  strings.TrimSpace(session.PermissionModeID),
	}
	if previousSession != nil {
		acpSession.acpLiveState = cloneACPLiveState(previousSession.acpLiveState)
	}
	a.storeSession(session.AgentSessionID, acpSession)

	method := acpResumeMethod(initializeResult)
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
	if err := a.applySessionConfigOptions(ctx, client, session, loadSessionResult); err != nil {
		return err
	}
	if err := a.applyACPMode(ctx, client, session, a.effectiveModeID(session)); err != nil {
		return err
	}
	started = true
	keepSession = true
	a.closeReplacedSession(previousSession, client)
	return nil
}

func (*standardACPAdapter) CanResume(session Session) bool {
	return strings.TrimSpace(session.ProviderSessionID) != ""
}

func (a *standardACPAdapter) HasLiveSession(session Session) bool {
	acpSession := a.getSession(session.AgentSessionID)
	return acpSession != nil && acpSession.client != nil
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
		closeErr := acpSession.client.Close()
		if closeErr != nil {
			a.logACPCloseDiagnostics("transport_close.failed", session, acpSession, closeErr)
			return closeErr
		}
		a.logACPCloseDiagnostics("closed", session, acpSession, nil)
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

func (a *standardACPAdapter) closeReplacedSession(previousSession *standardACPSession, currentClient *acpClient) {
	if previousSession == nil || previousSession.client == nil || previousSession.client == currentClient {
		return
	}
	if err := previousSession.client.Close(); err != nil {
		slog.Warn("agent session ACP replaced client close failed",
			"event", "agent_session.acp.replaced_client.close_failed",
			"provider", a.config.provider,
			"error", err.Error(),
		)
	}
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
	if a == nil || a.transport == nil {
		return nil, nil, errors.New("ACP process transport is unavailable")
	}
	command := append([]string(nil), a.config.command...)
	env := append(a.config.env(session), session.Env...)
	if a.config.commandResolver != nil {
		resolved, err := a.config.commandResolver(ctx, a.config.provider)
		if err != nil {
			return nil, nil, err
		}
		if len(resolved.Command) > 0 {
			command = append([]string(nil), resolved.Command...)
		}
		env = append(env, resolved.Env...)
	}
	if a.config.commandWithSettings != nil {
		command = a.config.commandWithSettings(command, session)
	}
	spec, cleanup, err := prepareProviderLaunch(ctx, a.preparer, session, ProcessSpec{
		Provider:       a.config.provider,
		AgentSessionID: session.AgentSessionID,
		RoomID:         session.RoomID,
		CWD:            session.CWD,
		Command:        command,
		Env:            env,
		DirectStart:    false,
	})
	if err != nil {
		a.logHermesStartupDiagnostics("process_prepare.failed", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"error":            err.Error(),
		})
		return nil, nil, err
	}
	if a.config.finalizeEnv != nil {
		spec.Env, err = a.config.finalizeEnv(spec.Env, session)
		if err != nil {
			cleanupPreparedLaunch(cleanup)
			return nil, nil, err
		}
	}
	processStartedAt := time.Now()
	a.logHermesStartupDiagnostics("process_start.start", map[string]any{
		"room_id":          session.RoomID,
		"agent_session_id": session.AgentSessionID,
		"cwd":              spec.CWD,
		"command":          spec.Command,
		"direct_start":     spec.DirectStart,
	})
	conn, err := a.transport.Start(ctx, spec)
	if err != nil {
		cleanupPreparedLaunch(cleanup)
		a.logHermesStartupDiagnostics("process_start.failed", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"elapsed_ms":       time.Since(processStartedAt).Milliseconds(),
			"error":            err.Error(),
		})
		return nil, nil, err
	}
	conn = wrapProviderLaunchCleanup(conn, cleanup)
	a.logHermesStartupDiagnostics("process_start.succeeded", map[string]any{
		"room_id":          session.RoomID,
		"agent_session_id": session.AgentSessionID,
		"elapsed_ms":       time.Since(processStartedAt).Milliseconds(),
	})
	client := newACPClientWithStderrMessageMapper(conn, a.config.stderrMessageMapper)
	client.SetMessageHandler(func(ctx context.Context, message acpMessage) error {
		turnSession := session
		turnID := a.sessionRecentTurnID(session.AgentSessionID)
		if acpSession := a.getSession(session.AgentSessionID); acpSession != nil {
			turnSession.ProviderSessionID = firstNonEmptyString(acpSession.providerSessionID, turnSession.ProviderSessionID)
		}
		_, err := a.handleACPMessage(ctx, client, turnSession, turnID, message, nil, nil, nil)
		return err
	})
	started := false
	defer func() {
		if !started {
			_ = client.Close()
		}
	}()

	initializeParams := defaultACPInitializeParams(a.host)
	if a.config.initializeParams != nil {
		initializeParams = a.config.initializeParams()
	}
	initializeStartedAt := time.Now()
	a.logHermesStartupDiagnostics("initialize.start", map[string]any{
		"room_id":          session.RoomID,
		"agent_session_id": session.AgentSessionID,
		"timeout_ms":       acpStartCallTimeout.Milliseconds(),
	})
	initializeResult, err := client.CallWithTimeout(ctx, acpStartCallTimeout, acpMethodInitialize, initializeParams, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	if err != nil {
		a.logHermesStartupDiagnostics("initialize.failed", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"elapsed_ms":       time.Since(initializeStartedAt).Milliseconds(),
			"error":            err.Error(),
		})
		return nil, nil, err
	}
	a.logHermesStartupDiagnostics("initialize.succeeded", map[string]any{
		"room_id":          session.RoomID,
		"agent_session_id": session.AgentSessionID,
		"elapsed_ms":       time.Since(initializeStartedAt).Milliseconds(),
		"agent_info":       acpAgentInfo(initializeResult),
	})

	if a.config.beforeNewSession != nil {
		beforeNewSessionStartedAt := time.Now()
		a.logHermesStartupDiagnostics("before_new_session.start", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
		})
		if err := a.config.beforeNewSession(ctx, client, session, initializeResult); err != nil {
			a.logHermesStartupDiagnostics("before_new_session.failed", map[string]any{
				"room_id":          session.RoomID,
				"agent_session_id": session.AgentSessionID,
				"elapsed_ms":       time.Since(beforeNewSessionStartedAt).Milliseconds(),
				"error":            err.Error(),
			})
			var callErr *acpCallError
			if errors.As(err, &callErr) && callErr.AuthRequired() {
				return nil, nil, fmt.Errorf("%s: %w", a.config.authRequiredMessage, err)
			}
			return nil, nil, err
		}
		a.logHermesStartupDiagnostics("before_new_session.succeeded", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"elapsed_ms":       time.Since(beforeNewSessionStartedAt).Milliseconds(),
		})
	}

	started = true
	return client, initializeResult, nil
}
