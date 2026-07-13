//revive:disable:file-length-limit
package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type standardACPConfig struct {
	provider            string
	adapterName         string
	command             []string
	defaultTitle        string
	defaultTitleAliases []string
	authRequiredMessage string
	permissionModeID    func(string) string
	// initializeParams returns the initialize request params for this ACP provider.
	// Some providers, such as Claude Agent, require richer terminal/auth capability
	// declarations than the generic ACP defaults.
	initializeParams func() map[string]any
	// setModeParams returns extra JSON-RPC params merged into session/set_mode after sessionId and modeId.
	setModeParams      func(Session) map[string]any
	failOnSetModeError bool
	env                func(Session) []string
	commandResolver    ProviderCommandResolver
	beforeNewSession   func(context.Context, *acpClient, Session, json.RawMessage) error
	// allowSyntheticNotice lets codex-acp-derived providers promote bare
	// transport text ("Reconnecting... 1/5", "Falling back ... transport")
	// streamed as ordinary chunks into system-notice banners instead of
	// appending it to the assistant reply.
	allowSyntheticNotice bool
	// stderrMessageMapper translates provider stderr frames into synthetic
	// session/update messages (e.g. codex-acp retry logs -> transport notices).
	stderrMessageMapper acpStderrMessageMapper
	// commandWithSettings appends session-settings-derived spawn arguments to
	// the resolved command (e.g. codex-acp `--config model=...` flags that can
	// only be applied at process start).
	commandWithSettings func([]string, Session) []string
	// requiresNewSessionForSettings reports settings patches that can only
	// take effect via a fresh process/session (spawn-time-only flags).
	requiresNewSessionForSettings func(Session, SessionSettingsPatch) bool
	// autoApprovePermissionDecision lets a provider resolve incoming
	// session/request_permission requests without prompting, from the live
	// permission tier (e.g. Cursor "full access"). It returns a decision
	// token ("approved" / "denied") to apply automatically, or "" to prompt
	// the user as usual. Nil (the default) always prompts.
	autoApprovePermissionDecision func(permissionModeID string) string
	// autoContinueRetriableTurnError resumes turns the agent ends "normally"
	// right after streaming a transient network error as plain text (Cursor's
	// "Error: RetriableError: ..." tail). See acp_auto_continue.go.
	autoContinueRetriableTurnError bool
}

type standardACPAdapter struct {
	config         standardACPConfig
	transport      ProcessTransport
	host           HostMetadata
	preparer       ProviderLaunchPreparer
	mu             sync.Mutex
	sessions       map[string]*standardACPSession
	commandSink    CommandSnapshotSink
	eventSink      SessionEventSink
	configSink     ConfigOptionsUpdateSink
	lifecycleMu    sync.Mutex
	lifecycleLocks map[string]*standardACPSessionLock
}

type standardACPSession struct {
	client            *acpClient
	providerSessionID string
	agentInfo         map[string]any
	promptImage       bool
	sessionClose      bool
	acpLiveState
	pendingApprovals map[string]*pendingACPApproval
	backgroundAgents map[string]standardACPBackgroundAgent
	recentTurnID     string
	recentTurnExpiry time.Time
	// permissionModeID tracks the session's live permission tier so an
	// auto-approve tier (e.g. Cursor "full access") applies to permission
	// requests immediately after a mid-session tier change, without a respawn.
	permissionModeID string
}

type standardACPSessionLock struct {
	mu   sync.Mutex
	refs int
}

type pendingACPApproval = pendingACPRequest

type standardACPBackgroundAgent struct {
	TaskID            string
	Description       string
	Status            string
	Summary           string
	LastToolName      string
	TaskType          string
	StartedAtUnixMS   int64
	UpdatedAtUnixMS   int64
	CompletedAtUnixMS int64
}

const standardACPRecentTurnTTL = 10 * time.Minute

const acpMethodSetConfigOption = "session/set_config_option"
const acpMethodCloseSession = "session/close"
const (
	acpCloseCallTimeout  = 750 * time.Millisecond
	acpCloseGraceTimeout = 200 * time.Millisecond
)

func (a *standardACPAdapter) applyProviderSessionMeta(params map[string]any, session Session) error {
	if params == nil {
		return nil
	}
	switch a.config.provider {
	case ProviderOpenClaw:
		mergeACPParamsMeta(params, map[string]any{"sessionKey": openclawGatewayChatSessionKey(session, a.host)})
	case ProviderClaudeCode:
		meta, err := buildClaudeCodeSessionMeta(session)
		if err != nil {
			phase := claudeProviderMetaLogPhase(err)
			if phase == "plugin_dir" {
				slog.Warn("agent session ACP claude provider meta plugin dir failed",
					"event", "agent_session.acp.claude_provider_meta.plugin_dir_failed",
					"room_id", session.RoomID,
					"agent_session_id", session.AgentSessionID,
					"provider_session_id", session.ProviderSessionID,
					"plugin_dir_env_present", strings.TrimSpace(meta.pluginDirPath) != "",
					"plugin_dir_path", meta.pluginDirPath,
					"error", err.Error(),
				)
				return err
			}
			slog.Warn("agent session ACP claude provider meta system prompt failed",
				"event", "agent_session.acp.claude_provider_meta.system_prompt_failed",
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", session.ProviderSessionID,
				"system_prompt_env_present", strings.TrimSpace(meta.systemPromptPath) != "",
				"system_prompt_path", meta.systemPromptPath,
				"error", err.Error(),
			)
			return err
		}
		mergeACPParamsMeta(params, meta.acpMeta())
		slog.Info("agent session ACP claude provider meta prepared",
			"event", "agent_session.acp.claude_provider_meta.prepared",
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"system_prompt_env_present", strings.TrimSpace(meta.systemPromptPath) != "",
			"system_prompt_path", meta.systemPromptPath,
			"system_prompt_present", strings.TrimSpace(meta.systemPromptAppend) != "",
			"system_prompt_len", len(meta.systemPromptAppend),
			"system_prompt_has_tutti_runtime", strings.Contains(meta.systemPromptAppend, "# Tutti Runtime"),
			"system_prompt_has_claude_mention_routing", strings.Contains(meta.systemPromptAppend, "Claude Code mention routing"),
			"system_prompt_has_agent_session_skill_routing", strings.Contains(meta.systemPromptAppend, `Skill(skill="tutti-cli"`),
			"meta_system_prompt_attached", strings.TrimSpace(meta.systemPromptAppend) != "",
			"plugin_dir_env_present", strings.TrimSpace(meta.pluginDirPath) != "",
			"plugin_dir_path", meta.pluginDirPath,
			"plugin_dir_present", meta.pluginDir != "",
			"meta_claude_code_attached", len(meta.options) > 0,
			"emit_raw_sdk_messages", meta.pluginDir != "",
		)
	}
	return nil
}

func (a *standardACPAdapter) ValidatePromptContent(session Session, content []PromptContentBlock) error {
	if !promptContentHasImage(content) {
		return nil
	}
	if err := validatePromptContentImagesForPreflight(content); err != nil {
		return err
	}
	acpSession := a.getSession(session.AgentSessionID)
	if acpSession != nil && acpSession.promptImage {
		return nil
	}
	return ErrPromptImageUnsupported
}

func standardACPPromptImageSupported(raw json.RawMessage) bool {
	return acpPromptImageSupported(raw)
}

func standardACPProviderPromptImageSupported(provider string, raw json.RawMessage) bool {
	switch strings.TrimSpace(provider) {
	case ProviderClaudeCode, ProviderOpenCode, ProviderCursor:
		// Some ACP providers support image prompt content, but current
		// initialize responses can omit or misreport promptCapabilities.image.
		return true
	}
	return standardACPPromptImageSupported(raw)
}

