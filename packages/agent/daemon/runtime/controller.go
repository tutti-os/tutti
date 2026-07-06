//revive:disable:file-length-limit
package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"strings"
	"sync"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

var (
	ErrSessionNotFound                  = errors.New("agent session not found")
	ErrSessionSettingsRequireNewSession = errors.New("agent session settings update requires a new session to preserve context")
	ErrSessionActiveTurn                = errors.New("agent session already has an active turn")
)

const defaultStreamingReportCoalesceWindow = 50 * time.Millisecond
const interactiveDenyFollowUpStartTimeout = 30 * time.Second
const interactiveDenyFollowUpPollInterval = 25 * time.Millisecond

type execMetadataContextKey struct{}

type Controller struct {
	startMu                     sync.Mutex
	mu                          sync.Mutex
	sessions                    map[string]Session
	adapters                    map[string]Adapter
	turns                       map[string]activeTurn
	commands                    map[string]AgentSessionCommandSnapshot
	pendingCommandSnapshots     map[string]AgentSessionCommandSnapshot
	configOptionsUpdates        map[string]AgentSessionConfigOptionsUpdate
	pendingConfigOptionsUpdates map[string][]AgentSessionConfigOptionsUpdate
	lifecycleLocks              map[string]*sessionLifecycleLock
	hub                         *EventHub
	reporter                    ActivityReporter
	reportCh                    chan reportRequest
}

type sessionLifecycleLock struct {
	mu   sync.Mutex
	refs int
}

type activeTurn struct {
	turnID string
	cancel context.CancelFunc
}

type reportRequest struct {
	ctx    context.Context
	report agentsessionstore.ReportActivityInput
}

type ReleaseIdleLiveSessionsInput struct {
	IdleAfter time.Duration
	Now       time.Time
	Limit     int
}

type ReleaseIdleLiveSessionsResult struct {
	Scanned            int
	Released           int
	SkippedFresh       int
	SkippedActiveTurn  int
	SkippedUnsupported int
	SkippedNotLive     int
	SkippedBusy        int
	Failed             int
}

// CloseAllLiveSessionsResult reports the outcome of CloseAllLiveSessions.
type CloseAllLiveSessionsResult struct {
	// Scanned counts sessions whose adapter reported a live provider process.
	Scanned int
	Closed  int
	Failed  int
}

type asyncActivityReporter interface {
	ActivityReporter
	AsyncActivityReporter()
}

func NewController(adapters []Adapter, reporter ActivityReporter) *Controller {
	byProvider := make(map[string]Adapter, len(adapters))
	for _, adapter := range adapters {
		if adapter == nil {
			continue
		}
		provider := strings.TrimSpace(adapter.Provider())
		if provider != "" {
			byProvider[provider] = adapter
		}
	}
	controller := &Controller{
		sessions:                    make(map[string]Session),
		adapters:                    byProvider,
		turns:                       make(map[string]activeTurn),
		commands:                    make(map[string]AgentSessionCommandSnapshot),
		pendingCommandSnapshots:     make(map[string]AgentSessionCommandSnapshot),
		configOptionsUpdates:        make(map[string]AgentSessionConfigOptionsUpdate),
		pendingConfigOptionsUpdates: make(map[string][]AgentSessionConfigOptionsUpdate),
		lifecycleLocks:              make(map[string]*sessionLifecycleLock),
		hub:                         NewEventHub(),
		reporter:                    reporter,
	}
	if reporter != nil {
		if _, ok := reporter.(asyncActivityReporter); !ok {
			controller.reportCh = make(chan reportRequest, 1024)
			go controller.runReportWorker()
		}
	}
	for _, adapter := range byProvider {
		if sinkAdapter, ok := adapter.(CommandSnapshotSinkAdapter); ok {
			sinkAdapter.SetCommandSnapshotSink(controller.applyCommandSnapshotByAgentSessionID)
		}
		if sinkAdapter, ok := adapter.(SessionEventSinkAdapter); ok {
			sinkAdapter.SetSessionEventSink(controller.applySessionEventsByAgentSessionID)
		}
		if sinkAdapter, ok := adapter.(ConfigOptionsUpdateSinkAdapter); ok {
			sinkAdapter.SetConfigOptionsUpdateSink(controller.applyConfigOptionsUpdateByAgentSessionID)
		}
	}
	return controller
}

func NewDefaultController(reporter ActivityReporter) *Controller {
	return NewDefaultControllerWithProcessTransport(reporter, nil)
}

func NewDefaultControllerWithProcessTransport(
	reporter ActivityReporter,
	transport ProcessTransport,
) *Controller {
	return NewDefaultControllerWithOptions(reporter, transport, ControllerOptions{
		HostMetadata: LegacyHostMetadata(),
	})
}

func NewDefaultControllerWithOptions(
	reporter ActivityReporter,
	transport ProcessTransport,
	options ControllerOptions,
) *Controller {
	host := options.HostMetadata
	adapters := []Adapter{
		newDefaultClaudeCodeAdapter(transport, host, options.ProviderCommandResolver),
		NewCodexAppServerAdapterWithHostMetadata(transport, host),
		NewCursorAdapterWithHostMetadata(transport, host),
		NewNexightAdapterWithHostMetadata(transport, host),
		NewGeminiAdapterWithHostMetadata(transport, host),
		NewHermesAdapterWithHostMetadata(transport, host),
		NewOpenClawAdapterWithHostMetadata(transport, host),
	}
	setProviderLaunchPreparer(adapters, options.ProviderLaunchPreparer)
	return NewController(adapters, reporter)
}

func newDefaultClaudeCodeAdapter(
	transport ProcessTransport,
	host HostMetadata,
	commandResolver ProviderCommandResolver,
) Adapter {
	if claudeCodeSDKRuntimeEnabled() {
		return NewClaudeCodeSDKAdapter(transport)
	}
	return newClaudeCodeAdapterWithHostMetadata(transport, host, commandResolver)
}

func (c *Controller) Start(ctx context.Context, input StartInput) (StartResult, error) {
	c.startMu.Lock()
	defer c.startMu.Unlock()

	roomID := strings.TrimSpace(input.RoomID)
	provider := strings.TrimSpace(input.Provider)
	if roomID == "" {
		return StartResult{}, fmt.Errorf("room id is required")
	}
	if provider == "" {
		return StartResult{}, fmt.Errorf("provider is required")
	}
	adapter := c.adapter(provider)
	if adapter == nil {
		return StartResult{}, fmt.Errorf("unsupported agent session provider %q", provider)
	}
	timestamp := unixMS(now())
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	settings := normalizeSessionSettings(
		input.Settings,
		provider,
		firstNonEmpty(input.PermissionModeID, defaultPermissionModeIDForProvider(provider)),
	)
	permissionModeID := settings.PermissionModeID
	if agentSessionID == "" {
		if existing, ok := c.findStartSession(roomID, strings.TrimSpace(input.AgentTargetID), provider, input.CWD, input.Title, settings, input.ProviderTargetRef); ok {
			return StartResult{Session: existing}, nil
		}
		agentSessionID = newID()
	}
	if existing, ok := c.get(roomID, agentSessionID); ok {
		return StartResult{Session: existing}, nil
	}
	session := Session{
		RoomID:               roomID,
		AgentSessionID:       agentSessionID,
		AgentTargetID:        strings.TrimSpace(input.AgentTargetID),
		Provider:             provider,
		ProviderSessionID:    "",
		CWD:                  strings.TrimSpace(input.CWD),
		Env:                  append([]string(nil), input.Env...),
		Status:               SessionStatusReady,
		Title:                firstNonEmpty(strings.TrimSpace(input.Title), provider),
		Visible:              sessionVisible(input.Visible),
		RuntimeContext:       clonePayload(input.RuntimeContext),
		ProviderTargetRef:    clonePayload(input.ProviderTargetRef),
		OpenclawGatewayReady: input.OpenclawGatewayReady,
		PermissionModeID:     permissionModeID,
		Settings:             cloneSessionSettings(settings),
		CreatedAtUnixMS:      timestamp,
		UpdatedAtUnixMS:      timestamp,
	}
	events, err := adapter.Start(ctx, session)
	if err != nil {
		detail := cleanVisibleErrorText(err.Error())
		code := visibleFailureCode(detail)
		sessionError := &SessionError{
			Code:         code,
			Message:      visibleFailureContent(provider, "start", code),
			DebugMessage: detail,
		}
		events = []activityshared.Event{newSessionActivityEvent(session, EventSessionFailed, SessionStatusFailed, map[string]any{
			"error":      detail,
			"code":       code,
			"retryable":  visibleFailureRetryable(code, detail),
			"startError": true,
		})}
		session = applySessionEvents(session, events)
		session.Status = SessionStatusFailed
		session.LastError = detail
		session.UpdatedAtUnixMS = unixMS(now())
		c.mu.Lock()
		c.sessions[sessionKey(roomID, agentSessionID)] = session
		c.mu.Unlock()
		c.publish(session, events)
		c.publishPendingConfigOptionsUpdates(session)
		c.publishPendingCommandSnapshot(session)
		c.enqueueSessionReport(ctx, session, events)
		return StartResult{Session: session, Error: sessionError}, nil
	}
	session = applySessionEvents(session, events)
	c.mu.Lock()
	c.sessions[sessionKey(roomID, agentSessionID)] = session
	c.mu.Unlock()
	c.publish(session, events)
	c.publishPendingConfigOptionsUpdates(session)
	if !c.publishPendingCommandSnapshot(session) {
		c.publishAdapterCommandSnapshot(session, adapter)
	}
	c.enqueueSessionReport(ctx, session, events)
	return StartResult{Session: session}, nil
}

