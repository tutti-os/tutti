//revive:disable:file-length-limit
//nolint:unused // Retain migrated helpers until the next agent-daemon decomposition pass.
package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
	runtimepaths "github.com/tutti-os/tutti/packages/agentactivity/daemon/internal/runtimepaths"
	"github.com/tutti-os/tutti/packages/agentactivity/daemon/internal/titletext"
)

const (
	codexACPCommand       = "codex-acp"
	nexightACPCommand     = "nexight-acp"
	codexAgentRoutingEnv  = "TUTTI_AGENT_ROUTING=1"
	codexRoutingPreload   = "LD_PRELOAD=" + runtimepaths.BundlePreloadSOPath
	acpMethodInitialize   = "initialize"
	acpMethodAuthenticate = "authenticate"
	acpMethodNewSession   = "session/new"
	acpMethodLoadSession  = "session/load"
	acpMethodResume       = "session/resume"
	acpMethodPrompt       = "session/prompt"
	acpMethodCancel       = "session/cancel"
	acpMethodUpdate       = "session/update"
	acpMethodPermission   = "session/request_permission"
	acpMethodSetMode      = "session/set_mode"
	acpProtocolVersion    = 1
	acpStartCallTimeout   = 30 * time.Second
)

const codexConfigFlag = "--config"

var acpPermissionModeTimeout = 10 * time.Second

var errPermissionRequestCanceled = errors.New("permission request canceled")

type codexAdapterConfig struct {
	provider            string
	command             []string
	adapterName         string
	authRequiredMessage string
	fallbackTitles      []string
}

type CodexAdapter struct {
	config      codexAdapterConfig
	transport   ProcessTransport
	host        HostMetadata
	mu          sync.Mutex
	sessions    map[string]*codexACPSession
	commandSink CommandSnapshotSink
	configSink  ConfigOptionsUpdateSink
}

type codexACPSession struct {
	client            *acpClient
	providerSessionID string
	agentInfo         map[string]any
	promptImage       bool
	authState         string
	authMessage       string
	acpLiveState
	pendingRequests map[string]*pendingACPRequest
}

type codexACPSessionStateSnapshot struct {
	agentInfo   map[string]any
	authState   string
	authMessage string
	acpLiveStateSnapshot
	pendingPrompt *SessionInteractivePrompt
}

type pendingACPRequest struct {
	agentSessionID string
	requestID      string
	eventID        string
	callID         string
	callType       string
	input          map[string]any
	kind           string
	name           string
	toolName       string
	prompt         *SessionInteractivePrompt
	options        []map[string]any
	response       chan pendingACPResponse
}

type pendingACPResponse struct {
	optionID string
	action   string
	payload  map[string]any
	result   map[string]any
	err      error
}

func NewCodexAdapter(transport ProcessTransport) *CodexAdapter {
	return NewCodexAdapterWithHostMetadata(transport, LegacyHostMetadata())
}

func NewCodexAdapterWithHostMetadata(transport ProcessTransport, host HostMetadata) *CodexAdapter {
	return newCodexFamilyAdapter(transport, codexAdapterConfig{
		provider:            ProviderCodex,
		command:             []string{codexACPCommand},
		adapterName:         "codex-acp",
		authRequiredMessage: "Codex ACP requires authentication in the runtime VM. Sync the Codex host credentials, then retry this session.",
		fallbackTitles:      []string{"", ProviderCodex},
	}, host)
}

func NewNexightAdapter(transport ProcessTransport) *CodexAdapter {
	return NewNexightAdapterWithHostMetadata(transport, LegacyHostMetadata())
}

func NewNexightAdapterWithHostMetadata(transport ProcessTransport, host HostMetadata) *CodexAdapter {
	return newCodexFamilyAdapter(transport, codexAdapterConfig{
		provider:            ProviderNexight,
		command:             []string{nexightACPCommand},
		adapterName:         "nexight-acp",
		authRequiredMessage: "Nexight ACP requires authentication in the runtime VM. Sync the Nexight host credentials, then retry this session.",
		fallbackTitles:      []string{"", ProviderNexight, "tutti"},
	}, host)
}

func newCodexFamilyAdapter(transport ProcessTransport, config codexAdapterConfig, host HostMetadata) *CodexAdapter {
	return &CodexAdapter{
		config:    config,
		transport: transport,
		host:      host,
		sessions:  make(map[string]*codexACPSession),
	}
}

func (a *CodexAdapter) Provider() string {
	if a == nil {
		return ""
	}
	return strings.TrimSpace(a.config.provider)
}

func (a *CodexAdapter) sessionCWD(session Session) string {
	cwd := strings.TrimSpace(session.CWD)
	if a == nil || strings.TrimSpace(a.config.provider) != ProviderCodex {
		return cwd
	}
	return projectCodexWorkspaceCWD(cwd, session.RoomID)
}

func projectCodexWorkspaceCWD(cwd, roomID string) string {
	roomID = strings.Trim(strings.TrimSpace(roomID), "/")
	if cwd == "" || roomID == "" || strings.Contains(roomID, "/") {
		return cwd
	}
	workspaceRoot := "/workspace/" + roomID
	if cwd == workspaceRoot {
		return "/workspace"
	}
	if strings.HasPrefix(cwd, workspaceRoot+"/") {
		return "/workspace" + strings.TrimPrefix(cwd, workspaceRoot)
	}
	return cwd
}

func (a *CodexAdapter) SetCommandSnapshotSink(sink CommandSnapshotSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.commandSink = sink
	a.mu.Unlock()
}

func (a *CodexAdapter) ValidatePromptContent(session Session, content []PromptContentBlock) error {
	if !promptContentHasImage(content) {
		return nil
	}
	acpSession := a.getSession(session.AgentSessionID)
	if acpSession != nil && acpSession.promptImage {
		return nil
	}
	return ErrPromptImageUnsupported
}

func codexPromptImageSupported(_ json.RawMessage) bool {
	// Codex ACP supports image prompt content even when older initialize results
	// omit promptCapabilities.image.
	return true
}

func (a *CodexAdapter) Start(ctx context.Context, session Session) ([]activityshared.Event, error) {
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
	a.storeSession(session.AgentSessionID, &codexACPSession{
		client:          client,
		agentInfo:       acpAgentInfo(initializeResult),
		promptImage:     codexPromptImageSupported(initializeResult),
		acpLiveState:    newACPLiveState(),
		pendingRequests: make(map[string]*pendingACPRequest),
	})

	sessionCWD := a.sessionCWD(session)
	sessionNewStartedAt := time.Now()
	slog.Info("agent session ACP new session starting",
		"event", "agent_session.acp.session_new.start",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
	)
	newSessionResult, err := client.CallWithTimeout(ctx, acpStartCallTimeout, acpMethodNewSession, map[string]any{
		"cwd":        firstNonEmpty(sessionCWD, "/"),
		"mcpServers": []any{},
	}, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	if err != nil {
		slog.Warn("agent session ACP new session failed",
			"event", "agent_session.acp.session_new.failed",
			"provider", a.config.provider,
			"adapter", a.config.adapterName,
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"elapsed_ms", time.Since(sessionNewStartedAt).Milliseconds(),
			"error", err.Error(),
		)
		var callErr *acpCallError
		if errors.As(err, &callErr) && callErr.AuthRequired() {
			authMessage := strings.TrimSpace(a.config.authRequiredMessage)
			a.storeSession(session.AgentSessionID, a.finalizeSession(session.AgentSessionID, &codexACPSession{
				agentInfo:       acpAgentInfo(initializeResult),
				promptImage:     codexPromptImageSupported(initializeResult),
				authState:       "auth_required",
				authMessage:     authMessage,
				acpLiveState:    newACPLiveState(),
				pendingRequests: make(map[string]*pendingACPRequest),
			}))
			keepSession = true
			return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, map[string]any{
				"adapter":          a.config.adapterName,
				"command":          a.commandString(),
				"agent":            acpAgentInfo(initializeResult),
				"permissionModeId": session.PermissionModeID,
				"authState":        "auth_required",
				"authMessage":      authMessage,
			})}, nil
		}
		return nil, err
	}
	providerSessionID, err := acpSessionID(newSessionResult)
	if err != nil {
		return nil, err
	}
	slog.Info("agent session ACP new session succeeded",
		"event", "agent_session.acp.session_new.succeeded",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", providerSessionID,
		"elapsed_ms", time.Since(sessionNewStartedAt).Milliseconds(),
	)
	session.ProviderSessionID = providerSessionID
	liveState := newACPLiveState()
	if currentSession := a.getSession(session.AgentSessionID); currentSession != nil {
		liveState = cloneACPLiveState(currentSession.acpLiveState)
	}
	applyACPConfigOptionsResult(&liveState, newSessionResult)
	if err := a.applyPermissionMode(ctx, client, session); err != nil {
		return nil, err
	}

	started = true
	a.storeSession(session.AgentSessionID, a.finalizeSession(session.AgentSessionID, &codexACPSession{
		client:            client,
		providerSessionID: providerSessionID,
		agentInfo:         acpAgentInfo(initializeResult),
		promptImage:       codexPromptImageSupported(initializeResult),
		acpLiveState:      liveState,
		pendingRequests:   make(map[string]*pendingACPRequest),
	}))
	keepSession = true
	return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, map[string]any{
		"adapter":          a.config.adapterName,
		"command":          a.commandString(),
		"agent":            acpAgentInfo(initializeResult),
		"permissionModeId": session.PermissionModeID,
	})}, nil
}

