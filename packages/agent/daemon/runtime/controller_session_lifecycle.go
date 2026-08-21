package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/daemon/titletext"
)

func (c *Controller) Start(ctx context.Context, input StartInput) (StartResult, error) {
	roomID := strings.TrimSpace(input.RoomID)
	provider := strings.TrimSpace(input.Provider)
	if roomID == "" {
		return StartResult{}, fmt.Errorf("room id is required")
	}
	if provider == "" {
		return StartResult{}, fmt.Errorf("provider is required")
	}
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	releaseStartupLock, err := c.acquireStartupLockContext(ctx, roomID, agentSessionID, provider)
	if err != nil {
		return StartResult{}, err
	}
	defer releaseStartupLock()

	adapter, err := c.resolveAdapter(ctx, AdapterResolveInput{Provider: provider, AgentTargetID: input.AgentTargetID, CWD: input.CWD, ProviderTargetRef: clonePayload(input.ProviderTargetRef)})
	if err != nil {
		return StartResult{}, err
	}
	if adapter == nil {
		return StartResult{}, fmt.Errorf("unsupported agent session provider %q", provider)
	}
	timestamp := unixMS(now())
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
			return StartResult{Session: existing, Created: false}, nil
		}
		agentSessionID = newID()
	}
	if existing, ok := c.get(roomID, agentSessionID); ok {
		return StartResult{Session: existing, Created: false}, nil
	}
	c.deleteRetainedGoalGenerationFences(roomID, agentSessionID)
	session := Session{
		RoomID:                  roomID,
		AgentSessionID:          agentSessionID,
		RootAgentSessionID:      agentSessionID,
		AgentTargetID:           strings.TrimSpace(input.AgentTargetID),
		Provider:                provider,
		ProviderSessionID:       "",
		CWD:                     strings.TrimSpace(input.CWD),
		Env:                     append([]string(nil), input.Env...),
		MCPServers:              cloneMCPServerBindings(input.MCPServers),
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
		startError := err
		if AppErrorCode(err) == "" {
			detail := cleanVisibleErrorText(err.Error())
			code := visibleFailureCode(detail)
			if errors.Is(err, ErrProviderStartTimeout) {
				// Provider-start ownership is carried separately in the error
				// chain. Keep the established presentation/API vocabulary here.
				code = "request_timed_out"
			}
			startError = &AppError{
				Code:         code,
				Message:      visibleFailureContent(provider, "start", code),
				DebugMessage: detail,
				Cause:        err,
			}
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
	c.advanceLiveConnectionGeneration(roomID, agentSessionID)
	session = applySessionEvents(session, events)
	c.mu.Lock()
	key := sessionKey(roomID, agentSessionID)
	c.sessions[key] = session
	c.notifySessionAvailableLocked(key)
	if input.Provisional {
		c.provisionalSessions[key] = true
	}
	if input.CanonicalInitPending {
		c.sessionInitializations[key] = &controllerSessionInitialization{
			events: append([]activityshared.Event(nil), events...),
		}
	}
	publicationPending := c.sessionPublicationPendingLocked(key)
	c.mu.Unlock()
	if publicationPending {
		return StartResult{Session: session, Created: true}, nil
	}
	c.publish(session, events)
	c.publishPendingConfigOptionsUpdates(session)
	if !c.publishPendingCommandSnapshot(session) {
		c.publishAdapterCommandSnapshot(session, adapter)
	}
	c.enqueueSessionReport(ctx, session, events)
	return StartResult{Session: session, Created: true}, nil
}

// PublishSessionInitialization releases the Runtime's report/event barrier
// after Host has durably initialized the canonical Session. The transition is
// idempotent. Prompt-provisional Sessions remain hidden until their submitted
// intent crosses its separate durable barrier in Exec.
func (c *Controller) PublishSessionInitialization(
	ctx context.Context,
	roomID string,
	agentSessionID string,
) (Session, error) {
	roomID = strings.TrimSpace(roomID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if roomID == "" || agentSessionID == "" {
		return Session{}, fmt.Errorf("room id and agent session id are required")
	}
	releaseLifecycleLock, err := c.acquireLifecycleLockContext(ctx, roomID, agentSessionID)
	if err != nil {
		return Session{}, err
	}
	defer releaseLifecycleLock()

	key := sessionKey(roomID, agentSessionID)
	c.mu.Lock()
	session, found := c.sessions[key]
	initialization, pending := c.sessionInitializations[key]
	provisional := c.provisionalSessions[key]
	if pending && provisional {
		// Canonical rail initialization is complete, but the initial-content
		// submit barrier still owns visibility. Preserve the historical
		// provisional behavior: provider callbacks stay hidden until Exec
		// durably publishes the submitted Turn.
		delete(c.sessionInitializations, key)
	}
	c.mu.Unlock()
	if !found {
		return Session{}, ErrSessionNotFound
	}
	if !pending || provisional {
		return session, nil
	}
	if err := ctx.Err(); err != nil {
		return Session{}, err
	}

	for {
		c.mu.Lock()
		current, stillPending := c.sessionInitializations[key]
		session, found = c.sessions[key]
		if !found {
			c.mu.Unlock()
			return Session{}, ErrSessionNotFound
		}
		if !stillPending || current != initialization {
			c.mu.Unlock()
			return session, nil
		}

		events := append([]activityshared.Event(nil), initialization.events...)
		initialization.events = nil
		configUpdates := append([]AgentSessionConfigOptionsUpdate(nil), c.pendingConfigOptionsUpdates[key]...)
		delete(c.pendingConfigOptionsUpdates, key)
		commandSnapshot, hasCommandSnapshot := c.pendingCommandSnapshots[agentSessionID]
		if hasCommandSnapshot {
			delete(c.pendingCommandSnapshots, agentSessionID)
			initialization.commandSnapshotResolved = true
		}
		resolveAdapterCommandSnapshot := !initialization.commandSnapshotResolved
		if resolveAdapterCommandSnapshot {
			initialization.commandSnapshotResolved = true
		}
		if !initialization.initialEventsPublished {
			if len(events) == 0 {
				events = []activityshared.Event{
					newSessionActivityEvent(session, EventSessionStarted, session.Status, nil),
				}
			}
			initialization.initialEventsPublished = true
		}
		if len(events) == 0 && len(configUpdates) == 0 && !hasCommandSnapshot && !resolveAdapterCommandSnapshot {
			// This lock transition is the ordering fence: callbacks that acquire
			// c.mu before deletion are drained above; callbacks that acquire it
			// afterwards observe a published Session and may fan out directly.
			delete(c.sessionInitializations, key)
			c.mu.Unlock()
			return session, nil
		}
		c.mu.Unlock()

		if len(events) > 0 {
			c.publish(session, events)
			c.enqueueInitializedSessionReport(ctx, session, events)
		}
		if len(configUpdates) > 0 {
			c.publishConfigOptionsUpdates(session, configUpdates)
		}
		if hasCommandSnapshot {
			c.applyCommandSnapshot(session, commandSnapshot)
		} else if resolveAdapterCommandSnapshot {
			if adapter := c.adapter(session.Provider); adapter != nil {
				c.publishAdapterCommandSnapshot(session, adapter)
			}
		}
	}
}

func (c *Controller) Resume(ctx context.Context, input ResumeInput) (Session, error) {
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
	releaseStartupLock, err := c.acquireStartupLockContext(ctx, roomID, agentSessionID, provider)
	if err != nil {
		return Session{}, err
	}
	defer releaseStartupLock()

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
	session := resumedSession(input, unixMS(now()))
	normalizedFences := make([]GoalGenerationFenceInput, 0, len(input.GoalGenerationFences))
	for _, inputFence := range input.GoalGenerationFences {
		fence, fenceErr := normalizeRetainedGoalGenerationFenceInput(inputFence)
		if fenceErr != nil {
			return Session{}, fenceErr
		}
		normalizedFences = append(normalizedFences, fence)
	}
	for _, fence := range normalizedFences {
		c.retainGoalGenerationFence(session, fence)
	}
	c.invalidateAppliedGoalGenerationFences(session)
	launchCtx := withProviderLaunchRuntimeContext(ctx, input.ProviderLaunchRuntimeContext)
	if err := adapter.Resume(launchCtx, session); err != nil {
		if !input.RecreateIfMissing || !isResumeRecreatableError(err) {
			return Session{}, err
		}
		// The provider session is not available locally (imported from another
		// device, rollout deleted, ...) and the caller opted into recreation, so
		// start a fresh provider session bound to the same agent session. This is
		// what keeps imported conversations continuable instead of forcing the
		// user into a brand new conversation.
		if err := c.recreateAdapterSession(launchCtx, session, adapter); err != nil {
			return Session{}, err
		}
		if refreshed, ok := c.get(session.RoomID, session.AgentSessionID); ok {
			return refreshed, nil
		}
		return session, nil
	}
	c.advanceLiveConnectionGeneration(roomID, agentSessionID)
	if err := c.applyRetainedGoalGenerationFencesOrClose(ctx, session, adapter); err != nil {
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

// Reprepare replaces one idle Session's provider connection using updated
// launch and MCP bindings. It preserves both canonical and provider session
// identity and never emits a canonical lifecycle report.
func (c *Controller) Reprepare(ctx context.Context, input ResumeInput) (Session, error) {
	roomID := strings.TrimSpace(input.RoomID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	provider := strings.TrimSpace(input.Provider)
	providerSessionID := strings.TrimSpace(input.ProviderSessionID)
	if roomID == "" || agentSessionID == "" || provider == "" || providerSessionID == "" {
		return Session{}, fmt.Errorf("room, agent session, provider, and provider session ids are required")
	}
	releaseStartupLock, err := c.acquireStartupLockContext(ctx, roomID, agentSessionID, provider)
	if err != nil {
		return Session{}, err
	}
	defer releaseStartupLock()
	releaseLifecycleLock, err := c.acquireLifecycleLockContext(ctx, roomID, agentSessionID)
	if err != nil {
		return Session{}, err
	}
	defer releaseLifecycleLock()

	current, adapter, err := c.sessionAndAdapter(roomID, agentSessionID)
	if err != nil {
		return Session{}, err
	}
	if current.Provider != provider ||
		strings.TrimSpace(current.ProviderSessionID) != providerSessionID ||
		strings.TrimSpace(current.AgentTargetID) != strings.TrimSpace(input.AgentTargetID) ||
		strings.TrimSpace(current.CWD) != strings.TrimSpace(input.CWD) ||
		!providerTargetRefsEqual(current.ProviderTargetRef, input.ProviderTargetRef) {
		return Session{}, errors.New("agent session reprepare identity mismatch")
	}
	key := sessionKey(roomID, agentSessionID)
	c.mu.Lock()
	turn, active := c.turns[key]
	activeTurnID := strings.TrimSpace(turn.turnID)
	c.mu.Unlock()
	if (active && activeTurnID != "") ||
		(current.TurnLifecycle != nil && current.TurnLifecycle.ActiveTurnID != nil && strings.TrimSpace(*current.TurnLifecycle.ActiveTurnID) != "") {
		return Session{}, ErrSessionActiveTurn
	}
	probe, probeOK := adapter.(LiveSessionProbeAdapter)
	releaser, releaseOK := adapter.(LiveSessionReleaseAdapter)
	if !probeOK || !releaseOK {
		return Session{}, errors.New("agent provider does not support live session reprepare")
	}

	replacement := resumedSession(input, unixMS(now()))
	normalizedFences := make([]GoalGenerationFenceInput, 0, len(input.GoalGenerationFences))
	for _, inputFence := range input.GoalGenerationFences {
		fence, fenceErr := normalizeRetainedGoalGenerationFenceInput(inputFence)
		if fenceErr != nil {
			return Session{}, fenceErr
		}
		normalizedFences = append(normalizedFences, fence)
	}
	for _, fence := range normalizedFences {
		c.retainGoalGenerationFence(replacement, fence)
	}
	if probe.HasLiveSession(current) {
		if err := releaser.ReleaseLiveSession(ctx, current); err != nil {
			return Session{}, err
		}
	}
	c.invalidateAppliedGoalGenerationFences(replacement)
	if err := adapter.Resume(withProviderLaunchRuntimeContext(ctx, input.ProviderLaunchRuntimeContext), replacement); err != nil {
		return Session{}, err
	}
	c.advanceLiveConnectionGeneration(roomID, agentSessionID)
	if err := c.applyRetainedGoalGenerationFences(ctx, replacement, adapter); err != nil {
		_ = releaser.ReleaseLiveSession(context.WithoutCancel(ctx), replacement)
		return Session{}, err
	}
	replacement.Status = SessionStatusReady
	c.store(replacement)
	c.publishPendingConfigOptionsUpdates(replacement)
	if !c.publishPendingCommandSnapshot(replacement) {
		c.publishAdapterCommandSnapshot(replacement, adapter)
	}
	return replacement, nil
}

func resumedSession(input ResumeInput, timestamp int64) Session {
	createdAtUnixMS := input.CreatedAtUnixMS
	if createdAtUnixMS <= 0 {
		createdAtUnixMS = timestamp
	}
	updatedAtUnixMS := input.UpdatedAtUnixMS
	if updatedAtUnixMS <= 0 {
		updatedAtUnixMS = timestamp
	}
	provider := strings.TrimSpace(input.Provider)
	initialTitleEstablished := initialTitleEstablishedFromRuntimeContext(input.RuntimeContext, input.Title)
	session := Session{
		RoomID: strings.TrimSpace(input.RoomID), AgentSessionID: strings.TrimSpace(input.AgentSessionID),
		RootAgentSessionID: strings.TrimSpace(input.AgentSessionID), AgentTargetID: strings.TrimSpace(input.AgentTargetID),
		Provider: provider, ProviderSessionID: strings.TrimSpace(input.ProviderSessionID), Resumable: input.Resumable,
		CWD: strings.TrimSpace(input.CWD), Env: append([]string(nil), input.Env...), MCPServers: cloneMCPServerBindings(input.MCPServers),
		Status: firstNonEmpty(normalizeSessionStatus(input.Status), SessionStatusReady), Title: strings.TrimSpace(input.Title),
		InitialTitleEstablished: initialTitleEstablished, UserTitleSet: initialTitleEstablished,
		Visible: sessionVisible(input.Visible), RuntimeContext: runtimeContextWithInitialTitleEstablished(input.RuntimeContext, initialTitleEstablished),
		ProviderTargetRef: clonePayload(input.ProviderTargetRef),
		PermissionModeID:  normalizePermissionModeIDWithFallback(provider, input.PermissionModeID, defaultPermissionModeIDForProvider(provider)),
		Settings:          normalizeOptionalSessionSettings(input.Settings, provider, firstNonEmpty(input.PermissionModeID, defaultPermissionModeIDForProvider(provider))),
		CreatedAtUnixMS:   createdAtUnixMS, UpdatedAtUnixMS: updatedAtUnixMS,
	}
	if session.Settings != nil {
		session.PermissionModeID = session.Settings.PermissionModeID
	}
	return session
}

func (c *Controller) Close(ctx context.Context, input CloseInput) (CloseResult, error) {
	releaseLifecycleLock, err := c.acquireLifecycleLockContext(ctx, input.RoomID, input.AgentSessionID)
	if err != nil {
		return CloseResult{}, err
	}
	defer releaseLifecycleLock()

	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return CloseResult{}, err
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	if quiescer, ok := adapter.(CloseQuiesceAdapter); ok {
		if err := quiescer.QuiesceForClose(ctx, session); err != nil {
			return CloseResult{}, err
		}
	}
	c.cancelActiveTurn(session.RoomID, session.AgentSessionID)
	closeErr := adapter.Close(ctx, session)
	if closeErr != nil && !input.PreserveCanonicalState {
		return CloseResult{}, closeErr
	}
	c.mu.Lock()
	publicationPending := c.sessionPublicationPendingLocked(key)
	if publicationPending || input.PreserveCanonicalState {
		delete(c.provisionalSessions, key)
		delete(c.sessionInitializations, key)
		delete(c.sessions, key)
		delete(c.liveConnectionGenerations, key)
		delete(c.turns, key)
		delete(c.commands, key)
		delete(c.pendingCommandSnapshots, session.AgentSessionID)
		delete(c.pendingConfigOptionsUpdates, key)
		delete(c.goalGenerationFences, key)
		delete(c.pendingSideEvents, key)
	}
	c.mu.Unlock()
	if publicationPending || input.PreserveCanonicalState {
		c.forgetSideStreamEvents(session)
	}
	if closeErr != nil {
		return CloseResult{AgentSessionID: session.AgentSessionID, Disconnected: true}, closeErr
	}
	if publicationPending || input.PreserveCanonicalState {
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
	delete(c.liveConnectionGenerations, key)
	delete(c.turns, key)
	delete(c.commands, key)
	delete(c.pendingCommandSnapshots, session.AgentSessionID)
	delete(c.pendingConfigOptionsUpdates, key)
	delete(c.provisionalSessions, key)
	delete(c.sessionInitializations, key)
	delete(c.goalGenerationFences, key)
	delete(c.pendingSideEvents, key)
	c.mu.Unlock()
	c.forgetSideStreamEvents(session)
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
			session.UserTitleSet = true
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
	session.UserTitleSet = true
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
	normalized.CodexSaverMode = settings.CodexSaverMode
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
//
// A provider/event title is a candidate, not the owner: once the user set the
// title explicitly (UserTitleSet) it is never overwritten by an event title.
func applySessionEventsBase(session Session, events []activityshared.Event) Session {
	for _, event := range events {
		if strings.TrimSpace(event.ProviderSessionID) != "" {
			session.ProviderSessionID = strings.TrimSpace(event.ProviderSessionID)
		}
		if title := strings.TrimSpace(event.Payload.Title); title != "" && !session.UserTitleSet {
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
		if title := strings.TrimSpace(event.Payload.Title); title != "" && !session.UserTitleSet {
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