func (c *Controller) Resume(ctx context.Context, input ResumeInput) (Session, error) {
	c.startMu.Lock()
	defer c.startMu.Unlock()

	roomID := strings.TrimSpace(input.RoomID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	provider := strings.TrimSpace(input.Provider)
	providerSessionID := strings.TrimSpace(input.ProviderSessionID)
	if roomID == "" {
		return Session{}, fmt.Errorf("room id is required")
	}
	if agentSessionID == "" {
		return Session{}, fmt.Errorf("agent session id is required")
	}
	if provider == "" {
		return Session{}, fmt.Errorf("provider is required")
	}
	if providerSessionID == "" {
		return Session{}, fmt.Errorf("provider session id is required")
	}
	if existing, ok := c.get(roomID, agentSessionID); ok {
		return existing, nil
	}
	adapter := c.adapter(provider)
	if adapter == nil {
		return Session{}, fmt.Errorf("unsupported agent session provider %q", provider)
	}
	timestamp := unixMS(now())
	createdAtUnixMS := input.CreatedAtUnixMS
	if createdAtUnixMS <= 0 {
		createdAtUnixMS = timestamp
	}
	updatedAtUnixMS := input.UpdatedAtUnixMS
	if updatedAtUnixMS <= 0 {
		updatedAtUnixMS = timestamp
	}
	session := Session{
		RoomID:            roomID,
		AgentSessionID:    agentSessionID,
		AgentTargetID:     strings.TrimSpace(input.AgentTargetID),
		Provider:          provider,
		ProviderSessionID: providerSessionID,
		CWD:               strings.TrimSpace(input.CWD),
		Env:               append([]string(nil), input.Env...),
		Status:            firstNonEmpty(normalizeSessionStatus(input.Status), SessionStatusReady),
		Title:             firstNonEmpty(strings.TrimSpace(input.Title), provider),
		Visible:           sessionVisible(input.Visible),
		RuntimeContext:    clonePayload(input.RuntimeContext),
		PermissionModeID:  normalizePermissionModeIDWithFallback(provider, input.PermissionModeID, defaultPermissionModeIDForProvider(provider)),
		Settings:          normalizeOptionalSessionSettings(input.Settings, provider, firstNonEmpty(input.PermissionModeID, defaultPermissionModeIDForProvider(provider))),
		CreatedAtUnixMS:   createdAtUnixMS,
		UpdatedAtUnixMS:   updatedAtUnixMS,
	}
	if session.Settings != nil {
		session.PermissionModeID = session.Settings.PermissionModeID
	}
	if err := adapter.Resume(ctx, session); err != nil {
		if !input.RecreateIfMissing || !isResumeRecreatableError(err) {
			return Session{}, err
		}
		// The provider session is not available locally (imported from another
		// device, rollout deleted, ...) and the caller opted into recreation, so
		// start a fresh provider session bound to the same agent session. This is
		// what keeps imported conversations continuable instead of forcing the
		// user into a brand new conversation.
		if err := c.recreateAdapterSession(ctx, session, adapter); err != nil {
			return Session{}, err
		}
		if refreshed, ok := c.get(session.RoomID, session.AgentSessionID); ok {
			return refreshed, nil
		}
		return session, nil
	}
	session.Status = SessionStatusReady
	c.store(session)
	c.publishPendingConfigOptionsUpdates(session)
	if !c.publishPendingCommandSnapshot(session) {
		c.publishAdapterCommandSnapshot(session, adapter)
	}
	return session, nil
}

func (c *Controller) Close(ctx context.Context, input CloseInput) (CloseResult, error) {
	releaseLifecycleLock := c.acquireLifecycleLock(input.RoomID, input.AgentSessionID)
	defer releaseLifecycleLock()

	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return CloseResult{}, err
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.cancelActiveTurn(session.RoomID, session.AgentSessionID)
	if err := adapter.Close(ctx, session); err != nil {
		return CloseResult{}, err
	}
	session.Status = SessionStatusCompleted
	events := []activityshared.Event{
		newSessionActivityEvent(session, EventSessionCompleted, SessionStatusCompleted, map[string]any{
			"reason": "session closed",
		}),
	}
	c.publish(session, events)
	c.enqueueSessionReport(ctx, session, events)
	c.mu.Lock()
	delete(c.sessions, key)
	delete(c.turns, key)
	delete(c.commands, key)
	delete(c.pendingCommandSnapshots, session.AgentSessionID)
	c.mu.Unlock()
	return CloseResult{AgentSessionID: session.AgentSessionID, Disconnected: true}, nil
}

func (c *Controller) HasActiveTurn(roomID, agentSessionID string) bool {
	if c == nil {
		return false
	}
	key := sessionKey(strings.TrimSpace(roomID), strings.TrimSpace(agentSessionID))
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.turns[key]
	return ok
}

func (c *Controller) SetVisible(ctx context.Context, roomID, agentSessionID string, visible bool) (Session, error) {
	session, ok := c.get(strings.TrimSpace(roomID), strings.TrimSpace(agentSessionID))
	if !ok {
		return Session{}, ErrSessionNotFound
	}
	if session.Visible == visible {
		return session, nil
	}
	session.Visible = visible
	session.UpdatedAtUnixMS = unixMS(now())
	c.store(session)
	if visible {
		c.enqueueSessionReport(ctx, session, []activityshared.Event{
			newSessionActivityEvent(session, EventSessionStarted, session.Status, nil),
		})
	}
	return session, nil
}

func sessionVisible(visible *bool) bool {
	return visible == nil || *visible
}

func normalizePermissionModeIDWithFallback(provider string, mode string, fallback string) string {
	mode = strings.TrimSpace(mode)
	if permissionModeIDAllowedForProvider(provider, mode) {
		return mode
	}
	fallback = strings.TrimSpace(fallback)
	if permissionModeIDAllowedForProvider(provider, fallback) {
		return fallback
	}
	return defaultPermissionModeIDForProvider(provider)
}

func defaultPermissionModeIDForProvider(provider string) string {
	switch strings.TrimSpace(provider) {
	case ProviderClaudeCode:
		return "default"
	case ProviderCodex, ProviderNexight:
		return "auto"
	case ProviderCursor:
		return "agent"
	case ProviderGemini, ProviderHermes:
		return "yolo"
	default:
		return ""
	}
}

// claudeCodePermissionModeIDs is the canonical set of claude-code permission
// modes — i.e. every ACP mode except "plan". It is the single source the
// allowlist, the forward ACP mapping (claudeCodeACPModeID), and the inverse
// (claudeCodeModeFromID) all derive from, so adding a mode (e.g. "auto") is a
// one-line change here rather than across several drifting switch statements.
var claudeCodePermissionModeIDs = []string{
	"default",
	"acceptEdits",
	"dontAsk",
	"bypassPermissions",
	"auto",
}

func isClaudeCodePermissionModeID(mode string) bool {
	mode = strings.TrimSpace(mode)
	for _, id := range claudeCodePermissionModeIDs {
		if id == mode {
			return true
		}
	}
	return false
}

func permissionModeIDAllowedForProvider(provider string, mode string) bool {
	switch strings.TrimSpace(provider) {
	case ProviderClaudeCode:
		return isClaudeCodePermissionModeID(mode)
	case ProviderCodex, ProviderNexight:
		switch strings.TrimSpace(mode) {
		case "read-only", "auto", "full-access":
			return true
		}
	case ProviderCursor:
		return cursorACPModeID(mode) != ""
	case ProviderGemini, ProviderHermes:
		return strings.TrimSpace(mode) == "yolo"
	}
	return false
}

func normalizeSessionSettings(settings *SessionSettings, provider string, defaultPermissionModeID string) SessionSettings {
	normalized := SessionSettings{
		PermissionModeID:       normalizePermissionModeIDWithFallback(provider, defaultPermissionModeID, ""),
		ConversationDetailMode: AgentConversationDetailModeCoding,
	}
	if settings == nil {
		return normalized
	}
	normalized.Model = strings.TrimSpace(settings.Model)
	normalized.ReasoningEffort = strings.TrimSpace(settings.ReasoningEffort)
	normalized.Speed = strings.TrimSpace(settings.Speed)
	normalized.ConversationDetailMode = normalizeAgentConversationDetailMode(settings.ConversationDetailMode)
	normalized.PlanMode = settings.PlanMode
	if settings.BrowserUse != nil {
		value := *settings.BrowserUse
		normalized.BrowserUse = &value
	}
	if settings.ComputerUse != nil {
		value := *settings.ComputerUse
		normalized.ComputerUse = &value
	}
	if mode := strings.TrimSpace(settings.PermissionModeID); mode != "" {
		normalized.PermissionModeID = normalizePermissionModeIDWithFallback(provider, mode, defaultPermissionModeID)
	}
	return normalized
}

func normalizeOptionalSessionSettings(
	settings *SessionSettings,
	provider string,
	defaultPermissionModeID string,
) *SessionSettings {
	if settings == nil {
		return nil
	}
	normalized := normalizeSessionSettings(settings, provider, defaultPermissionModeID)
	return cloneSessionSettings(normalized)
}

func cloneSessionSettings(settings SessionSettings) *SessionSettings {
	cloned := settings
	return &cloned
}

// applySessionEventsBase folds the non-status parts of an event batch:
// provider session id, title, runtime context, and last error. It is the
// shared core of the legacy applySessionEvents fold and the ADR 0008
// authority path (which derives status purely from the lifecycle instead).
func applySessionEventsBase(session Session, events []activityshared.Event) Session {
	for _, event := range events {
		if strings.TrimSpace(event.ProviderSessionID) != "" {
			session.ProviderSessionID = strings.TrimSpace(event.ProviderSessionID)
		}
		if title := strings.TrimSpace(event.Payload.Title); title != "" {
			session.Title = title
		}
		if runtimeContext := payloadMap(event.Payload.Metadata, "runtimeContext"); len(runtimeContext) > 0 {
			session.RuntimeContext = mergeRuntimeContextPatch(session.RuntimeContext, runtimeContext)
		}
		switch event.Type {
		case activityshared.EventSessionFailed, activityshared.EventTurnFailed:
			session.LastError = strings.TrimSpace(activityshared.BestEffortErrorMessage(event.Payload))
		case activityshared.EventTurnStarted, activityshared.EventTurnCompleted, activityshared.EventSessionCompleted:
			session.LastError = ""
		}
	}
	return session
}

func applySessionEvents(session Session, events []activityshared.Event) Session {
	for _, event := range events {
		if strings.TrimSpace(event.ProviderSessionID) != "" {
			session.ProviderSessionID = strings.TrimSpace(event.ProviderSessionID)
		}
		if title := strings.TrimSpace(event.Payload.Title); title != "" {
			session.Title = title
		}
		if runtimeContext := payloadMap(event.Payload.Metadata, "runtimeContext"); len(runtimeContext) > 0 {
			session.RuntimeContext = mergeRuntimeContextPatch(session.RuntimeContext, runtimeContext)
		}
		if next := deriveSessionStatusFromEvents([]activityshared.Event{event}, ""); next != "" {
			session.Status = next
		}
		switch event.Type {
		case activityshared.EventSessionFailed, activityshared.EventTurnFailed:
			session.LastError = strings.TrimSpace(activityshared.BestEffortErrorMessage(event.Payload))
		case activityshared.EventTurnStarted, activityshared.EventTurnCompleted, activityshared.EventSessionCompleted:
			session.LastError = ""
		}
	}
	return session
}

func mergeRuntimeContextPatch(current map[string]any, patch map[string]any) map[string]any {
	if len(patch) == 0 {
		return clonePayload(current)
	}
	next := clonePayload(current)
	if next == nil {
		next = map[string]any{}
	}
	for key, value := range patch {
		next[key] = clonePayloadValue(value)
	}
	return next
}

func (c *Controller) Exec(ctx context.Context, input ExecInput) (ExecResult, error) {
	releaseLifecycleLock := c.acquireLifecycleLock(input.RoomID, input.AgentSessionID)
	defer releaseLifecycleLock()

	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return ExecResult{}, err
	}
	metadata := cloneExecMetadata(input.Metadata)
	logAgentSubmitTrace("runtime.exec.entered", session, "", metadata, map[string]any{
		"content_block_count": len(input.Content),
	})
	if err := c.ensureLiveAdapterSession(ctx, session, adapter); err != nil {
		logAgentSubmitTrace("runtime.exec.ensure_live_failed", session, "", metadata, map[string]any{
			"error": err.Error(),
		})
		return ExecResult{}, err
	}
	logAgentSubmitTrace("runtime.exec.adapter_session_ready", session, "", metadata, nil)
	if refreshed, ok := c.get(session.RoomID, session.AgentSessionID); ok {
		session = refreshed
	}
	content := normalizeRuntimePromptContent(input.Content)
	if len(content) == 0 {
		return ExecResult{}, fmt.Errorf("prompt is required")
	}
	displayPrompt := strings.TrimSpace(input.DisplayPrompt)
	if promptAdapter, ok := adapter.(PromptContentAdapter); ok {
		if err := promptAdapter.ValidatePromptContent(session, content); err != nil {
			return ExecResult{}, err
		}
	}
	if input.Guidance {
		return c.guideActiveTurn(ctx, session, adapter, content, displayPrompt, metadata)
	}
	turnID := newID()
	runCtx, cancel := context.WithCancel(context.Background())
	if len(metadata) > 0 {
		runCtx = context.WithValue(runCtx, execMetadataContextKey{}, metadata)
	}
	// beginTurn returns the zero session on failure; keep the real session
	// for the goal-control fallback below.
	startedSession, err := c.beginTurn(session, turnID, cancel)
	if err != nil {
		cancel()
		if errors.Is(err, ErrSessionActiveTurn) {
			// Goal control (/goal paused|active|clear) is a thread-level
			// operation like Cancel: it must act immediately while a turn is
			// running, exactly when the single-turn gate would reject it.
			if result, handled, controlErr := c.execGoalControlWithActiveTurn(ctx, session, adapter, content, displayPrompt, turnID, metadata); handled {
				return result, controlErr
			}
		}
		return ExecResult{}, err
	}
	session = startedSession
	submitEvents := submittedTurnActivityEvents(session, turnID)
	if len(submitEvents) > 0 {
		c.publish(session, submitEvents)
		c.enqueueSessionReport(ctx, session, submitEvents)
	}
	logAgentSubmitTrace("runtime.submitted", session, turnID, metadata, map[string]any{
		"phase": "submitted",
	})
	go c.runExecTurn(runCtx, session, adapter, content, displayPrompt, turnID)
	return ExecResult{
		AgentSessionID:     session.AgentSessionID,
		Status:             ExecStatusStarted,
		TurnID:             turnID,
		Accepted:           true,
		SessionStatus:      session.Status,
		TurnLifecycle:      *session.TurnLifecycle,
		SubmitAvailability: *session.SubmitAvailability,
	}, nil
}

func (c *Controller) guideActiveTurn(
	ctx context.Context,
	session Session,
	adapter Adapter,
	content []PromptContentBlock,
	displayPrompt string,
	metadata map[string]any,
) (ExecResult, error) {
	guidanceAdapter, ok := adapter.(ActiveTurnGuidanceAdapter)
	if !ok {
		return ExecResult{}, ErrActiveTurnGuidanceUnsupported
	}
	if !c.HasActiveTurn(session.RoomID, session.AgentSessionID) {
		return ExecResult{}, ErrSessionNoActiveTurn
	}
	turnID := newID()
	runCtx := ctx
	if len(metadata) > 0 {
		runCtx = context.WithValue(ctx, execMetadataContextKey{}, metadata)
	}
	events, err := guidanceAdapter.GuideActiveTurn(runCtx, session, content, displayPrompt, turnID, nil, nil)
	if err != nil {
		logAgentSubmitTrace("runtime.exec.guidance_failed", session, turnID, metadata, map[string]any{
			"error": err.Error(),
		})
		return ExecResult{}, err
	}
	c.applySessionEventsByAgentSessionID(session.AgentSessionID, events)
	logAgentSubmitTrace("runtime.exec.guidance", session, turnID, metadata, map[string]any{
		"activity_event_count": len(events),
	})
	if refreshed, ok := c.get(session.RoomID, session.AgentSessionID); ok {
		session = refreshed
	}
	result := ExecResult{
		AgentSessionID: session.AgentSessionID,
		Status:         ExecStatusStarted,
		TurnID:         turnID,
		Accepted:       true,
		SessionStatus:  session.Status,
	}
	if session.TurnLifecycle != nil {
		result.TurnLifecycle = *session.TurnLifecycle
	}
	if session.SubmitAvailability != nil {
		result.SubmitAvailability = *session.SubmitAvailability
	}
	return result, nil
}

type GoalControlInput struct {
	RoomID         string
	AgentSessionID string
	Action         GoalControlAction
	Objective      string
}

type GoalControlResult struct {
	AgentSessionID string
	// Goal is the fresh goal snapshot after the action (nil after clear).
	Goal map[string]any
}

// GoalControl performs a direct goal action (banner buttons) as a
// session-level control operation — like Cancel, it never opens a turn, so it
// works regardless of what is currently running.
func (c *Controller) GoalControl(ctx context.Context, input GoalControlInput) (GoalControlResult, error) {
	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return GoalControlResult{}, err
	}
	goalAdapter, ok := adapter.(GoalControlAdapter)
	if !ok {
		return GoalControlResult{}, fmt.Errorf("agent provider does not support goals")
	}
	if err := c.ensureLiveAdapterSession(ctx, session, adapter); err != nil {
		return GoalControlResult{}, err
	}
	events, goal, err := goalAdapter.GoalControl(ctx, session, input.Action, input.Objective)
	if err != nil {
		slog.Warn("agent session goal control failed",
			"event", "agent_session.goal_control.failed",
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"action", string(input.Action),
			"error", err.Error(),
		)
		return GoalControlResult{}, err
	}
	c.applySessionEventsByAgentSessionID(session.AgentSessionID, events)
	slog.Info("agent session goal control accepted",
		"event", "agent_session.goal_control.accepted",
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"action", string(input.Action),
	)
	return GoalControlResult{AgentSessionID: session.AgentSessionID, Goal: goal}, nil
}

// execGoalControlWithActiveTurn runs a /goal control command while another
// turn holds the session's turn slot. The adapter executes it against the
// thread without opening a turn; the resulting events (steered user message,
// goal update, notice) are applied and published through the session-event
// path, and the running turn keeps owning the session lifecycle.
func (c *Controller) execGoalControlWithActiveTurn(
	ctx context.Context,
	session Session,
	adapter Adapter,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	metadata map[string]any,
) (ExecResult, bool, error) {
	goalAdapter, ok := adapter.(GoalControlAdapter)
	if !ok {
		return ExecResult{}, false, nil
	}
	events, handled, err := goalAdapter.ExecGoalControl(ctx, session, content, displayPrompt, turnID)
	slog.Info("agent session goal control with active turn",
		"event", "agent_session.goal_control.with_active_turn",
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"handled", handled,
		"event_count", len(events),
		"error", fmt.Sprintf("%v", err),
	)
	if !handled {
		return ExecResult{}, false, nil
	}
	if err != nil {
		logAgentSubmitTrace("runtime.exec.goal_control_failed", session, turnID, metadata, map[string]any{
			"error": err.Error(),
		})
		return ExecResult{}, true, err
	}
	c.applySessionEventsByAgentSessionID(session.AgentSessionID, events)
	logAgentSubmitTrace("runtime.exec.goal_control", session, turnID, metadata, map[string]any{
		"activity_event_count": len(events),
	})
	if refreshed, ok := c.get(session.RoomID, session.AgentSessionID); ok {
		session = refreshed
	}
	result := ExecResult{
		AgentSessionID: session.AgentSessionID,
		Status:         ExecStatusStarted,
		TurnID:         turnID,
		Accepted:       true,
		SessionStatus:  session.Status,
	}
	if session.TurnLifecycle != nil {
		result.TurnLifecycle = *session.TurnLifecycle
	}
	if session.SubmitAvailability != nil {
		result.SubmitAvailability = *session.SubmitAvailability
	}
	return result, true, nil
}

func (c *Controller) ensureLiveAdapterSession(ctx context.Context, session Session, adapter Adapter) error {
	probe, ok := adapter.(LiveSessionProbeAdapter)
	if !ok || probe.HasLiveSession(session) {
		return nil
	}
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		return ErrSessionDisconnected
	}
	if err := adapter.Resume(ctx, session); err != nil {
		return err
	}
	session.Status = SessionStatusReady
	session.UpdatedAtUnixMS = unixMS(now())
	c.store(session)
	if !c.publishPendingCommandSnapshot(session) {
		c.publishAdapterCommandSnapshot(session, adapter)
	}
	return nil
}

func (c *Controller) ReleaseIdleLiveSessions(ctx context.Context, input ReleaseIdleLiveSessionsInput) ReleaseIdleLiveSessionsResult {
	var result ReleaseIdleLiveSessionsResult
	if c == nil || input.IdleAfter <= 0 {
		return result
	}
	nowTime := input.Now
	if nowTime.IsZero() {
		nowTime = now()
	}
	nowUnixMS := unixMS(nowTime)
	idleAfterMS := input.IdleAfter.Milliseconds()
	if idleAfterMS <= 0 {
		return result
	}
	type candidate struct {
		session Session
		adapter Adapter
	}
	candidates := make([]candidate, 0)
	c.mu.Lock()
	for key, session := range c.sessions {
		session = c.reconcileSessionStatusLocked(key, session)
		c.sessions[key] = session
		candidates = append(candidates, candidate{
			session: session,
			adapter: c.adapters[session.Provider],
		})
	}
	c.mu.Unlock()
	for _, candidate := range candidates {
		if input.Limit > 0 && result.Scanned >= input.Limit {
			break
		}
		result.Scanned++
		result.add(c.releaseIdleLiveSession(ctx, candidate.session, candidate.adapter, nowUnixMS, idleAfterMS))
	}
	return result
}