func (a *CodexAdapter) Resume(ctx context.Context, session Session) error {
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
	a.storeSession(session.AgentSessionID, a.finalizeSession(session.AgentSessionID, &codexACPSession{
		client:            client,
		providerSessionID: session.ProviderSessionID,
		agentInfo:         acpAgentInfo(initializeResult),
		promptImage:       codexPromptImageSupported(initializeResult),
		acpLiveState:      newACPLiveState(),
		pendingRequests:   make(map[string]*pendingACPRequest),
	}))

	method := acpResumeMethod(initializeResult)
	if method == "" {
		return unsupportedACPResumeError(session)
	}
	sessionCWD := a.sessionCWD(session)
	loadSessionResult, err := client.CallWithTimeout(ctx, acpStartCallTimeout, method, map[string]any{
		"sessionId":  session.ProviderSessionID,
		"cwd":        firstNonEmpty(sessionCWD, "/"),
		"mcpServers": []any{},
	}, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	if err != nil {
		var callErr *acpCallError
		if errors.As(err, &callErr) && callErr.AuthRequired() {
			authMessage := strings.TrimSpace(a.config.authRequiredMessage)
			a.storeSession(session.AgentSessionID, a.finalizeSession(session.AgentSessionID, &codexACPSession{
				providerSessionID: session.ProviderSessionID,
				agentInfo:         acpAgentInfo(initializeResult),
				promptImage:       codexPromptImageSupported(initializeResult),
				authState:         "auth_required",
				authMessage:       authMessage,
				acpLiveState:      newACPLiveState(),
				pendingRequests:   make(map[string]*pendingACPRequest),
			}))
			keepSession = true
			return nil
		}
		return classifyACPResumeError(session, method, err)
	}
	liveState := newACPLiveState()
	if currentSession := a.getSession(session.AgentSessionID); currentSession != nil {
		liveState = cloneACPLiveState(currentSession.acpLiveState)
	}
	applyACPConfigOptionsResult(&liveState, loadSessionResult)
	if err := a.applyPermissionMode(ctx, client, session); err != nil {
		return err
	}
	started = true
	a.storeSession(session.AgentSessionID, a.finalizeSession(session.AgentSessionID, &codexACPSession{
		client:            client,
		providerSessionID: session.ProviderSessionID,
		agentInfo:         acpAgentInfo(initializeResult),
		promptImage:       codexPromptImageSupported(initializeResult),
		acpLiveState:      liveState,
		pendingRequests:   make(map[string]*pendingACPRequest),
	}))
	keepSession = true
	return nil
}

func (*CodexAdapter) CanResume(session Session) bool {
	return strings.TrimSpace(session.ProviderSessionID) != ""
}

func (a *CodexAdapter) Close(_ context.Context, session Session) error {
	if a == nil {
		return nil
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	a.rejectPendingRequests(agentSessionID, errPermissionRequestCanceled)
	a.mu.Lock()
	acpSession := a.sessions[agentSessionID]
	delete(a.sessions, agentSessionID)
	a.mu.Unlock()
	if acpSession != nil && acpSession.client != nil {
		return acpSession.client.Close()
	}
	return nil
}

func (a *CodexAdapter) startInitializedClient(
	ctx context.Context,
	session Session,
) (*acpClient, json.RawMessage, error) {
	if a == nil || a.transport == nil {
		return nil, nil, errors.New("ACP process transport is unavailable")
	}
	conn, err := a.transport.Start(ctx, ProcessSpec{
		Provider:       a.Provider(),
		AgentSessionID: session.AgentSessionID,
		RoomID:         session.RoomID,
		CWD:            a.sessionCWD(session),
		Command:        codexACPCommandWithSettings(a.config.command, session),
		Env:            append(codexACPEnv(session, a.host), session.Env...),
	})
	if err != nil {
		return nil, nil, err
	}
	client := newACPClientWithStderrMessageMapper(conn, codexACPSystemNoticeMessageFromStderr)
	client.SetMessageHandler(func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	started := false
	defer func() {
		if !started {
			_ = client.Close()
		}
	}()

	initializeStartedAt := time.Now()
	slog.Info("agent session ACP initialize starting",
		"event", "agent_session.acp.initialize.start",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
	)
	initializeResult, err := client.CallWithTimeout(ctx, acpStartCallTimeout, acpMethodInitialize, map[string]any{
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
		"clientInfo": a.host.clientInfoParams(),
	}, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	if err != nil {
		slog.Warn("agent session ACP initialize failed",
			"event", "agent_session.acp.initialize.failed",
			"provider", a.config.provider,
			"adapter", a.config.adapterName,
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"elapsed_ms", time.Since(initializeStartedAt).Milliseconds(),
			"error", err.Error(),
		)
		return nil, nil, err
	}
	slog.Info("agent session ACP initialize succeeded",
		"event", "agent_session.acp.initialize.succeeded",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"elapsed_ms", time.Since(initializeStartedAt).Milliseconds(),
	)
	started = true
	return client, initializeResult, nil
}

func (a *CodexAdapter) Exec(
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
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
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
	if fallbackTitle := fallbackACPFamilySessionTitle(session.Title, visibleText, a.config.fallbackTitles...); fallbackTitle != "" {
		startEvents = append(startEvents, newSessionTitleActivityEvent(session, fallbackTitle))
		session.Title = fallbackTitle
	}
	startEvents = append(startEvents,
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, visibleText, userPromptActivityPayload(content, explicitDisplayPrompt, nil)),
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
	)
	emitEvents(startEvents)

	result, err := acpSession.client.Call(ctx, acpMethodPrompt, map[string]any{
		"sessionId": acpSession.providerSessionID,
		"prompt":    promptContentForACP(content),
	}, func(ctx context.Context, message acpMessage) error {
		next, err := a.handleACPMessage(ctx, acpSession.client, session, turnID, message, normalizer, emitEvents, emitCommands)
		emitEvents(next)
		if err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, errPermissionRequestCanceled) {
			terminalEvents := normalizer.FinishInterrupted(session, turnID, "interrupted")
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
				"error": err.Error(),
			}))
			emitEvents(terminalEvents)
		} else {
			terminalEvents := normalizer.FinishFailed(session, turnID)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(err)))
			emitEvents(terminalEvents)
		}
		return events, nil
	}

	normalizer.ApplyAssistantFinalText(acpPromptResultAssistantText(result))
	stopReason := acpStopReason(result)
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
	return events, nil
}

func (a *CodexAdapter) applyPermissionMode(ctx context.Context, client *acpClient, session Session) error {
	modeID := codexACPEffectiveModeID(session)
	if modeID == "" {
		return nil
	}
	setModeStartedAt := time.Now()
	slog.Info("agent session ACP permission mode apply starting",
		"event", "agent_session.acp.permission_mode.start",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"mode_id", modeID,
	)
	_, err := client.CallWithTimeout(ctx, acpPermissionModeTimeout, acpMethodSetMode, map[string]any{
		"sessionId": session.ProviderSessionID,
		"modeId":    modeID,
	}, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	if err != nil {
		slog.Warn("agent session ACP permission mode apply failed",
			"event", "agent_session.acp.permission_mode.failed",
			"provider", a.config.provider,
			"adapter", a.config.adapterName,
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"mode_id", modeID,
			"elapsed_ms", time.Since(setModeStartedAt).Milliseconds(),
			"error", err.Error(),
		)
		slog.Warn("agent session ACP permission mode was not confirmed; continuing",
			"event", "agent_session.acp.permission_mode.unconfirmed",
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"mode_id", modeID,
			"error", err.Error(),
		)
		return nil
	}
	slog.Info("agent session ACP permission mode apply succeeded",
		"event", "agent_session.acp.permission_mode.succeeded",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"mode_id", modeID,
		"elapsed_ms", time.Since(setModeStartedAt).Milliseconds(),
	)
	return nil
}

func (a *CodexAdapter) ApplyPermissionMode(ctx context.Context, session Session) error {
	acpSession := a.getSession(session.AgentSessionID)
	if acpSession == nil || acpSession.client == nil {
		return nil
	}
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		session.ProviderSessionID = acpSession.providerSessionID
	}
	return a.applyPermissionMode(ctx, acpSession.client, session)
}

func (a *CodexAdapter) setSessionConfigOption(
	ctx context.Context,
	client *acpClient,
	session Session,
	configID string,
	value string,
) error {
	result, err := client.CallWithTimeout(ctx, acpStartCallTimeout, acpMethodSetConfigOption, map[string]any{
		"sessionId": session.ProviderSessionID,
		"configId":  configID,
		"value":     value,
	}, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	if err == nil {
		a.updateSessionConfigOptionsResult(session.AgentSessionID, result)
	}
	return err
}

func (a *CodexAdapter) updateSessionConfigOptionsResult(agentSessionID string, raw json.RawMessage) {
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

func (a *CodexAdapter) updateSessionConfigOption(
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

func (a *CodexAdapter) ApplySessionSettings(
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

	if patch.Model != nil {
		model := strings.TrimSpace(*patch.Model)
		if model != "" {
			if !a.sessionConfigOptionMatches(session.AgentSessionID, "model", model) {
				if err := a.setSessionConfigOption(ctx, acpSession.client, session, "model", model); err != nil {
					return fmt.Errorf("agent session ACP model configuration failed: %w", err)
				}
				a.updateSessionConfigOption(session.AgentSessionID, "model", model)
			}
		}
	}

	if patch.ReasoningEffort != nil {
		reasoning := codexACPReasoningEffortValue(*patch.ReasoningEffort)
		if reasoning != "" {
			if !a.sessionConfigOptionMatches(session.AgentSessionID, "reasoning_effort", reasoning) {
				if err := a.setSessionConfigOption(ctx, acpSession.client, session, "reasoning_effort", reasoning); err != nil {
					return fmt.Errorf("agent session ACP effort configuration failed: %w", err)
				}
				a.updateSessionConfigOption(session.AgentSessionID, "reasoning_effort", reasoning)
			}
		}
	}

	return nil
}

func (a *CodexAdapter) commandString() string {
	if a == nil {
		return ""
	}
	return strings.Join(a.config.command, " ")
}

func (*CodexAdapter) RequiresNewSessionForSettings(session Session, patch SessionSettingsPatch) bool {
	if patch.Model == nil {
		return false
	}
	currentModel := session.SettingsValue().Model
	nextModel := strings.TrimSpace(*patch.Model)
	return codexACPReasoningSummaryOverride(currentModel) != codexACPReasoningSummaryOverride(nextModel)
}

const (
	codexACPConfigModelReasoningSummary = "model_reasoning_summary"
	codexACPReasoningSummaryNone        = "none"
)

var codexACPModelsWithoutReasoningSummary = map[string]struct{}{
	"gpt-5.3-codex-spark": {},
}

func codexACPCommandWithSettings(base []string, session Session) []string {
	command := append([]string(nil), base...)
	if len(command) == 0 {
		return command
	}
	for _, entry := range codexACPConfigEntries(session) {
		command = append(command, codexConfigFlag, entry)
	}
	return command
}

func codexACPConfigEntries(session Session) []string {
	settings := session.SettingsValue()
	entries := make([]string, 0, 4)
	if model := strings.TrimSpace(settings.Model); model != "" {
		entries = append(entries, "model="+model)
		if summary := codexACPReasoningSummaryOverride(model); summary != "" {
			entries = append(entries, codexACPConfigModelReasoningSummary+"="+summary)
		}
	}
	if reasoning := codexACPReasoningEffortValue(settings.ReasoningEffort); reasoning != "" {
		entries = append(entries, "model_reasoning_effort="+reasoning)
	}
	return entries
}

func codexACPReasoningSummaryOverride(model string) string {
	if codexACPModelDisablesReasoningSummary(model) {
		return codexACPReasoningSummaryNone
	}
	return ""
}

func codexACPModelDisablesReasoningSummary(model string) bool {
	_, ok := codexACPModelsWithoutReasoningSummary[strings.ToLower(strings.TrimSpace(model))]
	return ok
}

func codexACPReasoningEffortValue(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "minimal":
		return "minimal"
	case "low":
		return "low"
	case "medium":
		return "medium"
	case "high":
		return "high"
	case "max", "xhigh":
		return "xhigh"
	default:
		return ""
	}
}

func codexACPModeID(mode string) string {
	switch strings.TrimSpace(mode) {
	case "read-only":
		return "read-only"
	case "auto":
		return "auto"
	case "full-access":
		return "full-access"
	default:
		return ""
	}
}

func codexACPEffectiveModeID(session Session) string {
	return codexACPModeID(session.PermissionModeID)
}

func (a *CodexAdapter) Cancel(ctx context.Context, session Session, reason string) ([]activityshared.Event, error) {
	reason = strings.TrimSpace(reason)
	acpSession := a.getSession(session.AgentSessionID)
	if acpSession == nil || acpSession.client == nil {
		slog.Warn("agent session ACP cancel failed because session is not connected",
			"event", "agent_session.acp.cancel.not_connected",
			"agent_session_id", session.AgentSessionID,
			"reason", reason,
		)
		return nil, ErrSessionDisconnected
	}
	slog.Info("agent session ACP cancel requested",
		"event", "agent_session.acp.cancel.requested",
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", acpSession.providerSessionID,
		"reason", reason,
	)
	if err := acpSession.client.Notify(ctx, acpMethodCancel, map[string]any{
		"sessionId": acpSession.providerSessionID,
	}); err != nil {
		slog.Warn("agent session ACP cancel notify failed",
			"event", "agent_session.acp.cancel.notify_failed",
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", acpSession.providerSessionID,
			"reason", reason,
			"error", err.Error(),
		)
		return nil, err
	}
	slog.Info("agent session ACP cancel accepted",
		"event", "agent_session.acp.cancel.accepted",
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", acpSession.providerSessionID,
		"reason", reason,
	)
	a.rejectPendingRequests(session.AgentSessionID, errPermissionRequestCanceled)
	return nil, nil
}

func (a *CodexAdapter) handleACPMessage(
	ctx context.Context,
	client *acpClient,
	session Session,
	turnID string,
	message acpMessage,
	normalizer *acpTurnNormalizer,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) ([]activityshared.Event, error) {
	switch message.Method {
	case acpMethodUpdate:
		if snapshot := a.applyACPUpdate(session.AgentSessionID, message.Params); snapshot != nil {
			if emitCommands != nil {
				emitCommands(*snapshot)
			} else {
				a.emitCommandSnapshot(*snapshot)
			}
		}
		a.emitConfigOptionsUpdate(session, message.Params)
		return acpUpdateEvents(session, turnID, message.Params, normalizer), nil
	case acpMethodPermission:
		if strings.TrimSpace(turnID) == "" || emit == nil {
			err := errors.New("permission request outside active prompt turn is not supported")
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32000, Message: err.Error()})
			return nil, err
		}
		events, pending, err := a.acpPermissionRequested(session, turnID, message.ID, message.Params)
		if err != nil {
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32602, Message: err.Error()})
			return events, err
		}
		if len(events) > 0 && emit != nil {
			// The caller emits returned events after this handler returns. Permission
			// requests must be visible while this handler is waiting for the user.
			emit(events)
		}
		defer a.deletePendingRequest(session.AgentSessionID, pending.requestID)
		selection, err := pending.wait(ctx)
		if err != nil {
			events := acpPermissionResolvedEvents(session, turnID, pending, pendingACPResponse{}, err)
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32000, Message: err.Error()})
			return events, err
		}
		result := selection.result
		if result == nil {
			result = acpPermissionResponseResult(selection.optionID)
		}
		if err := client.Respond(ctx, message.ID, result, nil); err != nil {
			return acpPermissionResolvedEvents(session, turnID, pending, selection, err), err
		}
		return acpPermissionResolvedEvents(session, turnID, pending, selection, nil), nil
	default:
		if len(message.ID) > 0 {
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32601, Message: "method not supported"})
		}
		return nil, nil
	}
}