func standardACPSessionCloseSupported(raw json.RawMessage) bool {
	var result struct {
		SessionCapabilities map[string]bool `json:"sessionCapabilities"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return false
	}
	return result.SessionCapabilities["close"]
}

func mergeACPParamsMeta(params map[string]any, meta map[string]any) {
	if len(meta) == 0 {
		return
	}
	existing, _ := params["_meta"].(map[string]any)
	if existing == nil {
		existing = map[string]any{}
		params["_meta"] = existing
	}
	for key, value := range meta {
		existing[key] = value
	}
}

func joinPromptSections(sections ...string) string {
	nonEmpty := make([]string, 0, len(sections))
	for _, section := range sections {
		if trimmed := strings.TrimSpace(section); trimmed != "" {
			nonEmpty = append(nonEmpty, trimmed)
		}
	}
	return strings.Join(nonEmpty, "\n\n")
}

func sessionEnvValue(env []string, key string) string {
	prefix := key + "="
	for _, item := range env {
		if strings.HasPrefix(item, prefix) {
			return strings.TrimPrefix(item, prefix)
		}
	}
	return ""
}

func standardACPInitialLiveState(provider string) acpLiveState {
	state := newACPLiveState()
	seedStandardACPInitialCommands(&state, provider)
	return state
}

func seedStandardACPInitialCommands(state *acpLiveState, provider string) {
	if state == nil || state.commandsKnown {
		return
	}
	if strings.TrimSpace(provider) == ProviderClaudeCode {
		state.availableCommands = claudeCodeACPCommands()
		state.commandsKnown = true
		return
	}
	if strings.TrimSpace(provider) == ProviderOpenCode {
		state.availableCommands = opencodeACPCommands()
		state.commandsKnown = true
	}
}

func standardACPAdapterOwnedCommands(provider string) []AgentSessionCommand {
	switch strings.TrimSpace(provider) {
	case ProviderOpenCode:
		return opencodeACPCommands()
	default:
		return nil
	}
}

func mergeStandardACPAdapterOwnedCommands(
	commands []AgentSessionCommand,
	provider string,
) []AgentSessionCommand {
	ownedCommands := standardACPAdapterOwnedCommands(provider)
	if len(ownedCommands) == 0 {
		return commands
	}
	merged := make([]AgentSessionCommand, 0, len(commands)+len(ownedCommands))
	merged = append(merged, commands...)
	merged = append(merged, ownedCommands...)
	return dedupeAgentSessionCommands(merged)
}

func (a *standardACPAdapter) Provider() string {
	if a == nil {
		return ""
	}
	return a.config.provider
}

func (a *standardACPAdapter) SetCommandSnapshotSink(sink CommandSnapshotSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.commandSink = sink
	a.mu.Unlock()
}

func (a *standardACPAdapter) SetSessionEventSink(sink SessionEventSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.eventSink = sink
	a.mu.Unlock()
}

func (a *standardACPAdapter) SetProviderLaunchPreparer(preparer ProviderLaunchPreparer) {
	if a == nil {
		return
	}
	a.preparer = preparer
}

func (a *standardACPAdapter) lockSessionLifecycle(agentSessionID string) func() {
	if a == nil {
		return func() {}
	}
	key := strings.TrimSpace(agentSessionID)
	a.lifecycleMu.Lock()
	if a.lifecycleLocks == nil {
		a.lifecycleLocks = make(map[string]*standardACPSessionLock)
	}
	lock := a.lifecycleLocks[key]
	if lock == nil {
		lock = &standardACPSessionLock{}
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
		acpLiveState:     standardACPInitialLiveState(a.config.provider),
		pendingApprovals: make(map[string]*pendingACPApproval),
		backgroundAgents: make(map[string]standardACPBackgroundAgent),
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
	if err := a.applySessionConfigOptions(ctx, client, session, newSessionResult); err != nil {
		a.logHermesStartupDiagnostics("config_options.failed", map[string]any{
			"room_id":             session.RoomID,
			"agent_session_id":    session.AgentSessionID,
			"provider_session_id": session.ProviderSessionID,
			"error":               err.Error(),
		})
		return nil, err
	}
	if err := a.applyPermissionMode(ctx, client, session); err != nil {
		a.logHermesStartupDiagnostics("permission_mode.failed", map[string]any{
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
		acpLiveState:      standardACPInitialLiveState(a.config.provider),
		pendingApprovals:  make(map[string]*pendingACPApproval),
		backgroundAgents:  make(map[string]standardACPBackgroundAgent),
		permissionModeID:  strings.TrimSpace(session.PermissionModeID),
	}
	if previousSession != nil {
		acpSession.acpLiveState = cloneACPLiveState(previousSession.acpLiveState)
		acpSession.backgroundAgents = cloneStandardACPBackgroundAgents(previousSession.backgroundAgents)
		seedStandardACPInitialCommands(&acpSession.acpLiveState, a.config.provider)
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
	if err := a.applySessionConfigOptions(ctx, client, session, loadSessionResult); err != nil {
		return err
	}
	if err := a.applyPermissionMode(ctx, client, session); err != nil {
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
		Provider:             a.config.provider,
		AgentSessionID:       session.AgentSessionID,
		RoomID:               session.RoomID,
		CWD:                  session.CWD,
		Command:              command,
		Env:                  env,
		OpenclawGatewayReady: session.OpenclawGatewayReady,
		DirectStart:          a.config.provider == ProviderClaudeCode,
	})
	if err != nil {
		a.logHermesStartupDiagnostics("process_prepare.failed", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"error":            err.Error(),
		})
		return nil, nil, err
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

func (a *standardACPAdapter) Exec(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) ([]activityshared.Event, error) {
	acpSession := a.getSession(session.AgentSessionID)
	if acpSession == nil || acpSession.client == nil {
		return nil, ErrSessionDisconnected
	}
	session.ProviderSessionID = acpSession.providerSessionID
	a.rememberSessionTurn(session.AgentSessionID, turnID)
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	mentionRoutingApplied, mentionRoutingSkills := tuttiMentionRoutingSkills(visibleText)
	providerContent, err := materializeProviderPromptImages(ctx, content)
	if err != nil {
		return nil, err
	}
	acpPromptContent := promptContentForACP(providerContent)
	if mentionRoutingApplied {
		acpPromptContent = appendTuttiMentionRoutingPrompt(acpPromptContent, mentionRoutingSkills)
	}
	normalizer := newACPTurnNormalizer()
	var events []activityshared.Event
	emitEvents := func(next []activityshared.Event) {
		if len(next) == 0 {
			return
		}
		events = append(events, next...)
		if emit != nil {
			emit(next)
		}
	}

	startEvents := make([]activityshared.Event, 0, 3)
	if fallbackTitle := fallbackStandardSessionTitle(a.config, session.Title, visibleText); fallbackTitle != "" {
		startEvents = append(startEvents, newSessionTitleActivityEvent(session, fallbackTitle))
		session.Title = fallbackTitle
	}
	startEvents = append(startEvents,
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, visibleText, userPromptActivityPayload(content, explicitDisplayPrompt, userPromptActivityPayloadExtraFromExecMetadata(ctx, nil))),
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
	)
	if event, ok := a.mirrorClaudeGoalSlashPrompt(session, visibleText); ok {
		startEvents = append(startEvents, event)
	}
	if event, ok := a.standardACPCompactStartedEvent(session, turnID, visibleText, normalizer); ok {
		startEvents = append(startEvents, event)
	}
	emitEvents(startEvents)
	slog.Info("agent session ACP exec started",
		"event", "agent_session.acp.exec.start",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"turn_id", turnID,
		"prompt_length", len(visibleText),
		"mention_uri_count", len(extractMentionURIs(visibleText)),
		"mention_routing_applied", mentionRoutingApplied,
		"mention_routing_skills", mentionRoutingSkills,
	)
	if mentionRoutingApplied {
		slog.Info("agent session ACP mention routing applied",
			"event", "agent_session.acp.mention_routing.applied",
			"provider", a.config.provider,
			"adapter", a.config.adapterName,
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"turn_id", turnID,
			"mention_routing_skills", mentionRoutingSkills,
			"prompt_length", len(visibleText),
		)
	}

	promptParams := acpPromptContent
	autoContinueAttempts := 0
execLoop:
	for {
		result, err := acpSession.client.Call(ctx, acpMethodPrompt, map[string]any{
			"sessionId": acpSession.providerSessionID,
			"prompt":    promptParams,
		}, func(ctx context.Context, message acpMessage) error {
			slog.Info("agent session ACP exec received message",
				"event", "agent_session.acp.exec.message",
				"provider", a.config.provider,
				"adapter", a.config.adapterName,
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", session.ProviderSessionID,
				"turn_id", turnID,
				"message_method", message.Method,
				"message_id", rawMessageLogValue(message.ID),
			)
			next, err := a.handleACPMessage(ctx, acpSession.client, session, turnID, message, normalizer, emitEvents, emitCommands)
			slog.Info("agent session ACP exec handled message",
				"event", "agent_session.acp.exec.message_handled",
				"provider", a.config.provider,
				"adapter", a.config.adapterName,
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", session.ProviderSessionID,
				"turn_id", turnID,
				"message_method", message.Method,
				"event_count", len(next),
				"event_type_counts", activityEventTypeCounts(next),
				"error", errString(err),
			)
			emitEvents(next)
			if err != nil {
				return err
			}
			return nil
		})
		if err != nil {
			slog.Warn("agent session ACP exec call failed",
				"event", "agent_session.acp.exec.call_failed",
				"provider", a.config.provider,
				"adapter", a.config.adapterName,
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", session.ProviderSessionID,
				"turn_id", turnID,
				"emitted_event_count", len(events),
				"emitted_event_type_counts", activityEventTypeCounts(events),
				"error", err.Error(),
			)
			if errors.Is(err, context.Canceled) || errors.Is(err, errPermissionRequestCanceled) {
				terminalEvents := normalizer.FinishInterrupted(session, turnID, "interrupted")
				terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
					"error": err.Error(),
				}))
				emitEvents(terminalEvents)
			} else {
				terminalEvents := normalizer.FinishFailed(session, turnID)
				terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", map[string]any{
					"error": err.Error(),
				}))
				emitEvents(terminalEvents)
			}
			return events, nil
		}

		stopReason := acpStopReason(result)
		normalizer.ApplyAssistantFinalText(acpPromptResultAssistantText(result))
		slog.Info("agent session ACP exec call completed",
			"event", "agent_session.acp.exec.call_completed",
			"provider", a.config.provider,
			"adapter", a.config.adapterName,
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"turn_id", turnID,
			"stop_reason", firstNonEmpty(stopReason, "end_turn"),
			"auto_continue_attempts", autoContinueAttempts,
			"emitted_event_count", len(events),
			"emitted_event_type_counts", activityEventTypeCounts(events),
		)
		if a.config.autoContinueRetriableTurnError && acpStopReasonEndsTurnNormally(stopReason) {
			if errLine, ok := acpRetriableTurnTailError(normalizer.CurrentAssistantText()); ok {
				if autoContinueAttempts < acpAutoContinueMaxAttempts {
					autoContinueAttempts++
					// Close out the error-text segment so the continuation
					// streams into a fresh message instead of appending to it.
					emitEvents(normalizer.Finish(session, turnID, messageStreamStateCompleted))
					if notice, ok := acpAutoContinueNoticeEvent(session, turnID, errLine, autoContinueAttempts); ok {
						emitEvents([]activityshared.Event{notice})
					}
					slog.Warn("agent session ACP auto-continue after retriable turn error",
						"event", "agent_session.acp.exec.auto_continue",
						"provider", a.config.provider,
						"adapter", a.config.adapterName,
						"room_id", session.RoomID,
						"agent_session_id", session.AgentSessionID,
						"provider_session_id", session.ProviderSessionID,
						"turn_id", turnID,
						"attempt", autoContinueAttempts,
						"max_attempts", acpAutoContinueMaxAttempts,
						"error_line", errLine,
					)
					promptParams = acpAutoContinuePromptContent()
					continue execLoop
				}
				// The retries were cut short too: surface the turn as failed
				// instead of a silent "completed" that strands the conversation.
				terminalEvents := normalizer.FinishFailed(session, turnID)
				terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", map[string]any{
					"error":      errLine,
					"stopReason": firstNonEmpty(stopReason, "end_turn"),
				}))
				emitEvents(terminalEvents)
				slog.Warn("agent session ACP auto-continue attempts exhausted",
					"event", "agent_session.acp.exec.auto_continue_exhausted",
					"provider", a.config.provider,
					"adapter", a.config.adapterName,
					"room_id", session.RoomID,
					"agent_session_id", session.AgentSessionID,
					"provider_session_id", session.ProviderSessionID,
					"turn_id", turnID,
					"attempts", autoContinueAttempts,
					"error_line", errLine,
				)
				break execLoop
			}
		}
		switch stopReason {
		case "canceled":
			terminalEvents := normalizer.FinishInterrupted(session, turnID, stopReason)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
				"stopReason": stopReason,
			}))
			emitEvents(terminalEvents)
		case "refusal", "max_tokens", "max_turn_requests":
			terminalEvents := normalizer.FinishFailed(session, turnID)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", map[string]any{
				"stopReason": stopReason,
			}))
			emitEvents(terminalEvents)
		default:
			terminalEvents := normalizer.FinishCompleted(session, turnID)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", map[string]any{
				"stopReason": firstNonEmpty(stopReason, "end_turn"),
			}))
			emitEvents(terminalEvents)
		}
		break execLoop
	}
	slog.Info("agent session ACP exec finished",
		"event", "agent_session.acp.exec.finished",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"turn_id", turnID,
		"final_event_count", len(events),
		"final_event_type_counts", activityEventTypeCounts(events),
	)
	return events, nil
}

func (a *standardACPAdapter) mirrorClaudeGoalSlashPrompt(session Session, prompt string) (activityshared.Event, bool) {
	if a == nil || a.config.provider != ProviderClaudeCode {
		return activityshared.Event{}, false
	}
	goal, updateType, ok := claudeGoalSlashPromptUpdate(prompt)
	if !ok {
		return activityshared.Event{}, false
	}
	a.mu.Lock()
	if acpSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]; acpSession != nil {
		if updateType == "thread_goal_update" {
			acpSession.goal = clonePayload(goal)
		} else {
			acpSession.goal = nil
		}
	}
	a.mu.Unlock()
	return acpGoalUpdatedEvent(session, updateType)
}

func (a *standardACPAdapter) standardACPCompactStartedEvent(
	session Session,
	turnID string,
	prompt string,
	normalizer *acpTurnNormalizer,
) (activityshared.Event, bool) {
	if a == nil || a.config.provider != ProviderOpenCode || normalizer == nil {
		return activityshared.Event{}, false
	}
	command, args := splitSlashCommand(prompt)
	if command != "/compact" || args != "" {
		return activityshared.Event{}, false
	}
	messageID := "compaction:" + strings.TrimSpace(turnID)
	normalizer.SuppressAssistantOutput()
	normalizer.TrackCompactionNotice(messageID, false)
	return appServerCompactionNoticeEvent(session, turnID, messageID, false), true
}

func claudeGoalSlashPromptUpdate(prompt string) (map[string]any, string, bool) {
	text := strings.TrimSpace(prompt)
	if !strings.HasPrefix(text, "/goal") {
		return nil, "", false
	}
	if len(text) > len("/goal") {
		switch text[len("/goal")] {
		case ' ', '\t', '\n', '\r':
		default:
			return nil, "", false
		}
	}
	objective := strings.TrimSpace(text[len("/goal"):])
	if objective == "" {
		return nil, "", false
	}
	switch strings.ToLower(objective) {
	case "clear", "reset":
		return nil, "thread_goal_cleared", true
	default:
		return map[string]any{
			"objective": objective,
			"status":    "active",
		}, "thread_goal_update", true
	}
}

func (a *standardACPAdapter) Cancel(ctx context.Context, session Session, _ string) ([]activityshared.Event, error) {
	acpSession := a.getSession(session.AgentSessionID)
	if acpSession != nil && acpSession.client != nil {
		_ = acpSession.client.Notify(ctx, acpMethodCancel, map[string]any{
			"sessionId": acpSession.providerSessionID,
		})
	}
	a.rejectPendingApprovals(session.AgentSessionID, errPermissionRequestCanceled)
	return nil, nil
}

func (a *standardACPAdapter) submitPermissionOption(ctx context.Context, session Session, input PermissionOptionInput) (string, error) {
	requestID := strings.TrimSpace(input.RequestID)
	optionID := strings.TrimSpace(input.OptionID)
	if requestID == "" {
		return "", errors.New("permission request id is required")
	}
	if optionID == "" {
		return "", errors.New("permission option id is required")
	}
	pending := a.getPendingApproval(session.AgentSessionID, requestID)
	if pending == nil {
		return "", fmt.Errorf("permission request %q is no longer live", requestID)
	}
	if pending.callType != "approval" {
		return "", fmt.Errorf("request %q requires interactive submission", requestID)
	}
	resolvedOptionID, ok := pending.resolvePermissionOptionID(optionID)
	if !ok {
		return "", fmt.Errorf("permission option %q is not available for request %q", optionID, requestID)
	}
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case pending.response <- pendingACPResponse{
		optionID: resolvedOptionID,
		result:   acpPermissionResponseResult(resolvedOptionID),
	}:
		return resolvedOptionID, nil
	default:
		return "", fmt.Errorf("permission request %q has already been answered", requestID)
	}
}

func (a *standardACPAdapter) SubmitInteractive(ctx context.Context, session Session, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
	requestID := strings.TrimSpace(input.RequestID)
	if requestID == "" {
		return SubmitInteractiveResult{}, errors.New("interactive request id is required")
	}
	pending := a.getPendingApproval(session.AgentSessionID, requestID)
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
		resolvedOptionID, err := a.submitPermissionOption(ctx, session, PermissionOptionInput{
			RoomID:         input.RoomID,
			AgentSessionID: input.AgentSessionID,
			RequestID:      requestID,
			OptionID:       optionID,
		})
		if err != nil {
			return SubmitInteractiveResult{}, err
		}
		return SubmitInteractiveResult{
			AgentSessionID: session.AgentSessionID,
			RequestID:      requestID,
			Accepted:       true,
			OptionID:       resolvedOptionID,
		}, nil
	}
	optionID := strings.TrimSpace(input.OptionID)
	action := strings.TrimSpace(input.Action)
	payload := clonePayload(input.Payload)
	result := acpInteractiveResponseResult(action, optionID, payload)
	select {
	case <-ctx.Done():
		return SubmitInteractiveResult{}, ctx.Err()
	case pending.response <- pendingACPResponse{
		optionID: optionID,
		action:   action,
		payload:  payload,
		result:   result,
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

func (a *standardACPAdapter) applyPermissionMode(ctx context.Context, client *acpClient, session Session) error {
	modeID := a.effectiveModeID(session)
	if modeID == "" {
		a.logHermesStartupDiagnostics("permission_mode.skipped", map[string]any{
			"room_id":             session.RoomID,
			"agent_session_id":    session.AgentSessionID,
			"provider_session_id": session.ProviderSessionID,
			"permission_mode_id":  session.PermissionModeID,
		})
		return nil
	}
	params := map[string]any{
		"sessionId": session.ProviderSessionID,
		"modeId":    modeID,
	}
	if merge := a.config.setModeParams; merge != nil {
		for k, v := range merge(session) {
			params[k] = v
		}
	}
	setModeStartedAt := time.Now()
	slog.Info("agent session ACP permission mode update started",
		"event", "agent_session.acp.permission_mode.start",
		"provider", a.config.provider,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"permission_mode_id", session.PermissionModeID,
		"mode_id", modeID,
		"timeout_ms", acpPermissionModeTimeout.Milliseconds(),
	)
	a.logHermesStartupDiagnostics("permission_mode.start", map[string]any{
		"room_id":             session.RoomID,
		"agent_session_id":    session.AgentSessionID,
		"provider_session_id": session.ProviderSessionID,
		"permission_mode_id":  session.PermissionModeID,
		"mode_id":             modeID,
		"timeout_ms":          acpPermissionModeTimeout.Milliseconds(),
	})
	_, err := client.CallWithTimeout(ctx, acpPermissionModeTimeout, acpMethodSetMode, params, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	if err != nil {
		a.logHermesStartupDiagnostics("permission_mode.unconfirmed", map[string]any{
			"room_id":             session.RoomID,
			"agent_session_id":    session.AgentSessionID,
			"provider_session_id": session.ProviderSessionID,
			"permission_mode_id":  session.PermissionModeID,
			"mode_id":             modeID,
			"elapsed_ms":          time.Since(setModeStartedAt).Milliseconds(),
			"error":               err.Error(),
		})
		if a.config.failOnSetModeError {
			return fmt.Errorf("agent session ACP permission mode confirmation failed: %w", err)
		}
		slog.Warn("agent session ACP permission mode was not confirmed; continuing",
			"event", "agent_session.acp.permission_mode.unconfirmed",
			"provider", a.config.provider,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"mode_id", modeID,
			"elapsed_ms", time.Since(setModeStartedAt).Milliseconds(),
			"error", err.Error(),
		)
		return nil
	}
	slog.Info("agent session ACP permission mode update succeeded",
		"event", "agent_session.acp.permission_mode.succeeded",
		"provider", a.config.provider,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"permission_mode_id", session.PermissionModeID,
		"mode_id", modeID,
		"elapsed_ms", time.Since(setModeStartedAt).Milliseconds(),
	)
	a.logHermesStartupDiagnostics("permission_mode.succeeded", map[string]any{
		"room_id":             session.RoomID,
		"agent_session_id":    session.AgentSessionID,
		"provider_session_id": session.ProviderSessionID,
		"permission_mode_id":  session.PermissionModeID,
		"mode_id":             modeID,
		"elapsed_ms":          time.Since(setModeStartedAt).Milliseconds(),
	})
	return nil
}

func (a *standardACPAdapter) applySessionConfigOptions(
	ctx context.Context,
	client *acpClient,
	session Session,
	startResult json.RawMessage,
) error {
	settings := session.SettingsValue()
	supported := acpConfigOptionIDs(startResult)
	if len(supported) == 0 {
		a.logHermesStartupDiagnostics("config_options.skipped", map[string]any{
			"room_id":             session.RoomID,
			"agent_session_id":    session.AgentSessionID,
			"provider_session_id": session.ProviderSessionID,
			"reason":              "none_supported",
		})
		return nil
	}
	a.logHermesStartupDiagnostics("config_options.start", map[string]any{
		"room_id":              session.RoomID,
		"agent_session_id":     session.AgentSessionID,
		"provider_session_id":  session.ProviderSessionID,
		"supported_option_ids": acpConfigOptionIDList(startResult),
		"model_requested":      strings.TrimSpace(settings.Model) != "",
		"effort_requested":     strings.TrimSpace(settings.ReasoningEffort) != "",
	})
	// Startup config options are applied best-effort: a value the agent
	// rejects (e.g. a model alias the signed-in account cannot access) must
	// not abort the whole session. The session stays usable on the agent's
	// default, and the user can pick a supported value from the live list.
	if model := strings.TrimSpace(settings.Model); model != "" && a.shouldApplyACPModelConfigOption(model, supported) {
		model = a.resolveClaudeCodeACPModelValue(session.AgentSessionID, model)
		if err := a.setSessionConfigOption(ctx, client, session, "model", model); err != nil {
			a.logStartupConfigOptionRejected(session, "model", model, err)
		} else {
			a.updateSessionConfigOption(session.AgentSessionID, "model", model)
		}
	}
	if reasoning := strings.TrimSpace(settings.ReasoningEffort); reasoning != "" && supported["effort"] {
		if err := a.setSessionConfigOption(ctx, client, session, "effort", reasoning); err != nil {
			a.logStartupConfigOptionRejected(session, "effort", reasoning, err)
		} else {
			a.updateSessionConfigOption(session.AgentSessionID, "effort", reasoning)
		}
	}
	if speed := strings.TrimSpace(settings.Speed); speed != "" && supported["fast"] {
		var ok bool
		speed, ok = a.resolveClaudeCodeACPFastValue(session.AgentSessionID, speed)
		if ok {
			if err := a.setSessionConfigOption(ctx, client, session, "fast", speed); err != nil {
				return fmt.Errorf("agent session ACP fast configuration failed: %w", err)
			}
			a.updateSessionConfigOption(session.AgentSessionID, "fast", speed)
		}
	}
	a.logHermesStartupDiagnostics("config_options.succeeded", map[string]any{
		"room_id":             session.RoomID,
		"agent_session_id":    session.AgentSessionID,
		"provider_session_id": session.ProviderSessionID,
	})
	return nil
}

func (a *standardACPAdapter) logStartupConfigOptionRejected(
	session Session,
	configID string,
	value string,
	err error,
) {
	slog.Warn("agent session ACP startup config option rejected; continuing on agent default",
		"event", "agent_session.acp.config_option.rejected",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"config_id", configID,
		"value", value,
		"error", err.Error(),
	)
}

func (a *standardACPAdapter) shouldApplyACPModelConfigOption(model string, supported map[string]bool) bool {
	if !supported["model"] {
		return false
	}
	if a.config.provider != ProviderClaudeCode {
		return true
	}
	return claudeCodeACPModelAliases[model]
}

func (a *standardACPAdapter) setSessionConfigOption(
	ctx context.Context,
	client *acpClient,
	session Session,
	configID string,
	value string,
) error {
	startedAt := time.Now()
	a.logHermesStartupDiagnostics("config_option.start", map[string]any{
		"room_id":             session.RoomID,
		"agent_session_id":    session.AgentSessionID,
		"provider_session_id": session.ProviderSessionID,
		"config_id":           configID,
		"value":               value,
		"timeout_ms":          acpStartCallTimeout.Milliseconds(),
	})
	result, err := client.CallWithTimeout(ctx, acpStartCallTimeout, acpMethodSetConfigOption, map[string]any{
		"sessionId": session.ProviderSessionID,
		"configId":  configID,
		"value":     value,
	}, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	if err != nil {
		a.logHermesStartupDiagnostics("config_option.failed", map[string]any{
			"room_id":             session.RoomID,
			"agent_session_id":    session.AgentSessionID,
			"provider_session_id": session.ProviderSessionID,
			"config_id":           configID,
			"elapsed_ms":          time.Since(startedAt).Milliseconds(),
			"error":               err.Error(),
		})
		return err
	}
	a.updateSessionConfigOptionsResult(session.AgentSessionID, result)
	a.logHermesStartupDiagnostics("config_option.succeeded", map[string]any{
		"room_id":              session.RoomID,
		"agent_session_id":     session.AgentSessionID,
		"provider_session_id":  session.ProviderSessionID,
		"config_id":            configID,
		"elapsed_ms":           time.Since(startedAt).Milliseconds(),
		"supported_option_ids": acpConfigOptionIDList(result),
	})
	return nil
}

func (a *standardACPAdapter) updateSessionConfigOptionsResult(agentSessionID string, raw json.RawMessage) {
	if a == nil || len(raw) == 0 {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil {
		return
	}
	applyACPConfigOptionsResult(&session.acpLiveState, raw)
}

func (a *standardACPAdapter) updateSessionConfigOption(
	agentSessionID string,
	configID string,
	value string,
) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil {
		return
	}
	session.ensureInitialized()
	if strings.TrimSpace(value) == "" {
		delete(session.configOptions, configID)
		return
	}
	session.configOptions[configID] = value
	updateConfigOptionDescriptorValue(session.configOptionDescriptors, configID, value)
}

// RequiresNewSessionForSettings implements NewSessionSettingsAdapter for
// providers whose config declares spawn-time-only settings (currently Nexight).
func (a *standardACPAdapter) RequiresNewSessionForSettings(session Session, patch SessionSettingsPatch) bool {
	if a == nil || a.config.requiresNewSessionForSettings == nil {
		return false
	}
	return a.config.requiresNewSessionForSettings(session, patch)
}

func (a *standardACPAdapter) ApplySessionSettings(
	ctx context.Context,
	session Session,
	patch SessionSettingsPatch,
) error {
	if a.RequiresNewSessionForSettings(session, patch) {
		return ErrSessionSettingsRequireNewSession
	}
	acpSession := a.getSession(session.AgentSessionID)
	if acpSession == nil || acpSession.client == nil {
		return nil
	}
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		session.ProviderSessionID = acpSession.providerSessionID
	}

	if patch.PlanMode != nil {
		if err := a.applyPermissionMode(ctx, acpSession.client, session); err != nil {
			return err
		}
	}

	if patch.Model != nil {
		model := strings.TrimSpace(*patch.Model)
		// A model the live agent advertises as a selectable option can be
		// switched in place via set_config_option, even if it is a concrete id
		// (e.g. Opus 4.6) rather than one of the static aliases. Only models the
		// running agent has not advertised still require a fresh session.
		advertised := a.sessionConfigOptionAdvertisesValue(session.AgentSessionID, "model", model)
		if a.config.provider == ProviderClaudeCode && model != "" && !claudeCodeACPModelAliases[model] && !advertised {
			return errors.New("claude code custom model changes require a new session")
		}
		supported := map[string]bool{"model": true}
		if advertised || a.shouldApplyACPModelConfigOption(model, supported) {
			model = a.resolveClaudeCodeACPModelValue(session.AgentSessionID, model)
			if !a.sessionConfigOptionMatches(session.AgentSessionID, "model", model) {
				if err := a.setSessionConfigOption(ctx, acpSession.client, session, "model", model); err != nil {
					return fmt.Errorf("agent session ACP model configuration failed: %w", err)
				}
				a.updateSessionConfigOption(session.AgentSessionID, "model", model)
			}
		}
	}

	if patch.ReasoningEffort != nil {
		reasoning := strings.TrimSpace(*patch.ReasoningEffort)
		if reasoning != "" {
			if !a.sessionConfigOptionMatches(session.AgentSessionID, "effort", reasoning) {
				if err := a.setSessionConfigOption(ctx, acpSession.client, session, "effort", reasoning); err != nil {
					return fmt.Errorf("agent session ACP effort configuration failed: %w", err)
				}
				a.updateSessionConfigOption(session.AgentSessionID, "effort", reasoning)
			}
		}
	}

	if patch.Speed != nil {
		speed := strings.TrimSpace(*patch.Speed)
		if speed != "" {
			var ok bool
			speed, ok = a.resolveClaudeCodeACPFastValue(session.AgentSessionID, speed)
			if !ok {
				return nil
			}
			if !a.sessionConfigOptionMatches(session.AgentSessionID, "fast", speed) {
				if err := a.setSessionConfigOption(ctx, acpSession.client, session, "fast", speed); err != nil {
					return fmt.Errorf("agent session ACP fast configuration failed: %w", err)
				}
				a.updateSessionConfigOption(session.AgentSessionID, "fast", speed)
			}
		}
	}

	return nil
}

func (a *standardACPAdapter) ApplyPermissionMode(ctx context.Context, session Session) error {
	acpSession := a.getSession(session.AgentSessionID)
	if acpSession == nil || acpSession.client == nil {
		return nil
	}
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		session.ProviderSessionID = acpSession.providerSessionID
	}
	// Track the live tier so auto-approve tiers (Cursor "full access") take
	// effect on subsequent permission requests without a respawn.
	a.setSessionPermissionModeID(session.AgentSessionID, session.PermissionModeID)
	return a.applyPermissionMode(ctx, acpSession.client, session)
}

func (a *standardACPAdapter) setSessionPermissionModeID(agentSessionID string, permissionModeID string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if session := a.sessions[strings.TrimSpace(agentSessionID)]; session != nil {
		session.permissionModeID = strings.TrimSpace(permissionModeID)
	}
}

// autoApprovePermissionDecision resolves the decision the provider's
// auto-approve tier applies to a permission request for this session, or ""
// to prompt the user. Reads the live tier so a mid-session change is honored.
func (a *standardACPAdapter) autoApprovePermissionDecision(agentSessionID string) string {
	if a == nil || a.config.autoApprovePermissionDecision == nil {
		return ""
	}
	a.mu.Lock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	permissionModeID := ""
	if session != nil {
		permissionModeID = session.permissionModeID
	}
	a.mu.Unlock()
	return a.config.autoApprovePermissionDecision(permissionModeID)
}

func (a *standardACPAdapter) effectiveModeID(session Session) string {
	if a == nil || a.config.permissionModeID == nil {
		return ""
	}
	if session.SettingsValue().PlanMode {
		if a.config.provider == ProviderClaudeCode || a.config.provider == ProviderCursor {
			return "plan"
		}
		if modeID := a.config.permissionModeID("plan"); modeID != "" {
			return modeID
		}
	}
	return a.config.permissionModeID(session.PermissionModeID)
}

func (a *standardACPAdapter) SessionState(session Session) SessionStateSnapshot {
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
	if a == nil {
		return snapshot
	}
	a.mu.Lock()
	acpSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	if acpSession == nil {
		a.mu.Unlock()
		return snapshot
	}
	state := snapshotACPLiveState(acpSession.acpLiveState)
	agentInfo := clonePayload(acpSession.agentInfo)
	backgroundAgents := standardACPBackgroundAgentsRuntimeContext(acpSession.backgroundAgents)
	promptImage := acpSession.promptImage
	var prompt *SessionInteractivePrompt
	for _, pending := range acpSession.pendingApprovals {
		prompt = pending.snapshotPrompt()
		break
	}
	a.mu.Unlock()

	if len(agentInfo) > 0 {
		snapshot.RuntimeContext["agent"] = agentInfo
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
	configOptionDescriptors := standardACPConfigOptionDescriptorsForRuntimeContext(
		a.config.provider,
		state.configOptionDescriptors,
	)
	if len(configOptionDescriptors) > 0 {
		snapshot.RuntimeContext["configOptions"] = configOptionDescriptors
	}
	if providerConfig := providerRuntimeConfig(session, session.Provider); len(providerConfig) > 0 {
		snapshot.RuntimeContext["providerConfig"] = providerConfig
	}
	if usage := acpUsageRuntimeContext(state.usage); len(usage) > 0 {
		snapshot.RuntimeContext["usage"] = usage
	}
	if len(state.goal) > 0 {
		snapshot.RuntimeContext["goal"] = state.goal
	}
	if len(backgroundAgents) > 0 {
		snapshot.RuntimeContext["backgroundAgents"] = backgroundAgents
	}
	capabilities := standardACPCapabilities(a.config.provider, promptImage, state)
	capabilities = appendBrowserUseCapability(capabilities, session.Env)
	capabilities = appendComputerUseCapability(capabilities, session.Env)
	if len(capabilities) > 0 {
		snapshot.RuntimeContext["capabilities"] = capabilities
	}
	snapshot.Settings = sessionSettingsWithACPConfig(
		session.Settings,
		session.Provider,
		session.PermissionModeID,
		state.configOptions,
		a.shouldProjectACPModelConfigOption(session.Settings),
	)
	if snapshot.Settings != nil {
		snapshot.RuntimeContext["model"] = snapshot.Settings.Model
		snapshot.RuntimeContext["reasoningEffort"] = snapshot.Settings.ReasoningEffort
		snapshot.RuntimeContext["speed"] = snapshot.Settings.Speed
		snapshot.RuntimeContext["planMode"] = snapshot.Settings.PlanMode
	}
	if prompt != nil {
		snapshot.PendingInteractive = prompt
	}
	return snapshot
}

func cloneStandardACPBackgroundAgents(value map[string]standardACPBackgroundAgent) map[string]standardACPBackgroundAgent {
	if len(value) == 0 {
		return make(map[string]standardACPBackgroundAgent)
	}
	out := make(map[string]standardACPBackgroundAgent, len(value))
	for key, agent := range value {
		out[key] = agent
	}
	return out
}

func standardACPBackgroundAgentsRuntimeContext(value map[string]standardACPBackgroundAgent) map[string]any {
	if len(value) == 0 {
		return nil
	}
	keys := make([]string, 0, len(value))
	for taskID := range value {
		keys = append(keys, taskID)
	}
	sort.Strings(keys)
	items := make([]any, 0, len(keys))
	runningCount := 0
	for _, taskID := range keys {
		agent := value[taskID]
		status := strings.TrimSpace(agent.Status)
		if status == "" {
			status = string(activityshared.ActivityStatusRunning)
		}
		if !standardACPBackgroundAgentStatusIsTerminal(status) {
			runningCount++
		}
		item := map[string]any{
			"taskId":      agent.TaskID,
			"description": agent.Description,
			"status":      status,
		}
		if agent.Summary != "" {
			item["summary"] = agent.Summary
		}
		if agent.LastToolName != "" {
			item["lastToolName"] = agent.LastToolName
		}
		if agent.TaskType != "" {
			item["taskType"] = agent.TaskType
		}
		if agent.StartedAtUnixMS > 0 {
			item["startedAtUnixMs"] = agent.StartedAtUnixMS
		}
		if agent.UpdatedAtUnixMS > 0 {
			item["updatedAtUnixMs"] = agent.UpdatedAtUnixMS
		}
		if agent.CompletedAtUnixMS > 0 {
			item["completedAtUnixMs"] = agent.CompletedAtUnixMS
		}
		items = append(items, item)
	}
	return map[string]any{
		"count": runningCount,
		"items": items,
	}
}

func standardACPBackgroundAgentStatusIsTerminal(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case string(activityshared.ActivityStatusCompleted), string(activityshared.ActivityStatusFailed), "cancelled", "canceled":
		return true
	default:
		return false
	}
}

func acpConfigOptionIDs(raw json.RawMessage) map[string]bool {
	if len(raw) == 0 {
		return nil
	}
	var payload struct {
		ConfigOptions []map[string]any `json:"configOptions"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || len(payload.ConfigOptions) == 0 {
		return nil
	}
	ids := make(map[string]bool, len(payload.ConfigOptions))
	for _, option := range payload.ConfigOptions {
		id := strings.TrimSpace(asString(option["id"]))
		if id != "" {
			ids[id] = true
		}
	}
	return ids
}

func acpConfigOptionIDList(raw json.RawMessage) []string {
	ids := acpConfigOptionIDs(raw)
	if len(ids) == 0 {
		return nil
	}
	out := make([]string, 0, len(ids))
	for id := range ids {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func (a *standardACPAdapter) shouldProjectACPModelConfigOption(settings *SessionSettings) bool {
	if a == nil || a.config.provider != ProviderClaudeCode {
		return true
	}
	model := strings.TrimSpace(normalizeSessionSettings(settings, a.config.provider, "").Model)
	if model == "" {
		return true
	}
	return claudeCodeACPModelAliases[model]
}

func standardACPConfigOptionDescriptorsForRuntimeContext(
	provider string,
	descriptors []map[string]any,
) []map[string]any {
	if strings.TrimSpace(provider) != ProviderClaudeCode {
		return cloneConfigOptionDescriptors(descriptors)
	}
	out := cloneConfigOptionDescriptors(descriptors)
	for _, descriptor := range out {
		if strings.TrimSpace(asString(descriptor["id"])) != "model" {
			continue
		}
		filtered, removedValues := claudeCodeSelectableACPModelOptions(descriptor["options"])
		if len(removedValues) == 0 {
			continue
		}
		descriptor["options"] = filtered
		currentValue := strings.TrimSpace(asString(descriptor["currentValue"]))
		if currentValue == "" {
			currentValue = strings.TrimSpace(asString(descriptor["current_value"]))
		}
		if removedValues[currentValue] {
			delete(descriptor, "currentValue")
			delete(descriptor, "current_value")
		}
	}
	return out
}

func claudeCodeSelectableACPModelOptions(options any) (any, map[string]bool) {
	removedValues := map[string]bool{}
	switch items := options.(type) {
	case []any:
		filtered := make([]any, 0, len(items))
		for _, item := range items {
			option, ok := item.(map[string]any)
			if ok && claudeCodeIsDirectCustomACPModelOption(option) {
				if value := strings.TrimSpace(asString(option["value"])); value != "" {
					removedValues[value] = true
				}
				continue
			}
			filtered = append(filtered, item)
		}
		return filtered, removedValues
	case []map[string]any:
		filtered := make([]map[string]any, 0, len(items))
		for _, option := range items {
			if claudeCodeIsDirectCustomACPModelOption(option) {
				if value := strings.TrimSpace(asString(option["value"])); value != "" {
					removedValues[value] = true
				}
				continue
			}
			filtered = append(filtered, option)
		}
		return filtered, removedValues
	default:
		return options, removedValues
	}
}

func claudeCodeIsDirectCustomACPModelOption(option map[string]any) bool {
	description := strings.TrimSpace(strings.ToLower(asString(option["description"])))
	return description == "custom model"
}

func (a *standardACPAdapter) handleACPMessage(
	ctx context.Context,
	client *acpClient,
	session Session,
	turnID string,
	message acpMessage,
	normalizer *acpTurnNormalizer,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) ([]activityshared.Event, error) {
	slog.Info("agent session ACP handle message",
		"event", "agent_session.acp.handle_message",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"turn_id", turnID,
		"message_method", message.Method,
		"message_id", rawMessageLogValue(message.ID),
	)
	switch message.Method {
	case acpMethodUpdate:
		if !a.standardACPUpdateMatchesProviderSession(session, message.Params) {
			return nil, nil
		}
		if snapshot := a.applyACPUpdate(session.AgentSessionID, message.Params); snapshot != nil {
			if emitCommands != nil {
				emitCommands(*snapshot)
			} else {
				a.emitCommandSnapshot(*snapshot)
			}
		}
		a.emitConfigOptionsUpdate(session, message.Params)
		events := standardACPUpdateEvents(a.config, session, turnID, message.Params, normalizer)
		slog.Info("agent session ACP update projected events",
			"event", "agent_session.acp.handle_message.update",
			"provider", a.config.provider,
			"adapter", a.config.adapterName,
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"turn_id", turnID,
			"event_count", len(events),
			"event_type_counts", activityEventTypeCounts(events),
		)
		if len(events) > 0 {
			if emit == nil || hasACPCurrentModeUpdatedEvent(events) {
				a.emitSessionEvents(session.AgentSessionID, events)
			}
		}
		return events, nil
	case acpMethodPermission:
		sessionLevelEmit := false
		if strings.TrimSpace(turnID) == "" {
			turnID = a.ensureSessionRecentTurnID(session.AgentSessionID)
		}
		if emit == nil {
			sessionLevelEmit = true
			emit = func(events []activityshared.Event) {
				a.emitSessionEvents(session.AgentSessionID, events)
			}
		}
		if strings.TrimSpace(turnID) == "" {
			err := errors.New("permission request outside active prompt turn is missing a turn id")
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32000, Message: err.Error()})
			return nil, err
		}
		// Auto-approve tiers (e.g. Cursor "full access") resolve the request
		// from the live permission tier without prompting; the tool call still
		// streams its own activity via session/update.
		if decision := a.autoApprovePermissionDecision(session.AgentSessionID); decision != "" {
			if optionID, ok := acpPermissionRequestDecisionOptionID(message.Params, decision); ok {
				_ = client.Respond(ctx, message.ID, acpPermissionResponseResult(optionID), nil)
				return nil, nil
			}
		}
		if sessionLevelEmit {
			emit([]activityshared.Event{newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", map[string]any{
				"synthetic": true,
			})})
		}
		events, pending, err := standardACPPermissionRequested(a, session, turnID, message.ID, message.Params)
		if err != nil {
			if sessionLevelEmit {
				emit(events)
			}
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32602, Message: err.Error()})
			return events, err
		}
		if len(events) > 0 && emit != nil {
			emit(events)
		}
		defer a.deletePendingApproval(session.AgentSessionID, pending.requestID)
		selection, err := pending.wait(ctx)
		if err != nil {
			events := acpPermissionResolvedEvents(session, turnID, pending, pendingACPResponse{}, err)
			if sessionLevelEmit {
				emit(events)
			}
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32000, Message: err.Error()})
			return events, err
		}
		result := selection.result
		if result == nil {
			result = acpPermissionResponseResult(selection.optionID)
		}
		if err := client.Respond(ctx, message.ID, result, nil); err != nil {
			events := acpPermissionResolvedEvents(session, turnID, pending, selection, err)
			if sessionLevelEmit {
				emit(events)
			}
			return events, err
		}
		events = acpPermissionResolvedEvents(session, turnID, pending, selection, nil)
		if sessionLevelEmit {
			emit(events)
		}
		return events, nil
	case claudeSDKMessageMethod:
		a.logClaudeSDKMessage(session, turnID, message.Params)
		projection := claudeSDKAssistantTextProjection(message.Params)
		events := a.mirrorClaudeSDKGoalStatus(session, message.Params)
		events = append(events, a.standardACPClaudeTaskEvents(session, turnID, message.Params)...)
		textEvents := claudeSDKAssistantTextEvents(session, turnID, projection, normalizer)
		if len(textEvents) > 0 {
			events = append(events, textEvents...)
		}
		if projection.shouldLog() {
			slog.Info("agent session Claude SDK assistant text projection",
				"event", "agent_session.claude_sdk.assistant_text_projection",
				"provider", a.config.provider,
				"adapter", a.config.adapterName,
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", session.ProviderSessionID,
				"turn_id", turnID,
				"message_id", projection.messageID,
				"message_type", projection.messageType,
				"message_role", projection.role,
				"stop_reason", projection.stopReason,
				"content_types", projection.contentTypes,
				"has_tool_use", projection.hasToolUse,
				"text_len", len(projection.text),
				"projected", len(textEvents) > 0,
				"skip_reason", projection.skipReason,
			)
		}
		if len(events) > 0 && emit == nil {
			a.emitSessionEvents(session.AgentSessionID, events)
		}
		return events, nil
	default:
		slog.Warn("agent session ACP ignored unsupported message",
			"event", "agent_session.acp.handle_message.unsupported",
			"provider", a.config.provider,
			"adapter", a.config.adapterName,
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"turn_id", turnID,
			"message_method", message.Method,
			"message_id", rawMessageLogValue(message.ID),
		)
		if len(message.ID) > 0 {
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32601, Message: "method not supported"})
		}
		return nil, nil
	}
}