func (c *Controller) releaseIdleLiveSession(
	ctx context.Context,
	session Session,
	adapter Adapter,
	nowUnixMS int64,
	idleAfterMS int64,
) ReleaseIdleLiveSessionsResult {
	var result ReleaseIdleLiveSessionsResult
	_, probe, ok := liveSessionReleaseAdapter(adapter)
	if !ok {
		result.SkippedUnsupported = 1
		return result
	}
	if strings.TrimSpace(session.ProviderSessionID) == "" || !probe.HasLiveSession(session) {
		result.SkippedNotLive = 1
		return result
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	_, hasActiveTurn := c.turns[key]
	c.mu.Unlock()
	if hasActiveTurn {
		result.SkippedActiveTurn = 1
		return result
	}
	if !sessionIdleFor(session, nowUnixMS, idleAfterMS) {
		result.SkippedFresh = 1
		return result
	}

	releaseLifecycleLock := c.acquireLifecycleLock(session.RoomID, session.AgentSessionID)
	defer releaseLifecycleLock()

	refreshed, adapter, err := c.sessionAndAdapter(session.RoomID, session.AgentSessionID)
	if err != nil {
		result.SkippedNotLive = 1
		return result
	}
	releaseAdapter, probe, ok := liveSessionReleaseAdapter(adapter)
	if !ok {
		result.SkippedUnsupported = 1
		return result
	}
	if strings.TrimSpace(refreshed.ProviderSessionID) == "" || !probe.HasLiveSession(refreshed) {
		result.SkippedNotLive = 1
		return result
	}
	if c.HasActiveTurn(refreshed.RoomID, refreshed.AgentSessionID) {
		result.SkippedActiveTurn = 1
		return result
	}
	if !sessionIdleFor(refreshed, nowUnixMS, idleAfterMS) {
		result.SkippedFresh = 1
		return result
	}
	if err := releaseAdapter.ReleaseLiveSession(ctx, refreshed); err != nil {
		if errors.Is(err, ErrLiveSessionBusy) {
			result.SkippedBusy = 1
			return result
		}
		result.Failed = 1
		slog.Warn("agent live session release failed",
			"event", "agent_session.live_release.failed",
			"room_id", refreshed.RoomID,
			"agent_session_id", refreshed.AgentSessionID,
			"provider", refreshed.Provider,
			"provider_session_id", refreshed.ProviderSessionID,
			"error", err.Error(),
		)
		return result
	}
	result.Released = 1
	return result
}

func liveSessionReleaseAdapter(adapter Adapter) (LiveSessionReleaseAdapter, LiveSessionProbeAdapter, bool) {
	releaseAdapter, releaseOK := adapter.(LiveSessionReleaseAdapter)
	probe, probeOK := adapter.(LiveSessionProbeAdapter)
	return releaseAdapter, probe, releaseOK && probeOK
}

// CloseAllLiveSessions force-terminates every live provider process across
// all sessions, regardless of idle time, active turns, or pending approval
// requests. Unlike ReleaseIdleLiveSessions (the periodic reaper, which only
// reclaims idle, non-busy sessions so it never interrupts work in
// progress), this exists for daemon shutdown: an OS process is not killed
// automatically just because its parent (tuttid) exits — it is reparented
// and keeps running. A provider subprocess (e.g. a Codex app-server) left
// behind here would keep running unmanaged, still able to act on the
// session's working directory, until something else notices and kills it.
// Call this once, during shutdown, before the daemon process exits.
//
// This only closes the provider-side process; it deliberately does not
// mark sessions completed or delete their records, so providers that
// support live-session resume (see LiveSessionReleaseAdapter) reconnect
// normally the next time the daemon starts and the session resumes.
func (c *Controller) CloseAllLiveSessions(ctx context.Context) CloseAllLiveSessionsResult {
	var result CloseAllLiveSessionsResult
	if c == nil {
		return result
	}
	type candidate struct {
		session Session
		adapter Adapter
	}
	c.mu.Lock()
	candidates := make([]candidate, 0, len(c.sessions))
	for _, session := range c.sessions {
		candidates = append(candidates, candidate{
			session: session,
			adapter: c.adapters[session.Provider],
		})
	}
	c.mu.Unlock()

	for _, cand := range candidates {
		probe, ok := cand.adapter.(LiveSessionProbeAdapter)
		if !ok || !probe.HasLiveSession(cand.session) {
			continue
		}
		result.Scanned++
		releaseLifecycleLock := c.acquireLifecycleLock(cand.session.RoomID, cand.session.AgentSessionID)
		err := cand.adapter.Close(ctx, cand.session)
		releaseLifecycleLock()
		if err != nil {
			result.Failed++
			slog.Warn("agent live session shutdown close failed",
				"event", "agent_session.shutdown_close.failed",
				"room_id", cand.session.RoomID,
				"agent_session_id", cand.session.AgentSessionID,
				"provider", cand.session.Provider,
				"error", err.Error(),
			)
			continue
		}
		result.Closed++
	}
	return result
}

func sessionIdleFor(session Session, nowUnixMS int64, idleAfterMS int64) bool {
	if session.UpdatedAtUnixMS <= 0 {
		return false
	}
	return nowUnixMS-session.UpdatedAtUnixMS >= idleAfterMS
}

func (r *ReleaseIdleLiveSessionsResult) add(next ReleaseIdleLiveSessionsResult) {
	r.Released += next.Released
	r.SkippedFresh += next.SkippedFresh
	r.SkippedActiveTurn += next.SkippedActiveTurn
	r.SkippedUnsupported += next.SkippedUnsupported
	r.SkippedNotLive += next.SkippedNotLive
	r.SkippedBusy += next.SkippedBusy
	r.Failed += next.Failed
}

// isResumeRecreatableError reports whether a failed resume should fall back to
// creating a fresh provider session in place. These are the "the provider
// session is not available locally" cases — anything else is a genuine failure
// that should surface to the caller.
func isResumeRecreatableError(err error) bool {
	switch AppErrorCode(err) {
	case AppErrorProviderSessionNotFound, AppErrorResumeSessionNotLocal:
		return true
	default:
		return false
	}
}

// recreateAdapterSession starts a brand new provider session for an existing
// agent session, clearing the stale provider session id so the adapter mints a
// fresh one. The new provider session id is captured from the started events and
// persisted via the session report, keeping the conversation continuable.
//
// The freshly started provider session has no memory of anything said before
// this point (e.g. an externally-imported conversation whose rollout only
// ever existed on another device, or local history retention pruning it) even
// though the transcript keeps showing the old messages joined seamlessly with
// new ones. Without an explicit notice this looks to the user like the agent
// silently forgot the conversation, so a visible system notice is appended
// alongside the started events.
func (c *Controller) recreateAdapterSession(ctx context.Context, session Session, adapter Adapter) error {
	fresh := session
	fresh.ProviderSessionID = ""
	fresh.Status = SessionStatusReady
	fresh.LastError = ""
	fresh.UpdatedAtUnixMS = unixMS(now())
	events, err := adapter.Start(ctx, fresh)
	if err != nil {
		return err
	}
	fresh = applySessionEvents(fresh, events)
	fresh.Status = SessionStatusReady
	fresh.UpdatedAtUnixMS = unixMS(now())
	if notice, ok := sessionRecreatedNoticeEvent(fresh); ok {
		events = append(events, notice)
	}
	c.store(fresh)
	c.publish(fresh, events)
	c.publishPendingConfigOptionsUpdates(fresh)
	if !c.publishPendingCommandSnapshot(fresh) {
		c.publishAdapterCommandSnapshot(fresh, adapter)
	}
	c.enqueueSessionReport(ctx, fresh, events)
	return nil
}

// sessionRecreatedNoticeEvent builds the visible system notice that
// accompanies a recreated provider session (see recreateAdapterSession). It
// reuses the same synthetic "agent_system_notice" message shape the ACP
// adapters already use for compaction/goal/transport notices
// (acpSystemNoticeEvent), so it renders through the existing generic notice
// card with no GUI changes required.
func sessionRecreatedNoticeEvent(session Session) (activityshared.Event, bool) {
	return acpSystemNoticeEvent(session, "", map[string]any{
		"sessionUpdate": "system_notice",
		"kind":          "agent_system_notice",
		"noticeKind":    "warning",
		"title":         "Conversation history could not be restored",
		"detail":        "The assistant could not resume this conversation's earlier messages locally (for example, if it was imported from another device or the local session data is no longer available), so this reply is starting fresh without that context.",
	}, "system_notice", true)
}

func (c *Controller) ValidatePromptContent(_ context.Context, input ExecInput) error {
	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return err
	}
	content := normalizeRuntimePromptContentForValidation(input.Content)
	if len(content) == 0 {
		return fmt.Errorf("prompt is required")
	}
	if promptAdapter, ok := adapter.(PromptContentAdapter); ok {
		return promptAdapter.ValidatePromptContent(session, content)
	}
	return nil
}

func (c *Controller) beginTurn(session Session, turnID string, cancel context.CancelFunc) (Session, error) {
	if c == nil {
		return Session{}, fmt.Errorf("agent session controller is unavailable")
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	session.Status = SessionStatusWorking
	session.TurnLifecycle = submittedTurnLifecycle(turnID)
	session.SubmitAvailability = blockedSubmitAvailability("active_turn")
	session.UpdatedAtUnixMS = unixMS(now())
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.turns[key]; ok {
		return Session{}, ErrSessionActiveTurn
	}
	c.sessions[key] = session
	c.turns[key] = activeTurn{turnID: turnID, cancel: cancel}
	return session, nil
}

func (c *Controller) runExecTurn(ctx context.Context, session Session, adapter Adapter, content []PromptContentBlock, displayPrompt string, turnID string) {
	if asyncAdapter, ok := adapter.(AsyncExecAdapter); ok {
		c.runAsyncExecTurn(ctx, session, asyncAdapter, content, displayPrompt, turnID)
		return
	}
	var emitted []activityshared.Event
	metadata := execMetadataFromContext(ctx)
	logAgentSubmitTrace("runtime.turn_goroutine_started", session, turnID, metadata, nil)
	emit := func(events []activityshared.Event) {
		if len(events) == 0 {
			return
		}
		session = c.foldTurnSessionEvents(session, events, turnID)
		if shouldAdvanceSessionUpdatedAtFromEvents(events) {
			session.UpdatedAtUnixMS = unixMS(now())
		}
		session = c.preserveCurrentSessionSettings(session)
		c.store(session)
		emitted = append(emitted, events...)
		c.publish(session, events)
		c.enqueueSessionReport(ctx, session, events)
		logAgentSubmitTrace("runtime.events_emitted", session, turnID, metadata, map[string]any{
			"activity_event_count": len(events),
			"session_status":       session.Status,
			"turn_phase":           turnLifecyclePhaseFromEvents(events),
		})
	}
	emitCommands := func(snapshot AgentSessionCommandSnapshot) {
		c.applyCommandSnapshot(session, snapshot)
	}
	events, err := adapter.Exec(ctx, session, content, displayPrompt, turnID, emit, emitCommands)
	shouldEmitTerminalEvents := false
	if err != nil {
		if errors.Is(err, context.Canceled) {
			events = []activityshared.Event{newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
				"error": err.Error(),
			})}
		} else {
			events = []activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", map[string]any{
				"error": err.Error(),
			})}
		}
		shouldEmitTerminalEvents = true
	}
	if err == nil {
		emit(unemittedActivityEvents(events, emitted))
	}
	if shouldEmitTerminalEvents || len(emitted) == 0 {
		emit(events)
	}
	statusEvents := events
	if len(statusEvents) == 0 {
		statusEvents = emitted
	}
	if session.LifecycleAuthority || eventsCarryAdapterLifecycleSnapshot(statusEvents) {
		session = c.foldTurnSessionEvents(session, statusEvents, "")
	} else {
		session = applySessionEvents(session, statusEvents)
		session = applyTurnLifecycleFromEvents(session, statusEvents)
		session.Status = deriveSessionStatusFromEvents(statusEvents, SessionStatusWorking)
	}
	if shouldAdvanceSessionUpdatedAtFromEvents(statusEvents) {
		session.UpdatedAtUnixMS = unixMS(now())
	}
	c.finishTurn(session, turnID)
}

func (c *Controller) runAsyncExecTurn(ctx context.Context, session Session, adapter AsyncExecAdapter, content []PromptContentBlock, displayPrompt string, turnID string) {
	metadata := execMetadataFromContext(ctx)
	logAgentSubmitTrace("runtime.async_turn_started", session, turnID, metadata, nil)
	var mu sync.Mutex
	finished := false
	finish := func(next Session) {
		if finished {
			return
		}
		finished = true
		c.finishTurn(next, turnID)
	}
	emit := func(events []activityshared.Event) {
		if len(events) == 0 {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		session = c.foldTurnSessionEvents(session, events, turnID)
		if shouldAdvanceSessionUpdatedAtFromEvents(events) {
			session.UpdatedAtUnixMS = unixMS(now())
		}
		session = c.preserveCurrentSessionSettings(session)
		c.store(session)
		c.publish(session, events)
		c.enqueueSessionReport(ctx, session, events)
		logAgentSubmitTrace("runtime.async_events_emitted", session, turnID, metadata, map[string]any{
			"activity_event_count": len(events),
			"session_status":       session.Status,
			"turn_phase":           turnLifecyclePhaseFromEvents(events),
		})
		if turnHasTerminalEvent(events, turnID) || turnSteeredIntoActiveTurn(events, turnID) {
			finish(session)
		}
	}
	emitCommands := func(snapshot AgentSessionCommandSnapshot) {
		mu.Lock()
		defer mu.Unlock()
		c.applyCommandSnapshot(session, snapshot)
	}
	if err := adapter.ExecAsync(ctx, session, content, displayPrompt, turnID, emit, emitCommands); err != nil {
		events := []activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", map[string]any{
			"error": err.Error(),
		})}
		if errors.Is(err, context.Canceled) {
			events = []activityshared.Event{newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
				"error": err.Error(),
			})}
		}
		emit(events)
	}
}

func turnHasTerminalEvent(events []activityshared.Event, turnID string) bool {
	turnID = strings.TrimSpace(turnID)
	for _, event := range events {
		if turnID != "" && strings.TrimSpace(event.Payload.TurnID) != turnID {
			continue
		}
		switch event.Type {
		case activityshared.EventTurnCompleted, activityshared.EventTurnFailed:
			return true
		default:
			if string(event.Type) == EventTurnCanceled {
				return true
			}
		}
	}
	return false
}

// turnSteeredIntoActiveTurn reports that the adapter steered this submission's
// content into an already-running provider turn (codex turn/steer): the steer
// turn id owns no provider turn, so no terminal event will ever arrive for it
// and the controller record must settle now. The blocking exec path gets this
// for free by calling finishTurn unconditionally after Exec returns.
func turnSteeredIntoActiveTurn(events []activityshared.Event, turnID string) bool {
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		return false
	}
	for _, event := range events {
		if event.Type != activityshared.EventMessageAppended || strings.TrimSpace(event.Payload.TurnID) != turnID {
			continue
		}
		if steered, ok := event.Payload.Metadata["steered"].(bool); ok && steered {
			return true
		}
	}
	return false
}

func submittedTurnLifecycle(turnID string) *TurnLifecycle {
	activeTurnID := strings.TrimSpace(turnID)
	return &TurnLifecycle{
		ActiveTurnID: &activeTurnID,
		Phase:        "submitted",
	}
}

func execMetadataFromContext(ctx context.Context) map[string]any {
	if ctx == nil {
		return nil
	}
	metadata, _ := ctx.Value(execMetadataContextKey{}).(map[string]any)
	return cloneExecMetadata(metadata)
}

func cloneExecMetadata(metadata map[string]any) map[string]any {
	if len(metadata) == 0 {
		return nil
	}
	cloned := make(map[string]any, len(metadata))
	for key, value := range metadata {
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			cloned[trimmed] = value
		}
	}
	return cloned
}

func logAgentSubmitTrace(event string, session Session, turnID string, metadata map[string]any, fields map[string]any) {
	clientSubmitID := metadataString(metadata, "clientSubmitId")
	if clientSubmitID == "" {
		return
	}
	args := []any{
		"event", "agent.submit.trace",
		"trace_event", event,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider", session.Provider,
		"provider_session_id", session.ProviderSessionID,
		"turn_id", strings.TrimSpace(turnID),
		"client_submit_id", clientSubmitID,
	}
	if submittedAt := metadataInt64(metadata, "clientSubmittedAtUnixMs"); submittedAt > 0 {
		args = append(args,
			"client_submitted_at_unix_ms", submittedAt,
			"elapsed_since_client_submit_ms", unixMS(now())-submittedAt,
		)
	}
	for key, value := range fields {
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			args = append(args, trimmed, value)
		}
	}
	slog.Info("agent submit trace", args...)
}

func metadataString(metadata map[string]any, key string) string {
	if len(metadata) == 0 {
		return ""
	}
	value, _ := metadata[key].(string)
	return strings.TrimSpace(value)
}

