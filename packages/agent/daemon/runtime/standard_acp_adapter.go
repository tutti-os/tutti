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
	"sort"
	"strings"
	"sync"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
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
}

type standardACPAdapter struct {
	config      standardACPConfig
	transport   ProcessTransport
	host        HostMetadata
	mu          sync.Mutex
	sessions    map[string]*standardACPSession
	commandSink CommandSnapshotSink
	eventSink   SessionEventSink
	configSink  ConfigOptionsUpdateSink
}

type standardACPSession struct {
	client            *acpClient
	providerSessionID string
	agentInfo         map[string]any
	promptImage       bool
	acpLiveState
	pendingApprovals map[string]*pendingACPApproval
	recentTurnID     string
	recentTurnExpiry time.Time
}

type pendingACPApproval = pendingACPRequest

const standardACPRecentTurnTTL = 10 * time.Minute

const acpMethodSetConfigOption = "session/set_config_option"
const claudeSystemPromptFileEnv = "TUTTI_CLAUDE_SYSTEM_PROMPT_FILE"
const claudePluginDirEnv = "TUTTI_CLAUDE_PLUGIN_DIR"
const claudeSDKMessageMethod = "_claude/sdkMessage"
const claudePlanModeInstructions = "You are in plan mode. Inspect files and gather context as needed, but do not edit files, run mutation commands, or make external changes. Produce a concrete implementation plan first. If the user gives feedback, refine the plan. Only after the user approves leaving plan mode may you implement changes."

var claudeCodeACPModelAliases = map[string]bool{
	"default":    true,
	"sonnet":     true,
	"opus":       true,
	"haiku":      true,
	"sonnet[1m]": true,
	"opusplan":   true,
}

// claudeCodeLegacyACPModelCandidates lists live ACP model values to try when a
// persisted alias (e.g. "opus") is not directly advertised. Order matters:
// claude-agent-acp 0.46+ exposes Opus as "opus[1m]"; 0.42.x folded Opus into
// "default" and rejected bare "opus".
func claudeCodeLegacyACPModelCandidates(model string) []string {
	switch strings.TrimSpace(model) {
	case "opus", "opusplan":
		return []string{"opus[1m]", "opus", "default"}
	default:
		return nil
	}
}

func NewGeminiAdapter(transport ProcessTransport) *standardACPAdapter {
	return NewGeminiAdapterWithHostMetadata(transport, LegacyHostMetadata())
}

func NewGeminiAdapterWithHostMetadata(transport ProcessTransport, host HostMetadata) *standardACPAdapter {
	return &standardACPAdapter{
		config: standardACPConfig{
			provider:            ProviderGemini,
			adapterName:         "gemini-acp",
			command:             []string{"gemini", "--acp"},
			defaultTitle:        "Gemini CLI",
			authRequiredMessage: "Gemini ACP requires authentication in the runtime VM; ensure Gemini host credentials are synced before starting Agent GUI",
			permissionModeID: func(string) string {
				return "yolo"
			},
			initializeParams: func() map[string]any { return defaultACPInitializeParams(host) },
			env:              func(session Session) []string { return standardACPEnv(session, host) },
			beforeNewSession: geminiACPBeforeNewSession,
		},
		transport: transport,
		host:      host,
		sessions:  make(map[string]*standardACPSession),
	}
}

func NewHermesAdapter(transport ProcessTransport) *standardACPAdapter {
	return NewHermesAdapterWithHostMetadata(transport, LegacyHostMetadata())
}

func NewHermesAdapterWithHostMetadata(transport ProcessTransport, host HostMetadata) *standardACPAdapter {
	return &standardACPAdapter{
		config: standardACPConfig{
			provider:            ProviderHermes,
			adapterName:         "hermes-acp",
			command:             []string{"hermes", "acp"},
			defaultTitle:        "Hermes Agent",
			authRequiredMessage: "Hermes ACP requires authentication in the runtime VM; ensure Hermes host credentials are synced before starting Agent GUI",
			permissionModeID: func(string) string {
				return "yolo"
			},
			initializeParams: func() map[string]any { return defaultACPInitializeParams(host) },
			env:              func(session Session) []string { return standardACPEnv(session, host) },
		},
		transport: transport,
		host:      host,
		sessions:  make(map[string]*standardACPSession),
	}
}

