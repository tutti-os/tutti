package agentruntime

import (
	"context"
	"fmt"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/daemon/titletext"
)

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
	adapter, err := c.resolveAdapter(ctx, AdapterResolveInput{Provider: provider, AgentTargetID: input.AgentTargetID, CWD: input.CWD, ProviderTargetRef: clonePayload(input.ProviderTargetRef)})
	if err != nil {
		return StartResult{}, err
	}
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
	title := titletext.Normalize(input.Title)
	initialTitleEstablished := input.InitialTitleEstablished || title != ""
	permissionModeID := settings.PermissionModeID
	if agentSessionID == "" {
		if existing, ok := c.findStartSession(roomID, strings.TrimSpace(input.AgentTargetID), provider, input.CWD, title, settings, input.ProviderTargetRef); ok {
			return StartResult{Session: existing}, nil
		}
		agentSessionID = newID()
	}
	if existing, ok := c.get(roomID, agentSessionID); ok {
		return StartResult{Session: existing}, nil
	}
	session := Session{
		RoomID:                  roomID,
		AgentSessionID:          agentSessionID,
		AgentTargetID:           strings.TrimSpace(input.AgentTargetID),
		Provider:                provider,
		ProviderSessionID:       "",
		CWD:                     strings.TrimSpace(input.CWD),
		Env:                     append([]string(nil), input.Env...),
		Status:                  SessionStatusReady,
		Title:                   title,
		InitialTitleEstablished: initialTitleEstablished,
		Visible:                 sessionVisible(input.Visible),
		RuntimeContext: runtimeContextWithInitialTitleEstablished(
			input.RuntimeContext,
			initialTitleEstablished,
		),
		ProviderTargetRef: clonePayload(input.ProviderTargetRef),
		PermissionModeID:  permissionModeID,
		Settings:          cloneSessionSettings(settings),
		CreatedAtUnixMS:   timestamp,
		UpdatedAtUnixMS:   timestamp,
	}
	events, err := adapter.Start(ctx, session)
	if err != nil {
		detail := cleanVisibleErrorText(err.Error())
		code := visibleFailureCode(detail)
		startError := &AppError{
			Code:         code,
			Message:      visibleFailureContent(provider, "start", code),
			DebugMessage: detail,
			Cause:        err,
		}
		// Provider adapters may emit command/config snapshots before Start returns.
		// Roll those provisional side channels back with the failed transaction so
		// a retry cannot consume stale state from an attempt that never committed.
		c.mu.Lock()
		delete(c.pendingCommandSnapshots, agentSessionID)
		delete(c.pendingConfigOptionsUpdates, sessionKey(roomID, agentSessionID))
		c.mu.Unlock()
		return StartResult{}, startError
	}
	session = applySessionEvents(session, events)
	c.mu.Lock()
	key := sessionKey(roomID, agentSessionID)
	c.sessions[key] = session
	c.notifySessionAvailableLocked(key)
	if input.Provisional {
		c.provisionalSessions[key] = true
	}
	c.mu.Unlock()
	if input.Provisional {
		return StartResult{Session: session}, nil
	}
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
	adapter, err := c.resolveAdapter(ctx, AdapterResolveInput{Provider: provider, AgentTargetID: input.AgentTargetID, CWD: input.CWD, ProviderTargetRef: clonePayload(input.ProviderTargetRef)})
	if err != nil {
		return Session{}, err
	}
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
	initialTitleEstablished := initialTitleEstablishedFromRuntimeContext(
		input.RuntimeContext,
		input.Title,
	)
	session := Session{
		RoomID:                  roomID,
		AgentSessionID:          agentSessionID,
		AgentTargetID:           strings.TrimSpace(input.AgentTargetID),
		Provider:                provider,
		ProviderSessionID:       providerSessionID,
		CWD:                     strings.TrimSpace(input.CWD),
		Env:                     append([]string(nil), input.Env...),
		Status:                  firstNonEmpty(normalizeSessionStatus(input.Status), SessionStatusReady),
		Title:                   strings.TrimSpace(input.Title),
		InitialTitleEstablished: initialTitleEstablished,
		Visible:                 sessionVisible(input.Visible),
		RuntimeContext: runtimeContextWithInitialTitleEstablished(
			input.RuntimeContext,
			initialTitleEstablished,
		),
		ProviderTargetRef: clonePayload(input.ProviderTargetRef),
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
	c.mu.Lock()
	provisional := c.provisionalSessions[key]
	if provisional {
		delete(c.provisionalSessions, key)
		delete(c.sessions, key)
		delete(c.turns, key)
		delete(c.commands, key)
		delete(c.pendingCommandSnapshots, session.AgentSessionID)
		delete(c.pendingConfigOptionsUpdates, key)
	}
	c.mu.Unlock()
	if provisional {
		return CloseResult{AgentSessionID: session.AgentSessionID, Disconnected: true}, nil
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
	delete(c.pendingConfigOptionsUpdates, key)
	delete(c.provisionalSessions, key)
	c.mu.Unlock()
	return CloseResult{AgentSessionID: session.AgentSessionID, Disconnected: true}, nil
}

func (c *Controller) HasActiveTurn(roomID, agentSessionID string) bool {
	_, ok := c.activeTurnID(roomID, agentSessionID)
	return ok
}

func (c *Controller) activeTurnID(roomID, agentSessionID string) (string, bool) {
	if c == nil {
		return "", false
	}
	key := sessionKey(strings.TrimSpace(roomID), strings.TrimSpace(agentSessionID))
	c.mu.Lock()
	defer c.mu.Unlock()
	turn, ok := c.turns[key]
	turnID := strings.TrimSpace(turn.turnID)
	return turnID, ok && turnID != ""
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

func (c *Controller) SetTitle(ctx context.Context, roomID, agentSessionID string, title string) (Session, error) {
	roomID = strings.TrimSpace(roomID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	releaseLifecycleLock := c.acquireLifecycleLock(roomID, agentSessionID)
	defer releaseLifecycleLock()

	session, ok := c.get(roomID, agentSessionID)
	if !ok {
		return Session{}, ErrSessionNotFound
	}
	title = strings.TrimSpace(title)
	if session.Title == title {
		if !session.InitialTitleEstablished {
			session = markInitialTitleEstablished(session)
			session.UpdatedAtUnixMS = unixMS(now())
			c.store(session)
			c.enqueueSessionReport(ctx, session, []activityshared.Event{
				newSessionActivityEvent(
					session,
					EventSessionUpdated,
					session.Status,
					nil,
				),
			})
		}
		return session, nil
	}
	session.Title = title
	session = markInitialTitleEstablished(session)
	session.UpdatedAtUnixMS = unixMS(now())
	c.store(session)
	events := []activityshared.Event{newSessionTitleActivityEvent(session, title)}
	c.publish(session, events)
	c.enqueueSessionReport(ctx, session, events)
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
	if profile, ok := migratedProviderComposerProfile(provider); ok {
		return strings.TrimSpace(profile.DefaultPermissionModeID)
	}
	return ""
}

func permissionModeIDAllowedForProvider(provider string, mode string) bool {
	mode = strings.TrimSpace(mode)
	if mode == "" {
		return false
	}
	if profile, ok := migratedProviderComposerProfile(provider); ok {
		for _, candidate := range profile.PermissionModes {
			if strings.TrimSpace(candidate.ID) == mode {
				return true
			}
		}
		return false
	}
	_, ok := providerregistry.NormalizeOpenProviderID(provider)
	return ok
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
