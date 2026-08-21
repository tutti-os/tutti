package agentruntime

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type standardACPProviderMessageHandler func(
	context.Context,
	*acpClient,
	Session,
	string,
	acpMessage,
	*acpTurnNormalizer,
	EventSink,
) ([]activityshared.Event, bool, error)

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
	// validateNewSessionResult, when set, inspects the raw session/new response
	// right after it succeeds and may reject the start (setup probes use it to
	// catch agents that create a session they cannot actually serve).
	validateNewSessionResult func(json.RawMessage) error
	// validateSettings rejects provider-specific setting combinations both
	// before startup and before live settings reach the provider. Generic ACP
	// descriptors can expose provider-wide options even when the selected model
	// narrows their support.
	validateSettings func(Session, SessionSettingsPatch) error
	// filterRuntimeConfigOptionDescriptors removes provider-invalid capability
	// values before descriptors become the live RuntimeContext authority.
	filterRuntimeConfigOptionDescriptors func(Session, []map[string]any) []map[string]any
	// filterRuntimeConfigOptionValues removes provider-invalid current values
	// before they become the SessionState settings/runtime-context authority.
	filterRuntimeConfigOptionValues func(Session, map[string]any) map[string]any
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
	// initialPromptContext resolves provider-owned context that ACP v1 cannot
	// carry through a developer/system channel. It is appended to the first
	// provider prompt only and never projected as user-visible content.
	initialPromptContext func(Session) (string, error)
	// finalizeEnv applies provider-owned environment composition after session,
	// target, and managed-runtime overrides have been resolved.
	finalizeEnv func([]string, Session) ([]string, error)
	// requiresNewSessionForSettings reports settings patches that can only
	// take effect via a fresh process/session (spawn-time-only flags).
	requiresNewSessionForSettings func(Session, SessionSettingsPatch) bool
	// automaticPermissionDecision lets a provider resolve incoming
	// session/request_permission requests without prompting, from the live
	// permission tier. It returns a decision
	// token ("approved" / "denied") to apply automatically, or "" to prompt
	// the user as usual. Nil (the default) always prompts.
	automaticPermissionDecision func(permissionModeID string) string
	// filterPermissionOptions narrows provider-offered approval choices before
	// they become a durable interaction. Providers use it only when an option
	// would conflict with live permission-tier semantics.
	filterPermissionOptions func([]map[string]any) []map[string]any
	// autoContinueRetriableTurnError resumes turns the agent ends "normally"
	// right after streaming a transient network error as plain text (Cursor's
	// "Error: RetriableError: ..." tail). See acp_auto_continue.go.
	autoContinueRetriableTurnError bool
	applySessionMeta               func(map[string]any, Session, HostMetadata)
	planModeRuntimeID              string
	planModeDisabledRuntimeID      string
	planModeUsesLaunchPermission   bool
	projectCurrentMode             bool
	startupDiagnostics             bool
	toolAliases                    map[string]string
	modelConfigOptionID            string
	modelDescriptionFormat         string
	permissionConfigOptionID       string
	reasoningConfigOptionID        string
	restrictConfigOptions          bool
	launchPermission               *StandardACPLaunchPermissionSetting
	setModelReasoningEffortMeta    bool
	messageDiagnostics             *standardACPMessageDiagnostics
	providerMessageHandler         standardACPProviderMessageHandler
	capabilities                   []string
	agentTargetID                  string
	installationID                 string
	executableIdentity             *ExecutableIdentity
	startupTimeout                 time.Duration
}

type standardACPMessageDiagnostics struct {
	method         string
	observeMessage func(standardACPConfig, Session, string, acpMessage, *acpTurnNormalizer)
	observeUpdate  func(standardACPConfig, Session, string, string, map[string]any)
}

func (a *standardACPAdapter) MatchesAdapterResolveInput(input AdapterResolveInput) bool {
	if a == nil || a.config.installationID == "" {
		return true
	}
	installationID := strings.TrimSpace(asString(input.ProviderTargetRef["extensionInstallationId"]))
	return strings.TrimSpace(input.AgentTargetID) == a.config.agentTargetID && installationID == a.config.installationID
}

