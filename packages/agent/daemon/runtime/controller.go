//revive:disable:file-length-limit
package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

var (
	ErrSessionNotFound                  = errors.New("agent session not found")
	ErrSessionSettingsRequireNewSession = errors.New("agent session settings update requires a new session to preserve context")
	ErrSessionActiveTurn                = errors.New("agent session already has an active turn")
)

const defaultStreamingReportCoalesceWindow = 50 * time.Millisecond
const interactiveDenyFollowUpStartTimeout = 30 * time.Second
const interactiveDenyFollowUpPollInterval = 25 * time.Millisecond

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
	hub                         *EventHub
	reporter                    ActivityReporter
	reportCh                    chan reportRequest
}

type activeTurn struct {
	turnID string
	cancel context.CancelFunc
}

type reportRequest struct {
	ctx    context.Context
	report agentsessionstore.ReportActivityInput
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
	return NewController(
		[]Adapter{
			NewClaudeCodeAdapterWithHostMetadata(transport, host),
			NewCodexAppServerAdapterWithHostMetadata(transport, host),
			NewNexightAdapterWithHostMetadata(transport, host),
			NewGeminiAdapterWithHostMetadata(transport, host),
			NewHermesAdapterWithHostMetadata(transport, host),
			NewOpenClawAdapterWithHostMetadata(transport, host),
		},
		reporter,
	)
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
		if existing, ok := c.findStartSession(roomID, provider, input.CWD, input.Title, settings); ok {
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
		Provider:             provider,
		ProviderSessionID:    "",
		CWD:                  strings.TrimSpace(input.CWD),
		Env:                  append([]string(nil), input.Env...),
		Status:               SessionStatusReady,
		Title:                firstNonEmpty(strings.TrimSpace(input.Title), provider),
		Visible:              sessionVisible(input.Visible),
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
		Provider:          provider,
		ProviderSessionID: providerSessionID,
		CWD:               strings.TrimSpace(input.CWD),
		Env:               append([]string(nil), input.Env...),
		Status:            firstNonEmpty(normalizeSessionStatus(input.Status), SessionStatusReady),
		Title:             firstNonEmpty(strings.TrimSpace(input.Title), provider),
		Visible:           sessionVisible(input.Visible),
		PermissionModeID:  normalizePermissionModeIDWithFallback(provider, input.PermissionModeID, defaultPermissionModeIDForProvider(provider)),
		Settings:          normalizeOptionalSessionSettings(input.Settings, provider, firstNonEmpty(input.PermissionModeID, defaultPermissionModeIDForProvider(provider))),
		CreatedAtUnixMS:   createdAtUnixMS,
		UpdatedAtUnixMS:   updatedAtUnixMS,
	}
	if session.Settings != nil {
		session.PermissionModeID = session.Settings.PermissionModeID
	}
	if err := adapter.Resume(ctx, session); err != nil {
		return Session{}, err
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
	case ProviderGemini, ProviderHermes:
		return "yolo"
	default:
		return ""
	}
}

func permissionModeIDAllowedForProvider(provider string, mode string) bool {
	switch strings.TrimSpace(provider) {
	case ProviderClaudeCode:
		switch strings.TrimSpace(mode) {
		case "default", "acceptEdits", "dontAsk", "bypassPermissions":
			return true
		}
	case ProviderCodex, ProviderNexight:
		switch strings.TrimSpace(mode) {
		case "read-only", "auto", "full-access":
			return true
		}
	case ProviderGemini, ProviderHermes:
		return strings.TrimSpace(mode) == "yolo"
	}
	return false
}