func (a *standardACPAdapter) standardACPUpdateMatchesProviderSession(session Session, raw json.RawMessage) bool {
	updateSessionID, ok := acpUpdateProviderSessionID(raw)
	if !ok {
		return true
	}
	liveSessionID := ""
	if acpSession := a.getSession(session.AgentSessionID); acpSession != nil {
		liveSessionID = strings.TrimSpace(acpSession.providerSessionID)
	}
	currentSessionID := firstNonEmptyString(liveSessionID, strings.TrimSpace(session.ProviderSessionID))
	if liveSessionID == "" && currentSessionID == strings.TrimSpace(session.AgentSessionID) {
		currentSessionID = ""
	}
	if currentSessionID == "" || updateSessionID == currentSessionID {
		return true
	}
	slog.Debug("agent session ACP ignored update for foreign provider session",
		"event", "agent_session.acp.update.foreign_provider_session_ignored",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", currentSessionID,
		"update_provider_session_id", updateSessionID,
	)
	return false
}

func acpUpdateProviderSessionID(raw json.RawMessage) (string, bool) {
	var params struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return "", false
	}
	sessionID := strings.TrimSpace(params.SessionID)
	return sessionID, sessionID != ""
}

func (a *standardACPAdapter) SetConfigOptionsUpdateSink(sink ConfigOptionsUpdateSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.configSink = sink
	a.mu.Unlock()
}