func (a *CodexAdapter) SetConfigOptionsUpdateSink(sink ConfigOptionsUpdateSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.configSink = sink
	a.mu.Unlock()
}

func (a *CodexAdapter) emitConfigOptionsUpdate(session Session, raw json.RawMessage) {
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

func (a *CodexAdapter) submitPermissionOption(ctx context.Context, session Session, input PermissionOptionInput) (string, error) {
	requestID := strings.TrimSpace(input.RequestID)
	optionID := strings.TrimSpace(input.OptionID)
	if requestID == "" {
		return "", errors.New("permission request id is required")
	}
	if optionID == "" {
		return "", errors.New("permission option id is required")
	}
	pending := a.getPendingRequest(session.AgentSessionID, requestID)
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

func (a *CodexAdapter) SessionState(session Session) SessionStateSnapshot {
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
	if len(state.agentInfo) > 0 {
		snapshot.RuntimeContext["agent"] = state.agentInfo
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

func (a *CodexAdapter) SessionCommandSnapshot(session Session) (AgentSessionCommandSnapshot, bool) {
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

func (a *CodexAdapter) snapshotSessionState(agentSessionID string) (codexACPSessionStateSnapshot, bool) {
	if a == nil {
		return codexACPSessionStateSnapshot{}, false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	acpSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if acpSession == nil {
		return codexACPSessionStateSnapshot{}, false
	}
	var prompt *SessionInteractivePrompt
	for _, pending := range acpSession.pendingRequests {
		prompt = pending.snapshotPrompt()
		break
	}
	return codexACPSessionStateSnapshot{
		agentInfo:            clonePayload(acpSession.agentInfo),
		authState:            strings.TrimSpace(acpSession.authState),
		authMessage:          strings.TrimSpace(acpSession.authMessage),
		acpLiveStateSnapshot: snapshotACPLiveState(acpSession.acpLiveState),
		pendingPrompt:        prompt,
	}, true
}

func (a *CodexAdapter) SubmitInteractive(ctx context.Context, session Session, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
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

func (a *CodexAdapter) storeSession(agentSessionID string, session *codexACPSession) {
	a.mu.Lock()
	if session != nil && session.agentInfo == nil {
		session.agentInfo = map[string]any{}
	}
	if session != nil {
		session.ensureInitialized()
	}
	if session != nil && session.pendingRequests == nil {
		session.pendingRequests = make(map[string]*pendingACPRequest)
	}
	a.sessions[agentSessionID] = session
	a.mu.Unlock()
}

func (a *CodexAdapter) emitCommandSnapshot(snapshot AgentSessionCommandSnapshot) {
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

func (a *CodexAdapter) finalizeSession(agentSessionID string, next *codexACPSession) *codexACPSession {
	if a == nil || next == nil {
		return next
	}
	a.mu.Lock()
	current := a.sessions[strings.TrimSpace(agentSessionID)]
	if current == nil {
		a.mu.Unlock()
		return next
	}
	if acpLiveStateIsEmpty(next.acpLiveState) {
		next.acpLiveState = cloneACPLiveState(current.acpLiveState)
	}
	a.mu.Unlock()
	return next
}

func acpLiveStateIsEmpty(state acpLiveState) bool {
	return strings.TrimSpace(state.currentMode) == "" &&
		!state.commandsKnown &&
		len(state.availableCommands) == 0 &&
		len(state.configOptions) == 0 &&
		len(state.configOptionDescriptors) == 0
}

func (a *CodexAdapter) removeSession(agentSessionID string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	delete(a.sessions, strings.TrimSpace(agentSessionID))
	a.mu.Unlock()
}

func (a *CodexAdapter) getSession(agentSessionID string) *codexACPSession {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[agentSessionID]
}

func (a *CodexAdapter) sessionConfigOptionMatches(agentSessionID string, configID string, value string) bool {
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

func providerSessionID(session *codexACPSession) string {
	if session == nil {
		return ""
	}
	return session.providerSessionID
}

func (a *CodexAdapter) applyACPUpdate(agentSessionID string, raw json.RawMessage) *AgentSessionCommandSnapshot {
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil {
		return nil
	}
	return applyACPUpdateToLiveState(&session.acpLiveState, agentSessionID, raw)
}

func acpModeValue(update map[string]any) string {
	return firstNonEmpty(
		asString(update["mode"]),
		asString(update["modeId"]),
		asString(update["mode_id"]),
		asString(update["name"]),
		asString(update["value"]),
	)
}

func acpCommandsValue(update map[string]any) ([]AgentSessionCommand, bool) {
	commands := make([]AgentSessionCommand, 0)
	found := false
	entryCount := 0
	appendCommand := func(command AgentSessionCommand) {
		command.Name = strings.TrimSpace(command.Name)
		command.Description = strings.TrimSpace(command.Description)
		command.InputHint = strings.TrimSpace(command.InputHint)
		if command.Name != "" {
			commands = append(commands, command)
		}
	}
	for _, key := range []string{"commands", "availableCommands", "available_commands"} {
		values, ok := update[key].([]any)
		if !ok {
			continue
		}
		found = true
		entryCount += len(values)
		for _, value := range values {
			switch typed := value.(type) {
			case string:
				appendCommand(AgentSessionCommand{Name: typed})
			case map[string]any:
				appendCommand(AgentSessionCommand{
					Name: firstNonEmpty(
						asString(typed["name"]),
						asString(typed["id"]),
						asString(typed["command"]),
					),
					Description: firstNonEmpty(
						asString(typed["description"]),
						asString(typed["summary"]),
					),
					InputHint: acpCommandInputHint(typed),
				})
			}
		}
	}
	if !found {
		return nil, false
	}
	commands = dedupeAgentSessionCommands(commands)
	if entryCount > 0 && len(commands) == 0 {
		return nil, false
	}
	return commands, true
}

func acpCommandInputHint(command map[string]any) string {
	if hint := firstNonEmpty(
		asString(command["inputHint"]),
		asString(command["input_hint"]),
		asString(command["hint"]),
	); hint != "" {
		return hint
	}
	if input, ok := command["input"].(map[string]any); ok {
		return firstNonEmpty(
			asString(input["hint"]),
			asString(input["inputHint"]),
			asString(input["input_hint"]),
		)
	}
	return ""
}

func dedupeAgentSessionCommands(commands []AgentSessionCommand) []AgentSessionCommand {
	if len(commands) == 0 {
		return []AgentSessionCommand{}
	}
	seen := make(map[string]struct{}, len(commands))
	out := make([]AgentSessionCommand, 0, len(commands))
	for _, command := range commands {
		command.Name = strings.TrimSpace(command.Name)
		command.Description = strings.TrimSpace(command.Description)
		command.InputHint = strings.TrimSpace(command.InputHint)
		if command.Name == "" {
			continue
		}
		if _, ok := seen[command.Name]; ok {
			continue
		}
		seen[command.Name] = struct{}{}
		out = append(out, command)
	}
	return out
}

func agentSessionCommandNames(commands []AgentSessionCommand) []string {
	if len(commands) == 0 {
		return []string{}
	}
	names := make([]string, 0, len(commands))
	for _, command := range commands {
		if name := strings.TrimSpace(command.Name); name != "" {
			names = append(names, name)
		}
	}
	return names
}

func acpConfigValues(update map[string]any) map[string]any {
	values := map[string]any{}
	for _, key := range []string{"config", "option", "options"} {
		if object, ok := update[key].(map[string]any); ok {
			for objectKey, objectValue := range object {
				if strings.TrimSpace(objectKey) != "" {
					values[objectKey] = objectValue
				}
			}
		}
	}
	configKey := firstNonEmpty(
		asString(update["key"]),
		asString(update["optionId"]),
		asString(update["option_id"]),
		asString(update["name"]),
	)
	if configKey != "" {
		if value, ok := update["value"]; ok {
			values[configKey] = value
		}
	}
	return values
}

func dedupeStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		normalized := strings.TrimSpace(value)
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	return out
}

func (a *CodexAdapter) storePendingRequest(pending *pendingACPRequest) {
	if a == nil || pending == nil {
		return
	}
	a.mu.Lock()
	session := a.sessions[pending.agentSessionID]
	if session != nil {
		if session.pendingRequests == nil {
			session.pendingRequests = make(map[string]*pendingACPRequest)
		}
		session.pendingRequests[strings.TrimSpace(pending.requestID)] = pending
	}
	a.mu.Unlock()
}

func (a *CodexAdapter) rejectPendingRequests(agentSessionID string, err error) {
	if a == nil {
		return
	}
	a.mu.Lock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	pending := make([]*pendingACPRequest, 0)
	if session != nil && session.pendingRequests != nil {
		for requestID, approval := range session.pendingRequests {
			pending = append(pending, approval)
			delete(session.pendingRequests, requestID)
		}
	}
	a.mu.Unlock()
	for _, approval := range pending {
		approval.reject(err)
	}
}

func (a *CodexAdapter) getPendingRequest(agentSessionID string, requestID string) *pendingACPRequest {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil || session.pendingRequests == nil {
		return nil
	}
	return session.pendingRequests[strings.TrimSpace(requestID)]
}

func (a *CodexAdapter) deletePendingRequest(agentSessionID string, requestID string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session != nil && session.pendingRequests != nil {
		delete(session.pendingRequests, strings.TrimSpace(requestID))
	}
	a.mu.Unlock()
}

func codexACPEnv(session Session, host HostMetadata) []string {
	env := []string{
		codexAgentRoutingEnv,
		codexRoutingPreload,
		"NO_BROWSER=1",
	}
	env = append(env, workspaceEnv(session, host)...)
	return env
}

func acpSessionID(raw json.RawMessage) (string, error) {
	var result struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", err
	}
	if strings.TrimSpace(result.SessionID) == "" {
		return "", errors.New("ACP session/new returned empty sessionId")
	}
	return strings.TrimSpace(result.SessionID), nil
}

func acpAgentInfo(raw json.RawMessage) map[string]any {
	var result struct {
		AgentInfo map[string]any `json:"agentInfo"`
	}
	if err := json.Unmarshal(raw, &result); err != nil || result.AgentInfo == nil {
		return map[string]any{}
	}
	return result.AgentInfo
}

func acpResumeMethod(raw json.RawMessage) string {
	var result map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &result) != nil {
		return ""
	}
	if truthyNested(result, "sessionCapabilities", "resume") ||
		truthyNested(result, "agentCapabilities", "resumeSession") ||
		truthyNested(result, "agentCapabilities", "resume") {
		return acpMethodResume
	}
	if truthyNested(result, "sessionCapabilities", "load") ||
		truthyNested(result, "sessionCapabilities", "loadSession") ||
		truthyNested(result, "agentCapabilities", "loadSession") ||
		truthyNested(result, "agentCapabilities", "load") {
		return acpMethodLoadSession
	}
	return ""
}

func truthyNested(value map[string]any, objectKey, fieldKey string) bool {
	nested, ok := value[objectKey].(map[string]any)
	if !ok {
		return false
	}
	switch field := nested[fieldKey].(type) {
	case bool:
		return field
	case string:
		return strings.EqualFold(strings.TrimSpace(field), "true")
	default:
		return false
	}
}

func acpStopReason(raw json.RawMessage) string {
	var result struct {
		StopReason string `json:"stopReason"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return ""
	}
	return canonicalACPStopReason(result.StopReason)
}

func canonicalACPStopReason(reason string) string {
	trimmed := strings.TrimSpace(reason)
	switch strings.ToLower(trimmed) {
	case "cancelled":
		return SessionStatusCanceled
	default:
		return trimmed
	}
}

func acpPromptResultAssistantText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return ""
	}
	return strings.TrimSpace(acpTextFromValue(decoded))
}

func acpTextFromValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := strings.TrimSpace(acpTextFromValue(item)); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "")
	case map[string]any:
		if role := strings.TrimSpace(asString(typed["role"])); role != "" && role != "assistant" && role != "agent" {
			return ""
		}
		if text := strings.TrimSpace(asString(typed["text"])); text != "" {
			return text
		}
		for _, key := range []string{"content", "message", "output", "result"} {
			if text := strings.TrimSpace(acpTextFromValue(typed[key])); text != "" {
				return text
			}
		}
		if messages, ok := typed["messages"].([]any); ok {
			for i := len(messages) - 1; i >= 0; i-- {
				if text := strings.TrimSpace(acpTextFromValue(messages[i])); text != "" {
					return text
				}
			}
		}
	}
	return ""
}

func acpUpdateEvents(session Session, turnID string, raw json.RawMessage, normalizer *acpTurnNormalizer) []activityshared.Event {
	var params struct {
		Update map[string]any `json:"update"`
	}
	if err := json.Unmarshal(raw, &params); err != nil || params.Update == nil {
		return nil
	}
	updateType := asString(params.Update["sessionUpdate"])
	switch updateType {
	case "user_message_chunk":
		return nil
	case "agent_message_chunk":
		if events, ok := acpSystemNoticeEvents(session, turnID, params.Update, normalizer, "agent_message_chunk", true); ok {
			return events
		}
		content := acpTextContent(params.Update["content"])
		if content == "" {
			return nil
		}
		if normalizer != nil {
			return normalizer.AppendAssistantChunk(session, turnID, content)
		}
		return nil
	case "agent_thought_chunk":
		if events, ok := acpSystemNoticeEvents(session, turnID, params.Update, normalizer, "agent_thought_chunk", true); ok {
			return events
		}
		content := acpTextContent(params.Update["content"])
		if content == "" || normalizer == nil {
			return nil
		}
		return normalizer.AppendThinkingChunk(session, turnID, content)
	case "tool_call", "tool_call_update":
		if normalizer != nil {
			if events, ok := normalizer.ToolCallEvents(session, turnID, params.Update); ok {
				return events
			}
			return nil
		}
		if event, ok := acpToolCallEvent(session, turnID, params.Update); ok {
			return []activityshared.Event{event}
		}
		return nil
	case "session_info_update":
		if event, ok := acpSessionTitleEvent(session, params.Update); ok {
			return []activityshared.Event{event}
		}
		return nil
	case "config_option_update":
		if event, ok := acpConfigOptionsUpdatedEvent(session, params.Update); ok {
			return []activityshared.Event{event}
		}
		return nil
	case "usage_update":
		if event, ok := acpUsageUpdatedEvent(session); ok {
			return []activityshared.Event{event}
		}
		return nil
	case "stream_error", "warning", "system_notice":
		if events, ok := acpSystemNoticeEvents(session, turnID, params.Update, normalizer, updateType, true); ok {
			return events
		}
		return nil
	case "available_commands_update", "current_mode_update", "plan":
		return nil
	default:
		if updateType == "" {
			return nil
		}
		return nil
	}
}

func codexACPSystemNoticeMessageFromStderr(stderr []byte) (acpMessage, bool) {
	text := strings.TrimSpace(string(stderr))
	if text == "" {
		return acpMessage{}, false
	}
	normalized := strings.ToLower(text)
	if !strings.Contains(normalized, "handled error during turn") {
		return acpMessage{}, false
	}
	if !strings.Contains(normalized, "responsestreamdisconnected") &&
		!strings.Contains(normalized, "broken pipe") &&
		!strings.Contains(normalized, "response stream") {
		return acpMessage{}, false
	}
	detail := truncateACPLogValue(text, 4000)
	params, err := json.Marshal(map[string]any{
		"update": map[string]any{
			"kind":              "agent_system_notice",
			"sessionUpdate":     "stream_error",
			"message":           "ResponseStreamDisconnected",
			"noticeKind":        "transport_retry",
			"severity":          "warning",
			"title":             "Codex connection interrupted. Reconnecting...",
			"detail":            detail,
			"additionalDetails": detail,
			"retryable":         true,
			"source":            "acp_stderr",
		},
	})
	if err != nil {
		return acpMessage{}, false
	}
	return acpMessage{
		JSONRPC: "2.0",
		Method:  acpMethodUpdate,
		Params:  params,
	}, true
}

func acpSystemNoticeEvents(session Session, turnID string, update map[string]any, _ *acpTurnNormalizer, fallbackKind string, allowSyntheticNotice bool) ([]activityshared.Event, bool) {
	event, ok := acpSystemNoticeEvent(session, turnID, update, fallbackKind, allowSyntheticNotice)
	if !ok {
		return nil, false
	}
	return []activityshared.Event{event}, true
}

func acpFailureMetadata(err error) map[string]any {
	if err == nil {
		return nil
	}
	payload := map[string]any{
		"error": err.Error(),
	}
	var callErr *acpCallError
	if !errors.As(err, &callErr) {
		return payload
	}
	payload["acpErrorCode"] = callErr.Err.Code
	if message := strings.TrimSpace(callErr.Err.Message); message != "" {
		payload["acpErrorMessage"] = message
	}
	data := acpErrorDataPayload(callErr.Err.Data)
	if message := strings.TrimSpace(asString(data["message"])); message != "" {
		payload["error"] = message
		payload["errorMessage"] = message
	}
	if codexErrorInfo := firstNonEmpty(asString(data["codex_error_info"]), asString(data["codexErrorInfo"])); codexErrorInfo != "" {
		payload["codexErrorInfo"] = codexErrorInfo
	}
	return payload
}

func acpErrorDataPayload(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil
	}
	return payload
}

func acpSystemNoticeEvent(session Session, turnID string, update map[string]any, fallbackKind string, allowSyntheticNotice bool) (activityshared.Event, bool) {
	notice := acpSystemNoticePayload(update)
	updateType := asString(update["sessionUpdate"])
	if len(notice) == 0 {
		if !allowSyntheticNotice {
			return activityshared.Event{}, false
		}
		switch updateType {
		case "stream_error", "warning", "system_notice":
			notice = map[string]any{}
		default:
			if textNotice, ok := acpSystemNoticeFromAgentText(acpTextContent(update["content"])); ok {
				notice = textNotice
			} else {
				return activityshared.Event{}, false
			}
		}
	}
	payload := map[string]any{
		"kind": "agent_system_notice",
		"acp": map[string]any{
			"sessionUpdate": firstNonEmpty(updateType, fallbackKind),
		},
	}
	copyStringPayload(payload, notice, "noticeKind")
	copyStringPayload(payload, notice, "severity")
	copyStringPayload(payload, notice, "source")
	copyStringPayload(payload, notice, "title")
	copyStringPayload(payload, notice, "detail")
	copyBoolPayload(payload, notice, "retryable")
	if extra := clonePayloadValue(notice["extra"]); extra != nil {
		payload["extra"] = extra
	}
	if codexErrorInfo := clonePayloadValue(firstPresentAny(notice["codexErrorInfo"], notice["codex_error_info"], update["codexErrorInfo"], update["codex_error_info"])); codexErrorInfo != nil {
		payload["codexErrorInfo"] = codexErrorInfo
	}
	if additionalDetails := firstNonEmpty(asString(notice["additionalDetails"]), asString(notice["additional_details"]), asString(update["additionalDetails"]), asString(update["additional_details"])); additionalDetails != "" {
		payload["additionalDetails"] = additionalDetails
	}
	noticeKind := firstNonEmpty(asString(payload["noticeKind"]), acpNoticeKindFromUpdate(firstNonEmpty(updateType, fallbackKind)))
	severity := firstNonEmpty(asString(payload["severity"]), acpNoticeSeverity(noticeKind))
	detail := firstNonEmpty(asString(payload["detail"]), acpTextContent(update["content"]), asString(update["text"]), asString(payload["additionalDetails"]), asString(update["message"]))
	title := firstNonEmpty(asString(payload["title"]), acpNoticeTitle(noticeKind, detail))
	payload["noticeKind"] = noticeKind
	payload["severity"] = severity
	payload["title"] = title
	if detail != "" {
		payload["detail"] = detail
	}
	payload["content"] = title
	payload["text"] = title
	return newTurnActivityEvent(session, EventMessage, turnID, messageStreamStateCompleted, RoleAssistant, title, payload), true
}

func acpSystemNoticePayload(update map[string]any) map[string]any {
	if asString(update["kind"]) == "agent_system_notice" {
		return update
	}
	meta, _ := update["_meta"].(map[string]any)
	if meta == nil {
		return nil
	}
	if tsh, ok := meta["tsh"].(map[string]any); ok && asString(tsh["kind"]) == "agent_system_notice" {
		return tsh
	}
	if asString(meta["kind"]) == "agent_system_notice" {
		return meta
	}
	return nil
}

func acpSystemNoticeFromAgentText(text string) (map[string]any, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, false
	}
	normalized := strings.ToLower(text)
	if acpAgentTextLooksLikeTransportRetry(normalized) {
		return map[string]any{
			"kind":       "agent_system_notice",
			"noticeKind": "transport_retry",
			"severity":   "warning",
			"title":      "Codex connection interrupted. Reconnecting...",
			"detail":     text,
			"retryable":  true,
			"source":     "agent_text",
		}, true
	}
	if strings.Contains(normalized, "falling back from websockets to https transport") ||
		strings.Contains(normalized, "switched to https transport") {
		return map[string]any{
			"kind":       "agent_system_notice",
			"noticeKind": "transport_fallback",
			"severity":   "warning",
			"title":      "Codex switched to HTTPS transport.",
			"detail":     text,
			"source":     "agent_message_chunk",
		}, true
	}
	return nil, false
}

func acpAgentTextLooksLikeTransportRetry(normalized string) bool {
	if !strings.Contains(normalized, "reconnecting") {
		return false
	}
	if strings.Contains(normalized, "responsestreamdisconnected") ||
		strings.Contains(normalized, "broken pipe") ||
		strings.Contains(normalized, "handled error during turn") ||
		strings.Contains(normalized, "response stream") ||
		strings.Contains(normalized, "websocket") {
		return true
	}
	return strings.Contains(normalized, "/5") || strings.Contains(normalized, "/ 5")
}

func copyStringPayload(payload map[string]any, source map[string]any, key string) {
	if value := asString(source[key]); value != "" {
		payload[key] = value
	}
}

func copyBoolPayload(payload map[string]any, source map[string]any, key string) {
	if value, ok := source[key].(bool); ok {
		payload[key] = value
	}
}

func firstPresentAny(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func acpNoticeKindFromUpdate(updateType string) string {
	switch strings.TrimSpace(updateType) {
	case "stream_error":
		return "transport_retry"
	case "warning":
		return "warning"
	default:
		return "system_notice"
	}
}

func acpNoticeSeverity(noticeKind string) string {
	switch strings.TrimSpace(noticeKind) {
	case "transport_retry", "transport_fallback", "warning":
		return "warning"
	default:
		return "info"
	}
}

func acpNoticeTitle(noticeKind string, detail string) string {
	switch strings.TrimSpace(noticeKind) {
	case "transport_retry":
		return "Codex connection interrupted. Reconnecting..."
	case "transport_fallback":
		return "Codex switched to HTTPS transport."
	case "warning":
		return firstNonEmpty(detail, "Codex warning")
	default:
		return firstNonEmpty(detail, "Agent notice")
	}
}

func acpSessionTitleEvent(session Session, update map[string]any) (activityshared.Event, bool) {
	title := titletext.Normalize(firstNonEmpty(
		asString(update["title"]),
		asString(update["name"]),
		asString(update["summary"]),
	))
	if title == "" || title == strings.TrimSpace(session.Title) {
		return activityshared.Event{}, false
	}
	return newSessionTitleActivityEvent(session, title), true
}

func acpConfigOptionsUpdatedEvent(session Session, update map[string]any) (activityshared.Event, bool) {
	ctx, ok := activityEventContext(session, newID(), "")
	if !ok {
		return activityshared.Event{}, false
	}
	event := activityshared.NewSessionUpdated(ctx, "")
	metadata := map[string]any{
		"acpSessionUpdate": "config_option_update",
	}
	if key := asString(update["key"]); key != "" {
		metadata["configOptionKey"] = key
	}
	event.Payload.Metadata = metadata
	return event, true
}

func acpUsageUpdatedEvent(session Session) (activityshared.Event, bool) {
	ctx, ok := activityEventContext(session, newID(), "")
	if !ok {
		return activityshared.Event{}, false
	}
	event := activityshared.NewSessionUpdated(ctx, "")
	event.Payload.Metadata = map[string]any{
		"acpSessionUpdate": "usage_update",
	}
	return event, true
}

func newSessionTitleActivityEvent(session Session, title string) activityshared.Event {
	ctx, ok := activityEventContext(session, newID(), "")
	if !ok {
		return activityshared.Event{}
	}
	ctx.Title = titletext.Normalize(title)
	return activityshared.NewSessionTitleUpdated(ctx)
}

func fallbackACPFamilySessionTitle(currentTitle string, prompt string, fallbackTitles ...string) string {
	if !shouldUseFallbackACPTitle(currentTitle, fallbackTitles...) {
		return ""
	}
	return promptTitleSnippet(prompt)
}

func shouldUseFallbackACPTitle(title string, fallbackTitles ...string) bool {
	normalizedTitle := strings.ToLower(strings.TrimSpace(title))
	for _, fallbackTitle := range fallbackTitles {
		if normalizedTitle == strings.ToLower(strings.TrimSpace(fallbackTitle)) {
			return true
		}
	}
	return false
}

func promptTitleSnippet(prompt string) string {
	fields := strings.Fields(titletext.Normalize(prompt))
	if len(fields) == 0 {
		return ""
	}
	title := strings.Join(fields, " ")
	const maxRunes = 48
	runes := []rune(title)
	if len(runes) <= maxRunes {
		return title
	}
	return strings.TrimSpace(string(runes[:maxRunes])) + "..."
}

func acpToolCallEvent(session Session, turnID string, update map[string]any) (activityshared.Event, bool) {
	return acpToolCallEventWithID(session, newID(), turnID, update)
}

func acpToolCallEventWithID(session Session, eventID string, turnID string, update map[string]any) (activityshared.Event, bool) {
	callID := firstNonEmpty(asString(update["toolCallId"]), asString(update["id"]))
	name := firstNonEmpty(asString(update["title"]), asString(update["name"]), callID, "tool")
	kind := asString(update["kind"])
	status := acpResolvedToolCallStatus(update, string(activityshared.ActivityStatusRunning))
	rawInput := acpToolCallRawInput(update)
	rawOutput := acpToolCallRawOutput(update)
	locations := clonePayloadValue(update["locations"])
	content := acpSanitizeImagePayload(update["content"])
	toolName := acpToolName(callID, name, kind, rawInput)
	eventType := EventCallStarted
	callBody := acpNormalizeToolInput(rawInput, kind, locations)
	switch normalizedCallStatus(status) {
	case messageStreamStateCompleted:
		eventType = EventCallCompleted
		callBody = acpNormalizeToolOutput(rawOutput, content)
	case messageStreamStateFailed:
		eventType = EventCallFailed
		callBody = acpNormalizeToolOutput(rawOutput, content)
	default:
		status = string(activityshared.ActivityStatusRunning)
	}
	payload := map[string]any{
		"callId":   callID,
		"callType": "tool",
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
	if len(callBody) > 0 {
		switch eventType {
		case EventCallCompleted:
			payload["output"] = callBody
		case EventCallFailed:
			payload["error"] = callBody
			if mirroredOutput := acpMirrorFailedToolOutput(callBody); len(mirroredOutput) > 0 {
				payload["output"] = mirroredOutput
			}
		default:
			payload["input"] = callBody
		}
	}
	logACPToolCallDiagnostic(session, turnID, update, payload)
	return newTurnActivityEventWithID(session, eventID, eventType, turnID, status, "", name, payload), true
}

func acpToolCallRawInput(update map[string]any) any {
	if rawInput, ok := update["rawInput"]; ok {
		return clonePayloadValue(rawInput)
	}
	if input, ok := update["input"]; ok {
		return clonePayloadValue(input)
	}
	return nil
}

func acpToolCallRawOutput(update map[string]any) any {
	if rawOutput, ok := update["rawOutput"]; ok {
		return clonePayloadValue(rawOutput)
	}
	if output, ok := update["output"]; ok {
		return clonePayloadValue(output)
	}
	return nil
}

func acpToolName(callID string, title string, kind string, rawInput any) string {
	input, _ := rawInput.(map[string]any)
	normalizedCallID := strings.ToLower(strings.TrimSpace(callID))
	normalizedKind := strings.ToLower(strings.TrimSpace(kind))
	trimmedTitle := strings.TrimSpace(title)
	normalizedTitle := strings.ToLower(trimmedTitle)
	if syntheticToolName := acpSyntheticToolName(normalizedTitle); syntheticToolName != "" {
		return syntheticToolName
	}
	if strings.HasPrefix(normalizedCallID, "web_search_") {
		return "WebSearch"
	}
	if input != nil {
		if strings.TrimSpace(asString(input["cmd"])) != "" || acpExtractShellCommand(input["command"]) != "" {
			return "Bash"
		}
	}
	if fetchToolName := acpFetchToolName(input); fetchToolName != "" {
		return fetchToolName
	}
	if strings.HasPrefix(normalizedTitle, "searching for:") {
		return "WebSearch"
	}
	switch normalizedKind {
	case "think":
		if normalizedTitle == "update_todo" || input != nil && input["todos"] != nil {
			return "TodoWrite"
		}
		return "Think"
	case "read":
		if input != nil && strings.TrimSpace(asString(input["pattern"])) != "" {
			return "Glob"
		}
		return "Read"
	case "search":
		switch normalizedTitle {
		case "glob", "find", "fd", "file_search":
			return "Glob"
		case "grep", "rg", "ripgrep", "codebase_search":
			return "Grep"
		default:
			return "Bash"
		}
	case "other":
		switch normalizedTitle {
		case "task":
			return "Agent"
		case "agent":
			return "Agent"
		case "rg", "ripgrep":
			return "Grep"
		case "find", "fd":
			return "Glob"
		}
	case "edit":
	case "move":
		return "Edit"
	case "delete":
		return "Write"
	case "execute":
		if input != nil {
			if strings.TrimSpace(asString(input["agentName"])) != "" {
				return "Agent"
			}
			if strings.TrimSpace(asString(input["task"])) != "" {
				return "Agent"
			}
		}
		return "Bash"
	case "fetch":
		return "WebFetch"
	}
	switch normalizedTitle {
	case "run_subagent":
		return "Agent"
	case "grep_search", "codebase_search":
		return "Grep"
	case "file_search":
		return "Glob"
	case "create_file", "create_new_file", "write_file", "write_to_file":
		return "Write"
	case "insert_text", "replace_in_file", "edit_file":
		return "Edit"
	case "read_file", "list_dir":
		return "Read"
	}
	if trimmedTitle != "" {
		return trimmedTitle
	}
	return "Tool"
}

func acpSyntheticToolName(normalizedTitle string) string {
	switch normalizedTitle {
	case "enterplanmode":
		return "EnterPlanMode"
	case "exitplanmode":
		return "ExitPlanMode"
	case "askuserquestion":
		return "AskUserQuestion"
	case "toolsearch":
		return "ToolSearch"
	case "skill":
		return "Skill"
	default:
		return ""
	}
}

func acpFetchToolName(input map[string]any) string {
	if input == nil {
		return ""
	}
	action, _ := input["action"].(map[string]any)
	actionType := strings.ToLower(strings.TrimSpace(asString(action["type"])))
	switch actionType {
	case "search", "search_query", "web_search":
		return "WebSearch"
	case "open_page", "open", "fetch", "web_fetch":
		return "WebFetch"
	}
	if firstNonEmpty(asString(action["url"]), asString(input["url"])) != "" {
		return "WebFetch"
	}
	if firstNonEmpty(
		asString(action["query"]),
		asString(input["query"]),
		asString(input["search_query"]),
		asString(input["searchQuery"]),
	) != "" {
		return "WebSearch"
	}
	return ""
}

func acpNormalizeToolInput(rawInput any, kind string, locations any) map[string]any {
	body := acpMapFromValue(rawInput, "rawInput")
	if len(body) == 0 {
		return nil
	}
	if command := acpExtractShellCommand(firstNonEmptyShellCommand(body["command"], body["cmd"])); command != "" {
		body["command"] = command
		delete(body, "cmd")
	}
	if cwd := strings.TrimSpace(asString(body["cwd"])); cwd == "" {
		delete(body, "cwd")
	}
	locationList := acpLocationList(locations)
	normalizedKind := strings.ToLower(strings.TrimSpace(kind))
	switch normalizedKind {
	case "read":
		if path := acpFirstLocationPath(locationList); path != "" {
			body["file_path"] = path
		}
	case "edit", "delete", "move":
		if path := acpFirstLocationPath(locationList); path != "" {
			body["file_path"] = path
		}
	case "execute":
		if task := strings.TrimSpace(asString(body["task"])); task != "" {
			body["prompt"] = task
			body["description"] = task
		}
		if agentName := strings.TrimSpace(asString(body["agentName"])); agentName != "" {
			body["subagent_type"] = agentName
		}
	case "fetch":
		action, _ := body["action"].(map[string]any)
		actionType := strings.ToLower(strings.TrimSpace(asString(action["type"])))
		switch actionType {
		case "search", "search_query", "web_search":
			if query := firstNonEmpty(
				asString(action["query"]),
				asString(body["query"]),
				asString(body["search_query"]),
				asString(body["searchQuery"]),
			); query != "" {
				body["query"] = query
			}
		case "open_page", "open", "fetch", "web_fetch":
			if url := firstNonEmpty(asString(action["url"]), asString(body["url"])); url != "" {
				body["url"] = url
			}
		}
	case "think":
		if todos := acpNormalizeTodos(body["todos"]); len(todos) > 0 {
			body["todos"] = todos
		}
	}
	return acpSanitizeImagePayloadMap(body)
}

func firstNonEmptyShellCommand(values ...any) any {
	for _, value := range values {
		if acpExtractShellCommand(value) != "" {
			return value
		}
	}
	return nil
}

func acpNormalizeToolOutput(rawOutput any, content any) map[string]any {
	body := acpMapFromValue(rawOutput, "output")
	if len(body) == 0 && content == nil {
		return nil
	}
	if body == nil {
		body = map[string]any{}
	}
	body = acpSanitizeImagePayloadMap(body)
	if content != nil {
		sanitizedContent := acpSanitizeImagePayload(content)
		body["content"] = sanitizedContent
		if stdout := strings.TrimSpace(asString(body["stdout"])); stdout == "" {
			if text := acpContentText(sanitizedContent); text != "" {
				body["stdout"] = text
			}
		}
		acpApplyDiffContent(body, sanitizedContent)
	}
	return body
}

func acpSanitizeImagePayloadMap(value map[string]any) map[string]any {
	sanitized, _ := acpSanitizeImagePayload(value).(map[string]any)
	return sanitized
}

func acpSanitizeImagePayload(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		sanitized := make(map[string]any, len(typed))
		imageLike := acpLooksLikeImagePayload(typed)
		for key, entry := range typed {
			normalizedKey := strings.ToLower(strings.TrimSpace(key))
			if imageLike && normalizedKey == "data" {
				continue
			}
			if imageLike && (normalizedKey == "uri" || normalizedKey == "path") {
				if text, ok := entry.(string); ok && strings.HasPrefix(strings.ToLower(strings.TrimSpace(text)), "data:image/") {
					continue
				}
			}
			sanitized[key] = acpSanitizeImagePayload(entry)
		}
		return sanitized
	case []any:
		sanitized := make([]any, len(typed))
		for index, entry := range typed {
			sanitized[index] = acpSanitizeImagePayload(entry)
		}
		return sanitized
	default:
		return clonePayloadValue(value)
	}
}

func acpLooksLikeImagePayload(value map[string]any) bool {
	normalizedType := strings.ToLower(strings.TrimSpace(asString(value["type"])))
	normalizedMimeType := strings.ToLower(strings.TrimSpace(asString(value["mimeType"])))
	uri := strings.TrimSpace(firstNonEmpty(asString(value["uri"]), asString(value["path"])))
	_, hasData := value["data"]
	return normalizedType == "image" || strings.HasPrefix(normalizedMimeType, "image/") || (uri != "" && hasData)
}

func acpMirrorFailedToolOutput(body map[string]any) map[string]any {
	if len(body) == 0 {
		return nil
	}
	mirrored := map[string]any{}
	for _, key := range []string{"stdout", "stderr", "aggregated_output", "formatted_output", "content", "changes", "status", "call_id", "turn_id", "cwd", "parsed_cmd", "command", "exit_code", "duration", "duration_ms", "completed_at_ms", "source", "process_id"} {
		if value, ok := body[key]; ok && value != nil {
			mirrored[key] = clonePayloadValue(value)
		}
	}
	if len(mirrored) == 0 {
		return nil
	}
	return mirrored
}

func acpMapFromValue(value any, scalarKey string) map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		return clonePayloadDeep(typed)
	case nil:
		return nil
	default:
		return map[string]any{scalarKey: clonePayloadValue(value)}
	}
}

func acpExtractShellCommand(command any) string {
	switch typed := command.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []any:
		for index := len(typed) - 1; index >= 0; index-- {
			if candidate := strings.TrimSpace(asString(typed[index])); candidate != "" {
				return candidate
			}
		}
	}
	return ""
}

func acpLocationList(value any) []map[string]any {
	items, _ := value.([]any)
	if len(items) == 0 {
		return nil
	}
	locations := make([]map[string]any, 0, len(items))
	for _, item := range items {
		location, _ := item.(map[string]any)
		if len(location) == 0 {
			continue
		}
		locations = append(locations, location)
	}
	return locations
}

func acpFirstLocationPath(locations []map[string]any) string {
	if len(locations) == 0 {
		return ""
	}
	return strings.TrimSpace(asString(locations[0]["path"]))
}

func acpNormalizeTodos(value any) []map[string]any {
	switch typed := value.(type) {
	case []any:
		out := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			todo, _ := item.(map[string]any)
			if len(todo) == 0 {
				continue
			}
			out = append(out, clonePayloadDeep(todo))
		}
		return out
	case string:
		lines := strings.Split(typed, "\n")
		out := make([]map[string]any, 0, len(lines))
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "- [") {
				continue
			}
			status := "pending"
			if strings.HasPrefix(strings.ToLower(line), "- [x]") {
				status = "completed"
			}
			content := strings.TrimSpace(line[5:])
			if content == "" {
				continue
			}
			out = append(out, map[string]any{
				"content": content,
				"status":  status,
			})
		}
		return out
	default:
		return nil
	}
}

func acpContentText(value any) string {
	items, _ := value.([]any)
	parts := make([]string, 0, len(items))
	for _, item := range items {
		if text := acpExtractContentText(item); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func acpExtractContentText(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case map[string]any:
		if text := strings.TrimSpace(asString(typed["text"])); text != "" {
			return text
		}
		if content := strings.TrimSpace(asString(typed["content"])); content != "" {
			return content
		}
		if nested, ok := typed["content"].(map[string]any); ok {
			if text := strings.TrimSpace(asString(nested["text"])); text != "" {
				return text
			}
		}
	}
	return ""
}

func acpApplyDiffContent(body map[string]any, value any) {
	items, _ := value.([]any)
	for _, item := range items {
		diff, _ := item.(map[string]any)
		if strings.TrimSpace(asString(diff["type"])) != "diff" {
			continue
		}
		if path := strings.TrimSpace(asString(diff["path"])); path != "" {
			body["filePath"] = path
		}
		if oldText := asString(diff["oldText"]); oldText != "" {
			body["oldString"] = oldText
		}
		if newText := asString(diff["newText"]); newText != "" {
			body["newString"] = newText
		}
		return
	}
}

func acpToolCallDiagnosticEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("TUTTI_ACP_TOOL_DEBUG"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func logACPToolCallDiagnostic(session Session, turnID string, raw map[string]any, normalized map[string]any) {
	if !acpToolCallDiagnosticEnabled() {
		return
	}
	slog.Info(
		"acp tool call normalized",
		"event", "agent_session.acp_tool_call.normalized",
		"room_id", strings.TrimSpace(session.RoomID),
		"agent_session_id", strings.TrimSpace(session.AgentSessionID),
		"turn_id", strings.TrimSpace(turnID),
		"raw", clonePayloadDeep(raw),
		"normalized", clonePayload(normalized),
	)
}

func clonePayloadDeep(payload map[string]any) map[string]any {
	if len(payload) == 0 {
		return nil
	}
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		out[key] = clonePayloadValue(value)
	}
	return out
}

func normalizedCallStatus(status string) string {
	switch canonicalACPStatusToken(status) {
	case "completed", "complete", "success", "succeeded", "ok", "done":
		return messageStreamStateCompleted
	case "failed", "failure", "error", "errored", "canceled", "cancel":
		return messageStreamStateFailed
	default:
		return messageStreamStateStreaming
	}
}

func canonicalACPStatusToken(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "cancelled":
		return SessionStatusCanceled
	default:
		return strings.ToLower(strings.TrimSpace(status))
	}
}

func acpResolvedToolCallStatus(update map[string]any, fallback string) string {
	status := normalizedCallStatus(firstNonEmpty(asString(update["status"]), fallback))
	if status != messageStreamStateStreaming {
		return status
	}
	rawOutput := acpToolCallRawOutput(update)
	if inferred := acpInferTerminalToolStatus(rawOutput); inferred != "" {
		return inferred
	}
	if inferred := acpInferImageGenerationTerminalStatus(update, rawOutput); inferred != "" {
		return inferred
	}
	return status
}

func acpInferTerminalToolStatus(rawOutput any) string {
	body := acpMapFromValue(rawOutput, "output")
	if len(body) == 0 {
		return ""
	}
	if status := normalizedCallStatus(asString(body["status"])); status != messageStreamStateStreaming {
		return status
	}
	if status := normalizedCallStatus(asString(body["state"])); status != messageStreamStateStreaming {
		return status
	}
	if exitCode, ok := acpIntFromValue(body["exitCode"]); ok {
		if exitCode == 0 {
			return messageStreamStateCompleted
		}
		return messageStreamStateFailed
	}
	if exitCode, ok := acpIntFromValue(body["exit_code"]); ok {
		if exitCode == 0 {
			return messageStreamStateCompleted
		}
		return messageStreamStateFailed
	}
	if exitCode, ok := acpExitCodeFromText(body["output"]); ok {
		if exitCode == 0 {
			return messageStreamStateCompleted
		}
		return messageStreamStateFailed
	}
	return ""
}

func acpInferImageGenerationTerminalStatus(update map[string]any, rawOutput any) string {
	if !acpToolCallLooksLikeImageGeneration(update) {
		return ""
	}
	if acpContainsImageContent(update["content"]) {
		return messageStreamStateCompleted
	}
	if strings.TrimSpace(firstNonEmpty(
		asString(update["saved_path"]),
		asString(update["savedPath"]),
		asString(update["result"]),
	)) != "" {
		return messageStreamStateCompleted
	}
	body := acpMapFromValue(rawOutput, "output")
	if len(body) == 0 {
		return ""
	}
	if strings.TrimSpace(firstNonEmpty(
		asString(body["saved_path"]),
		asString(body["savedPath"]),
		asString(body["result"]),
	)) != "" {
		return messageStreamStateCompleted
	}
	return ""
}

func acpToolCallLooksLikeImageGeneration(update map[string]any) bool {
	for _, candidate := range []string{
		asString(update["toolName"]),
		asString(update["title"]),
		asString(update["name"]),
		asString(update["toolCallId"]),
		asString(update["id"]),
	} {
		normalized := strings.ToLower(strings.TrimSpace(candidate))
		if strings.HasPrefix(normalized, "ig_") {
			return true
		}
		if toolName := acpCanonicalImageGenerationToolName(candidate, update["content"]); toolName != "" {
			return true
		}
	}
	return false
}

func acpIntFromValue(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case int32:
		return int(typed), true
	case int64:
		return int(typed), true
	case float64:
		return int(typed), true
	case json.Number:
		n, err := typed.Int64()
		if err != nil {
			return 0, false
		}
		return int(n), true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(typed))
		if err != nil {
			return 0, false
		}
		return n, true
	default:
		return 0, false
	}
}

func acpExitCodeFromText(value any) (int, bool) {
	text := strings.TrimSpace(asString(value))
	if text == "" {
		return 0, false
	}
	lower := strings.ToLower(text)
	if !strings.HasPrefix(lower, "exit code ") {
		return 0, false
	}
	return acpIntFromValue(strings.TrimSpace(text[len("Exit code "):]))
}

func (a *CodexAdapter) acpPermissionRequested(session Session, turnID string, rawRequestID json.RawMessage, raw json.RawMessage) ([]activityshared.Event, *pendingACPRequest, error) {
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
	title := firstNonEmpty(asString(params.ToolCall["title"]), asString(params.ToolCall["toolCallId"]), "Permission requested")
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
	pending := &pendingACPRequest{
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
	a.storePendingRequest(pending)
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

func (p *pendingACPRequest) wait(ctx context.Context) (pendingACPResponse, error) {
	if p == nil {
		return pendingACPResponse{}, errors.New("permission request is not live")
	}
	select {
	case <-ctx.Done():
		return pendingACPResponse{}, ctx.Err()
	case selection := <-p.response:
		if selection.err != nil {
			return pendingACPResponse{}, selection.err
		}
		return selection, nil
	}
}

func (p *pendingACPRequest) reject(err error) {
	if p == nil {
		return
	}
	if err == nil {
		err = errPermissionRequestCanceled
	}
	select {
	case p.response <- pendingACPResponse{err: err}:
	default:
	}
}

func cloneOptionMaps(in []map[string]any) []map[string]any {
	if len(in) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(in))
	for _, item := range in {
		out = append(out, clonePayload(item))
	}
	return out
}

func (p *pendingACPRequest) hasOption(optionID string) bool {
	optionID = strings.TrimSpace(optionID)
	if p == nil || optionID == "" {
		return false
	}
	for _, option := range p.options {
		if firstNonEmpty(asString(option["optionId"]), asString(option["id"])) == optionID {
			return true
		}
	}
	return false
}

func (p *pendingACPRequest) resolvePermissionOptionID(optionID string) (string, bool) {
	optionID = strings.TrimSpace(optionID)
	if p == nil || optionID == "" {
		return "", false
	}
	if p.hasOption(optionID) {
		return optionID, true
	}
	decision := permissionOptionDecision(optionID)
	if decision == "" {
		return "", false
	}
	aliases := permissionOptionDecisionAliases(decision)
	for _, option := range p.options {
		resolvedOptionID := firstNonEmpty(asString(option["optionId"]), asString(option["id"]))
		if resolvedOptionID == "" {
			continue
		}
		for _, value := range []string{
			resolvedOptionID,
			asString(option["kind"]),
			asString(option["name"]),
			asString(option["label"]),
		} {
			token := normalizePermissionOptionToken(value)
			if token == "" {
				continue
			}
			for _, alias := range aliases {
				if token == alias {
					return resolvedOptionID, true
				}
			}
		}
	}
	return "", false
}

func permissionOptionDecision(value string) string {
	switch normalizePermissionOptionToken(value) {
	case "approve", "approved", "allow", "allowed", "allowonce", "accept", "accepted", "acceptedits", "confirm", "confirmed", "ok", "proceed", "yes":
		return "approved"
	case "deny", "denied", "disallow", "reject", "rejected", "rejectonce", "decline", "declined", "no":
		return "denied"
	default:
		return ""
	}
}

func permissionOptionDecisionAliases(decision string) []string {
	switch decision {
	case "approved":
		return []string{"approve", "approved", "allow", "allowed", "allowonce", "accept", "accepted", "acceptedits", "confirm", "confirmed", "ok", "proceed", "yes"}
	case "denied":
		return []string{"deny", "denied", "disallow", "reject", "rejected", "rejectonce", "decline", "declined", "no"}
	default:
		return nil
	}
}

func normalizePermissionOptionToken(value string) string {
	var builder strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(value)) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func acpPermissionResponseResult(optionID string) map[string]any {
	return map[string]any{
		"outcome": map[string]any{
			"outcome":  "selected",
			"optionId": strings.TrimSpace(optionID),
		},
	}
}

func acpInteractiveResponseResult(action string, optionID string, payload map[string]any) map[string]any {
	outcome := map[string]any{
		"outcome": firstNonEmpty(strings.TrimSpace(action), "submitted"),
	}
	if optionID = strings.TrimSpace(optionID); optionID != "" {
		outcome["optionId"] = optionID
	}
	if payload = clonePayload(payload); payload != nil {
		outcome["payload"] = payload
	}
	return map[string]any{"outcome": outcome}
}

func acpPermissionResolvedEvents(session Session, turnID string, pending *pendingACPRequest, response pendingACPResponse, err error) []activityshared.Event {
	if pending == nil {
		return nil
	}
	callType := firstNonEmpty(strings.TrimSpace(pending.callType), "approval")
	if err != nil {
		return []activityshared.Event{newTurnActivityEventWithID(session, pending.eventID, EventCallFailed, turnID, messageStreamStateFailed, "", pending.name, map[string]any{
			"callId":   pending.callID,
			"callType": callType,
			"name":     pending.name,
			"toolName": pending.toolName,
			"status":   messageStreamStateFailed,
			"error": map[string]any{
				"requestId": pending.requestID,
				"message":   err.Error(),
			},
		})}
	}
	return []activityshared.Event{
		newTurnActivityEventWithID(session, pending.eventID, EventCallCompleted, turnID, messageStreamStateCompleted, "", pending.name, map[string]any{
			"callId":   pending.callID,
			"callType": callType,
			"name":     pending.name,
			"toolName": pending.toolName,
			"status":   messageStreamStateCompleted,
			"output":   pending.resolvedOutput(response),
		}),
		newTurnActivityEvent(session, EventTurnUpdated, turnID, SessionStatusWorking, "", "", map[string]any{
			"phase":     string(activityshared.TurnPhaseWorking),
			"requestId": pending.requestID,
		}),
	}
}

func (p *pendingACPRequest) snapshotPrompt() *SessionInteractivePrompt {
	if p == nil {
		return nil
	}
	if p.prompt != nil {
		prompt := *p.prompt
		prompt.RequestID = firstNonEmpty(strings.TrimSpace(prompt.RequestID), p.requestID)
		prompt.ToolName = firstNonEmpty(strings.TrimSpace(prompt.ToolName), p.toolName, p.name)
		prompt.Status = firstNonEmpty(strings.TrimSpace(prompt.Status), SessionStatusWaiting)
		prompt.Input = clonePayload(prompt.Input)
		prompt.Output = clonePayload(prompt.Output)
		prompt.Error = clonePayload(prompt.Error)
		prompt.Metadata = clonePayload(prompt.Metadata)
		return &prompt
	}
	return &SessionInteractivePrompt{
		Kind:      "approval",
		RequestID: p.requestID,
		ToolName:  p.name,
		Status:    SessionStatusWaiting,
		Input:     p.snapshotApprovalInput(),
		Metadata: map[string]any{
			"callType": "approval",
			"toolName": firstNonEmpty(strings.TrimSpace(p.toolName), p.name),
		},
	}
}

func (p *pendingACPRequest) resolvedOutput(response pendingACPResponse) map[string]any {
	output := map[string]any{
		"requestId": p.requestID,
	}
	if p.callType == "interactive" {
		if response.action != "" {
			output["action"] = response.action
		}
		if response.optionID != "" {
			output["selectedId"] = strings.TrimSpace(response.optionID)
		}
		if payload := clonePayload(response.payload); payload != nil {
			output["payload"] = payload
		}
		return output
	}
	output["selectedId"] = strings.TrimSpace(response.optionID)
	return output
}

func (p *pendingACPRequest) snapshotApprovalInput() map[string]any {
	input := clonePayload(p.input)
	if input == nil {
		input = map[string]any{}
	}
	if _, ok := input["requestId"]; !ok && strings.TrimSpace(p.requestID) != "" {
		input["requestId"] = p.requestID
	}
	if _, ok := input["callId"]; !ok && strings.TrimSpace(p.callID) != "" {
		input["callId"] = p.callID
	}
	if _, ok := input["options"]; !ok {
		input["options"] = cloneOptionMaps(p.options)
	}
	return input
}

func acpInteractivePrompt(toolCall map[string]any, options []map[string]any, requestID string) *SessionInteractivePrompt {
	toolName := acpInteractiveToolName(toolCall)
	switch toolName {
	case "AskUserQuestion":
		input := clonePayload(payloadObject(toolCall["input"]))
		if input == nil {
			input = map[string]any{}
		}
		if _, ok := input["questions"]; !ok {
			if questions := payloadArray(toolCall["questions"]); len(questions) > 0 {
				input["questions"] = questions
			}
		}
		return &SessionInteractivePrompt{
			Kind:      "ask-user",
			RequestID: requestID,
			ToolName:  toolName,
			Status:    "waiting_input",
			Input:     input,
			Metadata: map[string]any{
				"callType":        "interactive",
				"interactiveKind": "ask-user",
				"toolName":        toolName,
				"options":         cloneOptionMaps(options),
			},
		}
	case "ExitPlanMode":
		input := clonePayload(payloadObject(toolCall["input"]))
		if input == nil {
			input = map[string]any{}
		}
		return &SessionInteractivePrompt{
			Kind:      "exit-plan",
			RequestID: requestID,
			ToolName:  toolName,
			Status:    "waiting_input",
			Input:     input,
			Metadata: map[string]any{
				"callType":        "interactive",
				"interactiveKind": "exit-plan",
				"toolName":        toolName,
				"options":         cloneOptionMaps(options),
			},
		}
	default:
		return nil
	}
}

func acpApprovalInput(toolCall map[string]any, options []map[string]any, requestID string) map[string]any {
	input := map[string]any{
		"requestId": requestID,
		"toolCall":  clonePayload(toolCall),
		"options":   cloneOptionMaps(options),
	}
	for key, value := range acpApprovalDisplayInput(toolCall) {
		if _, exists := input[key]; !exists {
			input[key] = clonePayloadValue(value)
		}
	}
	return input
}

func acpApprovalDisplayInput(toolCall map[string]any) map[string]any {
	if len(toolCall) == 0 {
		return nil
	}
	displayInput := clonePayload(payloadObject(toolCall["input"]))
	if displayInput == nil {
		displayInput = clonePayload(payloadObject(toolCall["rawInput"]))
	}
	if displayInput == nil {
		displayInput = clonePayload(payloadObject(toolCall["raw_input"]))
	}
	if displayInput == nil {
		displayInput = clonePayload(payloadObject(toolCall["arguments"]))
	}
	if displayInput == nil {
		displayInput = clonePayload(payloadObject(toolCall["args"]))
	}
	if displayInput == nil {
		displayInput = map[string]any{}
	}
	for _, key := range []string{
		"command",
		"cmd",
		"description",
		"file_path",
		"filePath",
		"path",
		"notebook_path",
		"query",
		"search_query",
		"searchQuery",
		"pattern",
		"cwd",
	} {
		if _, exists := displayInput[key]; exists {
			continue
		}
		if value, exists := toolCall[key]; exists {
			displayInput[key] = clonePayloadValue(value)
		}
	}
	if command := acpApprovalDisplayCommand(firstNonEmptyShellCommand(displayInput["command"], displayInput["cmd"])); command != "" {
		displayInput["command"] = command
		delete(displayInput, "cmd")
	}
	if len(displayInput) == 0 {
		return nil
	}
	return displayInput
}

func acpApprovalDisplayCommand(command any) string {
	switch typed := command.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []any:
		if len(typed) >= 3 {
			flag := strings.TrimSpace(asString(typed[len(typed)-2]))
			if flag == "-c" || flag == "-lc" {
				return strings.TrimSpace(asString(typed[len(typed)-1]))
			}
		}
		parts := make([]string, 0, len(typed))
		for _, part := range typed {
			if text := strings.TrimSpace(asString(part)); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, " ")
	default:
		return ""
	}
}

func interactivePromptKind(prompt *SessionInteractivePrompt) string {
	if prompt == nil {
		return ""
	}
	return strings.TrimSpace(prompt.Kind)
}

func acpInteractiveToolName(toolCall map[string]any) string {
	name := firstNonEmpty(
		asString(toolCall["name"]),
		asString(toolCall["toolName"]),
		asString(toolCall["title"]),
	)
	return acpSyntheticToolName(normalizeInteractiveName(name))
}

func normalizeInteractiveName(name string) string {
	return strings.NewReplacer("_", "", "-", "", " ", "").Replace(strings.ToLower(strings.TrimSpace(name)))
}

func payloadObject(value any) map[string]any {
	obj, _ := value.(map[string]any)
	return obj
}

func payloadArray(value any) []map[string]any {
	items, _ := value.([]map[string]any)
	if items != nil {
		return cloneOptionMaps(items)
	}
	if generic, ok := value.([]any); ok {
		out := make([]map[string]any, 0, len(generic))
		for _, item := range generic {
			if obj, ok := item.(map[string]any); ok {
				out = append(out, clonePayload(obj))
			}
		}
		return out
	}
	return nil
}

func acpRequestID(raw json.RawMessage) string {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return strings.TrimSpace(text)
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err == nil {
		return strings.TrimSpace(number.String())
	}
	return strings.TrimSpace(string(raw))
}

func asString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	default:
		return ""
	}
}

func newSessionActivityEvent(session Session, eventType string, status string, metadata map[string]any) activityshared.Event {
	ctx, ok := activityEventContext(session, newID(), "")
	if !ok {
		return activityshared.Event{}
	}
	var event activityshared.Event
	switch eventType {
	case EventSessionStarted:
		event = activityshared.NewSessionStarted(ctx)
	case EventSessionUpdated:
		event = activityshared.NewSessionUpdated(ctx, activityshared.SessionStatus(status))
	case EventSessionCompleted:
		event = activityshared.NewSessionCompleted(ctx)
	case EventSessionFailed:
		event = activityshared.NewSessionFailed(ctx)
	case EventSessionCanceled:
		event = activityshared.NewSessionUpdated(ctx, activityshared.SessionStatusPaused)
	default:
		return activityshared.Event{}
	}
	event.Payload.Metadata = clonePayload(metadata)
	return event
}

func newTurnActivityEvent(session Session, eventType string, turnID string, status string, role string, content string, payload map[string]any) activityshared.Event {
	return newTurnActivityEventWithID(session, newID(), eventType, turnID, status, role, content, payload)
}

func newTurnActivityEventWithID(session Session, eventID string, eventType string, turnID string, status string, role string, content string, payload map[string]any) activityshared.Event {
	ctx, ok := activityEventContext(session, eventID, turnID)
	if !ok {
		return activityshared.Event{}
	}
	switch eventType {
	case EventTurnStarted:
		event := activityshared.NewTurnStarted(ctx, turnID)
		event.Payload.Metadata = clonePayload(payload)
		return event
	case EventTurnUpdated:
		phase := activityshared.TurnPhase(firstNonEmpty(payloadString(payload, "phase"), string(activityshared.TurnPhaseWorking)))
		event := activityshared.NewTurnUpdated(ctx, turnID, phase)
		event.Payload.Metadata = clonePayload(payload)
		return event
	case EventTurnCompleted:
		event := activityshared.NewTurnCompleted(ctx, turnID, activityshared.TurnOutcomeCompleted)
		event.Payload.Metadata = clonePayload(payload)
		return event
	case EventTurnFailed:
		event := activityshared.NewTurnFailed(ctx, turnID)
		event.Payload.Metadata = clonePayload(payload)
		return event
	case EventTurnCanceled:
		event := activityshared.NewTurnCompleted(ctx, turnID, activityshared.TurnOutcomeInterrupted)
		event.Payload.Metadata = clonePayload(payload)
		return event
	case EventMessage:
		messageRole := activityshared.MessageRole(strings.TrimSpace(role))
		if messageRole == "" {
			messageRole = activityshared.MessageRoleAssistant
		}
		if status == "" && messageRole == activityshared.MessageRoleUser {
			status = messageStreamStateCompleted
		}
		event := activityshared.NewMessageAppended(ctx, messageRole, content)
		event.Payload.Metadata = clonePayload(payload)
		if event.Payload.Metadata == nil {
			event.Payload.Metadata = map[string]any{}
		}
		if strings.TrimSpace(payloadString(event.Payload.Metadata, "messageId")) == "" {
			event.Payload.Metadata["messageId"] = eventID
		}
		if strings.TrimSpace(payloadString(event.Payload.Metadata, "contentMode")) == "" {
			event.Payload.Metadata["contentMode"] = messageContentModeSnapshot
		}
		if status != "" {
			event.Payload.Metadata["streamState"] = status
		}
		return event
	case EventCallStarted:
		event := activityshared.NewCallStarted(
			ctx,
			payloadString(payload, "callId"),
			firstNonEmpty(payloadString(payload, "callType"), "tool"),
			payloadString(payload, "name"),
			payloadMap(payload, "input"),
		)
		if status := payloadString(payload, "status"); status != "" {
			event.Payload.Status = status
		}
		event.Payload.Metadata = clonePayload(payload)
		return event
	case EventCallCompleted:
		event := activityshared.NewCallCompleted(
			ctx,
			payloadString(payload, "callId"),
			firstNonEmpty(payloadString(payload, "callType"), "tool"),
			payloadString(payload, "name"),
			payloadMap(payload, "output"),
		)
		if status := payloadString(payload, "status"); status != "" {
			event.Payload.Status = status
		}
		event.Payload.Metadata = clonePayload(payload)
		return event
	case EventCallFailed:
		event := activityshared.NewCallFailed(
			ctx,
			payloadString(payload, "callId"),
			firstNonEmpty(payloadString(payload, "callType"), "tool"),
			payloadString(payload, "name"),
			payloadMap(payload, "error"),
		)
		if output := payloadMap(payload, "output"); len(output) > 0 {
			event.Payload.Output = output
		}
		if status := payloadString(payload, "status"); status != "" {
			event.Payload.Status = status
		}
		event.Payload.Metadata = clonePayload(payload)
		return event
	default:
		return activityshared.Event{}
	}
}