func metadataInt64(metadata map[string]any, key string) int64 {
	if len(metadata) == 0 {
		return 0
	}
	switch value := metadata[key].(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	case json.Number:
		parsed, _ := value.Int64()
		return parsed
	default:
		return 0
	}
}

func turnLifecyclePhaseFromEvents(events []activityshared.Event) string {
	for _, event := range events {
		if phase := turnLifecyclePhaseFromEvent(event); phase != "" {
			return phase
		}
	}
	return ""
}

func blockedSubmitAvailability(reason string) *SubmitAvailability {
	return &SubmitAvailability{
		State:  "blocked",
		Reason: strings.TrimSpace(reason),
	}
}

func availableSubmitAvailability() *SubmitAvailability {
	return &SubmitAvailability{State: "available"}
}

func submittedTurnActivityEvents(session Session, turnID string) []activityshared.Event {
	ctx, ok := activityEventContext(session, "turn-submitted:"+turnID, turnID)
	if !ok {
		return nil
	}
	event := activityshared.NewTurnUpdated(ctx, turnID, activityshared.TurnPhaseSubmitted)
	// The controller owns the submit moment; it publishes the submitted
	// lifecycle snapshot so downstream layers copy instead of recomputing
	// (ADR 0008).
	activityshared.StampTurnLifecycleSnapshot(&event, activityshared.TurnLifecycleSnapshot{
		Origin:       activityshared.TurnLifecycleOriginController,
		ActiveTurnID: turnID,
		Phase:        string(activityshared.TurnPhaseSubmitted),
	})
	return []activityshared.Event{event}
}

// eventsCarryAdapterLifecycleSnapshot reports whether the batch contains an
// adapter-origin lifecycle snapshot — the signal that this session's provider
// publishes authoritative snapshots (ADR 0008).
func eventsCarryAdapterLifecycleSnapshot(events []activityshared.Event) bool {
	for _, event := range events {
		if snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(event); ok &&
			snapshot.Origin == activityshared.TurnLifecycleOriginAdapter {
			return true
		}
	}
	return false
}

// applyTurnLifecycleSnapshots copies stamped lifecycle snapshots onto the
// session record. Consumers copy, never merge: the snapshot is the turn
// owner's full statement of the lifecycle at that moment.
func applyTurnLifecycleSnapshots(session Session, events []activityshared.Event) Session {
	for _, event := range events {
		snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(event)
		if !ok {
			continue
		}
		session = applyTurnLifecycleSnapshot(session, snapshot, strings.TrimSpace(event.Payload.TurnID))
	}
	return session
}

func applyTurnLifecycleSnapshot(session Session, snapshot activityshared.TurnLifecycleSnapshot, eventTurnID string) Session {
	switch snapshot.Origin {
	case activityshared.TurnLifecycleOriginAdapter:
		// Snapshots reach the record over two channels (Exec emit closure and
		// the session event sink); drop anything older than what we applied.
		if snapshot.Seq != 0 && snapshot.Seq <= session.LifecycleSeq {
			return session
		}
		session.LifecycleSeq = snapshot.Seq
		session.LifecycleAuthority = true
	case activityshared.TurnLifecycleOriginController:
		// The controller only authors the submit moment and the settle
		// fallback; neither may clobber a different live provider turn.
		if session.TurnLifecycle != nil && session.TurnLifecycle.ActiveTurnID != nil {
			current := strings.TrimSpace(*session.TurnLifecycle.ActiveTurnID)
			if runtimeTurnLifecyclePhaseIsLive(session.TurnLifecycle.Phase) &&
				current != "" &&
				current != strings.TrimSpace(snapshot.ActiveTurnID) &&
				current != eventTurnID {
				return session
			}
		}
	default:
		return session
	}
	lifecycle := TurnLifecycle{Phase: snapshot.Phase, Settling: snapshot.Settling}
	if turnID := strings.TrimSpace(snapshot.ActiveTurnID); turnID != "" {
		lifecycle.ActiveTurnID = &turnID
	}
	if outcome := strings.TrimSpace(snapshot.Outcome); outcome != "" {
		lifecycle.Outcome = &outcome
	}
	session.TurnLifecycle = &lifecycle
	return session
}

// sessionLevelStatusFromEvents extracts the genuinely session-scoped status
// signals from a batch: session failure/completion and explicit effective
// statuses. Unlike the legacy fold it never defaults an unknown or empty
// effective status to ready — for authority sessions readiness is derived
// from the lifecycle, not from metadata refreshes.
func sessionLevelStatusFromEvents(events []activityshared.Event) string {
	status := ""
	for _, event := range events {
		switch event.Type {
		case activityshared.EventSessionFailed:
			status = SessionStatusFailed
		case activityshared.EventSessionCompleted:
			status = SessionStatusCompleted
		case activityshared.EventSessionUpdated:
			switch strings.TrimSpace(event.Payload.EffectiveStatus) {
			case string(activityshared.SessionStatusWorking):
				status = SessionStatusWorking
			case string(activityshared.SessionStatusWaiting):
				status = SessionStatusWaiting
			case string(activityshared.SessionStatusCompleted):
				status = SessionStatusCompleted
			case string(activityshared.SessionStatusFailed):
				status = SessionStatusFailed
			case string(activityshared.SessionStatusPaused):
				status = SessionStatusCanceled
			}
		}
	}
	return status
}

// statusForAuthoritySession is THE status derivation for snapshot-authority
// sessions: a pure function of the copied lifecycle plus session-level
// signals. No other code path may write Status for these sessions.
func statusForAuthoritySession(session Session, batchSessionLevel string) string {
	if batchSessionLevel == SessionStatusFailed || batchSessionLevel == SessionStatusCompleted {
		return batchSessionLevel
	}
	lifecycle := session.TurnLifecycle
	if lifecycle != nil && runtimeTurnLifecyclePhaseIsLive(lifecycle.Phase) {
		if activityshared.TurnLifecyclePhaseIsWaiting(lifecycle.Phase) {
			return SessionStatusWaiting
		}
		return SessionStatusWorking
	}
	if sessionHasLiveBackgroundAgents(session) {
		return SessionStatusWorking
	}
	if lifecycle != nil && lifecycle.Phase == "settled" {
		if lifecycle.Outcome != nil {
			switch strings.TrimSpace(*lifecycle.Outcome) {
			case string(activityshared.TurnOutcomeFailed):
				return SessionStatusFailed
			case string(activityshared.TurnOutcomeInterrupted), "canceled":
				return SessionStatusCanceled
			}
		}
		return SessionStatusReady
	}
	if batchSessionLevel != "" {
		return batchSessionLevel
	}
	if current := strings.TrimSpace(session.Status); current != "" {
		return current
	}
	return SessionStatusReady
}

// submitAvailabilityForAuthoritySession derives SubmitAvailability from the
// same copied lifecycle, replacing the hand-written variants that used to
// live in the lifecycle fold, the reporter's codex patch path, and the
// reconcile.
func submitAvailabilityForAuthoritySession(session Session) *SubmitAvailability {
	lifecycle := session.TurnLifecycle
	if lifecycle != nil && runtimeTurnLifecyclePhaseIsLive(lifecycle.Phase) {
		if activityshared.TurnLifecyclePhaseIsWaiting(lifecycle.Phase) {
			return blockedSubmitAvailability("waiting")
		}
		return blockedSubmitAvailability("active_turn")
	}
	if sessionHasLiveBackgroundAgents(session) {
		return blockedSubmitAvailability("background_agent")
	}
	return availableSubmitAvailability()
}

// foldTurnSessionEvents applies an emitted turn event batch to the session
// record. Snapshot-authority sessions copy lifecycle snapshots and derive
// Status/SubmitAvailability purely (ADR 0008); legacy sessions keep the
// historic folding path until their provider publishes snapshots (Phase B).
func (c *Controller) foldTurnSessionEvents(session Session, events []activityshared.Event, execTurnID string) Session {
	previousStatus := session.Status
	if session.LifecycleAuthority || eventsCarryAdapterLifecycleSnapshot(events) {
		session = applySessionEventsBase(session, events)
		session = applyTurnLifecycleSnapshots(session, events)
		session.Status = statusForAuthoritySession(session, sessionLevelStatusFromEvents(events))
		session.SubmitAvailability = submitAvailabilityForAuthoritySession(session)
		return session
	}
	session = applySessionEvents(session, events)
	session = applyTurnLifecycleFromEvents(session, events)
	if turnEventsAreTerminal(events) {
		session = reconcileFinishedTurnStatus(session)
	} else if execTurnID != "" {
		session = c.preserveActiveTurnStatus(session, execTurnID, previousStatus)
	}
	return session
}

func applyTurnLifecycleFromEvents(session Session, events []activityshared.Event) Session {
	for _, event := range events {
		phase := turnLifecyclePhaseFromEvent(event)
		if phase == "" {
			continue
		}
		turnID := strings.TrimSpace(event.Payload.TurnID)
		if turnID == "" {
			continue
		}
		lifecycle := TurnLifecycle{Phase: phase}
		if phase == "settled" {
			outcome := turnLifecycleOutcomeFromEvent(event)
			if outcome != "" {
				lifecycle.Outcome = &outcome
			}
			session.SubmitAvailability = availableSubmitAvailability()
		} else {
			activeTurnID := turnID
			lifecycle.ActiveTurnID = &activeTurnID
			if phase == "waiting" {
				session.SubmitAvailability = blockedSubmitAvailability("waiting")
			} else {
				session.SubmitAvailability = blockedSubmitAvailability("active_turn")
			}
		}
		session.TurnLifecycle = &lifecycle
	}
	return session
}

func turnLifecyclePhaseFromEvent(event activityshared.Event) string {
	switch event.Type {
	case activityshared.EventTurnStarted:
		return "running"
	case activityshared.EventTurnUpdated:
		switch strings.TrimSpace(event.Payload.TurnPhase) {
		case "submitted":
			return "submitted"
		case string(activityshared.TurnPhaseWaiting), string(activityshared.TurnPhaseWaitingApproval), string(activityshared.TurnPhaseWaitingInput):
			return "waiting"
		case string(activityshared.TurnPhaseRunning), string(activityshared.TurnPhaseWorking):
			return "running"
		}
	case activityshared.EventTurnCompleted, activityshared.EventTurnFailed:
		return "settled"
	default:
		if string(event.Type) == EventTurnCanceled {
			return "settled"
		}
	}
	return ""
}

func turnLifecycleOutcomeFromEvent(event activityshared.Event) string {
	switch event.Type {
	case activityshared.EventTurnFailed:
		return "failed"
	case activityshared.EventTurnCompleted:
		if strings.TrimSpace(event.Payload.TurnOutcome) == string(activityshared.TurnOutcomeInterrupted) {
			return "canceled"
		}
		return "completed"
	default:
		if string(event.Type) == EventTurnCanceled {
			return "canceled"
		}
		return strings.TrimSpace(event.Payload.TurnOutcome)
	}
}

func cloneRuntimeSubmitAvailability(value *SubmitAvailability) *SubmitAvailability {
	if value == nil {
		return nil
	}
	return &SubmitAvailability{
		State:  strings.TrimSpace(value.State),
		Reason: strings.TrimSpace(value.Reason),
	}
}

func cloneRuntimeCompletedCommand(value *CompletedCommand) *CompletedCommand {
	if value == nil {
		return nil
	}
	return &CompletedCommand{
		Kind:   strings.TrimSpace(value.Kind),
		Status: strings.TrimSpace(value.Status),
	}
}

func cloneRuntimeTurnLifecycle(value *TurnLifecycle) *TurnLifecycle {
	if value == nil {
		return nil
	}
	var activeTurnID *string
	if value.ActiveTurnID != nil {
		active := strings.TrimSpace(*value.ActiveTurnID)
		activeTurnID = &active
	}
	var outcome *string
	if value.Outcome != nil {
		next := strings.TrimSpace(*value.Outcome)
		outcome = &next
	}
	return &TurnLifecycle{
		ActiveTurnID:     activeTurnID,
		Phase:            strings.TrimSpace(value.Phase),
		Settling:         value.Settling,
		Outcome:          outcome,
		CompletedCommand: cloneRuntimeCompletedCommand(value.CompletedCommand),
	}
}