func (a *standardACPAdapter) emitConfigOptionsUpdate(session Session, raw json.RawMessage) {
	configOptionKey, ok := acpConfigOptionsUpdateKey(raw)
	if !ok {
		return
	}
	a.mu.Lock()
	sink := a.configSink
	a.mu.Unlock()
	if sink == nil {
		return
	}
	update := AgentSessionConfigOptionsUpdate{
		RoomID:            session.RoomID,
		AgentSessionID:    session.AgentSessionID,
		Provider:          session.Provider,
		ProviderSessionID: session.ProviderSessionID,
		ConfigOptionKey:   configOptionKey,
		OccurredAtUnixMS:  unixMS(now()),
	}
	sink(update)
}

func (a *standardACPAdapter) emitSessionEvents(agentSessionID string, events []activityshared.Event) {
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

func activityEventTypeCounts(events []activityshared.Event) []string {
	if len(events) == 0 {
		return nil
	}
	out := make([]string, 0, len(events))
	for _, event := range events {
		out = append(out, string(event.Type))
	}
	return summarizeLogValueCounts(out)
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (a *standardACPAdapter) logHermesStartupDiagnostics(stage string, payload map[string]any) {
	if a == nil || a.config.provider != ProviderHermes {
		return
	}
	if payload == nil {
		payload = map[string]any{}
	}
	payload["stage"] = stage
	payload["provider"] = a.config.provider
	payload["adapter"] = a.config.adapterName
	slog.Info("agent session Hermes startup diagnostics",
		"event", "agent_session.hermes_startup_diagnostics."+stage,
		"payload_json", jsonStringForLog(payload),
	)
}

func (a *standardACPAdapter) logClaudeSDKMessage(session Session, turnID string, raw json.RawMessage) {
	if a == nil || a.config.provider != ProviderClaudeCode {
		return
	}
	var params map[string]any
	if err := json.Unmarshal(raw, &params); err != nil {
		slog.Warn("agent session Claude SDK message decode failed",
			"event", "agent_session.claude_sdk_message.decode_failed",
			"provider", a.config.provider,
			"adapter", a.config.adapterName,
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"turn_id", turnID,
			"error", err.Error(),
		)
		return
	}
	message, _ := params["message"].(map[string]any)
	messageType := strings.TrimSpace(asString(message["type"]))
	if messageType == "system" && strings.TrimSpace(asString(message["subtype"])) == "init" {
		slog.Info("agent session Claude SDK init",
			"event", "agent_session.claude_sdk.init",
			"provider", a.config.provider,
			"adapter", a.config.adapterName,
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"turn_id", turnID,
			"plugins", claudeSDKPluginNames(message["plugins"]),
			"skills", stringSliceFromAny(message["skills"]),
			"slash_commands", stringSliceFromAny(message["slash_commands"]),
		)
		return
	}
	// Surface auth-failure detail that acp-agent.js otherwise collapses into an
	// opaque -32000 "Authentication required". The CLI emits a synthetic
	// assistant message or success result whose text says e.g. "Please run
	// /login" / "OAuth token revoked" / "Session expired"; logging the exact
	// variant tells us which credential path actually failed (esp. for plan mode).
	if detail := claudeSDKAuthFailureDetail(message); detail != "" {
		slog.Warn("agent session Claude SDK auth failure detail",
			"event", "agent_session.claude_sdk.auth_failure_detail",
			"provider", a.config.provider,
			"adapter", a.config.adapterName,
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"turn_id", turnID,
			"message_type", messageType,
			"message_subtype", strings.TrimSpace(asString(message["subtype"])),
			"message_model", strings.TrimSpace(asString(message["model"])),
			"detail", detail,
		)
	}
}

type claudeSDKAssistantTextProjectionResult struct {
	messageID    string
	messageType  string
	role         string
	stopReason   string
	contentTypes []string
	hasToolUse   bool
	text         string
	skipReason   string
}

func (p claudeSDKAssistantTextProjectionResult) shouldLog() bool {
	return p.text != "" || p.role == "assistant" || p.skipReason == "decode_failed"
}

func claudeSDKAssistantTextProjection(raw json.RawMessage) claudeSDKAssistantTextProjectionResult {
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return claudeSDKAssistantTextProjectionResult{skipReason: "decode_failed"}
	}
	root := payloadObject(decoded)
	if len(root) == 0 {
		return claudeSDKAssistantTextProjectionResult{skipReason: "empty_payload"}
	}
	envelope := payloadObject(root["message"])
	if len(envelope) == 0 {
		envelope = root
	}
	message := envelope
	if inner := payloadObject(envelope["message"]); strings.TrimSpace(asString(inner["role"])) == "assistant" {
		message = inner
	}
	result := claudeSDKAssistantTextProjectionResult{
		messageID:   strings.TrimSpace(asString(message["id"])),
		messageType: firstNonEmpty(strings.TrimSpace(asString(envelope["type"])), strings.TrimSpace(asString(message["type"]))),
		role:        strings.TrimSpace(asString(message["role"])),
		stopReason:  firstNonEmpty(strings.TrimSpace(asString(envelope["stop_reason"])), strings.TrimSpace(asString(message["stop_reason"]))),
	}
	if result.role != "assistant" {
		result.skipReason = "not_assistant"
		return result
	}
	result.text, result.contentTypes, result.hasToolUse = claudeSDKAssistantTextFromContent(message["content"])
	if result.text == "" {
		result.skipReason = "no_text_content"
	}
	return result
}

func claudeSDKAssistantTextFromContent(content any) (string, []string, bool) {
	switch typed := content.(type) {
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return "", nil, false
		}
		return text, []string{"string"}, false
	case []any:
		parts := make([]string, 0, len(typed))
		contentTypes := make([]string, 0, len(typed))
		hasToolUse := false
		for _, item := range typed {
			block := payloadObject(item)
			if len(block) == 0 {
				continue
			}
			blockType := strings.TrimSpace(asString(block["type"]))
			if blockType != "" {
				contentTypes = append(contentTypes, blockType)
			}
			if blockType == "tool_use" {
				hasToolUse = true
				continue
			}
			if blockType != "" && blockType != "text" {
				continue
			}
			if text := strings.TrimSpace(asString(block["text"])); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.TrimSpace(strings.Join(parts, "\n")), contentTypes, hasToolUse
	default:
		return "", nil, false
	}
}

func claudeSDKAssistantTextEvents(
	session Session,
	turnID string,
	projection claudeSDKAssistantTextProjectionResult,
	normalizer *acpTurnNormalizer,
) []activityshared.Event {
	if strings.TrimSpace(projection.text) == "" {
		return nil
	}
	if normalizer != nil {
		return normalizer.AppendAssistantSnapshot(session, turnID, projection.text, projection.messageID)
	}
	messageID := firstNonEmpty(strings.TrimSpace(projection.messageID), newID())
	return []activityshared.Event{newTurnActivityEventWithID(session, messageID, EventMessage, turnID, messageStreamStateCompleted, RoleAssistant, projection.text, map[string]any{
		"messageId":   messageID,
		"contentMode": messageContentModeSnapshot,
		"streamState": messageStreamStateCompleted,
		"source":      "claude_sdk",
	})}
}

func (a *standardACPAdapter) mirrorClaudeSDKGoalStatus(session Session, raw json.RawMessage) []activityshared.Event {
	if a == nil || a.config.provider != ProviderClaudeCode {
		return nil
	}
	goal, ok := claudeSDKGoalStatusPayload(raw)
	if !ok {
		return nil
	}
	a.mu.Lock()
	if acpSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]; acpSession != nil {
		acpSession.goal = clonePayload(goal)
	}
	a.mu.Unlock()
	slog.Info("agent session Claude SDK goal status mirrored",
		"event", "agent_session.claude_sdk.goal_status_mirrored",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"goal_status", strings.TrimSpace(asString(goal["status"])),
		"goal_objective_len", len(strings.TrimSpace(asString(goal["objective"]))),
		"goal_has_reason", strings.TrimSpace(asString(goal["reason"])) != "",
	)
	if event, ok := acpGoalUpdatedEvent(session, "thread_goal_update"); ok {
		return []activityshared.Event{event}
	}
	return nil
}