func NewOpenClawAdapter(transport ProcessTransport) *standardACPAdapter {
	return NewOpenClawAdapterWithHostMetadata(transport, LegacyHostMetadata())
}

func NewOpenClawAdapterWithHostMetadata(transport ProcessTransport, host HostMetadata) *standardACPAdapter {
	return &standardACPAdapter{
		config: standardACPConfig{
			provider:            ProviderOpenClaw,
			adapterName:         "openclaw-acp",
			command:             []string{"openclaw", "acp", "-v"},
			defaultTitle:        "OpenClaw",
			authRequiredMessage: "OpenClaw ACP requires authentication in the runtime VM; ensure OpenClaw host credentials are synced before starting Agent GUI",
			permissionModeID: func(string) string {
				// OpenClaw ACP maps session/set_mode modeId -> gateway thinkingLevel.
				// It is not a permission-mode channel, so sending approve-all /
				// approve-reads here is a protocol error.
				return ""
			},
			initializeParams: func() map[string]any { return defaultACPInitializeParams(host) },
			env:              func(session Session) []string { return openclawACPEnv(session, host) },
		},
		transport: transport,
		host:      host,
		sessions:  make(map[string]*standardACPSession),
	}
}

// openclawGatewayChatSessionKey selects the gateway sessionKey hint for OpenClaw GUI ACP.
// Without it, openclaw acp falls back to "acp:<uuid>", which makes the gateway treat the chat as an
// ACP-spawned session and require sessions.json metadata that this desktop flow never writes.
func openclawGatewayChatSessionKey(session Session, host HostMetadata) string {
	prefix := host.OpenClawSessionKeyPrefix
	if strings.TrimSpace(session.AgentSessionID) != "" {
		return fmt.Sprintf("%s%s", prefix, session.AgentSessionID)
	}
	return prefix + "desktop"
}

func (a *standardACPAdapter) applyProviderSessionMeta(params map[string]any, session Session) error {
	if params == nil {
		return nil
	}
	switch a.config.provider {
	case ProviderOpenClaw:
		mergeACPParamsMeta(params, map[string]any{"sessionKey": openclawGatewayChatSessionKey(session, a.host)})
	case ProviderClaudeCode:
		systemPromptPath := sessionEnvValue(session.Env, claudeSystemPromptFileEnv)
		pluginDirPath := sessionEnvValue(session.Env, claudePluginDirEnv)
		systemPrompt, err := claudeSystemPromptAppend(session.Env)
		if err != nil {
			slog.Warn("agent session ACP claude provider meta system prompt failed",
				"event", "agent_session.acp.claude_provider_meta.system_prompt_failed",
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", session.ProviderSessionID,
				"system_prompt_env_present", strings.TrimSpace(systemPromptPath) != "",
				"system_prompt_path", systemPromptPath,
				"error", err.Error(),
			)
			return err
		}
		pluginDir, err := claudePluginDir(session.Env)
		if err != nil {
			slog.Warn("agent session ACP claude provider meta plugin dir failed",
				"event", "agent_session.acp.claude_provider_meta.plugin_dir_failed",
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", session.ProviderSessionID,
				"plugin_dir_env_present", strings.TrimSpace(pluginDirPath) != "",
				"plugin_dir_path", pluginDirPath,
				"error", err.Error(),
			)
			return err
		}
		systemPromptPresent := strings.TrimSpace(systemPrompt) != ""
		if systemPromptPresent {
			mergeACPParamsMeta(params, map[string]any{
				"systemPrompt": map[string]any{
					"type":   "preset",
					"preset": "claude_code",
					"append": systemPrompt,
				},
			})
		}
		claudeOptions := map[string]any{
			"planModeInstructions": claudePlanModeInstructions,
			"disallowedTools":      []string{"Monitor"},
		}
		extraArgs := map[string]string{}
		if pluginDir != "" {
			extraArgs["plugin-dir"] = pluginDir
			claudeOptions["plugins"] = []map[string]string{
				{"type": "local", "path": pluginDir},
			}
		}
		if model := claudeCodeCustomModel(session); model != "" {
			extraArgs["model"] = model
		}
		if len(extraArgs) > 0 {
			claudeOptions["extraArgs"] = extraArgs
		}
		claudeCodeMeta := map[string]any{
			"options": claudeOptions,
		}
		// Capture system/init plus turn `result` messages. acp-agent.js emits the
		// raw SDK message before it inspects it, so an auth rejection it would
		// otherwise collapse into an opaque -32000 (e.g. "Not logged in · Please
		// run /login") is surfaced to us here. `result` is one message per turn,
		// so the overhead is negligible. See logClaudeSDKMessage.
		claudeCodeMeta["emitRawSDKMessages"] = []map[string]string{
			{"type": "system", "subtype": "init"},
			{"type": "result"},
		}
		if len(claudeOptions) > 0 {
			mergeACPParamsMeta(params, map[string]any{
				"claudeCode": claudeCodeMeta,
			})
		}
		slog.Info("agent session ACP claude provider meta prepared",
			"event", "agent_session.acp.claude_provider_meta.prepared",
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"system_prompt_env_present", strings.TrimSpace(systemPromptPath) != "",
			"system_prompt_path", systemPromptPath,
			"system_prompt_present", systemPromptPresent,
			"system_prompt_len", len(systemPrompt),
			"system_prompt_has_tutti_runtime", strings.Contains(systemPrompt, "# Tutti Runtime"),
			"system_prompt_has_claude_mention_routing", strings.Contains(systemPrompt, "Claude Code mention routing"),
			"system_prompt_has_agent_session_skill_routing", strings.Contains(systemPrompt, `Skill(skill="tutti-cli"`),
			"meta_system_prompt_attached", systemPromptPresent,
			"plugin_dir_env_present", strings.TrimSpace(pluginDirPath) != "",
			"plugin_dir_path", pluginDirPath,
			"plugin_dir_present", pluginDir != "",
			"meta_claude_code_attached", len(claudeOptions) > 0,
			"emit_raw_sdk_messages", pluginDir != "",
		)
	}
	return nil
}

