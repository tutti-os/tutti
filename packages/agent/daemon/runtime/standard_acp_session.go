package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"sort"
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
	mcpServers := acpMCPServers(session.MCPServers)
	if len(mcpServers) > 0 && !standardACPHTTPMCPSupported(initializeResult) {
		a.logStandardACPStartupDiagnostics("mcp_http.unsupported_fallback", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"binding_count":    len(mcpServers),
		})
		mcpServers = nil
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
	if a.config.localToolBridge != nil && standardACPHTTPMCPSupported(initializeResult) {
		binding, release, bindErr := a.config.localToolBridge.Bind(ctx, session)
		if bindErr != nil {
			return nil, fmt.Errorf("bind local ACP tool bridge: %w", bindErr)
		}
		acpSession.localToolRelease = release
		mcpServers = append(mcpServers, acpMCPServers([]MCPServerBinding{binding})...)
	}

	newSessionParams := map[string]any{
		"cwd":        standardACPProtocolCWD(session.CWD),
		"mcpServers": mcpServers,
	}
	if err := a.applyProviderSessionMeta(newSessionParams, session); err != nil {
		return nil, err
	}
	newSessionStartedAt := time.Now()
	a.logStandardACPStartupDiagnostics("session_new.start", map[string]any{
		"room_id":          session.RoomID,
		"agent_session_id": session.AgentSessionID,
		"cwd":              standardACPProtocolCWD(session.CWD),
		"timeout_ms":       a.startupCallTimeout().Milliseconds(),
	})
	newSessionResult, err := a.callSessionNewWithRetry(ctx, client, session, newSessionParams, func(ctx context.Context, message acpMessage) error {
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
		return nil, &AppError{
			Code:         AppErrorProviderSessionCreateFailed,
			Message:      err.Error(),
			DebugMessage: "provider session/new failed: " + err.Error(),
			Cause:        err,
		}
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
	applyACPConfigOptionsResult(
		&acpSession.acpLiveState,
		newSessionResult,
		a.config.modelConfigOptionID,
		a.config.modelDescriptionFormat,
	)
	applyACPModelsResult(&acpSession.acpLiveState, newSessionResult, a.config.modelDescriptionFormat)
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

func (a *standardACPAdapter) callSessionNewWithRetry(
	ctx context.Context,
	client *acpClient,
	session Session,
	params map[string]any,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	limit := 0
	if a != nil && a.config.retrySessionNewError != nil && a.config.sessionNewRetryLimit > 0 {
		limit = a.config.sessionNewRetryLimit
	}
	for attempt := 0; ; attempt++ {
		result, err := client.CallWithTimeout(ctx, a.startupCallTimeout(), acpMethodNewSession, params, handler)
		if err == nil || attempt >= limit || a.config.retrySessionNewError == nil || !a.config.retrySessionNewError(err) {
			return result, err
		}
		a.logStandardACPStartupDiagnostics("session_new.retry", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"attempt":          attempt + 1,
			"max_retries":      limit,
			"error":            err.Error(),
		})
	}
}

// standardACPProtocolCWD keeps the provider protocol's working directory
// aligned with the process working directory when the caller did not supply
// one. A POSIX root is not a valid Windows workspace fallback: sending "/"
// makes a Windows provider resolve searches against a path that cannot exist.
func standardACPProtocolCWD(cwd string) string {
	if strings.TrimSpace(cwd) != "" {
		return cwd
	}
	if runtime.GOOS == "windows" {
		if processCWD, err := os.Getwd(); err == nil && strings.TrimSpace(processCWD) != "" {
			return processCWD
		}
		// Keep the provider anchored to the child process's native cwd even if
		// the host cannot materialize an absolute spelling for it.
		return "."
	}
	return "/"
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
	client, initializeResult, attachedCheckpoint, err := a.startClient(ctx, session, true, true)
	if err != nil {
		return err
	}
	mcpServers := acpMCPServers(session.MCPServers)
	if !attachedCheckpoint && len(mcpServers) > 0 && !standardACPHTTPMCPSupported(initializeResult) {
		a.logStandardACPStartupDiagnostics("mcp_http.unsupported_fallback", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"binding_count":    len(mcpServers),
		})
		mcpServers = nil
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
	if a.config.localToolBridge != nil && standardACPHTTPMCPSupported(initializeResult) {
		binding, release, bindErr := a.config.localToolBridge.Bind(ctx, session)
		if bindErr != nil {
			return fmt.Errorf("bind local ACP tool bridge: %w", bindErr)
		}
		acpSession.localToolRelease = release
		mcpServers = append(mcpServers, acpMCPServers([]MCPServerBinding{binding})...)
	}

	method := acpSession.resumeMethod
	if method == "" {
		return unsupportedACPResumeError(session)
	}
	resumeParams := map[string]any{
		"sessionId":  session.ProviderSessionID,
		"cwd":        standardACPProtocolCWD(session.CWD),
		"mcpServers": mcpServers,
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
	applyACPConfigOptionsResult(
		&acpSession.acpLiveState,
		loadSessionResult,
		a.config.modelConfigOptionID,
		a.config.modelDescriptionFormat,
	)
	applyACPModelsResult(&acpSession.acpLiveState, loadSessionResult, a.config.modelDescriptionFormat)
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

func acpMCPServers(bindings []MCPServerBinding) []any {
	servers := make([]any, 0, len(bindings))
	for _, binding := range bindings {
		if strings.TrimSpace(binding.Name) == "" || strings.TrimSpace(binding.URL) == "" || strings.TrimSpace(binding.Type) != "http" {
			continue
		}
		headerNames := make([]string, 0, len(binding.Headers))
		for name := range binding.Headers {
			headerNames = append(headerNames, name)
		}
		sort.Strings(headerNames)
		headers := make([]any, 0, len(headerNames))
		for _, name := range headerNames {
			headers = append(headers, map[string]any{"name": name, "value": binding.Headers[name]})
		}
		servers = append(servers, map[string]any{
			"name": binding.Name, "type": "http", "url": binding.URL, "headers": headers,
		})
	}
	return servers
}

func standardACPHTTPMCPSupported(raw json.RawMessage) bool {
	var result struct {
		AgentCapabilities struct {
			MCPCapabilities struct {
				HTTP bool `json:"http"`
			} `json:"mcpCapabilities"`
		} `json:"agentCapabilities"`
	}
	return json.Unmarshal(raw, &result) == nil && result.AgentCapabilities.MCPCapabilities.HTTP
}

func (*standardACPAdapter) CanResume(session Session) bool {
	return strings.TrimSpace(session.ProviderSessionID) != ""
}

func (a *standardACPAdapter) HasLiveSession(session Session) bool {
	acpSession := a.getUsableSession(session.AgentSessionID)
	if acpSession == nil || acpSession.client == nil {
		return false
	}
	select {
	case <-acpSession.client.Done():
		return false
	default:
		return true
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
	client, initializeResult, _, err := a.startClient(ctx, session, false, true)
	return client, initializeResult, err
}

func (a *standardACPAdapter) ConnectorCapabilities(
	ctx context.Context,
	session Session,
) (ConnectorCapabilities, error) {
	client, initializeResult, _, err := a.startClient(ctx, session, false, false)
	if err != nil {
		return ConnectorCapabilities{}, err
	}
	if err := client.Close(); err != nil {
		slog.WarnContext(ctx, "close ACP Connector capability probe", "provider", a.Provider(), "error", err)
	}
	return ConnectorCapabilities{HTTPMCP: standardACPHTTPMCPSupported(initializeResult)}, nil
}

func (a *standardACPAdapter) startClient(
	ctx context.Context,
	session Session,
	allowAttachedCheckpoint bool,
	runBeforeNewSession bool,
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
		ProtocolCWD:        standardACPProtocolCWD(session.CWD),
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
		"protocol_cwd":     spec.ProtocolCWD,
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

	if runBeforeNewSession && a.config.beforeNewSession != nil {
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