func claudeSDKGoalStatusPayload(raw json.RawMessage) (map[string]any, bool) {
	var params any
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, false
	}
	attachment := claudeSDKGoalStatusAttachment(params, 6)
	if len(attachment) == 0 {
		return nil, false
	}
	objective := strings.TrimSpace(asString(attachment["condition"]))
	if objective == "" {
		return nil, false
	}
	goal := map[string]any{
		"objective": objective,
		"status":    "active",
	}
	if met, ok := attachment["met"].(bool); ok && met {
		goal["status"] = "complete"
	}
	for _, key := range []string{"reason", "iterations", "durationMs", "tokens", "sentinel"} {
		if value, ok := attachment[key]; ok {
			goal[key] = value
		}
	}
	return goal, true
}

func claudeSDKGoalStatusAttachment(value any, depth int) map[string]any {
	if depth <= 0 {
		return nil
	}
	obj := payloadObject(value)
	if len(obj) > 0 {
		if strings.TrimSpace(asString(obj["type"])) == "goal_status" {
			return obj
		}
		if attachment := payloadObject(obj["attachment"]); strings.TrimSpace(asString(attachment["type"])) == "goal_status" {
			return attachment
		}
		for _, child := range obj {
			if attachment := claudeSDKGoalStatusAttachment(child, depth-1); len(attachment) > 0 {
				return attachment
			}
		}
		return nil
	}
	switch items := value.(type) {
	case []any:
		for _, item := range items {
			if attachment := claudeSDKGoalStatusAttachment(item, depth-1); len(attachment) > 0 {
				return attachment
			}
		}
	case []map[string]any:
		for _, item := range items {
			if attachment := claudeSDKGoalStatusAttachment(item, depth-1); len(attachment) > 0 {
				return attachment
			}
		}
	}
	return nil
}

// claudeSDKAuthFailureDetail returns the auth-related text from a raw SDK
// message when it looks like a local login/credential rejection, else "".
func claudeSDKAuthFailureDetail(message map[string]any) string {
	text := claudeSDKMessageText(message)
	if text == "" {
		return ""
	}
	lower := strings.ToLower(text)
	for _, marker := range []string{"please run /login", "not logged in", "oauth token", "session expired", "authentication", "api key authentication"} {
		if strings.Contains(lower, marker) {
			if len(text) > 600 {
				text = text[:600]
			}
			return text
		}
	}
	return ""
}

type standardACPClaudeTaskMessage struct {
	TaskID       string
	Subtype      string
	Description  string
	Status       string
	Summary      string
	LastToolName string
	TaskType     string
}