func (c *Controller) preserveActiveTurnStatus(session Session, turnID string, previousStatus string) Session {
	if c == nil || session.Status != SessionStatusReady {
		return session
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	active, ok := c.turns[key]
	c.mu.Unlock()
	if ok && active.turnID == turnID {
		session.Status = firstNonEmpty(previousStatus, SessionStatusWorking)
	}
	return session
}

func (c *Controller) preserveCurrentSessionSettings(session Session) Session {
	if c == nil {
		return session
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.preserveCurrentSessionSettingsLocked(key, session)
}

func (c *Controller) preserveCurrentSessionSettingsLocked(key string, session Session) Session {
	if c == nil {
		return session
	}
	current, ok := c.sessions[key]
	if !ok ||
		strings.TrimSpace(current.RoomID) != strings.TrimSpace(session.RoomID) ||
		strings.TrimSpace(current.AgentSessionID) != strings.TrimSpace(session.AgentSessionID) ||
		strings.TrimSpace(current.Provider) != strings.TrimSpace(session.Provider) {
		return session
	}
	session.PermissionModeID = strings.TrimSpace(current.PermissionModeID)
	if current.Settings != nil {
		settings := normalizeSessionSettings(current.Settings, current.Provider, session.PermissionModeID)
		session.Settings = cloneSessionSettings(settings)
	} else {
		session.Settings = nil
	}
	session.RuntimeContext = runtimeContextWithSessionSettings(session.RuntimeContext, session.SettingsValue())
	return session
}

func runtimeContextWithSessionSettings(runtimeContext map[string]any, settings SessionSettings) map[string]any {
	next := clonePayload(runtimeContext)
	if next == nil {
		next = map[string]any{}
	}
	next["permissionModeId"] = strings.TrimSpace(settings.PermissionModeID)
	next["planMode"] = settings.PlanMode
	next["model"] = strings.TrimSpace(settings.Model)
	next["reasoningEffort"] = strings.TrimSpace(settings.ReasoningEffort)
	next["speed"] = strings.TrimSpace(settings.Speed)
	return next
}

func sessionHasDifferentLiveTurn(session Session, turnID string) bool {
	if !sessionHasLiveTurnLifecycle(session) {
		return false
	}
	return runtimeTurnLifecycleActiveTurnID(session.TurnLifecycle) != strings.TrimSpace(turnID)
}

func settleFinishedTurnLifecycle(session Session, turnID string) Session {
	if session.TurnLifecycle == nil {
		return session
	}
	if runtimeTurnLifecycleActiveTurnID(session.TurnLifecycle) != strings.TrimSpace(turnID) {
		return session
	}
	if !runtimeTurnLifecyclePhaseIsLive(session.TurnLifecycle.Phase) {
		return session
	}
	outcome := "completed"
	if session.TurnLifecycle.Outcome != nil && strings.TrimSpace(*session.TurnLifecycle.Outcome) != "" {
		outcome = strings.TrimSpace(*session.TurnLifecycle.Outcome)
	}
	session.TurnLifecycle = &TurnLifecycle{
		Phase:            "settled",
		Outcome:          &outcome,
		CompletedCommand: cloneRuntimeCompletedCommand(session.TurnLifecycle.CompletedCommand),
	}
	session.SubmitAvailability = availableSubmitAvailability()
	return session
}

func sessionHasLiveTurnLifecycle(session Session) bool {
	if session.TurnLifecycle == nil {
		return false
	}
	return runtimeTurnLifecycleActiveTurnID(session.TurnLifecycle) != "" &&
		runtimeTurnLifecyclePhaseIsLive(session.TurnLifecycle.Phase)
}

func sessionHasLiveBackgroundAgents(session Session) bool {
	backgroundAgents := payloadMap(session.RuntimeContext, "backgroundAgents")
	if len(backgroundAgents) == 0 {
		return false
	}
	if metadataInt64(backgroundAgents, "count") > 0 {
		return true
	}
	items, _ := backgroundAgents["items"].([]any)
	for _, item := range items {
		agent := payloadMap(map[string]any{"item": item}, "item")
		if len(agent) == 0 {
			continue
		}
		status := firstNonEmptyString(payloadString(agent, "status"), string(activityshared.ActivityStatusRunning))
		if !claudeSDKBackgroundAgentStatusIsTerminal(status) {
			return true
		}
	}
	return false
}

func runtimeTurnLifecycleActiveTurnID(value *TurnLifecycle) string {
	if value == nil || value.ActiveTurnID == nil {
		return ""
	}
	return strings.TrimSpace(*value.ActiveTurnID)
}

func runtimeTurnLifecyclePhaseIsLive(phase string) bool {
	// Delegates to the canonical predicate; the phase vocabulary lives in
	// exactly one place (activityshared, mirrored in activity-core for TS).
	return activityshared.TurnLifecyclePhaseIsLive(phase)
}

func unemittedActivityEvents(events []activityshared.Event, emitted []activityshared.Event) []activityshared.Event {
	if len(events) == 0 {
		return nil
	}
	if len(emitted) == 0 {
		return events
	}
	seen := make(map[string]struct{}, len(emitted))
	for _, event := range emitted {
		seen[activityEventIdentity(event)] = struct{}{}
	}
	out := make([]activityshared.Event, 0, len(events))
	for _, event := range events {
		if _, ok := seen[activityEventIdentity(event)]; ok {
			continue
		}
		out = append(out, event)
	}
	return out
}

func activityEventIdentity(event activityshared.Event) string {
	if event.EventID != "" {
		return event.EventID
	}
	return fmt.Sprintf(
		"%s\x00%s\x00%s\x00%s\x00%d",
		event.Type,
		event.AgentSessionID,
		event.ProviderSessionID,
		event.Payload.TurnID,
		event.OccurredAtUnixMS,
	)
}

func (c *Controller) finishTurn(session Session, turnID string) {
	if c == nil {
		return
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	if active, ok := c.turns[key]; ok && active.turnID == turnID {
		delete(c.turns, key)
	}
	if current, ok := c.sessions[key]; ok && sessionHasDifferentLiveTurn(current, turnID) {
		c.mu.Unlock()
		return
	}
	session = c.preserveCurrentSessionSettingsLocked(key, session)
	if session.LifecycleAuthority {
		// ADR 0008: no silent record mutation. If the adapter already settled
		// this turn via its snapshot, nothing is left to do; otherwise (steer
		// absorption, adapter death before settle) publish a controller-origin
		// settled snapshot so even the fallback flows through the single copy
		// pipeline — and reaches reporter/GUI, unlike the old silent write.
		needsFallback := session.TurnLifecycle != nil &&
			session.TurnLifecycle.ActiveTurnID != nil &&
			strings.TrimSpace(*session.TurnLifecycle.ActiveTurnID) == strings.TrimSpace(turnID) &&
			runtimeTurnLifecyclePhaseIsLive(session.TurnLifecycle.Phase)
		c.sessions[key] = session
		c.mu.Unlock()
		if needsFallback {
			c.applySessionEventsByAgentSessionID(session.AgentSessionID, settledFallbackTurnEvents(session, turnID))
		}
		return
	}
	session = settleFinishedTurnLifecycle(session, turnID)
	session = c.reconcileSessionStatusLocked(key, session)
	c.sessions[key] = session
	c.mu.Unlock()
}

// sessionViewHasUnsettledTurn reports whether the GUI-facing session view still
// presents an active or blocked turn. It is used to detect a desync where the
// runtime has already finished a turn but the persisted/streamed view never
// settled (composer stays blocked, stop button stays inert).
func sessionViewHasUnsettledTurn(session Session) bool {
	if sa := session.SubmitAvailability; sa != nil && strings.TrimSpace(sa.State) == "blocked" {
		return true
	}
	if tl := session.TurnLifecycle; tl != nil {
		if tl.ActiveTurnID != nil && strings.TrimSpace(*tl.ActiveTurnID) != "" {
			return true
		}
		if phase := strings.TrimSpace(tl.Phase); phase != "" && phase != "settled" {
			return true
		}
	}
	return false
}

// settledFallbackTurnEvents builds the controller-origin settled snapshot the
// finishTurn fallback publishes when the adapter never settled the turn it
// owns (for example a submission absorbed by steering).
func settledFallbackTurnEvents(session Session, turnID string) []activityshared.Event {
	ctx, ok := activityEventContext(session, "turn-settled:"+turnID, turnID)
	if !ok {
		return nil
	}
	event := activityshared.NewTurnUpdated(ctx, turnID, activityshared.TurnPhaseIdle)
	activityshared.StampTurnLifecycleSnapshot(&event, activityshared.TurnLifecycleSnapshot{
		Origin:  activityshared.TurnLifecycleOriginController,
		Phase:   "settled",
		Outcome: string(activityshared.TurnOutcomeCompleted),
	})
	return []activityshared.Event{event}
}

// reconcileStuckTurnView force settles a session whose GUI-facing view still
// shows an active/blocked turn even though the runtime holds no active turn for
// it. It synthesizes a settle event and pushes it through the same atomic
// apply -> store -> publish -> report pipeline as every other reconciliation
// path (applySessionEventsByAgentSessionID), so:
//   - a snapshot-authority session (ADR 0008, session.LifecycleAuthority) is
//     settled via the same controller-origin stamped snapshot finishTurn's
//     fallback uses, honoring "copy, never merge" instead of hand-writing
//     TurnLifecycle directly; and
//   - the settle is applied to whatever session is CURRENT at the time of the
//     atomic read, not the possibly-stale snapshot captured earlier in Cancel
//     (a direct c.store of the stale snapshot could otherwise resurrect state
//     a concurrent event already moved past).
//
// Returns true when a reconciliation was performed.
func (c *Controller) reconcileStuckTurnView(_ context.Context, session Session, reason string) bool {
	if c == nil || !sessionViewHasUnsettledTurn(session) {
		return false
	}
	turnID := ""
	if tl := session.TurnLifecycle; tl != nil && tl.ActiveTurnID != nil {
		turnID = strings.TrimSpace(*tl.ActiveTurnID)
	}
	if turnID == "" {
		return false
	}
	var events []activityshared.Event
	if session.LifecycleAuthority {
		events = settledFallbackTurnEvents(session, turnID)
	} else {
		event := newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", map[string]any{
			"reconciled": "cancel-no-active-turn",
		})
		if event.Type != "" {
			events = []activityshared.Event{event}
		}
	}
	if len(events) == 0 {
		return false
	}
	c.applySessionEventsByAgentSessionID(session.AgentSessionID, events)
	slog.Info("agent session cancel reconciled stuck turn view",
		"event", "agent_session.cancel.reconciled_stuck_turn",
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider", session.Provider,
		"turn_id", turnID,
		"lifecycle_authority", session.LifecycleAuthority,
		"reason", reason,
	)
	return true
}

func (c *Controller) Cancel(ctx context.Context, input CancelInput) (CancelResult, error) {
	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return CancelResult{}, err
	}
	reason := strings.TrimSpace(input.Reason)
	slog.Info("agent session cancel requested",
		"event", "agent_session.cancel.requested",
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider", session.Provider,
		"status", session.Status,
		"reason", reason,
	)
	active, ok := c.activeTurn(session.RoomID, session.AgentSessionID)
	if !ok {
		// No controller turn record - but the runtime may own cancellable
		// work the registry does not know about (linked child agents that
		// outlive their parent turn, or a desynced turn record). Reconcile
		// with the adapter instead of skipping: the turn machine answers
		// no-op cancels safely, and anything it actually stopped surfaces
		// as events.
		events, err := adapter.Cancel(ctx, session, reason)
		if err != nil && errors.Is(err, ErrSessionNoActiveTurn) {
			// The adapter's way of answering "nothing was running" - the
			// reconcile found no runtime work either.
			err = nil
		}
		if err != nil {
			slog.Warn("agent session cancel adapter failed without active turn",
				"event", "agent_session.cancel.reconcile_failed",
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider", session.Provider,
				"reason", reason,
				"error", err.Error(),
			)
			return CancelResult{}, err
		}
		if len(events) > 0 {
			// Apply to the CURRENT stored session (atomic read-apply-store):
			// the turn may have settled and stored a newer session while
			// adapter.Cancel blocked; applying to this call's pre-cancel
			// snapshot would resurrect the working/running state and wedge
			// the GUI in a permanent spinner.
			c.applySessionEventsByAgentSessionID(session.AgentSessionID, events)
			slog.Info("agent session cancel reconciled runtime work without a turn record",
				"event", "agent_session.cancel.reconciled",
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider", session.Provider,
				"reason", reason,
				"event_count", len(events),
			)
			return CancelResult{AgentSessionID: session.AgentSessionID, Canceled: true}, nil
		}
		slog.Info("agent session cancel found nothing to stop",
			"event", "agent_session.cancel.nothing_to_stop",
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider", session.Provider,
			"status", session.Status,
			"reason", reason,
		)
		// The runtime holds no active turn, yet the GUI-facing view may still
		// show a blocked composer / running turn if a prior turn-completed
		// update failed to reach the persisted session state. Pressing stop is
		// the user's recovery gesture, so reconcile the stale view by force
		// settling the turn here instead of leaving it stuck forever.
		c.reconcileStuckTurnView(ctx, session, reason)
		return CancelResult{AgentSessionID: session.AgentSessionID, Canceled: false}, nil
	}
	if active.cancel != nil {
		active.cancel()
	}
	events, err := adapter.Cancel(ctx, session, reason)
	if err != nil {
		if errors.Is(err, ErrSessionNoActiveTurn) {
			c.clearActiveTurnIfMatches(session.RoomID, session.AgentSessionID, active.turnID)
			current, ok := c.get(session.RoomID, session.AgentSessionID)
			if !ok {
				current = session
			}
			reconciled := c.reconcileStuckTurnView(ctx, current, reason)
			canceled := sessionCancelAlreadySettledCanceled(current)
			slog.Info("agent session cancel raced with settled turn",
				"event", "agent_session.cancel.settle_race",
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider", session.Provider,
				"turn_id", active.turnID,
				"reason", reason,
				"reconciled", reconciled,
				"canceled", canceled,
			)
			return CancelResult{AgentSessionID: session.AgentSessionID, Canceled: canceled}, nil
		}
		slog.Warn("agent session cancel adapter failed",
			"event", "agent_session.cancel.adapter_failed",
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider", session.Provider,
			"turn_id", active.turnID,
			"reason", reason,
			"error", err.Error(),
		)
		return CancelResult{}, err
	}
	if len(events) > 0 {
		// interruptActiveTurn returns only after the turn actually settled,
		// so the turn's terminal store always lands during adapter.Cancel;
		// apply these events to the CURRENT stored session instead of this
		// call's pre-cancel snapshot (which would resurrect working state).
		c.applySessionEventsByAgentSessionID(session.AgentSessionID, events)
	}
	slog.Info("agent session cancel accepted",
		"event", "agent_session.cancel.accepted",
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider", session.Provider,
		"turn_id", active.turnID,
		"reason", reason,
	)
	return CancelResult{AgentSessionID: session.AgentSessionID, Canceled: true}, nil
}

func sessionCancelAlreadySettledCanceled(session Session) bool {
	if strings.TrimSpace(session.Status) == SessionStatusCanceled {
		return true
	}
	if session.TurnLifecycle != nil && session.TurnLifecycle.Outcome != nil {
		outcome := strings.ToLower(strings.TrimSpace(*session.TurnLifecycle.Outcome))
		return outcome == "canceled" || outcome == "cancelled" || outcome == string(activityshared.TurnOutcomeInterrupted)
	}
	return false
}

func (c *Controller) cancelActiveTurn(roomID, agentSessionID string) {
	if c == nil {
		return
	}
	key := sessionKey(strings.TrimSpace(roomID), strings.TrimSpace(agentSessionID))
	c.mu.Lock()
	active, ok := c.turns[key]
	c.mu.Unlock()
	if ok && active.cancel != nil {
		active.cancel()
	}
}

func (c *Controller) clearActiveTurnIfMatches(roomID, agentSessionID, turnID string) {
	if c == nil {
		return
	}
	key := sessionKey(strings.TrimSpace(roomID), strings.TrimSpace(agentSessionID))
	turnID = strings.TrimSpace(turnID)
	c.mu.Lock()
	defer c.mu.Unlock()
	if active, ok := c.turns[key]; ok && strings.TrimSpace(active.turnID) == turnID {
		delete(c.turns, key)
	}
}

func (c *Controller) activeTurn(roomID, agentSessionID string) (activeTurn, bool) {
	if c == nil {
		return activeTurn{}, false
	}
	key := sessionKey(strings.TrimSpace(roomID), strings.TrimSpace(agentSessionID))
	c.mu.Lock()
	defer c.mu.Unlock()
	active, ok := c.turns[key]
	return active, ok
}

func (c *Controller) reconcileSessionStatusLocked(key string, session Session) Session {
	if c == nil {
		return session
	}
	if _, hasActiveTurn := c.turns[key]; hasActiveTurn {
		return session
	}
	if sessionHasLiveTurnLifecycle(session) {
		return session
	}
	return reconcileFinishedTurnStatus(session)
}

func reconcileFinishedTurnStatus(session Session) Session {
	if sessionHasLiveTurnLifecycle(session) {
		return session
	}
	if sessionHasLiveBackgroundAgents(session) {
		session.Status = SessionStatusWorking
		session.SubmitAvailability = blockedSubmitAvailability("background_agent")
		return session
	}
	if session.Status == SessionStatusWorking {
		session.Status = SessionStatusReady
	}
	return session
}

func turnEventsAreTerminal(events []activityshared.Event) bool {
	for _, event := range events {
		switch event.Type {
		case activityshared.EventTurnCompleted, activityshared.EventTurnFailed:
			return true
		}
	}
	return false
}

func (c *Controller) UpdateSettings(ctx context.Context, input UpdateSettingsInput) (UpdateSettingsResult, error) {
	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return UpdateSettingsResult{}, err
	}
	nextSession := session
	settings := normalizeSessionSettings(nextSession.Settings, nextSession.Provider, nextSession.PermissionModeID)
	if input.Settings.Model != nil {
		settings.Model = strings.TrimSpace(*input.Settings.Model)
	}
	if input.Settings.ReasoningEffort != nil {
		settings.ReasoningEffort = strings.TrimSpace(*input.Settings.ReasoningEffort)
	}
	if input.Settings.Speed != nil {
		settings.Speed = strings.TrimSpace(*input.Settings.Speed)
	}
	if input.Settings.PlanMode != nil {
		settings.PlanMode = *input.Settings.PlanMode
	}
	if input.Settings.BrowserUse != nil {
		value := *input.Settings.BrowserUse
		settings.BrowserUse = &value
	}
	if input.Settings.ComputerUse != nil {
		value := *input.Settings.ComputerUse
		settings.ComputerUse = &value
	}
	permissionChanged := false
	if input.Settings.PermissionModeID != nil {
		normalized := normalizePermissionModeIDWithFallback(
			nextSession.Provider,
			strings.TrimSpace(*input.Settings.PermissionModeID),
			nextSession.PermissionModeID,
		)
		permissionChanged = normalized != nextSession.PermissionModeID
		settings.PermissionModeID = normalized
		nextSession.PermissionModeID = normalized
	}
	nextSession.Settings = cloneSessionSettings(settings)
	if newSessionAdapter, ok := adapter.(NewSessionSettingsAdapter); ok && newSessionAdapter.RequiresNewSessionForSettings(session, input.Settings) {
		return UpdateSettingsResult{}, ErrSessionSettingsRequireNewSession
	}
	if permissionChanged {
		if permissionAdapter, ok := adapter.(PermissionModeAdapter); ok {
			if err := permissionAdapter.ApplyPermissionMode(ctx, nextSession); err != nil {
				return UpdateSettingsResult{}, err
			}
		}
	}
	if liveSettingsAdapter, ok := adapter.(LiveSettingsAdapter); ok {
		if err := liveSettingsAdapter.ApplySessionSettings(ctx, nextSession, input.Settings); err != nil {
			return UpdateSettingsResult{}, err
		}
	}
	c.store(nextSession)
	return UpdateSettingsResult{
		AgentSessionID: nextSession.AgentSessionID,
		Settings:       settings,
	}, nil
}