func (a *standardACPAdapter) ValidatePromptContent(session Session, content []PromptContentBlock) error {
	if !promptContentHasImage(content) {
		return nil
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
	if strings.TrimSpace(provider) == ProviderClaudeCode {
		// Claude Agent ACP supports image prompt content, but current initialize
		// responses can omit or misreport promptCapabilities.image.
		return true
	}
	return standardACPPromptImageSupported(raw)
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

func claudeSystemPromptAppend(env []string) (string, error) {
	path := sessionEnvValue(env, claudeSystemPromptFileEnv)
	if strings.TrimSpace(path) == "" {
		return "", nil
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read claude system prompt: %w", err)
	}
	return string(content), nil
}

func claudePluginDir(env []string) (string, error) {
	path := sessionEnvValue(env, claudePluginDirEnv)
	if strings.TrimSpace(path) == "" {
		return "", nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("stat claude plugin dir: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("claude plugin dir is not a directory: %s", path)
	}
	return path, nil
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

func claudeCodeACPModeID(mode string) string {
	switch strings.TrimSpace(mode) {
	case "default":
		return "default"
	case "acceptEdits":
		return "acceptEdits"
	case "dontAsk":
		return "dontAsk"
	case "bypassPermissions":
		return "bypassPermissions"
	default:
		return ""
	}
}

func claudeCodeACPCommands() []AgentSessionCommand {
	return []AgentSessionCommand{
		{Name: "review"},
		{Name: "compact"},
	}
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
	}
}

func NewClaudeCodeAdapter(transport ProcessTransport) *standardACPAdapter {
	return NewClaudeCodeAdapterWithHostMetadata(transport, LegacyHostMetadata())
}

func NewClaudeCodeAdapterWithHostMetadata(transport ProcessTransport, host HostMetadata) *standardACPAdapter {
	return newClaudeCodeAdapterWithHostMetadata(transport, host, nil)
}

func newClaudeCodeAdapterWithHostMetadata(
	transport ProcessTransport,
	host HostMetadata,
	commandResolver ProviderCommandResolver,
) *standardACPAdapter {
	return &standardACPAdapter{
		config: standardACPConfig{
			provider:            ProviderClaudeCode,
			adapterName:         "claude-agent-acp",
			command:             []string{"claude-agent-acp"},
			defaultTitle:        "Claude Agent",
			defaultTitleAliases: []string{"Claude Code", ProviderClaudeCode},
			authRequiredMessage: "Claude Agent ACP requires authentication in the runtime VM; sign in to the local Claude Code agent so its credentials can be synced, then retry this session.",
			permissionModeID:    claudeCodeACPModeID,
			initializeParams:    func() map[string]any { return claudeACPInitializeParams(host) },
			failOnSetModeError:  true,
			env:                 func(session Session) []string { return claudeACPEnv(session, host) },
			commandResolver:     commandResolver,
		},
		transport: transport,
		host:      host,
		sessions:  make(map[string]*standardACPSession),
	}
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

func (a *standardACPAdapter) Start(ctx context.Context, session Session) ([]activityshared.Event, error) {
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
	defer func() {
		if !started {
			_ = client.Close()
		}
		if !keepSession {
			a.removeSession(session.AgentSessionID)
		}
	}()
	acpSession := &standardACPSession{
		client:           client,
		agentInfo:        acpAgentInfo(initializeResult),
		promptImage:      standardACPProviderPromptImageSupported(a.config.provider, initializeResult),
		acpLiveState:     standardACPInitialLiveState(a.config.provider),
		pendingApprovals: make(map[string]*pendingACPApproval),
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
		acpLiveState:      standardACPInitialLiveState(a.config.provider),
		pendingApprovals:  make(map[string]*pendingACPApproval),
	}
	if previousSession != nil {
		acpSession.acpLiveState = cloneACPLiveState(previousSession.acpLiveState)
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
	return nil
}

func (*standardACPAdapter) CanResume(session Session) bool {
	return strings.TrimSpace(session.ProviderSessionID) != ""
}

func (a *standardACPAdapter) HasLiveSession(session Session) bool {
	acpSession := a.getSession(session.AgentSessionID)
	return acpSession != nil && acpSession.client != nil
}

func (a *standardACPAdapter) Close(_ context.Context, session Session) error {
	if a == nil || a.transport == nil {
		return nil
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	a.rejectPendingApprovals(agentSessionID, errPermissionRequestCanceled)
	a.mu.Lock()
	acpSession := a.sessions[agentSessionID]
	delete(a.sessions, agentSessionID)
	a.mu.Unlock()
	if acpSession != nil && acpSession.client != nil {
		return acpSession.client.Close()
	}
	return nil
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
	processStartedAt := time.Now()
	a.logHermesStartupDiagnostics("process_start.start", map[string]any{
		"room_id":          session.RoomID,
		"agent_session_id": session.AgentSessionID,
		"cwd":              session.CWD,
		"command":          command,
		"direct_start":     a.config.provider == ProviderClaudeCode,
	})
	conn, err := a.transport.Start(ctx, ProcessSpec{
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
		a.logHermesStartupDiagnostics("process_start.failed", map[string]any{
			"room_id":          session.RoomID,
			"agent_session_id": session.AgentSessionID,
			"elapsed_ms":       time.Since(processStartedAt).Milliseconds(),
			"error":            err.Error(),
		})
		return nil, nil, err
	}
	a.logHermesStartupDiagnostics("process_start.succeeded", map[string]any{
		"room_id":          session.RoomID,
		"agent_session_id": session.AgentSessionID,
		"elapsed_ms":       time.Since(processStartedAt).Milliseconds(),
	})
	client := newACPClientWithStderrMessageMapper(conn, standardACPStderrMessageMapper(a.config.provider))
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
	mentionRoutingApplied, mentionRoutingSkills := claudeCodeMentionRoutingSkills(a.config.provider, visibleText)
	acpPromptContent := promptContentForACP(content)
	if mentionRoutingApplied {
		acpPromptContent = prependClaudeCodeMentionRoutingPrompt(acpPromptContent, mentionRoutingSkills)
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
		"claude_mention_routing_applied", mentionRoutingApplied,
		"claude_mention_routing_skills", mentionRoutingSkills,
	)
	if mentionRoutingApplied {
		slog.Info("agent session ACP claude mention routing applied",
			"event", "agent_session.acp.claude_mention_routing.applied",
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

	result, err := acpSession.client.Call(ctx, acpMethodPrompt, map[string]any{
		"sessionId": acpSession.providerSessionID,
		"prompt":    acpPromptContent,
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
		"emitted_event_count", len(events),
		"emitted_event_type_counts", activityEventTypeCounts(events),
	)
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

func claudeCodeMentionRoutingSkills(provider string, visibleText string) (bool, []string) {
	if strings.TrimSpace(provider) != ProviderClaudeCode {
		return false, nil
	}
	var skills []string
	seenSkills := map[string]struct{}{}
	for _, mention := range extractMentionURIs(visibleText) {
		skill := skillForMentionURI(mention)
		if skill == "" {
			continue
		}
		if _, ok := seenSkills[skill]; !ok {
			skills = append(skills, skill)
			seenSkills[skill] = struct{}{}
		}
	}
	return len(skills) > 0, skills
}

func skillForMentionURI(uri string) string {
	switch {
	case strings.HasPrefix(uri, "mention://workspace-issue/"):
		return "issue-manager"
	case strings.HasPrefix(uri, "mention://workspace-app/"):
		return "workspace-app"
	case strings.HasPrefix(uri, "mention://workspace-reference/"):
		return "reference"
	case strings.HasPrefix(uri, "mention://agent-session/"):
		return "tutti-cli"
	default:
		return ""
	}
}

func extractMentionURIs(text string) []string {
	const marker = "mention://"
	var mentions []string
	seen := map[string]struct{}{}
	for offset := 0; offset < len(text); {
		index := strings.Index(text[offset:], marker)
		if index < 0 {
			break
		}
		start := offset + index
		end := start
		for end < len(text) && !mentionURITerminator(text[end]) {
			end++
		}
		mention := strings.TrimSpace(text[start:end])
		if _, ok := seen[mention]; mention != "" && !ok {
			mentions = append(mentions, mention)
			seen[mention] = struct{}{}
		}
		offset = end
	}
	return mentions
}

func mentionURITerminator(char byte) bool {
	switch char {
	case ' ', '\t', '\n', '\r', ')', ']', '>', '"', '\'':
		return true
	default:
		return false
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
		if err := a.setSessionConfigOption(ctx, client, session, "fast", speed); err != nil {
			return fmt.Errorf("agent session ACP fast configuration failed: %w", err)
		}
		a.updateSessionConfigOption(session.AgentSessionID, "fast", speed)
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

func (a *standardACPAdapter) ApplySessionSettings(
	ctx context.Context,
	session Session,
	patch SessionSettingsPatch,
) error {
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
			if !a.sessionConfigOptionAdvertisesValue(session.AgentSessionID, "fast", speed) {
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
	return a.applyPermissionMode(ctx, acpSession.client, session)
}

func (a *standardACPAdapter) effectiveModeID(session Session) string {
	if a == nil || a.config.permissionModeID == nil {
		return ""
	}
	if a.config.provider == ProviderClaudeCode && session.SettingsValue().PlanMode {
		return "plan"
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
		if len(events) > 0 && emit == nil {
			a.emitSessionEvents(session.AgentSessionID, events)
		}
		return events, nil
	case acpMethodPermission:
		if strings.TrimSpace(turnID) == "" || emit == nil {
			err := errors.New("permission request outside active prompt turn is not supported")
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32000, Message: err.Error()})
			return nil, err
		}
		events, pending, err := standardACPPermissionRequested(a, session, turnID, message.ID, message.Params)
		if err != nil {
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
	case claudeSDKMessageMethod:
		a.logClaudeSDKMessage(session, turnID, message.Params)
		events := a.mirrorClaudeSDKGoalStatus(session, message.Params)
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
	return applyACPUpdateToLiveState(&session.acpLiveState, agentSessionID, raw)
}

func standardProviderSessionID(session *standardACPSession) string {
	if session == nil {
		return ""
	}
	return session.providerSessionID
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

const (
	geminiAuthMethodOAuthPersonal = "oauth-personal"
	geminiAuthMethodAPIKey        = "gemini-api-key"
)

func geminiACPBeforeNewSession(
	ctx context.Context,
	client *acpClient,
	_ Session,
	initializeResult json.RawMessage,
) error {
	methodID := selectGeminiACPAuthMethod(initializeResult)
	if methodID == "" {
		return errors.New("gemini ACP initialize did not advertise an authentication method")
	}
	slog.Info("agent session gemini ACP authenticate starting",
		"event", "agent_session.gemini.acp.authenticate.start",
		"method_id", methodID,
	)
	_, err := client.CallWithTimeout(ctx, acpStartCallTimeout, acpMethodAuthenticate, map[string]any{
		"methodId": methodID,
	}, nil)
	if err != nil {
		slog.Warn("agent session gemini ACP authenticate failed",
			"event", "agent_session.gemini.acp.authenticate.failed",
			"method_id", methodID,
			"error", err.Error(),
		)
		return err
	}
	slog.Info("agent session gemini ACP authenticate succeeded",
		"event", "agent_session.gemini.acp.authenticate.succeeded",
		"method_id", methodID,
	)
	return nil
}

func selectGeminiACPAuthMethod(initializeResult json.RawMessage) string {
	var result struct {
		AuthMethods []struct {
			ID string `json:"id"`
		} `json:"authMethods"`
	}
	if err := json.Unmarshal(initializeResult, &result); err != nil || len(result.AuthMethods) == 0 {
		return geminiAuthMethodOAuthPersonal
	}
	ids := make([]string, 0, len(result.AuthMethods))
	for _, method := range result.AuthMethods {
		id := strings.TrimSpace(method.ID)
		if id != "" {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return geminiAuthMethodOAuthPersonal
	}
	for _, preferred := range []string{geminiAuthMethodAPIKey, geminiAuthMethodOAuthPersonal} {
		for _, id := range ids {
			if id == preferred {
				return id
			}
		}
	}
	return ids[0]
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

func claudeACPEnv(session Session, host HostMetadata) []string {
	env := standardACPEnv(session, host)
	env = append(env, "IS_SANDBOX=1")
	return env
}

func claudeCodeCustomModel(session Session) string {
	model := strings.TrimSpace(session.SettingsValue().Model)
	if model == "" || claudeCodeACPModelAliases[model] {
		return ""
	}
	return model
}

func openclawACPEnv(session Session, host HostMetadata) []string {
	env := standardACPEnv(session, host)
	// OpenClaw enables Node's module compile cache before its ACP runtime starts.
	// With routed ACP startup this can stall before JSON-RPC initialize responds.
	env = append(env, "NODE_DISABLE_COMPILE_CACHE=1")
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

func claudeACPInitializeParams(host HostMetadata) map[string]any {
	return map[string]any{
		"protocolVersion": acpProtocolVersion,
		"clientCapabilities": map[string]any{
			"fs": map[string]any{
				"readTextFile":  true,
				"writeTextFile": true,
			},
			"terminal": true,
			"auth": map[string]any{
				"terminal": true,
			},
			"_meta": map[string]any{
				"terminal_output": true,
				"terminal-auth":   true,
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
		if events, ok := acpSystemNoticeEvents(session, turnID, params.Update, normalizer, "agent_message_chunk", config.provider == ProviderCodex); ok {
			return events
		}
		content := acpTextContent(params.Update["content"])
		if content == "" || normalizer == nil {
			return nil
		}
		return normalizer.AppendAssistantChunk(session, turnID, content)
	case "agent_thought_chunk":
		if events, ok := acpSystemNoticeEvents(session, turnID, params.Update, normalizer, "agent_thought_chunk", config.provider == ProviderCodex); ok {
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
		if events, ok := acpSystemNoticeEvents(session, turnID, params.Update, normalizer, updateType, config.provider == ProviderCodex); ok {
			return events
		}
		return nil
	case "available_commands_update", "current_mode_update", "plan":
		return nil
	default:
		return nil
	}
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

func standardACPStderrMessageMapper(provider string) acpStderrMessageMapper {
	if strings.TrimSpace(provider) == ProviderCodex {
		return codexACPSystemNoticeMessageFromStderr
	}
	return nil
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
		status := acpResolvedToolCallStatus(update, "in_progress")
		sanitizedUpdate := acpSanitizeImagePayloadMap(update)
		payload := map[string]any{
			"callId":   callID,
			"callType": firstNonEmpty(asString(update["kind"]), asString(update["callType"]), "tool"),
			"name":     name,
			"status":   status,
		}
		switch status {
		case messageStreamStateCompleted:
			payload["output"] = sanitizedUpdate
			return newTurnActivityEventWithID(session, eventID, EventCallCompleted, turnID, status, "", name, payload), true
		case messageStreamStateFailed:
			payload["error"] = sanitizedUpdate
			return newTurnActivityEventWithID(session, eventID, EventCallFailed, turnID, status, "", name, payload), true
		default:
			payload["input"] = sanitizedUpdate
			if updateType == "tool_call_update" {
				payload["status"] = messageStreamStateStreaming
			}
			return newTurnActivityEventWithID(session, eventID, EventCallStarted, turnID, messageStreamStateStreaming, "", name, payload), true
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

func isTerminalACPToolStatus(status string) bool {
	switch normalizedCallStatus(status) {
	case messageStreamStateCompleted, messageStreamStateFailed:
		return true
	default:
		return false
	}
}

func shouldIgnoreStandardACPTitle(config standardACPConfig, currentTitle string, title string) bool {
	if strings.TrimSpace(config.provider) != ProviderClaudeCode {
		return false
	}
	if isClaudeACPInterruptMarker(title) || isClaudeCodeMentionHandoffTitle(title) {
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

func isClaudeCodeMentionHandoffTitle(title string) bool {
	return strings.HasPrefix(strings.TrimSpace(title), "Claude Code mention handoff routing for this user turn:")
}

func prependClaudeCodeMentionRoutingPrompt(content []map[string]any, skills []string) []map[string]any {
	routingPrompt := strings.TrimSpace(claudeCodeMentionRoutingPrompt(skills))
	if routingPrompt == "" {
		return content
	}
	out := make([]map[string]any, 0, len(content)+1)
	out = append(out, map[string]any{
		"type": "text",
		"text": routingPrompt,
	})
	out = append(out, content...)
	return out
}

func claudeCodeMentionRoutingPrompt(skills []string) string {
	unique := make([]string, 0, len(skills))
	seen := map[string]bool{}
	for _, skill := range skills {
		skill = strings.TrimSpace(skill)
		if skill == "" || seen[skill] {
			continue
		}
		seen[skill] = true
		unique = append(unique, skill)
	}
	if len(unique) == 0 {
		return ""
	}
	lines := []string{
		"Claude Code mention handoff routing for this user turn:",
		"- This block is internal Tutti routing metadata. Do not quote, summarize, or display it to the user.",
		"- Before Bash, WebFetch, browser, MCP lookup, file search, raw CLI commands, or provider-native substitute tools, call the Claude Code Skill tool for the exact visible injected Tutti skill that matches the mention kind.",
		"- Skill names may be namespaced. Prefer the exact visible `tutti-cli:<skill>` name when present; use the plain `<skill>` name only if that exact name is visible. Do not pass arguments to Skill.",
	}
	for _, skill := range unique {
		switch skill {
		case "workspace-app":
			lines = append(lines,
				"- For `mention://workspace-app/...`, first call `Skill(skill=\"tutti-cli:workspace-app\")` when that name is visible, otherwise `Skill(skill=\"workspace-app\")` only if visible.",
				"- The workspace app id inside the mention is not a skill name. Do not call an app-id-derived Skill name.",
			)
		case "issue-manager":
			lines = append(lines, "- For `mention://workspace-issue/...`, first call `Skill(skill=\"tutti-cli:issue-manager\")` when that name is visible, otherwise `Skill(skill=\"issue-manager\")` only if visible.")
		case "reference":
			lines = append(lines, "- For `mention://workspace-reference/...`, first call `Skill(skill=\"tutti-cli:reference\")` when that name is visible, otherwise `Skill(skill=\"reference\")` only if visible.")
		case "tutti-cli":
			lines = append(lines, "- For `mention://agent-session/...`, first call `Skill(skill=\"tutti-cli:tutti-cli\")` when that name is visible, otherwise `Skill(skill=\"tutti-cli\")` only if visible.")
		default:
			lines = append(lines, "- First call the exact visible Skill for `"+skill+"`.")
		}
	}
	return strings.Join(lines, "\n")
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