func normalizeSessionSettings(settings *SessionSettings, provider string, defaultPermissionModeID string) SessionSettings {
	normalized := SessionSettings{
		PermissionModeID: normalizePermissionModeIDWithFallback(provider, defaultPermissionModeID, ""),
	}
	if settings == nil {
		return normalized
	}
	normalized.Model = strings.TrimSpace(settings.Model)
	normalized.ReasoningEffort = strings.TrimSpace(settings.ReasoningEffort)
	normalized.PlanMode = settings.PlanMode
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

func applySessionEvents(session Session, events []activityshared.Event) Session {
	for _, event := range events {
		if strings.TrimSpace(event.ProviderSessionID) != "" {
			session.ProviderSessionID = strings.TrimSpace(event.ProviderSessionID)
		}
		if title := strings.TrimSpace(event.Payload.Title); title != "" {
			session.Title = title
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

func (c *Controller) Exec(_ context.Context, input ExecInput) (ExecResult, error) {
	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return ExecResult{}, err
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
	turnID := newID()
	runCtx, cancel := context.WithCancel(context.Background())
	session, err = c.beginTurn(session, turnID, cancel)
	if err != nil {
		cancel()
		return ExecResult{}, err
	}
	go c.runExecTurn(runCtx, session, adapter, content, displayPrompt, turnID)
	return ExecResult{
		AgentSessionID: session.AgentSessionID,
		Status:         ExecStatusStarted,
		TurnID:         turnID,
		Accepted:       true,
		SessionStatus:  session.Status,
	}, nil
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
	var emitted []activityshared.Event
	emit := func(events []activityshared.Event) {
		if len(events) == 0 {
			return
		}
		previousStatus := session.Status
		session = applySessionEvents(session, events)
		session = c.preserveActiveTurnStatus(session, turnID, previousStatus)
		if shouldAdvanceSessionUpdatedAtFromEvents(events) {
			session.UpdatedAtUnixMS = unixMS(now())
		}
		c.store(session)
		emitted = append(emitted, events...)
		c.publish(session, events)
		c.enqueueSessionReport(ctx, session, events)
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
	session = applySessionEvents(session, statusEvents)
	session.Status = deriveSessionStatusFromEvents(statusEvents, SessionStatusWorking)
	if shouldAdvanceSessionUpdatedAtFromEvents(statusEvents) {
		session.UpdatedAtUnixMS = unixMS(now())
	}
	c.finishTurn(session, turnID)
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
	session = c.reconcileSessionStatusLocked(key, session)
	c.sessions[key] = session
	c.mu.Unlock()
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
		slog.Info("agent session cancel skipped because no active turn exists",
			"event", "agent_session.cancel.no_active_turn",
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider", session.Provider,
			"status", session.Status,
			"reason", reason,
		)
		return CancelResult{AgentSessionID: session.AgentSessionID, Canceled: false}, nil
	}
	if active.cancel != nil {
		active.cancel()
	}
	events, err := adapter.Cancel(ctx, session, reason)
	if err != nil {
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
		session = applySessionEvents(session, events)
		if shouldAdvanceSessionUpdatedAtFromEvents(events) {
			session.UpdatedAtUnixMS = unixMS(now())
		}
		c.store(session)
		c.publish(session, events)
		c.enqueueSessionReport(ctx, session, events)
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
	if session.Status != SessionStatusWorking {
		return session
	}
	session.Status = SessionStatusReady
	return session
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
	if input.Settings.PlanMode != nil {
		settings.PlanMode = *input.Settings.PlanMode
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
		RoomID:            session.RoomID,
		AgentSessionID:    session.AgentSessionID,
		Provider:          session.Provider,
		ProviderSessionID: session.ProviderSessionID,
		Status:            session.Status,
		PermissionModeID:  session.PermissionModeID,
		Settings:          normalizeOptionalSessionSettings(session.Settings, session.Provider, session.PermissionModeID),
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
		if override.Provider != "" {
			snapshot.Provider = override.Provider
		}
		if override.ProviderSessionID != "" {
			snapshot.ProviderSessionID = override.ProviderSessionID
		}
		if override.Status != "" {
			snapshot.Status = override.Status
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
		Provider:          session.Provider,
		ProviderSessionID: session.ProviderSessionID,
		Status:            session.Status,
		PermissionModeID:  session.PermissionModeID,
		Settings:          normalizeOptionalSessionSettings(session.Settings, session.Provider, session.PermissionModeID),
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
			c.syncPermissionModeFromInteractiveSelection(session, result.OptionID)
			c.scheduleInteractiveDenyFollowUp(input)
		}
		return result, err
	}
	return SubmitInteractiveResult{}, fmt.Errorf("agent provider %q does not support interactive submission", session.Provider)
}

func (c *Controller) syncPermissionModeFromInteractiveSelection(session Session, optionID string) {
	if c == nil || strings.TrimSpace(session.Provider) != ProviderClaudeCode {
		return
	}
	modeID := claudeCodeInteractivePermissionModeID(optionID)
	if modeID == "" {
		return
	}
	current, ok := c.Session(session.RoomID, session.AgentSessionID)
	if !ok || strings.TrimSpace(current.Provider) != ProviderClaudeCode {
		return
	}
	if modeID == strings.TrimSpace(current.PermissionModeID) {
		return
	}
	nextSession := current
	nextSession.PermissionModeID = modeID
	settings := normalizeSessionSettings(nextSession.Settings, nextSession.Provider, nextSession.PermissionModeID)
	settings.PermissionModeID = modeID
	nextSession.Settings = cloneSessionSettings(settings)
	nextSession.UpdatedAtUnixMS = unixMS(now())
	c.store(nextSession)
	patch := permissionModeStatePatch(nextSession)
	c.publishSessionStatePatch(nextSession, patch)
	c.enqueueSessionStatePatchReport(context.Background(), nextSession, patch)
}

func claudeCodeInteractivePermissionModeID(optionID string) string {
	switch strings.TrimSpace(optionID) {
	case "default", "acceptEdits", "dontAsk", "bypassPermissions":
		return strings.TrimSpace(optionID)
	}
	return ""
}

func permissionModeStatePatch(session Session) agentsessionstore.WorkspaceAgentStatePatch {
	settings := normalizeSessionSettings(session.Settings, session.Provider, session.PermissionModeID)
	runtimeContext := map[string]any{
		"permissionModeId": strings.TrimSpace(settings.PermissionModeID),
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
			Provider:          strings.TrimSpace(session.Provider),
			ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
			CWD:               strings.TrimSpace(session.CWD),
			Title:             strings.TrimSpace(session.Title),
			LifecycleStatus:   lifecycleStatus,
			CurrentPhase:      currentPhase,
			OccurredAtUnixMS:  occurredAtUnixMS,
		},
	}
}

func statePatchFromSessionStateSnapshot(snapshot SessionStateSnapshot) agentsessionstore.WorkspaceAgentStatePatch {
	runtimeContext := clonePayload(snapshot.RuntimeContext)
	return agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID:    strings.TrimSpace(snapshot.AgentSessionID),
		Provider:          strings.TrimSpace(snapshot.Provider),
		ProviderSessionID: strings.TrimSpace(snapshot.ProviderSessionID),
		Model:             strings.TrimSpace(runtimeContextString(runtimeContext, "model")),
		PermissionModeID:  strings.TrimSpace(snapshot.PermissionModeID),
		Settings:          sessionSettingsPayload(snapshot.Settings),
		RuntimeContext:    runtimeContext,
		CWD:               strings.TrimSpace(runtimeContextString(runtimeContext, "cwd")),
		Title:             strings.TrimSpace(runtimeContextString(runtimeContext, "title")),
		LifecycleStatus:   string(activityshared.SessionLifecycleStatusActive),
		CurrentPhase:      snapshotStatusPhase(snapshot.Status),
		OccurredAtUnixMS:  snapshot.UpdatedAtUnixMS,
	}
}

func sessionSettingsPayload(settings *SessionSettings) map[string]any {
	if settings == nil {
		return nil
	}
	return map[string]any{
		"model":            strings.TrimSpace(settings.Model),
		"permissionModeId": strings.TrimSpace(settings.PermissionModeID),
		"planMode":         settings.PlanMode,
		"reasoningEffort":  strings.TrimSpace(settings.ReasoningEffort),
	}
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

func (c *Controller) publishSessionStateChanged(session Session) {
	if c == nil || c.hub == nil {
		return
	}
	roomID := strings.TrimSpace(session.RoomID)
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	if roomID == "" || agentSessionID == "" {
		return
	}
	c.hub.Publish(roomID, agentSessionID, []StreamEvent{sessionStateSnapshotStreamEvent(session)})
}

func (c *Controller) publishSessionStateSnapshotChanged(session Session) {
	if c == nil || c.hub == nil {
		return
	}
	roomID := strings.TrimSpace(session.RoomID)
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	if roomID == "" || agentSessionID == "" {
		return
	}
	snapshot := c.sessionStateSnapshot(session)
	if snapshot.AgentSessionID == "" {
		return
	}
	c.hub.Publish(roomID, agentSessionID, []StreamEvent{{
		EventType: StreamEventStatePatch,
		Data:      statePatchFromSessionStateSnapshot(snapshot),
	}})
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

func (c *Controller) findStartSession(roomID, provider, cwd, title string, settings SessionSettings) (Session, bool) {
	if c == nil {
		return Session{}, false
	}
	roomID = strings.TrimSpace(roomID)
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
		if strings.TrimSpace(session.CWD) != cwd {
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
			} else if event.Payload.TurnPhase == string(activityshared.TurnPhaseWorking) {
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