func shouldAdvanceSessionUpdatedAtFromEvents(events []activityshared.Event) bool {
	for _, event := range events {
		switch event.Type {
		case activityshared.EventTurnStarted,
			activityshared.EventTurnCompleted,
			activityshared.EventTurnFailed:
			return true
		case activityshared.EventTurnUpdated:
			switch strings.TrimSpace(event.Payload.TurnPhase) {
			case string(activityshared.TurnPhaseWaitingApproval),
				string(activityshared.TurnPhaseWaitingInput),
				string(activityshared.SessionStatusWaiting):
				return true
			}
		}
	}
	return false
}

func (c *Controller) State(roomID, agentSessionID string) (SessionStateSnapshot, error) {
	session, adapter, err := c.sessionAndAdapter(roomID, agentSessionID)
	if err != nil {
		return SessionStateSnapshot{}, err
	}
	snapshot := SessionStateSnapshot{
		RoomID:             session.RoomID,
		AgentSessionID:     session.AgentSessionID,
		AgentTargetID:      session.AgentTargetID,
		Provider:           session.Provider,
		ProviderSessionID:  session.ProviderSessionID,
		Status:             session.Status,
		TurnLifecycle:      cloneRuntimeTurnLifecycle(session.TurnLifecycle),
		SubmitAvailability: cloneRuntimeSubmitAvailability(session.SubmitAvailability),
		PermissionModeID:   session.PermissionModeID,
		Settings:           normalizeOptionalSessionSettings(session.Settings, session.Provider, session.PermissionModeID),
		RuntimeContext: map[string]any{
			"cwd":              session.CWD,
			"title":            session.Title,
			"permissionModeId": session.PermissionModeID,
			"visible":          session.Visible,
		},
		UpdatedAtUnixMS: session.UpdatedAtUnixMS,
	}
	if snapshot.Settings != nil {
		snapshot.RuntimeContext["model"] = snapshot.Settings.Model
		snapshot.RuntimeContext["reasoningEffort"] = snapshot.Settings.ReasoningEffort
		snapshot.RuntimeContext["speed"] = snapshot.Settings.Speed
		snapshot.RuntimeContext["planMode"] = snapshot.Settings.PlanMode
	}
	if stateAdapter, ok := adapter.(StateAdapter); ok {
		override := stateAdapter.SessionState(session)
		if override.RoomID != "" {
			snapshot.RoomID = override.RoomID
		}
		if override.AgentSessionID != "" {
			snapshot.AgentSessionID = override.AgentSessionID
		}
		if override.AgentTargetID != "" {
			snapshot.AgentTargetID = override.AgentTargetID
		}
		if override.Provider != "" {
			snapshot.Provider = override.Provider
		}
		if override.ProviderSessionID != "" {
			snapshot.ProviderSessionID = override.ProviderSessionID
		}
		if override.Status != "" {
			snapshot.Status = override.Status
		}
		if override.TurnLifecycle != nil {
			snapshot.TurnLifecycle = cloneRuntimeTurnLifecycle(override.TurnLifecycle)
		}
		if override.SubmitAvailability != nil {
			snapshot.SubmitAvailability = cloneRuntimeSubmitAvailability(override.SubmitAvailability)
		}
		if override.PermissionModeID != "" {
			snapshot.PermissionModeID = normalizePermissionModeIDWithFallback(
				session.Provider,
				override.PermissionModeID,
				snapshot.PermissionModeID,
			)
		}
		if override.Settings != nil {
			snapshot.Settings = normalizeOptionalSessionSettings(override.Settings, session.Provider, snapshot.PermissionModeID)
		}
		if override.AuthState != "" {
			snapshot.AuthState = override.AuthState
		}
		if override.RuntimeContext != nil {
			snapshot.RuntimeContext = override.RuntimeContext
		}
		if override.PendingInteractive != nil {
			snapshot.PendingInteractive = override.PendingInteractive
		}
		if override.UpdatedAtUnixMS > 0 {
			snapshot.UpdatedAtUnixMS = override.UpdatedAtUnixMS
		}
	}
	if snapshot.RuntimeContext == nil {
		snapshot.RuntimeContext = map[string]any{}
	}
	snapshot.RuntimeContext["permissionModeId"] = snapshot.PermissionModeID
	snapshot.RuntimeContext["visible"] = session.Visible
	if snapshot.Settings != nil {
		snapshot.RuntimeContext["model"] = snapshot.Settings.Model
		snapshot.RuntimeContext["reasoningEffort"] = snapshot.Settings.ReasoningEffort
		snapshot.RuntimeContext["speed"] = snapshot.Settings.Speed
		snapshot.RuntimeContext["planMode"] = snapshot.Settings.PlanMode
	}
	return snapshot, nil
}

func (c *Controller) sessionStateSnapshot(session Session) SessionStateSnapshot {
	snapshot, err := c.State(session.RoomID, session.AgentSessionID)
	if err == nil {
		return snapshot
	}
	return SessionStateSnapshot{
		RoomID:            session.RoomID,
		AgentSessionID:    session.AgentSessionID,
		AgentTargetID:     session.AgentTargetID,
		Provider:          session.Provider,
		ProviderSessionID: session.ProviderSessionID,
		Status:            session.Status,
		TurnLifecycle:     cloneRuntimeTurnLifecycle(session.TurnLifecycle),
		SubmitAvailability: cloneRuntimeSubmitAvailability(
			session.SubmitAvailability,
		),
		PermissionModeID: session.PermissionModeID,
		Settings:         normalizeOptionalSessionSettings(session.Settings, session.Provider, session.PermissionModeID),
		RuntimeContext: map[string]any{
			"cwd":              session.CWD,
			"title":            session.Title,
			"permissionModeId": session.PermissionModeID,
			"visible":          session.Visible,
		},
		UpdatedAtUnixMS: session.UpdatedAtUnixMS,
	}
}

func (c *Controller) SubmitInteractive(ctx context.Context, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return SubmitInteractiveResult{}, err
	}
	if interactiveAdapter, ok := adapter.(InteractiveAdapter); ok {
		result, err := interactiveAdapter.SubmitInteractive(ctx, session, input)
		if err == nil {
			c.syncClaudeCodeModeFromSelection(session, result.OptionID)
			if adapterShouldReceiveInteractiveDenyFollowUp(adapter) {
				c.scheduleInteractiveDenyFollowUp(input)
			}
		}
		return result, err
	}
	return SubmitInteractiveResult{}, fmt.Errorf("agent provider %q does not support interactive submission", session.Provider)
}

// claudeCodeModeFromID is the inverse of the adapter's effectiveModeID: it maps
// an ACP mode id back to the (planMode, permissionModeID) that the session
// settings represent. ok is false for ids that are not mode switches (ordinary
// tool-approval options like allow_once/reject_once), which must not touch the
// session mode. For "plan" the permission mode is left empty, meaning "keep the
// current permission mode" while in plan.
func claudeCodeModeFromID(modeID string) (planMode bool, permissionModeID string, ok bool) {
	modeID = strings.TrimSpace(modeID)
	if modeID == "plan" {
		return true, "", true
	}
	if isClaudeCodePermissionModeID(modeID) {
		return false, modeID, true
	}
	return false, "", false
}

// syncClaudeCodeModeFromSelection mirrors a claude-code interactive selection
// (the exit-plan switch_mode options) into the session's authoritative mode.
// Selecting a permission mode leaves plan mode and switches the mode in one
// step; selecting "plan" (keep planning) stays in plan. The single state patch
// it publishes drives the composer reactively — there is no separate frontend
// optimistic write.
func (c *Controller) syncClaudeCodeModeFromSelection(session Session, optionID string) {
	if c == nil || strings.TrimSpace(session.Provider) != ProviderClaudeCode {
		return
	}
	planMode, permissionModeID, ok := claudeCodeModeFromID(optionID)
	if !ok {
		return
	}
	current, found := c.Session(session.RoomID, session.AgentSessionID)
	if !found || strings.TrimSpace(current.Provider) != ProviderClaudeCode {
		return
	}
	c.applyClaudeCodeMode(current, planMode, permissionModeID)
}

// applyClaudeCodeMode is the single writer of a claude-code session's mode. It
// updates plan mode and permission mode together, no-ops when nothing changes,
// and publishes one state patch so every reader (composer, list, reports) sees
// the same authoritative value. An empty permissionModeID keeps the current
// permission mode (used when entering plan).
func (c *Controller) applyClaudeCodeMode(current Session, planMode bool, permissionModeID string) {
	currentSettings := normalizeSessionSettings(current.Settings, current.Provider, current.PermissionModeID)
	nextPermission := strings.TrimSpace(permissionModeID)
	if nextPermission == "" {
		nextPermission = strings.TrimSpace(currentSettings.PermissionModeID)
	}
	if currentSettings.PlanMode == planMode &&
		strings.TrimSpace(currentSettings.PermissionModeID) == nextPermission &&
		strings.TrimSpace(current.PermissionModeID) == nextPermission {
		return
	}
	nextSession := current
	nextSession.PermissionModeID = nextPermission
	settings := normalizeSessionSettings(nextSession.Settings, nextSession.Provider, nextSession.PermissionModeID)
	settings.PlanMode = planMode
	settings.PermissionModeID = nextPermission
	nextSession.Settings = cloneSessionSettings(settings)
	nextSession.UpdatedAtUnixMS = unixMS(now())
	c.store(nextSession)
	patch := permissionModeStatePatch(nextSession)
	c.publishSessionStatePatch(nextSession, patch)
	c.enqueueSessionStatePatchReport(context.Background(), nextSession, patch)
}

func permissionModeStatePatch(session Session) agentsessionstore.WorkspaceAgentStatePatch {
	settings := normalizeSessionSettings(session.Settings, session.Provider, session.PermissionModeID)
	runtimeContext := map[string]any{
		"permissionModeId": strings.TrimSpace(settings.PermissionModeID),
		"planMode":         settings.PlanMode,
	}
	if strings.TrimSpace(session.CWD) != "" {
		runtimeContext["cwd"] = strings.TrimSpace(session.CWD)
	}
	if strings.TrimSpace(session.Title) != "" {
		runtimeContext["title"] = strings.TrimSpace(session.Title)
	}
	return agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID:    strings.TrimSpace(session.AgentSessionID),
		Provider:          strings.TrimSpace(session.Provider),
		ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
		PermissionModeID:  strings.TrimSpace(settings.PermissionModeID),
		Settings:          sessionSettingsPayload(&settings),
		RuntimeContext:    runtimeContext,
		OccurredAtUnixMS:  session.UpdatedAtUnixMS,
	}
}

func adapterShouldReceiveInteractiveDenyFollowUp(adapter Adapter) bool {
	if _, ok := adapter.(*ClaudeCodeSDKAdapter); ok {
		return false
	}
	return true
}