func (a *standardACPAdapter) standardACPClaudeTaskEvents(session Session, turnID string, raw json.RawMessage) []activityshared.Event {
	task, ok := standardACPClaudeTaskMessageFromRaw(raw)
	if !ok {
		return nil
	}
	agent, runtimeContext, ok := a.updateStandardACPBackgroundAgent(session.AgentSessionID, task)
	if !ok {
		return nil
	}
	metadata := standardACPBackgroundAgentMetadata(agent)
	activityKey := "claude-task:" + agent.TaskID
	ctx, ok := activityEventContext(session, newID(), turnID)
	if !ok {
		return nil
	}
	var event activityshared.Event
	switch {
	case strings.EqualFold(agent.Status, string(activityshared.ActivityStatusFailed)):
		event = activityshared.NewActivityFailed(ctx, activityKey, metadata)
	case standardACPBackgroundAgentStatusIsTerminal(agent.Status):
		event = activityshared.NewActivityCompleted(ctx, activityKey, metadata)
	case task.Subtype == "task_started":
		event = activityshared.NewActivityStarted(ctx, activityKey, metadata)
	default:
		event = activityshared.NewActivityUpdated(ctx, activityKey, metadata)
	}
	return []activityshared.Event{
		event,
		newSessionActivityEvent(session, EventSessionUpdated, SessionStatusReady, map[string]any{
			"runtimeContext": map[string]any{
				"backgroundAgents": runtimeContext,
			},
		}),
	}
}

func standardACPClaudeTaskMessageFromRaw(raw json.RawMessage) (standardACPClaudeTaskMessage, bool) {
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil || len(payload) == 0 {
		return standardACPClaudeTaskMessage{}, false
	}
	message, _ := payload["message"].(map[string]any)
	if message == nil {
		message = payload
	}
	if asString(message["type"]) != "system" {
		return standardACPClaudeTaskMessage{}, false
	}
	subtype := strings.TrimSpace(asString(message["subtype"]))
	switch subtype {
	case "task_started", "task_progress", "task_notification", "task_updated":
	default:
		return standardACPClaudeTaskMessage{}, false
	}
	taskID := firstNonEmptyString(
		asString(message["task_id"]),
		asString(message["taskId"]),
		asString(payload["task_id"]),
		asString(payload["taskId"]),
	)
	if taskID == "" {
		return standardACPClaudeTaskMessage{}, false
	}
	return standardACPClaudeTaskMessage{
		TaskID:       taskID,
		Subtype:      subtype,
		Description:  firstNonEmptyString(asString(message["description"]), asString(payload["description"])),
		Status:       firstNonEmptyString(asString(message["status"]), asString(payload["status"])),
		Summary:      firstNonEmptyString(asString(message["summary"]), asString(payload["summary"])),
		LastToolName: firstNonEmptyString(asString(message["last_tool_name"]), asString(message["lastToolName"]), asString(payload["last_tool_name"]), asString(payload["lastToolName"])),
		TaskType:     firstNonEmptyString(asString(message["task_type"]), asString(message["taskType"]), asString(payload["task_type"]), asString(payload["taskType"])),
	}, true
}

func (a *standardACPAdapter) updateStandardACPBackgroundAgent(agentSessionID string, task standardACPClaudeTaskMessage) (standardACPBackgroundAgent, map[string]any, bool) {
	if a == nil || task.TaskID == "" {
		return standardACPBackgroundAgent{}, nil, false
	}
	updatedAt := unixMS(now())
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil {
		return standardACPBackgroundAgent{}, nil, false
	}
	if session.backgroundAgents == nil {
		session.backgroundAgents = make(map[string]standardACPBackgroundAgent)
	}
	agent := session.backgroundAgents[task.TaskID]
	agent.TaskID = task.TaskID
	agent.UpdatedAtUnixMS = updatedAt
	if task.Description != "" {
		agent.Description = task.Description
	}
	if task.Summary != "" {
		agent.Summary = task.Summary
	}
	if task.LastToolName != "" {
		agent.LastToolName = task.LastToolName
	}
	if task.TaskType != "" {
		agent.TaskType = task.TaskType
	}
	agent.Status = standardACPClaudeTaskStatus(task, agent.Status)
	if task.Subtype == "task_started" && agent.StartedAtUnixMS == 0 {
		agent.StartedAtUnixMS = updatedAt
	}
	if standardACPBackgroundAgentStatusIsTerminal(agent.Status) && agent.CompletedAtUnixMS == 0 {
		agent.CompletedAtUnixMS = updatedAt
	}
	session.backgroundAgents[task.TaskID] = agent
	return agent, standardACPBackgroundAgentsRuntimeContext(session.backgroundAgents), true
}

func standardACPClaudeTaskStatus(task standardACPClaudeTaskMessage, previous string) string {
	if status := strings.TrimSpace(task.Status); status != "" {
		switch strings.ToLower(status) {
		case "error", "errored":
			return string(activityshared.ActivityStatusFailed)
		case "done", "success", "succeeded":
			return string(activityshared.ActivityStatusCompleted)
		default:
			return status
		}
	}
	switch task.Subtype {
	case "task_notification":
		return string(activityshared.ActivityStatusCompleted)
	case "task_started", "task_progress", "task_updated":
		if strings.TrimSpace(previous) != "" {
			return strings.TrimSpace(previous)
		}
		return string(activityshared.ActivityStatusRunning)
	default:
		return firstNonEmptyString(previous, string(activityshared.ActivityStatusRunning))
	}
}

func standardACPBackgroundAgentMetadata(agent standardACPBackgroundAgent) map[string]any {
	metadata := map[string]any{
		"kind":        "background_agent",
		"taskId":      agent.TaskID,
		"description": agent.Description,
		"status":      firstNonEmptyString(agent.Status, string(activityshared.ActivityStatusRunning)),
		"title":       firstNonEmptyString(agent.Description, "Background agent"),
	}
	if agent.Summary != "" {
		metadata["summary"] = agent.Summary
	}
	if agent.LastToolName != "" {
		metadata["lastToolName"] = agent.LastToolName
	}
	if agent.TaskType != "" {
		metadata["taskType"] = agent.TaskType
	}
	if agent.StartedAtUnixMS > 0 {
		metadata["startedAtUnixMs"] = agent.StartedAtUnixMS
	}
	if agent.UpdatedAtUnixMS > 0 {
		metadata["updatedAtUnixMs"] = agent.UpdatedAtUnixMS
	}
	if agent.CompletedAtUnixMS > 0 {
		metadata["completedAtUnixMs"] = agent.CompletedAtUnixMS
	}
	return metadata
}

// claudeSDKMessageText extracts human-readable text from an SDK message's
// `result` field or nested `message.content` text blocks.
func claudeSDKMessageText(message map[string]any) string {
	if result := strings.TrimSpace(asString(message["result"])); result != "" {
		return result
	}
	inner, ok := message["message"].(map[string]any)
	if !ok {
		return ""
	}
	switch content := inner["content"].(type) {
	case string:
		return strings.TrimSpace(content)
	case []any:
		var parts []string
		for _, block := range content {
			b, ok := block.(map[string]any)
			if !ok {
				continue
			}
			if t := strings.TrimSpace(asString(b["text"])); t != "" {
				parts = append(parts, t)
			}
		}
		return strings.TrimSpace(strings.Join(parts, "\n"))
	}
	return ""
}

func claudeSDKPluginNames(value any) []string {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return nil
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		plugin, _ := item.(map[string]any)
		name := strings.TrimSpace(asString(plugin["name"]))
		source := strings.TrimSpace(asString(plugin["source"]))
		if name == "" {
			continue
		}
		if source != "" {
			result = append(result, name+" ("+source+")")
		} else {
			result = append(result, name)
		}
	}
	return result
}

func stringSliceFromAny(value any) []string {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return nil
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		text := strings.TrimSpace(asString(item))
		if text != "" {
			result = append(result, text)
		}
	}
	return result
}

func jsonStringForLog(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf(`{"marshal_error":%q}`, err.Error())
	}
	return string(raw)
}

func rawMessageLogValue(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return strings.TrimSpace(asString)
	}
	return trimmed
}

func (a *standardACPAdapter) storeSession(agentSessionID string, session *standardACPSession) {
	a.mu.Lock()
	if session != nil && session.agentInfo == nil {
		session.agentInfo = map[string]any{}
	}
	if session != nil {
		session.ensureInitialized()
	}
	if session != nil && session.pendingApprovals == nil {
		session.pendingApprovals = make(map[string]*pendingACPApproval)
	}
	if session != nil && session.backgroundAgents == nil {
		session.backgroundAgents = make(map[string]standardACPBackgroundAgent)
	}
	a.sessions[agentSessionID] = session
	a.mu.Unlock()
}

func (a *standardACPAdapter) getSession(agentSessionID string) *standardACPSession {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[agentSessionID]
}

func (a *standardACPAdapter) rememberSessionTurn(agentSessionID string, turnID string) {
	turnID = strings.TrimSpace(turnID)
	if a == nil || turnID == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	acpSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if acpSession == nil {
		return
	}
	acpSession.recentTurnID = turnID
	acpSession.recentTurnExpiry = time.Now().Add(standardACPRecentTurnTTL)
}

func (a *standardACPAdapter) ensureSessionRecentTurnID(agentSessionID string) string {
	if turnID := a.sessionRecentTurnID(agentSessionID); turnID != "" {
		return turnID
	}
	turnID := "synthetic-" + newID()
	a.rememberSessionTurn(agentSessionID, turnID)
	return turnID
}