type standardACPAdapter struct {
	config                     standardACPConfig
	transport                  ProcessTransport
	host                       HostMetadata
	preparer                   ProviderLaunchPreparer
	mu                         sync.Mutex
	sessions                   map[string]*standardACPSession
	retiredSessions            map[string][]*standardACPSession
	terminalInteractions       terminalInteractiveDispositionStore
	interactiveDispositionSink InteractiveDispositionSink
	commandSink                CommandSnapshotSink
	eventSink                  SessionEventSink
	inputUnits                 *providerInputUnitTracker
	configSink                 ConfigOptionsUpdateSink
	promptImageMaterializer    providerPromptImageMaterializer
	lifecycleMu                sync.Mutex
	lifecycleLocks             map[string]*standardACPSessionLock
}

type standardACPSession struct {
	client *acpClient
	// releasing fences new live-client work while idle release is closing the
	// transport. The lifecycle lock serializes mutating entrypoints; this flag
	// also makes liveness probes fail closed during the close call.
	releasing bool
	// releaseFailed keeps a physical client registered for another Close
	// attempt while preventing new work from reusing its closed stdin.
	releaseFailed     bool
	providerSessionID string
	// resumeMethod records the capability proven by this process's initialize
	// handshake. Idle release is safe only when the next process can restore
	// the provider session through this method.
	resumeMethod string
	// resumeRuntimeContext preserves the historical adapter projection only
	// when replay attaches at an already-initialized connection checkpoint.
	resumeRuntimeContext map[string]any
	agentInfo            map[string]any
	promptImage          bool
	sessionClose         bool
	acpLiveState
	pendingApprovals map[string]*pendingACPApproval
	recentTurnID     string
	recentTurnExpiry time.Time
	// lifecycleSeq orders provider-agnostic authoritative turn snapshots
	// emitted by the standard ACP adapter (ADR 0008).
	lifecycleSeq uint64
	// permissionModeID tracks the session's live permission tier so automatic
	// approval or denial applies immediately after a mid-session tier change,
	// without a respawn.
	permissionModeID string
	// planMode denies permission-gated operations even when the provider emits
	// a request while its planning workflow is active.
	planMode bool
	// initialPromptContext remains pending until the provider accepts its first
	// prompt. A failed transport call leaves it pending for the next attempt.
	initialPromptContext string
}

func (a *standardACPAdapter) resolveInitialPromptContext(session Session) (string, error) {
	if a == nil || a.config.initialPromptContext == nil {
		return "", nil
	}
	context, err := a.config.initialPromptContext(session)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(context), nil
}

func (a *standardACPAdapter) pendingInitialPromptContext(session *standardACPSession) string {
	if a == nil || session == nil {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return session.initialPromptContext
}

func (a *standardACPAdapter) consumeInitialPromptContext(session *standardACPSession) {
	if a == nil || session == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session.initialPromptContext = ""
}

func (a *standardACPAdapter) stampTurnLifecycleSnapshots(acpSession *standardACPSession, events []activityshared.Event) []activityshared.Event {
	if a == nil || acpSession == nil || len(events) == 0 {
		return events
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return stampAdapterTurnLifecycleEvents(events, func() uint64 {
		acpSession.lifecycleSeq++
		return acpSession.lifecycleSeq
	})
}

type standardACPSessionLock struct {
	mu   sync.Mutex
	refs int
}

type pendingACPApproval = pendingInteractiveRequest

const standardACPRecentTurnTTL = 10 * time.Minute

const acpMethodSetConfigOption = "session/set_config_option"
const acpMethodSetModel = "session/set_model"
const acpMethodCloseSession = "session/close"
const (
	acpCloseCallTimeout  = 750 * time.Millisecond
	acpCloseGraceTimeout = 200 * time.Millisecond
)

func (a *standardACPAdapter) applyProviderSessionMeta(params map[string]any, session Session) error {
	if params == nil {
		return nil
	}
	if a.config.applySessionMeta != nil {
		a.config.applySessionMeta(params, session, a.host)
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
	if migratedProviderHasCapability(provider, CapabilityImageInput) {
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

func sessionEnvValue(env []string, key string) string {
	prefix := key + "="
	for _, item := range env {
		if strings.HasPrefix(item, prefix) {
			return strings.TrimPrefix(item, prefix)
		}
	}
	return ""
}

func standardACPInitialLiveState() acpLiveState {
	return newACPLiveState()
}

func (a *standardACPAdapter) Provider() string {
	if a == nil {
		return ""
	}
	return a.config.provider
}

// UsesRootProviderTurnLifecycle keeps provider completion separate from the
// canonical root turn. Standard ACP does not currently expose durable child
// sessions, but it must still use the same daemon-owned settlement path as
// every other provider so adding an ACP child-session strategy cannot create a
// second completion model.
func (*standardACPAdapter) UsesRootProviderTurnLifecycle() bool {
	return true
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