func (c *Controller) scheduleInteractiveDenyFollowUp(input SubmitInteractiveInput) {
	prompt := interactiveDenyFollowUpPrompt(input)
	if c == nil || prompt == "" {
		return
	}
	roomID := strings.TrimSpace(input.RoomID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if roomID == "" || agentSessionID == "" {
		return
	}
	go c.runInteractiveDenyFollowUp(roomID, agentSessionID, prompt)
}

func (c *Controller) runInteractiveDenyFollowUp(roomID string, agentSessionID string, prompt string) {
	deadline := time.Now().Add(interactiveDenyFollowUpStartTimeout)
	for {
		if _, ok := c.activeTurn(roomID, agentSessionID); !ok {
			break
		}
		if time.Now().After(deadline) {
			slog.Warn("agent interactive deny follow-up skipped because the active turn did not finish",
				"event", "agent_session.interactive.deny_follow_up.timeout",
				"room_id", roomID,
				"agent_session_id", agentSessionID,
			)
			return
		}
		time.Sleep(interactiveDenyFollowUpPollInterval)
	}
	if _, err := c.Exec(context.Background(), ExecInput{
		RoomID:         roomID,
		AgentSessionID: agentSessionID,
		Content:        []PromptContentBlock{{Type: "text", Text: prompt}},
	}); err != nil {
		slog.Warn("agent interactive deny follow-up failed to start",
			"event", "agent_session.interactive.deny_follow_up.failed",
			"room_id", roomID,
			"agent_session_id", agentSessionID,
			"error", err.Error(),
		)
	}
}

func interactiveDenyFollowUpPrompt(input SubmitInteractiveInput) string {
	if input.Payload == nil || !isInteractiveDenySelection(input) {
		return ""
	}
	return strings.TrimSpace(asString(input.Payload["denyMessage"]))
}

func isInteractiveDenySelection(input SubmitInteractiveInput) bool {
	for _, value := range []string{
		input.Action,
		input.OptionID,
		asString(input.Payload["optionId"]),
	} {
		if isDenyInteractiveSelectionValue(value) {
			return true
		}
	}
	return false
}

func isDenyInteractiveSelectionValue(value string) bool {
	token := normalizePermissionOptionToken(value)
	if token == "" {
		return false
	}
	if permissionOptionDecision(token) == "denied" {
		return true
	}
	switch token {
	case "abort", "aborted":
		return true
	default:
		return false
	}
}

func (c *Controller) Subscribe(roomID, agentSessionID string) (<-chan StreamEvent, func(), bool) {
	roomID = strings.TrimSpace(roomID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if roomID == "" || agentSessionID == "" {
		ch := make(chan StreamEvent)
		close(ch)
		return ch, func() {}, false
	}
	key := sessionKey(roomID, agentSessionID)
	c.mu.Lock()
	session, ok := c.sessions[key]
	var initial []StreamEvent
	if ok {
		initial = append(initial, sessionStateSnapshotStreamEvent(session))
	}
	if snapshot, hasSnapshot := c.commands[key]; hasSnapshot {
		snapshot.Commands = cloneAgentSessionCommands(snapshot.Commands)
		initial = append(initial, commandSnapshotStreamEvent(snapshot))
	}
	if update, hasUpdate := c.configOptionsUpdates[key]; hasUpdate {
		initial = append(initial, configOptionsUpdateStreamEvent(update))
	}
	if !ok {
		c.mu.Unlock()
		ch := make(chan StreamEvent)
		close(ch)
		return ch, func() {}, false
	}
	events, unsubscribe := c.hub.SubscribeWithInitial(roomID, agentSessionID, initial)
	c.mu.Unlock()
	return events, unsubscribe, true
}

func sessionStateSnapshotStreamEvent(session Session) StreamEvent {
	occurredAtUnixMS := session.UpdatedAtUnixMS
	if occurredAtUnixMS <= 0 {
		occurredAtUnixMS = unixMS(now())
	}
	lifecycleStatus, currentPhase := sessionSnapshotLifecycleAndPhase(session.Status)
	return StreamEvent{
		EventType: StreamEventStatePatch,
		Data: agentsessionstore.WorkspaceAgentStatePatch{
			AgentSessionID:    strings.TrimSpace(session.AgentSessionID),
			AgentTargetID:     strings.TrimSpace(session.AgentTargetID),
			Provider:          strings.TrimSpace(session.Provider),
			ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
			CWD:               strings.TrimSpace(session.CWD),
			Title:             strings.TrimSpace(session.Title),
			LifecycleStatus:   lifecycleStatus,
			CurrentPhase:      currentPhase,
			TurnLifecycle:     activityTurnLifecycleFromRuntime(session.TurnLifecycle),
			SubmitAvailability: activitySubmitAvailabilityFromRuntime(
				session.SubmitAvailability,
			),
			OccurredAtUnixMS: occurredAtUnixMS,
		},
	}
}

func statePatchFromSessionStateSnapshot(snapshot SessionStateSnapshot) agentsessionstore.WorkspaceAgentStatePatch {
	runtimeContext := clonePayload(snapshot.RuntimeContext)
	return agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID:    strings.TrimSpace(snapshot.AgentSessionID),
		AgentTargetID:     strings.TrimSpace(snapshot.AgentTargetID),
		Provider:          strings.TrimSpace(snapshot.Provider),
		ProviderSessionID: strings.TrimSpace(snapshot.ProviderSessionID),
		Model:             strings.TrimSpace(runtimeContextString(runtimeContext, "model")),
		PermissionModeID:  strings.TrimSpace(snapshot.PermissionModeID),
		Settings:          sessionSettingsPayload(snapshot.Settings),
		RuntimeContext:    runtimeContext,
		TurnLifecycle:     activityTurnLifecycleFromRuntime(snapshot.TurnLifecycle),
		SubmitAvailability: activitySubmitAvailabilityFromRuntime(
			snapshot.SubmitAvailability,
		),
		CWD:             strings.TrimSpace(runtimeContextString(runtimeContext, "cwd")),
		Title:           strings.TrimSpace(runtimeContextString(runtimeContext, "title")),
		LifecycleStatus: string(activityshared.SessionLifecycleStatusActive),
		CurrentPhase:    snapshotStatusPhase(snapshot.Status),
		PendingInteractive: activityInteractivePromptFromRuntime(
			snapshot.PendingInteractive,
		),
		PendingInteractivePresent: true,
		OccurredAtUnixMS:          snapshot.UpdatedAtUnixMS,
	}
}

func activityTurnLifecycleFromRuntime(value *TurnLifecycle) *agentsessionstore.WorkspaceAgentTurnLifecycle {
	if value == nil {
		return nil
	}
	var activeTurnID *string
	if value.ActiveTurnID != nil {
		active := strings.TrimSpace(*value.ActiveTurnID)
		activeTurnID = &active
	}
	var outcome *string
	if value.Outcome != nil {
		next := strings.TrimSpace(*value.Outcome)
		outcome = &next
	}
	return &agentsessionstore.WorkspaceAgentTurnLifecycle{
		ActiveTurnID:     activeTurnID,
		Phase:            strings.TrimSpace(value.Phase),
		Settling:         value.Settling,
		Outcome:          outcome,
		CompletedCommand: activityCompletedCommandFromRuntime(value.CompletedCommand),
	}
}

func activityCompletedCommandFromRuntime(value *CompletedCommand) *agentsessionstore.WorkspaceAgentCompletedCommand {
	if value == nil {
		return nil
	}
	return &agentsessionstore.WorkspaceAgentCompletedCommand{
		Kind:   strings.TrimSpace(value.Kind),
		Status: strings.TrimSpace(value.Status),
	}
}

func activitySubmitAvailabilityFromRuntime(value *SubmitAvailability) *agentsessionstore.WorkspaceAgentSubmitAvailability {
	if value == nil {
		return nil
	}
	return &agentsessionstore.WorkspaceAgentSubmitAvailability{
		State:  strings.TrimSpace(value.State),
		Reason: strings.TrimSpace(value.Reason),
	}
}

func activityInteractivePromptFromRuntime(prompt *SessionInteractivePrompt) *agentsessionstore.WorkspaceAgentInteractivePrompt {
	if prompt == nil {
		return nil
	}
	return &agentsessionstore.WorkspaceAgentInteractivePrompt{
		Kind:      strings.TrimSpace(prompt.Kind),
		RequestID: strings.TrimSpace(prompt.RequestID),
		ToolName:  strings.TrimSpace(prompt.ToolName),
		Status:    strings.TrimSpace(prompt.Status),
		Input:     clonePayload(prompt.Input),
		Output:    clonePayload(prompt.Output),
		Error:     clonePayload(prompt.Error),
		Metadata:  clonePayload(prompt.Metadata),
	}
}

func sessionSettingsPayload(settings *SessionSettings) map[string]any {
	if settings == nil {
		return nil
	}
	payload := map[string]any{
		"model":            strings.TrimSpace(settings.Model),
		"permissionModeId": strings.TrimSpace(settings.PermissionModeID),
		"planMode":         settings.PlanMode,
		"reasoningEffort":  strings.TrimSpace(settings.ReasoningEffort),
	}
	if settings.BrowserUse != nil {
		payload["browserUse"] = *settings.BrowserUse
	}
	if settings.ComputerUse != nil {
		payload["computerUse"] = *settings.ComputerUse
	}
	return payload
}

func sessionSettingsFromPayload(payload map[string]any) *SessionSettings {
	if len(payload) == 0 {
		return nil
	}
	settings := &SessionSettings{
		Model:            strings.TrimSpace(payloadStringValue(payload, "model")),
		PermissionModeID: strings.TrimSpace(payloadStringValue(payload, "permissionModeId")),
		PlanMode:         payloadBoolValue(payload, "planMode"),
		ReasoningEffort:  strings.TrimSpace(payloadStringValue(payload, "reasoningEffort")),
	}
	if value, ok := payload["browserUse"].(bool); ok {
		settings.BrowserUse = &value
	}
	if value, ok := payload["computerUse"].(bool); ok {
		settings.ComputerUse = &value
	}
	if strings.TrimSpace(settings.Model) == "" &&
		strings.TrimSpace(settings.PermissionModeID) == "" &&
		strings.TrimSpace(settings.ReasoningEffort) == "" &&
		!settings.PlanMode &&
		settings.BrowserUse == nil &&
		settings.ComputerUse == nil {
		return nil
	}
	return settings
}

func payloadStringValue(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return value
}

func payloadBoolValue(payload map[string]any, key string) bool {
	value, _ := payload[key].(bool)
	return value
}

func runtimeContextString(runtimeContext map[string]any, key string) string {
	value, _ := runtimeContext[key].(string)
	return strings.TrimSpace(value)
}

func snapshotStatusPhase(status string) string {
	switch strings.TrimSpace(status) {
	case SessionStatusWorking:
		return string(activityshared.TurnPhaseWorking)
	case SessionStatusWaiting:
		return string(activityshared.TurnPhaseWaitingInput)
	case SessionStatusFailed:
		return string(activityshared.TurnPhaseFailed)
	default:
		return string(activityshared.TurnPhaseIdle)
	}
}

func sessionSnapshotLifecycleAndPhase(status string) (string, string) {
	switch strings.TrimSpace(strings.ToLower(status)) {
	case SessionStatusWorking:
		return string(activityshared.SessionLifecycleStatusActive), string(activityshared.TurnPhaseWorking)
	case SessionStatusWaiting:
		return string(activityshared.SessionLifecycleStatusActive), SessionStatusWaiting
	case SessionStatusFailed:
		return string(activityshared.SessionLifecycleStatusFailed), SessionStatusFailed
	case SessionStatusCompleted, SessionStatusCanceled:
		return string(activityshared.SessionLifecycleStatusEnded), string(activityshared.TurnPhaseIdle)
	default:
		return string(activityshared.SessionLifecycleStatusActive), string(activityshared.TurnPhaseIdle)
	}
}

func (c *Controller) PublishStreamEvent(roomID, agentSessionID string, event StreamEvent) {
	roomID = strings.TrimSpace(roomID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if c == nil || roomID == "" || agentSessionID == "" || event.EventType == "" {
		return
	}
	c.hub.Publish(roomID, agentSessionID, []StreamEvent{event})
}

func (c *Controller) publishSessionStatePatch(session Session, patch agentsessionstore.WorkspaceAgentStatePatch) {
	if c == nil || c.hub == nil {
		return
	}
	roomID := strings.TrimSpace(session.RoomID)
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	if roomID == "" || agentSessionID == "" || strings.TrimSpace(patch.AgentSessionID) == "" {
		return
	}
	c.hub.Publish(roomID, agentSessionID, []StreamEvent{{
		EventType: StreamEventStatePatch,
		Data:      patch,
	}})
}

func (c *Controller) Session(roomID, agentSessionID string) (Session, bool) {
	return c.get(strings.TrimSpace(roomID), strings.TrimSpace(agentSessionID))
}

func (c *Controller) CanResume(input ResumeInput) bool {
	if c == nil {
		return false
	}
	provider := strings.TrimSpace(input.Provider)
	if provider == "" {
		return false
	}
	adapter := c.adapter(provider)
	if adapter == nil {
		return false
	}
	probeAdapter, ok := adapter.(ResumeProbeAdapter)
	if !ok {
		return false
	}
	return probeAdapter.CanResume(Session{
		RoomID:            strings.TrimSpace(input.RoomID),
		AgentSessionID:    strings.TrimSpace(input.AgentSessionID),
		Provider:          provider,
		ProviderSessionID: strings.TrimSpace(input.ProviderSessionID),
		CWD:               strings.TrimSpace(input.CWD),
		Env:               append([]string(nil), input.Env...),
		Status:            normalizeSessionStatus(input.Status),
		Title:             strings.TrimSpace(input.Title),
		Visible:           sessionVisible(input.Visible),
		PermissionModeID:  normalizePermissionModeIDWithFallback(provider, input.PermissionModeID, defaultPermissionModeIDForProvider(provider)),
		Settings:          normalizeOptionalSessionSettings(input.Settings, provider, firstNonEmpty(input.PermissionModeID, defaultPermissionModeIDForProvider(provider))),
		CreatedAtUnixMS:   input.CreatedAtUnixMS,
		UpdatedAtUnixMS:   input.UpdatedAtUnixMS,
	})
}

func (c *Controller) Sessions(roomID string) []Session {
	if c == nil {
		return nil
	}
	roomID = strings.TrimSpace(roomID)
	c.mu.Lock()
	defer c.mu.Unlock()
	result := make([]Session, 0)
	for key, session := range c.sessions {
		if strings.TrimSpace(session.RoomID) != roomID {
			continue
		}
		session = c.reconcileSessionStatusLocked(key, session)
		c.sessions[key] = session
		result = append(result, session)
	}
	return result
}

func (c *Controller) adapter(provider string) Adapter {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.adapters[provider]
}

func (c *Controller) sessionAndAdapter(roomID, agentSessionID string) (Session, Adapter, error) {
	session, ok := c.get(strings.TrimSpace(roomID), strings.TrimSpace(agentSessionID))
	if !ok {
		return Session{}, nil, ErrSessionNotFound
	}
	adapter := c.adapter(session.Provider)
	if adapter == nil {
		return Session{}, nil, fmt.Errorf("unsupported agent session provider %q", session.Provider)
	}
	return session, adapter, nil
}

func (c *Controller) get(roomID, agentSessionID string) (Session, bool) {
	if c == nil {
		return Session{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	key := sessionKey(roomID, agentSessionID)
	session, ok := c.sessions[key]
	if ok {
		session = c.reconcileSessionStatusLocked(key, session)
		c.sessions[key] = session
	}
	return session, ok
}

func (c *Controller) acquireLifecycleLock(roomID, agentSessionID string) func() {
	if c == nil {
		return func() {}
	}
	key := sessionKey(strings.TrimSpace(roomID), strings.TrimSpace(agentSessionID))
	c.mu.Lock()
	lock := c.lifecycleLocks[key]
	if lock == nil {
		lock = &sessionLifecycleLock{}
		c.lifecycleLocks[key] = lock
	}
	lock.refs++
	c.mu.Unlock()

	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		c.mu.Lock()
		lock.refs--
		if lock.refs <= 0 && c.lifecycleLocks[key] == lock {
			delete(c.lifecycleLocks, key)
		}
		c.mu.Unlock()
	}
}

func (c *Controller) findStartSession(
	roomID,
	agentTargetID,
	provider,
	cwd,
	title string,
	settings SessionSettings,
	providerTargetRef map[string]any,
) (Session, bool) {
	if c == nil {
		return Session{}, false
	}
	roomID = strings.TrimSpace(roomID)
	agentTargetID = strings.TrimSpace(agentTargetID)
	provider = strings.TrimSpace(provider)
	cwd = strings.TrimSpace(cwd)
	title = strings.TrimSpace(title)
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, session := range c.sessions {
		session = c.reconcileSessionStatusLocked(sessionKey(session.RoomID, session.AgentSessionID), session)
		if strings.TrimSpace(session.RoomID) != roomID {
			continue
		}
		if strings.TrimSpace(session.Provider) != provider {
			continue
		}
		if agentTargetID != "" {
			if strings.TrimSpace(session.AgentTargetID) != agentTargetID {
				continue
			}
		} else if strings.TrimSpace(session.AgentTargetID) != "" {
			continue
		}
		if strings.TrimSpace(session.CWD) != cwd {
			continue
		}
		if !providerTargetRefsEqual(session.ProviderTargetRef, providerTargetRef) {
			continue
		}
		if title != "" && strings.TrimSpace(session.Title) != title {
			continue
		}
		existingSettings := normalizeSessionSettings(session.Settings, session.Provider, session.PermissionModeID)
		if existingSettings.PermissionModeID != settings.PermissionModeID ||
			existingSettings.Model != settings.Model ||
			existingSettings.ReasoningEffort != settings.ReasoningEffort ||
			existingSettings.PlanMode != settings.PlanMode {
			continue
		}
		switch session.Status {
		case SessionStatusCanceled, SessionStatusFailed, SessionStatusCompleted:
			continue
		default:
			return session, true
		}
	}
	return Session{}, false
}

func providerTargetRefsEqual(left, right map[string]any) bool {
	if len(left) == 0 && len(right) == 0 {
		return true
	}
	return reflect.DeepEqual(left, right)
}

func (s Session) SettingsValue() SessionSettings {
	return normalizeSessionSettings(s.Settings, s.Provider, s.PermissionModeID)
}

func (c *Controller) store(session Session) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.sessions[sessionKey(session.RoomID, session.AgentSessionID)] = session
	c.mu.Unlock()
}

func (c *Controller) publishPendingConfigOptionsUpdates(session Session) {
	if c == nil {
		return
	}
	roomID := strings.TrimSpace(session.RoomID)
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	if roomID == "" || agentSessionID == "" {
		return
	}
	key := sessionKey(roomID, agentSessionID)
	c.mu.Lock()
	pending := c.pendingConfigOptionsUpdates[key]
	if len(pending) > 0 {
		delete(c.pendingConfigOptionsUpdates, key)
	}
	c.mu.Unlock()
	if len(pending) == 0 {
		return
	}
	events := make([]StreamEvent, 0, len(pending))
	for _, update := range pending {
		update = c.completeConfigOptionsUpdate(session, update)
		c.recordConfigOptionsUpdate(session, update)
		events = append(events, configOptionsUpdateStreamEvent(update))
	}
	c.hub.Publish(roomID, agentSessionID, events)
	c.enqueueSessionSnapshotReport(context.Background(), session)
}

func (c *Controller) publish(session Session, events []activityshared.Event) {
	if len(events) == 0 {
		return
	}
	projected := ProjectActivityEventsToStreamEvents(session, events)
	c.enrichStreamStateEventsWithSessionSnapshot(session, projected)
	slog.Debug(
		"agent session publish events",
		"event", "agent_session.publish",
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider", session.Provider,
		"provider_session_id", session.ProviderSessionID,
		"activity_event_count", len(events),
		"projected_event_count", len(projected),
		"projected_event_type_counts", streamEventTypeCounts(projected),
	)
	c.hub.Publish(session.RoomID, session.AgentSessionID, projected)
}

func streamEventTypeCounts(events []StreamEvent) []string {
	if len(events) == 0 {
		return nil
	}
	types := make([]string, 0, len(events))
	for _, event := range events {
		types = append(types, event.EventType)
	}
	return summarizeLogValueCounts(types)
}

func (c *Controller) publishAdapterCommandSnapshot(session Session, adapter Adapter) {
	commandAdapter, ok := adapter.(CommandSnapshotAdapter)
	if !ok {
		return
	}
	snapshot, ok := commandAdapter.SessionCommandSnapshot(session)
	if !ok {
		return
	}
	c.applyCommandSnapshot(session, snapshot)
}

func (c *Controller) publishPendingCommandSnapshot(session Session) bool {
	if c == nil {
		return false
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	if agentSessionID == "" {
		return false
	}
	c.mu.Lock()
	snapshot, ok := c.pendingCommandSnapshots[agentSessionID]
	if ok {
		delete(c.pendingCommandSnapshots, agentSessionID)
	}
	c.mu.Unlock()
	if !ok {
		return false
	}
	c.applyCommandSnapshot(session, snapshot)
	return true
}

func (c *Controller) applyCommandSnapshot(session Session, snapshot AgentSessionCommandSnapshot) {
	if c == nil {
		return
	}
	roomID := strings.TrimSpace(session.RoomID)
	agentSessionID := strings.TrimSpace(firstNonEmpty(snapshot.AgentSessionID, session.AgentSessionID))
	if roomID == "" || agentSessionID == "" {
		return
	}
	snapshot.AgentSessionID = agentSessionID
	snapshot.Commands = cloneAgentSessionCommands(snapshot.Commands)
	key := sessionKey(roomID, agentSessionID)
	c.mu.Lock()
	if _, ok := c.sessions[key]; !ok {
		c.mu.Unlock()
		return
	}
	c.commands[key] = snapshot
	c.mu.Unlock()
	c.hub.Publish(roomID, agentSessionID, []StreamEvent{commandSnapshotStreamEvent(snapshot)})
}

func (c *Controller) applyCommandSnapshotByAgentSessionID(snapshot AgentSessionCommandSnapshot) {
	if c == nil {
		return
	}
	agentSessionID := strings.TrimSpace(snapshot.AgentSessionID)
	if agentSessionID == "" {
		return
	}
	c.mu.Lock()
	var session Session
	found := false
	for _, candidate := range c.sessions {
		if strings.TrimSpace(candidate.AgentSessionID) == agentSessionID {
			session = candidate
			found = true
			break
		}
	}
	c.mu.Unlock()
	if !found {
		snapshot.AgentSessionID = agentSessionID
		snapshot.Commands = cloneAgentSessionCommands(snapshot.Commands)
		c.mu.Lock()
		c.pendingCommandSnapshots[agentSessionID] = snapshot
		c.mu.Unlock()
		return
	}
	c.applyCommandSnapshot(session, snapshot)
}

func (c *Controller) applySessionEventsByAgentSessionID(agentSessionID string, events []activityshared.Event) {
	if c == nil || len(events) == 0 {
		return
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID == "" {
		return
	}
	// Read-apply-store atomically: a non-atomic window here lets a background
	// sink emission overwrite a session another goroutine just settled (lost
	// update on status/title).
	c.mu.Lock()
	var session Session
	foundKey := ""
	for key, candidate := range c.sessions {
		if strings.TrimSpace(candidate.AgentSessionID) == agentSessionID {
			session = candidate
			foundKey = key
			break
		}
	}
	if foundKey == "" {
		c.mu.Unlock()
		return
	}
	if session.LifecycleAuthority || eventsCarryAdapterLifecycleSnapshot(events) {
		// ADR 0008: copy snapshots and derive purely — no ready-guard, no
		// reconcile; the snapshot IS the truth.
		session = applySessionEventsBase(session, events)
		session = applyTurnLifecycleSnapshots(session, events)
		session.Status = statusForAuthoritySession(session, sessionLevelStatusFromEvents(events))
		session.SubmitAvailability = submitAvailabilityForAuthoritySession(session)
	} else {
		previousStatus := session.Status
		session = applySessionEvents(session, events)
		session = applyTurnLifecycleFromEvents(session, events)
		session.Status = deriveSessionStatusFromEvents(events, session.Status)
		// Metadata-only session updates (usage/goal refreshes) default to
		// ready; while the lifecycle reports an active turn that would flap
		// the status to idle mid-turn.
		if session.Status == SessionStatusReady &&
			session.TurnLifecycle != nil &&
			session.TurnLifecycle.ActiveTurnID != nil {
			session.Status = firstNonEmpty(previousStatus, SessionStatusWorking)
		}
		if session.TurnLifecycle == nil || session.TurnLifecycle.ActiveTurnID == nil {
			session = c.reconcileSessionStatusLocked(foundKey, session)
		}
	}
	if shouldAdvanceSessionUpdatedAtFromEvents(events) {
		session.UpdatedAtUnixMS = unixMS(now())
	}
	c.sessions[foundKey] = session
	c.mu.Unlock()
	c.publish(session, events)
	c.enqueueSessionReport(context.Background(), session, events)
}

func commandSnapshotStreamEvent(snapshot AgentSessionCommandSnapshot) StreamEvent {
	return StreamEvent{
		EventType: StreamEventAvailableCommands,
		Data:      snapshot,
	}
}

func (c *Controller) applyConfigOptionsUpdateByAgentSessionID(update AgentSessionConfigOptionsUpdate) {
	if c == nil {
		return
	}
	agentSessionID := strings.TrimSpace(update.AgentSessionID)
	if agentSessionID == "" {
		return
	}
	roomID := strings.TrimSpace(update.RoomID)
	c.mu.Lock()
	var session Session
	found := false
	if roomID != "" {
		if candidate, ok := c.sessions[sessionKey(roomID, agentSessionID)]; ok {
			session = candidate
			found = true
		}
	} else {
		for _, candidate := range c.sessions {
			if strings.TrimSpace(candidate.AgentSessionID) == agentSessionID {
				session = candidate
				found = true
				break
			}
		}
	}
	if !found {
		if roomID != "" {
			key := sessionKey(roomID, agentSessionID)
			c.pendingConfigOptionsUpdates[key] = append(c.pendingConfigOptionsUpdates[key], update)
		}
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
	update = c.completeConfigOptionsUpdate(session, update)
	c.recordConfigOptionsUpdate(session, update)
	c.hub.Publish(session.RoomID, session.AgentSessionID, []StreamEvent{
		configOptionsUpdateStreamEvent(update),
	})
	c.enqueueSessionSnapshotReport(context.Background(), session)
}

func (c *Controller) recordConfigOptionsUpdate(session Session, update AgentSessionConfigOptionsUpdate) {
	if c == nil {
		return
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	c.configOptionsUpdates[key] = update
	c.mu.Unlock()
}

func (*Controller) completeConfigOptionsUpdate(session Session, update AgentSessionConfigOptionsUpdate) AgentSessionConfigOptionsUpdate {
	if update.RoomID == "" {
		update.RoomID = session.RoomID
	}
	if update.Provider == "" {
		update.Provider = session.Provider
	}
	if update.ProviderSessionID == "" {
		update.ProviderSessionID = session.ProviderSessionID
	}
	if update.OccurredAtUnixMS <= 0 {
		update.OccurredAtUnixMS = unixMS(now())
	}
	return update
}

func configOptionsUpdateStreamEvent(update AgentSessionConfigOptionsUpdate) StreamEvent {
	return StreamEvent{
		EventType: StreamEventConfigOptions,
		Data:      update,
	}
}

func cloneAgentSessionCommands(commands []AgentSessionCommand) []AgentSessionCommand {
	if len(commands) == 0 {
		return []AgentSessionCommand{}
	}
	out := make([]AgentSessionCommand, len(commands))
	copy(out, commands)
	return out
}

func (c *Controller) enqueueSessionReport(ctx context.Context, session Session, events []activityshared.Event) {
	report := reportActivityInput(session, events)
	c.enrichReportStatePatchesWithSessionSnapshot(session, &report)
	c.enqueueReport(ctx, report)
}

func (c *Controller) enqueueSessionSnapshotReport(ctx context.Context, session Session) {
	report := agentsessionstore.ReportActivityInput{
		WorkspaceID: session.RoomID,
		Connector: &agentsessionstore.ConnectorInfo{
			ID:      session.Provider,
			Version: "agent-gui-runtime",
		},
		Source: eventSourceFromSession(session),
	}
	c.enrichReportWithSessionSnapshot(session, &report)
	c.enqueueReport(ctx, report)
}

func (c *Controller) enqueueSessionStatePatchReport(
	ctx context.Context,
	session Session,
	patch agentsessionstore.WorkspaceAgentStatePatch,
) {
	report := agentsessionstore.ReportActivityInput{
		WorkspaceID: session.RoomID,
		Connector: &agentsessionstore.ConnectorInfo{
			ID:      session.Provider,
			Version: "agent-gui-runtime",
		},
		Source:       eventSourceFromSession(session),
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{patch},
	}
	c.enqueueReport(ctx, report)
}

func (c *Controller) enrichReportWithSessionSnapshot(session Session, report *agentsessionstore.ReportActivityInput) {
	if report == nil {
		return
	}
	snapshot := c.sessionStateSnapshot(session)
	if snapshot.AgentSessionID == "" {
		return
	}
	patch := statePatchFromSessionStateSnapshot(snapshot)
	if len(report.StatePatches) == 0 {
		report.StatePatches = append(report.StatePatches, patch)
		return
	}
	enrichReportStatePatches(report, patch)
}

func (c *Controller) enrichReportStatePatchesWithSessionSnapshot(
	session Session,
	report *agentsessionstore.ReportActivityInput,
) {
	if report == nil || len(report.StatePatches) == 0 {
		return
	}
	snapshot := c.sessionStateSnapshot(session)
	if snapshot.AgentSessionID == "" {
		return
	}
	enrichReportStatePatches(report, statePatchFromSessionStateSnapshot(snapshot))
}

func (c *Controller) enrichStreamStateEventsWithSessionSnapshot(
	session Session,
	events []StreamEvent,
) {
	if c == nil || len(events) == 0 {
		return
	}
	snapshot := c.sessionStateSnapshot(session)
	if snapshot.AgentSessionID == "" {
		return
	}
	snapshotPatch := statePatchFromSessionStateSnapshot(snapshot)
	for index := range events {
		if events[index].EventType != StreamEventStatePatch {
			continue
		}
		patch, ok := events[index].Data.(agentsessionstore.WorkspaceAgentStatePatch)
		if !ok {
			continue
		}
		tmp := agentsessionstore.ReportActivityInput{
			StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{patch},
		}
		enrichReportStatePatches(&tmp, snapshotPatch)
		events[index].Data = tmp.StatePatches[0]
	}
}

func enrichReportStatePatches(
	report *agentsessionstore.ReportActivityInput,
	patch agentsessionstore.WorkspaceAgentStatePatch,
) {
	if report == nil {
		return
	}
	for index := range report.StatePatches {
		report.StatePatches[index].Settings = clonePayload(patch.Settings)
		report.StatePatches[index].RuntimeContext = clonePayload(patch.RuntimeContext)
		report.StatePatches[index].TurnLifecycle = cloneTurnLifecycle(patch.TurnLifecycle)
		report.StatePatches[index].SubmitAvailability = cloneSubmitAvailability(patch.SubmitAvailability)
		report.StatePatches[index].PendingInteractive = cloneInteractivePrompt(patch.PendingInteractive)
		report.StatePatches[index].PendingInteractivePresent = patch.PendingInteractivePresent
		if report.StatePatches[index].Provider == "" {
			report.StatePatches[index].Provider = patch.Provider
		}
		if report.StatePatches[index].ProviderSessionID == "" {
			report.StatePatches[index].ProviderSessionID = patch.ProviderSessionID
		}
		if report.StatePatches[index].Model == "" {
			report.StatePatches[index].Model = patch.Model
		}
		if report.StatePatches[index].PermissionModeID == "" {
			report.StatePatches[index].PermissionModeID = patch.PermissionModeID
		}
		if report.StatePatches[index].CWD == "" {
			report.StatePatches[index].CWD = patch.CWD
		}
		if report.StatePatches[index].Title == "" {
			report.StatePatches[index].Title = patch.Title
		}
	}
}

func (c *Controller) enqueueReport(ctx context.Context, report agentsessionstore.ReportActivityInput) {
	if len(report.TimelineItems) == 0 && len(report.StatePatches) == 0 && len(report.MessageUpdates) == 0 {
		return
	}
	if c.reporter == nil {
		return
	}
	request := reportRequest{
		ctx:    context.WithoutCancel(ctx),
		report: report,
	}
	timelineItemsForLog, statePatchesForLog := SummarizeReportActivityInputForLog(report)
	slog.Debug(
		"agent session activity report enqueued",
		"event", "agent_session.activity_report.enqueued",
		"room_id", report.WorkspaceID,
		"agent_session_id", report.Source.AgentID,
		"provider", report.Source.Provider,
		"provider_session_id", report.Source.ProviderSessionID,
		"timeline_item_count", len(report.TimelineItems),
		"state_patch_count", len(report.StatePatches),
		"message_update_count", len(report.MessageUpdates),
		"timeline_items", timelineItemsForLog,
		"state_patches", statePatchesForLog,
	)
	if c.reportCh == nil {
		c.report(request.ctx, request)
		return
	}
	select {
	case c.reportCh <- request:
	default:
		slog.Warn(
			"agent session activity report queue full; reporting inline",
			"event", "agent_session.activity_report.queue_full",
			"room_id", report.WorkspaceID,
			"agent_session_id", report.Source.AgentID,
			"provider", report.Source.Provider,
			"provider_session_id", report.Source.ProviderSessionID,
			"timeline_item_count", len(report.TimelineItems),
			"state_patch_count", len(report.StatePatches),
			"message_update_count", len(report.MessageUpdates),
			"timeline_items", timelineItemsForLog,
			"state_patches", statePatchesForLog,
		)
		c.report(request.ctx, request)
	}
}

func (c *Controller) runReportWorker() {
	coalescer := newStreamingReportCoalescer(defaultStreamingReportCoalesceWindow)
	defer coalescer.stop()
	for {
		select {
		case request, ok := <-c.reportCh:
			if !ok {
				for _, pending := range coalescer.flushAll() {
					c.report(pending.ctx, pending)
				}
				return
			}
			for _, next := range coalescer.add(request) {
				c.report(next.ctx, next)
			}
		case <-coalescer.ready():
			for _, pending := range coalescer.flushAll() {
				c.report(pending.ctx, pending)
			}
		}
	}
}

func (c *Controller) report(ctx context.Context, request reportRequest) {
	if c.reporter == nil {
		return
	}
	if err := c.reporter.Report(ctx, request.report); err != nil {
		timelineItemsForLog, statePatchesForLog := SummarizeReportActivityInputForLog(request.report)
		slog.Error(
			"agent session activity report failed",
			"event", "agent_session.activity_report.controller_failed",
			"room_id", request.report.WorkspaceID,
			"agent_session_id", request.report.Source.AgentID,
			"provider", request.report.Source.Provider,
			"provider_session_id", request.report.Source.ProviderSessionID,
			"timeline_item_count", len(request.report.TimelineItems),
			"state_patch_count", len(request.report.StatePatches),
			"message_update_count", len(request.report.MessageUpdates),
			"timeline_items", timelineItemsForLog,
			"state_patches", statePatchesForLog,
			"error", err,
		)
	}
}

func sessionKey(roomID, agentSessionID string) string {
	return roomID + "/" + agentSessionID
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func deriveSessionStatusFromEvents(events []activityshared.Event, fallback string) string {
	status := strings.TrimSpace(fallback)
	for _, event := range events {
		switch event.Type {
		case activityshared.EventSessionFailed, activityshared.EventTurnFailed:
			status = SessionStatusFailed
		case activityshared.EventSessionCompleted:
			status = SessionStatusCompleted
		case activityshared.EventTurnCompleted:
			if strings.TrimSpace(event.Payload.TurnOutcome) == string(activityshared.TurnOutcomeInterrupted) {
				status = SessionStatusCanceled
			} else {
				status = SessionStatusReady
			}
		case activityshared.EventTurnUpdated:
			if event.Payload.TurnPhase == string(activityshared.TurnPhaseWaitingApproval) ||
				event.Payload.TurnPhase == string(activityshared.TurnPhaseWaitingInput) {
				status = SessionStatusWaiting
			} else if event.Payload.TurnPhase == string(activityshared.TurnPhaseWorking) ||
				event.Payload.TurnPhase == string(activityshared.TurnPhaseRunning) ||
				event.Payload.TurnPhase == string(activityshared.TurnPhaseSubmitted) {
				status = SessionStatusWorking
			}
		case activityshared.EventSessionUpdated:
			if next := sessionStatusFromActivity(event.Payload.EffectiveStatus); next != "" {
				status = next
			}
		case activityshared.EventTurnStarted:
			status = SessionStatusWorking
		}
	}
	return firstNonEmpty(status, SessionStatusReady)
}

func normalizeSessionStatus(status string) string {
	switch strings.TrimSpace(status) {
	case SessionStatusReady:
		return SessionStatusReady
	case SessionStatusWorking:
		return SessionStatusWorking
	case SessionStatusWaiting:
		return SessionStatusWaiting
	case SessionStatusCanceled:
		return SessionStatusCanceled
	case SessionStatusFailed:
		return SessionStatusFailed
	case SessionStatusCompleted:
		return SessionStatusCompleted
	default:
		return ""
	}
}