func (a *standardACPAdapter) sessionRecentTurnID(agentSessionID string) string {
	if a == nil {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	acpSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if acpSession == nil || strings.TrimSpace(acpSession.recentTurnID) == "" {
		return ""
	}
	if !acpSession.recentTurnExpiry.IsZero() && time.Now().After(acpSession.recentTurnExpiry) {
		acpSession.recentTurnID = ""
		acpSession.recentTurnExpiry = time.Time{}
		return ""
	}
	return strings.TrimSpace(acpSession.recentTurnID)
}

func (a *standardACPAdapter) sessionConfigOptionMatches(agentSessionID string, configID string, value string) bool {
	if a == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil {
		return false
	}
	return acpConfigOptionMatches(session.acpLiveState, configID, value)
}

func (a *standardACPAdapter) sessionConfigOptionAdvertisesValue(agentSessionID string, configID string, value string) bool {
	if a == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil {
		return false
	}
	return acpConfigOptionAdvertisesValue(session.acpLiveState, configID, value)
}

func (a *standardACPAdapter) resolveClaudeCodeACPModelValue(agentSessionID string, model string) string {
	model = strings.TrimSpace(model)
	if model == "" || a == nil || a.config.provider != ProviderClaudeCode {
		return model
	}
	if a.sessionConfigOptionAdvertisesValue(agentSessionID, "model", model) {
		return model
	}
	for _, candidate := range claudeCodeLegacyACPModelCandidates(model) {
		if a.sessionConfigOptionAdvertisesValue(agentSessionID, "model", candidate) {
			return candidate
		}
	}
	return model
}

func (a *standardACPAdapter) resolveClaudeCodeACPFastValue(agentSessionID string, speed string) (string, bool) {
	speed = strings.TrimSpace(speed)
	if speed == "" {
		return "", false
	}
	if a == nil || a.config.provider != ProviderClaudeCode {
		return speed, true
	}
	candidates, known := claudeCodeACPFastConfigValueCandidates(speed)
	if !known {
		return "", false
	}
	for _, candidate := range candidates {
		if a.sessionConfigOptionAdvertisesValue(agentSessionID, "fast", candidate) {
			return candidate, true
		}
	}
	return "", false
}

func claudeCodeACPFastConfigValueCandidates(speed string) ([]string, bool) {
	switch strings.TrimSpace(speed) {
	case sessionSpeedStandard:
		return []string{claudeCodeACPFastOff}, true
	case sessionSpeedFast:
		return []string{claudeCodeACPFastOn}, true
	case claudeCodeACPFastOff:
		return []string{claudeCodeACPFastOff}, true
	case claudeCodeACPFastOn:
		return []string{claudeCodeACPFastOn}, true
	default:
		return nil, false
	}
}

func claudeCodeSpeedFromACPFastConfigValue(speed string) string {
	switch strings.TrimSpace(speed) {
	case claudeCodeACPFastOff:
		return sessionSpeedStandard
	case claudeCodeACPFastOn:
		return sessionSpeedFast
	default:
		return strings.TrimSpace(speed)
	}
}

func (a *standardACPAdapter) removeSession(agentSessionID string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	delete(a.sessions, strings.TrimSpace(agentSessionID))
	a.mu.Unlock()
}

func (a *standardACPAdapter) emitCommandSnapshot(snapshot AgentSessionCommandSnapshot) {
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

func (a *standardACPAdapter) SessionCommandSnapshot(session Session) (AgentSessionCommandSnapshot, bool) {
	if a == nil {
		return AgentSessionCommandSnapshot{}, false
	}
	a.mu.Lock()
	acpSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	if acpSession == nil {
		a.mu.Unlock()
		return AgentSessionCommandSnapshot{}, false
	}
	snapshot, ok := commandSnapshotFromACPLiveState(session.AgentSessionID, acpSession.acpLiveState)
	a.mu.Unlock()
	return snapshot, ok
}

func (a *standardACPAdapter) applyACPUpdate(agentSessionID string, raw json.RawMessage) *AgentSessionCommandSnapshot {
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil {
		return nil
	}
	snapshot := applyACPUpdateToLiveState(&session.acpLiveState, agentSessionID, raw)
	if snapshot == nil {
		return nil
	}
	session.availableCommands = mergeStandardACPAdapterOwnedCommands(
		session.availableCommands,
		a.config.provider,
	)
	mergedSnapshot, _ := commandSnapshotFromACPLiveState(agentSessionID, session.acpLiveState)
	return &mergedSnapshot
}

func (a *standardACPAdapter) storePendingApproval(pending *pendingACPApproval) {
	if a == nil || pending == nil {
		return
	}
	a.mu.Lock()
	session := a.sessions[pending.agentSessionID]
	if session != nil {
		if session.pendingApprovals == nil {
			session.pendingApprovals = make(map[string]*pendingACPApproval)
		}
		session.pendingApprovals[strings.TrimSpace(pending.requestID)] = pending
	}
	a.mu.Unlock()
}

func (a *standardACPAdapter) rejectPendingApprovals(agentSessionID string, err error) {
	if a == nil {
		return
	}
	a.mu.Lock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	pending := make([]*pendingACPApproval, 0)
	if session != nil && session.pendingApprovals != nil {
		for requestID, approval := range session.pendingApprovals {
			pending = append(pending, approval)
			delete(session.pendingApprovals, requestID)
		}
	}
	a.mu.Unlock()
	for _, approval := range pending {
		approval.reject(err)
	}
}

func (a *standardACPAdapter) getPendingApproval(agentSessionID string, requestID string) *pendingACPApproval {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil || session.pendingApprovals == nil {
		return nil
	}
	return session.pendingApprovals[strings.TrimSpace(requestID)]
}

func (a *standardACPAdapter) deletePendingApproval(agentSessionID string, requestID string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session != nil && session.pendingApprovals != nil {
		delete(session.pendingApprovals, strings.TrimSpace(requestID))
	}
	a.mu.Unlock()
}

func standardACPEnv(session Session, host HostMetadata) []string {
	env := []string{
		codexAgentRoutingEnv,
		codexRoutingPreload,
		"NO_BROWSER=1",
	}
	env = append(env, workspaceEnv(session, host)...)
	return env
}

func defaultACPInitializeParams(host HostMetadata) map[string]any {
	return map[string]any{
		"protocolVersion": acpProtocolVersion,
		"clientCapabilities": map[string]any{
			"fs": map[string]any{
				"readTextFile":  false,
				"writeTextFile": false,
			},
			"terminal": false,
			"_meta": map[string]any{
				"terminal_output": true,
			},
		},
		"clientInfo": host.clientInfoParams(),
	}
}

func fallbackStandardSessionTitle(config standardACPConfig, currentTitle string, prompt string) string {
	if isStandardACPPlaceholderTitle(config, currentTitle) {
		return promptTitleSnippet(prompt)
	}
	return ""
}

func standardACPUpdateEvents(config standardACPConfig, session Session, turnID string, raw json.RawMessage, normalizer *acpTurnNormalizer) []activityshared.Event {
	var params struct {
		Update map[string]any `json:"update"`
	}
	if err := json.Unmarshal(raw, &params); err != nil || params.Update == nil {
		return nil
	}
	if events := standardACPInterruptEvents(config, session, turnID, params.Update); len(events) > 0 {
		return events
	}
	updateType := asString(params.Update["sessionUpdate"])
	switch updateType {
	case "user_message_chunk":
		return nil
	case "agent_message_chunk":
		if events, ok := acpSystemNoticeEvents(session, turnID, params.Update, normalizer, "agent_message_chunk", config.allowSyntheticNotice); ok {
			return events
		}
		content := acpTextContent(params.Update["content"])
		if content == "" || normalizer == nil {
			return nil
		}
		return normalizer.AppendAssistantChunk(session, turnID, content)
	case "agent_thought_chunk":
		if events, ok := acpSystemNoticeEvents(session, turnID, params.Update, normalizer, "agent_thought_chunk", config.allowSyntheticNotice); ok {
			return events
		}
		content := acpTextContent(params.Update["content"])
		if content == "" || normalizer == nil {
			return nil
		}
		return normalizer.AppendThinkingChunk(session, turnID, content)
	case "session_info_update":
		if event, ok := acpSessionTitleEvent(session, params.Update); ok {
			if shouldIgnoreStandardACPTitle(config, session.Title, event.Payload.Title) {
				return nil
			}
			return []activityshared.Event{event}
		}
		return nil
	case "tool_call", "tool_call_update":
		if events, ok := normalizer.StandardToolCallEvents(session, turnID, updateType, params.Update); ok {
			return events
		}
		return nil
	case "config_option_update":
		if event, ok := acpConfigOptionsUpdatedEvent(session, params.Update); ok {
			return []activityshared.Event{event}
		}
		return nil
	case "usage_update":
		logACPUsageUpdate(config, session, turnID, params.Update)
		if event, ok := acpUsageUpdatedEvent(session); ok {
			return []activityshared.Event{event}
		}
		return nil
	case "thread_goal_update", "thread_goal_clear", "thread_goal_cleared":
		logACPGoalUpdate(config, session, turnID, updateType, params.Update)
		if event, ok := acpGoalUpdatedEvent(session, updateType); ok {
			return []activityshared.Event{event}
		}
		return nil
	case "stream_error", "warning", "system_notice":
		if events, ok := acpSystemNoticeEvents(session, turnID, params.Update, normalizer, updateType, config.allowSyntheticNotice); ok {
			return events
		}
		return nil
	case "current_mode_update":
		modeID := acpModeValue(params.Update)
		logACPCurrentModeUpdate(config, session, params.Update)
		// Cursor plan mode is orthogonal to permission tiers; mirror agent-driven
		// plan entry/exit into the session settings that drive the composer badge.
		if config.provider == ProviderCursor {
			if event, ok := acpCurrentModeUpdatedEvent(session, modeID); ok {
				return []activityshared.Event{event}
			}
		}
		return nil
	case "available_commands_update", "plan":
		return nil
	default:
		return nil
	}
}

func logACPCurrentModeUpdate(config standardACPConfig, session Session, update map[string]any) {
	slog.Info("agent session ACP current mode update",
		"event", "agent_session.acp.current_mode_update",
		"provider", config.provider,
		"adapter", config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"mode_id", strings.TrimSpace(acpModeValue(update)),
	)
}

func logACPUsageUpdate(
	config standardACPConfig,
	session Session,
	turnID string,
	update map[string]any,
) {
	parsed, parsedOK := acpUsageValue(update)
	slog.Info("agent session ACP usage update",
		"event", "agent_session.acp.usage_update",
		"provider", config.provider,
		"adapter", config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"turn_id", turnID,
		"raw_used", firstACPInt64LogValue(update, "used"),
		"raw_size", firstACPInt64LogValue(update, "size"),
		"raw_cost_amount", nestedACPFloatLogValue(update, "cost", "amount"),
		"raw_cost_currency", nestedACPStringLogValue(update, "cost", "currency"),
		"parsed_ok", parsedOK,
		"context_known", parsed.contextKnown,
		"context_used_tokens", parsed.contextUsedTokens,
		"context_window_tokens", parsed.contextWindowTokens,
		"quota_count", len(parsed.quotas),
	)
}

func firstACPInt64LogValue(source map[string]any, keys ...string) any {
	if value, ok := firstACPInt64(source, keys...); ok {
		return value
	}
	return nil
}

func nestedACPFloatLogValue(source map[string]any, key string, nestedKey string) any {
	nested, _ := source[key].(map[string]any)
	if len(nested) == 0 {
		return nil
	}
	if value, ok := acpFloatValue(nested[nestedKey]); ok {
		return value
	}
	return nil
}

func nestedACPStringLogValue(source map[string]any, key string, nestedKey string) any {
	nested, _ := source[key].(map[string]any)
	if len(nested) == 0 {
		return nil
	}
	value := strings.TrimSpace(asString(nested[nestedKey]))
	if value == "" {
		return nil
	}
	return value
}

func logACPGoalUpdate(config standardACPConfig, session Session, turnID string, updateType string, update map[string]any) {
	goal := payloadObject(update["goal"])
	slog.Info("agent session ACP goal update",
		"event", "agent_session.acp.goal_update",
		"provider", config.provider,
		"adapter", config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"turn_id", turnID,
		"update_type", strings.TrimSpace(updateType),
		"goal_status", strings.TrimSpace(asString(goal["status"])),
		"goal_objective_len", len(strings.TrimSpace(asString(goal["objective"]))),
		"goal_has_reason", strings.TrimSpace(asString(goal["reason"])) != "",
	)
}

func standardACPInterruptEvents(
	config standardACPConfig,
	session Session,
	turnID string,
	update map[string]any,
) []activityshared.Event {
	if strings.TrimSpace(config.provider) != ProviderClaudeCode {
		return nil
	}
	candidates := []string{
		asString(update["title"]),
		asString(update["text"]),
		acpTextContent(update["content"]),
	}
	for _, candidate := range candidates {
		if !isClaudeACPInterruptMarker(candidate) {
			continue
		}
		events := make([]activityshared.Event, 0, 2)
		if strings.TrimSpace(turnID) != "" {
			events = append(
				events,
				newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", nil),
			)
		}
		return events
	}
	return nil
}

func standardACPToolCallEvent(session Session, turnID string, updateType string, update map[string]any) (activityshared.Event, bool) {
	return standardACPToolCallEventWithID(session, newID(), turnID, updateType, update)
}

func standardACPToolCallEventWithID(session Session, eventID string, turnID string, updateType string, update map[string]any) (activityshared.Event, bool) {
	callID := firstNonEmpty(asString(update["toolCallId"]), asString(update["callId"]), asString(update["id"]))
	if callID == "" {
		callID = newID()
	}
	if strings.TrimSpace(session.Provider) != ProviderClaudeCode {
		name := firstNonEmpty(asString(update["title"]), asString(update["name"]), callID, "tool")
		kind := asString(update["kind"])
		status := acpResolvedToolCallStatus(update, "in_progress")
		sanitizedUpdate := acpSanitizeImagePayloadMap(update)
		rawInput := acpToolCallRawInput(update)
		rawOutput := acpToolCallRawOutput(update)
		locations := clonePayloadValue(update["locations"])
		content := acpSanitizeImagePayload(update["content"])
		toolName := acpToolName(callID, name, kind, rawInput)
		displayName := firstNonEmpty(toolName, name)
		payload := map[string]any{
			"callId":   callID,
			"callType": firstNonEmpty(kind, asString(update["callType"]), "tool"),
			"name":     displayName,
			"status":   status,
		}
		if toolName != "" {
			payload["toolName"] = toolName
		}
		if kind != "" {
			payload["kind"] = kind
			payload["acp"] = map[string]any{
				"sessionUpdate": asString(update["sessionUpdate"]),
				"kind":          kind,
			}
		} else if sessionUpdate := asString(update["sessionUpdate"]); sessionUpdate != "" {
			payload["acp"] = map[string]any{
				"sessionUpdate": sessionUpdate,
			}
		}
		if locations != nil {
			payload["locations"] = locations
		}
		if content != nil {
			payload["content"] = content
		}
		inputBody := acpNormalizeToolInput(rawInput, kind, locations)
		outputBody := acpNormalizeToolOutput(rawOutput, content)
		switch status {
		case messageStreamStateCompleted:
			if len(inputBody) > 0 {
				payload["input"] = inputBody
			}
			payload["output"] = mergeACPStandardRawToolBody(outputBody, sanitizedUpdate)
			fileChanges := fileChangesFromACPToolPayload(payload)
			if fileChanges != nil {
				payload["fileChanges"] = fileChanges
			}
			return newTurnActivityEventWithID(session, eventID, EventCallCompleted, turnID, status, "", displayName, payload), true
		case messageStreamStateFailed:
			payload["error"] = mergeACPStandardRawToolBody(outputBody, sanitizedUpdate)
			return newTurnActivityEventWithID(session, eventID, EventCallFailed, turnID, status, "", displayName, payload), true
		default:
			payload["input"] = mergeACPStandardRawToolBody(inputBody, sanitizedUpdate)
			if updateType == "tool_call_update" {
				payload["status"] = messageStreamStateStreaming
			}
			return newTurnActivityEventWithID(session, eventID, EventCallStarted, turnID, messageStreamStateStreaming, "", displayName, payload), true
		}
	}

	rawInput := acpToolCallRawInput(update)
	rawOutput := acpToolCallRawOutput(update)
	locations := clonePayloadValue(update["locations"])
	content := acpSanitizeImagePayload(update["content"])
	kind := firstNonEmpty(asString(update["kind"]), asString(update["callType"]))
	toolName := standardACPClaudeToolName(update, rawInput, rawOutput)
	title := firstNonEmpty(asString(update["title"]), asString(update["name"]))
	name := standardACPClaudeToolDisplayName(title, callID, toolName)
	status := acpResolvedToolCallStatus(update, "in_progress")
	callType := standardACPClaudeToolCallType(toolName, kind)
	payload := map[string]any{
		"callId":   callID,
		"callType": callType,
		"name":     name,
		"status":   status,
	}
	if toolName != "" {
		payload["toolName"] = toolName
	}
	if kind != "" {
		payload["kind"] = kind
		payload["acp"] = map[string]any{
			"sessionUpdate": asString(update["sessionUpdate"]),
			"kind":          kind,
		}
	} else if sessionUpdate := asString(update["sessionUpdate"]); sessionUpdate != "" {
		payload["acp"] = map[string]any{
			"sessionUpdate": sessionUpdate,
		}
	}
	if locations != nil {
		payload["locations"] = locations
	}
	if content != nil {
		payload["content"] = content
	}
	if metadata := standardACPClaudeToolMetadata(update, rawInput, rawOutput); metadata != nil {
		payload["metadata"] = metadata
	}

	inputBody := standardACPClaudeNormalizeToolInput(toolName, kind, update, rawInput, locations)
	outputBody := standardACPClaudeNormalizeToolOutput(toolName, update, rawInput, rawOutput, content)
	switch status {
	case messageStreamStateCompleted:
		if len(outputBody) > 0 {
			payload["output"] = outputBody
		}
		return newTurnActivityEventWithID(session, eventID, EventCallCompleted, turnID, status, "", name, payload), true
	case messageStreamStateFailed:
		if len(outputBody) > 0 {
			payload["error"] = outputBody
			if mirroredOutput := acpMirrorFailedToolOutput(outputBody); len(mirroredOutput) > 0 {
				payload["output"] = mirroredOutput
			}
		}
		return newTurnActivityEventWithID(session, eventID, EventCallFailed, turnID, status, "", name, payload), true
	default:
		if len(inputBody) > 0 {
			payload["input"] = inputBody
		}
		if updateType == "tool_call_update" {
			payload["status"] = messageStreamStateStreaming
		}
		return newTurnActivityEventWithID(session, eventID, EventCallStarted, turnID, messageStreamStateStreaming, "", name, payload), true
	}
}

func standardACPClaudeToolDisplayName(title string, callID string, toolName string) string {
	trimmedTitle := strings.TrimSpace(title)
	if trimmedTitle == "" || strings.EqualFold(trimmedTitle, callID) || strings.HasPrefix(strings.ToLower(trimmedTitle), "call_") {
		return firstNonEmpty(toolName, callID, "tool")
	}
	return trimmedTitle
}

func standardACPClaudeToolName(update map[string]any, rawInput any, rawOutput any) string {
	if imageGenerationToolName := standardACPClaudeImageGenerationToolName(update, rawInput, rawOutput); imageGenerationToolName != "" {
		return imageGenerationToolName
	}
	for _, candidate := range []map[string]any{
		acpMapFromValue(rawInput, "rawInput"),
		acpMapFromValue(rawOutput, "rawOutput"),
		update,
	} {
		if toolName := standardACPClaudeMetaString(candidate, "toolName"); toolName != "" {
			return toolName
		}
	}
	return standardACPClaudeCanonicalToolName(update, rawInput)
}

func standardACPClaudeToolCallType(toolName string, kind string) string {
	switch strings.ToLower(strings.TrimSpace(toolName)) {
	case "task", "subagent", "delegateagent", "delegatetask", "agent":
		return "subagent"
	default:
		return firstNonEmpty(strings.TrimSpace(kind), "tool")
	}
}

func standardACPClaudeToolMetadata(update map[string]any, rawInput any, rawOutput any) map[string]any {
	metadata := map[string]any{}
	if parentToolUseID := standardACPClaudeParentToolUseID(update, rawInput, rawOutput); parentToolUseID != "" {
		metadata["parentToolUseId"] = parentToolUseID
	}
	if toolResponse := standardACPClaudeToolResponse(update, rawInput, rawOutput); toolResponse != nil {
		metadata["claudeToolResponse"] = acpSanitizeImagePayloadMap(toolResponse)
	}
	if len(metadata) == 0 {
		return nil
	}
	return metadata
}

func standardACPClaudeImageGenerationToolName(update map[string]any, rawInput any, rawOutput any) string {
	for _, candidate := range []string{
		standardACPClaudeMetaString(acpMapFromValue(rawInput, "rawInput"), "toolName"),
		standardACPClaudeMetaString(acpMapFromValue(rawOutput, "rawOutput"), "toolName"),
		standardACPClaudeMetaString(update, "toolName"),
		firstNonEmpty(asString(update["title"]), asString(update["name"]), asString(update["toolCallId"])),
	} {
		if toolName := acpCanonicalImageGenerationToolName(candidate, update["content"]); toolName != "" {
			return toolName
		}
	}
	return ""
}

func standardACPClaudeCanonicalToolName(update map[string]any, rawInput any) string {
	return acpToolName(
		asString(update["toolCallId"]),
		firstNonEmpty(asString(update["title"]), asString(update["name"]), asString(update["toolCallId"])),
		asString(update["kind"]),
		rawInput,
	)
}

func acpCanonicalImageGenerationToolName(candidate string, _ any) string {
	normalized := strings.ToLower(strings.TrimSpace(candidate))
	switch normalized {
	case "image_generation", "image generation", "imagegen", "generate_image", "generateimage", "image_generator", "imagegenerator":
		return "ImageGeneration"
	}
	if strings.HasPrefix(normalized, "ig_") {
		return "ImageGeneration"
	}
	return ""
}

func acpContainsImageContent(value any) bool {
	entries, ok := value.([]any)
	if !ok {
		return false
	}
	for _, entry := range entries {
		entryMap, _ := entry.(map[string]any)
		if len(entryMap) == 0 {
			continue
		}
		target := entryMap
		if nested, ok := entryMap["content"].(map[string]any); ok && len(nested) > 0 {
			target = nested
		}
		if acpLooksLikeImagePayload(target) {
			return true
		}
	}
	return false
}

func standardACPClaudeNormalizeToolInput(toolName string, kind string, update map[string]any, rawInput any, locations any) map[string]any {
	body := acpNormalizeToolInput(rawInput, kind, locations)
	if len(body) == 0 {
		body = map[string]any{}
	}
	if strings.EqualFold(strings.TrimSpace(toolName), "Skill") {
		if skill := strings.TrimSpace(asString(body["skill"])); skill == "" {
			if toolResponse := standardACPClaudeToolResponse(update, rawInput, nil); toolResponse != nil {
				if skill = strings.TrimSpace(asString(toolResponse["commandName"])); skill != "" {
					body["skill"] = skill
				}
			}
		}
	}
	if strings.EqualFold(strings.TrimSpace(toolName), "Agent") || strings.EqualFold(strings.TrimSpace(toolName), "Task") {
		toolResponse := standardACPClaudeToolResponse(update, rawInput, nil)
		if toolResponse != nil {
			if prompt := strings.TrimSpace(asString(toolResponse["prompt"])); prompt != "" {
				body["prompt"] = prompt
				body["description"] = prompt
			}
			if agentType := strings.TrimSpace(asString(toolResponse["agentType"])); agentType != "" {
				body["subagent_type"] = agentType
			}
			if agentID := strings.TrimSpace(asString(toolResponse["agentId"])); agentID != "" {
				body["childSessionID"] = agentID
			}
		}
	}
	if len(body) == 0 {
		return nil
	}
	return body
}

func standardACPClaudeNormalizeToolOutput(toolName string, update map[string]any, rawInput any, rawOutput any, content any) map[string]any {
	body := acpNormalizeToolOutput(rawOutput, content)
	if len(body) == 0 {
		body = map[string]any{}
	}
	if strings.EqualFold(strings.TrimSpace(toolName), "Skill") {
		if skill := strings.TrimSpace(asString(acpMapFromValue(rawInput, "rawInput")["skill"])); skill != "" {
			body["commandName"] = skill
		}
		if _, ok := body["success"]; !ok {
			body["success"] = normalizedCallStatus(acpResolvedToolCallStatus(update, "in_progress")) == messageStreamStateCompleted
		}
	}
	if (strings.EqualFold(strings.TrimSpace(toolName), "Agent") || strings.EqualFold(strings.TrimSpace(toolName), "Task")) && len(body) == 0 {
		if toolResponse := standardACPClaudeToolResponse(update, nil, rawOutput); toolResponse != nil {
			body = toolResponse
		}
	}
	if len(body) == 0 {
		return nil
	}
	return body
}

func standardACPClaudeParentToolUseID(update map[string]any, rawInput any, rawOutput any) string {
	for _, candidate := range []map[string]any{
		acpMapFromValue(rawInput, "rawInput"),
		acpMapFromValue(rawOutput, "rawOutput"),
		update,
	} {
		if parentToolUseID := standardACPClaudeMetaString(candidate, "parentToolUseId"); parentToolUseID != "" {
			return parentToolUseID
		}
	}
	return ""
}

func standardACPClaudeToolResponse(update map[string]any, rawInput any, rawOutput any) map[string]any {
	for _, candidate := range []map[string]any{
		acpMapFromValue(rawInput, "rawInput"),
		acpMapFromValue(rawOutput, "rawOutput"),
		update,
	} {
		meta := payloadMap(candidate, "_meta")
		claudeCode := payloadMap(meta, "claudeCode")
		if toolResponse := payloadMap(claudeCode, "toolResponse"); toolResponse != nil {
			return toolResponse
		}
	}
	return nil
}

func standardACPClaudeMetaString(value map[string]any, key string) string {
	meta := payloadMap(value, "_meta")
	claudeCode := payloadMap(meta, "claudeCode")
	return strings.TrimSpace(asString(claudeCode[key]))
}

func shouldIgnoreStandardACPTitle(config standardACPConfig, currentTitle string, title string) bool {
	if isInternalMentionRoutingTitle(title) {
		return true
	}
	if strings.TrimSpace(config.provider) != ProviderClaudeCode {
		return false
	}
	if isClaudeACPInterruptMarker(title) {
		return true
	}
	return !isStandardACPPlaceholderTitle(config, currentTitle)
}

func isStandardACPPlaceholderTitle(config standardACPConfig, title string) bool {
	normalizedTitle := strings.ToLower(strings.TrimSpace(title))
	placeholderTitles := append([]string{"", config.defaultTitle}, config.defaultTitleAliases...)
	for _, placeholderTitle := range placeholderTitles {
		if normalizedTitle == strings.ToLower(strings.TrimSpace(placeholderTitle)) {
			return true
		}
	}
	return false
}

func isClaudeACPInterruptMarker(text string) bool {
	normalized := strings.ToLower(strings.TrimSpace(text))
	switch normalized {
	case "[request interrupted by user]",
		"request interrupted by user",
		"[request interrupted by user for tool use]",
		"request interrupted by user for tool use":
		return true
	default:
		return false
	}
}

func standardACPPermissionRequested(
	adapter *standardACPAdapter,
	session Session,
	turnID string,
	rawRequestID json.RawMessage,
	raw json.RawMessage,
) ([]activityshared.Event, *pendingACPApproval, error) {
	var params struct {
		ToolCall map[string]any   `json:"toolCall"`
		Options  []map[string]any `json:"options"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, nil, fmt.Errorf("invalid permission request: %w", err)
	}
	requestID := acpRequestID(rawRequestID)
	if requestID == "" {
		return nil, nil, errors.New("permission request id is required")
	}
	interactivePrompt := acpInteractivePrompt(params.ToolCall, params.Options, requestID)
	if len(params.Options) == 0 && interactivePrompt == nil {
		return []activityshared.Event{newTurnActivityEvent(session, EventCallFailed, turnID, messageStreamStateFailed, "", "Permission requested", map[string]any{
			"callId":   requestID,
			"callType": "approval",
			"name":     "Permission requested",
			"status":   messageStreamStateFailed,
			"error": map[string]any{
				"requestId": requestID,
				"message":   "permission request did not include options",
			},
		})}, nil, errors.New("permission request did not include options")
	}
	title := firstNonEmpty(
		asString(params.ToolCall["title"]),
		asString(params.ToolCall["name"]),
		asString(params.ToolCall["toolCallId"]),
		"Permission requested",
	)
	callID := firstNonEmpty(asString(params.ToolCall["toolCallId"]), asString(params.ToolCall["id"]), newID())
	callType := "approval"
	status := string(activityshared.TurnPhaseWaitingApproval)
	input := acpApprovalInput(params.ToolCall, params.Options, requestID)
	payload := map[string]any{
		"callId":   callID,
		"callType": "approval",
		"name":     title,
		"toolName": "Approval",
		"status":   status,
		"input":    input,
	}
	if interactivePrompt != nil {
		callType = "interactive"
		title = firstNonEmpty(interactivePrompt.ToolName, title)
		status = firstNonEmpty(interactivePrompt.Status, "waiting_input")
		input = clonePayload(interactivePrompt.Input)
		if input == nil {
			input = map[string]any{}
		}
		input["requestId"] = requestID
		if len(params.Options) > 0 {
			input["options"] = cloneOptionMaps(params.Options)
		}
		payload = map[string]any{
			"callId":   callID,
			"callType": callType,
			"name":     title,
			"toolName": interactivePrompt.ToolName,
			"status":   status,
			"input":    input,
		}
		if metadata := clonePayload(interactivePrompt.Metadata); metadata != nil {
			payload["metadata"] = metadata
		}
	}
	pending := &pendingACPApproval{
		agentSessionID: strings.TrimSpace(session.AgentSessionID),
		requestID:      requestID,
		eventID:        newID(),
		callID:         callID,
		callType:       callType,
		input:          input,
		kind:           firstNonEmpty(interactivePromptKind(interactivePrompt), "approval"),
		name:           title,
		toolName:       firstNonEmpty(asString(payload["toolName"]), title),
		prompt:         interactivePrompt,
		options:        params.Options,
		response:       make(chan pendingACPResponse, 1),
	}
	adapter.storePendingApproval(pending)
	return []activityshared.Event{
		newTurnActivityEvent(session, EventTurnUpdated, turnID, SessionStatusWaiting, "", "", map[string]any{
			"phase":     string(activityshared.TurnPhaseWaitingApproval),
			"requestId": requestID,
		}),
		newTurnActivityEventWithID(
			session,
			pending.eventID,
			EventCallStarted,
			turnID,
			SessionStatusWaiting,
			"",
			title,
			payload,
		),
	}, pending, nil
}
