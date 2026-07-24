package agentruntime

import (
	"context"
	"fmt"
	"log/slog"
	"reflect"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

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
	extensionTargetRef := providerTargetRefString(input.ProviderTargetRef, "kind") == "agent_extension"
	if extensionTargetRef {
		if !authorizedAgentExtensionResumeInput(input, provider) {
			return false
		}
		// The fixed Target binding is durable launch authority. A dynamic adapter
		// can be resolved from it during Resume even when the process cache is
		// empty after a daemon restart.
		if c.adapterResolver != nil {
			return true
		}
	}
	adapter := c.adapter(provider)
	if adapter == nil {
		return false
	}
	if bound, ok := adapter.(ResolveInputBoundAdapter); extensionTargetRef && ok &&
		!bound.MatchesAdapterResolveInput(AdapterResolveInput{
			Provider:          provider,
			AgentTargetID:     strings.TrimSpace(input.AgentTargetID),
			CWD:               strings.TrimSpace(input.CWD),
			ProviderTargetRef: clonePayload(input.ProviderTargetRef),
		}) {
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

func authorizedAgentExtensionResumeInput(input ResumeInput, provider string) bool {
	return strings.TrimSpace(input.ProviderSessionID) != "" &&
		strings.TrimSpace(input.AgentTargetID) != "" &&
		providerTargetRefString(input.ProviderTargetRef, "provider") == provider &&
		providerTargetRefString(input.ProviderTargetRef, "targetId") == strings.TrimSpace(input.AgentTargetID) &&
		providerTargetRefString(input.ProviderTargetRef, "extensionInstallationId") != ""
}

func providerTargetRefString(ref map[string]any, key string) string {
	value, _ := ref[key].(string)
	return strings.TrimSpace(value)
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
		if c.provisionalSessions[key] {
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

func (c *Controller) resolveAdapter(ctx context.Context, input AdapterResolveInput) (Adapter, error) {
	provider := strings.TrimSpace(input.Provider)
	if adapter := c.adapter(provider); adapter != nil {
		if bound, ok := adapter.(ResolveInputBoundAdapter); ok && !bound.MatchesAdapterResolveInput(input) {
			return nil, fmt.Errorf("cached adapter binding mismatch for %q", provider)
		}
		return adapter, nil
	}
	if c == nil || c.adapterResolver == nil {
		return nil, nil
	}
	adapter, err := c.adapterResolver.ResolveAdapter(ctx, input)
	if err != nil {
		return nil, err
	}
	if adapter == nil || strings.TrimSpace(adapter.Provider()) != provider {
		return nil, fmt.Errorf("resolved adapter provider mismatch for %q", provider)
	}
	c.configureAdapter(adapter)
	c.mu.Lock()
	if existing := c.adapters[provider]; existing != nil {
		if bound, ok := existing.(ResolveInputBoundAdapter); ok && !bound.MatchesAdapterResolveInput(input) {
			c.mu.Unlock()
			return nil, fmt.Errorf("cached adapter binding mismatch for %q", provider)
		}
		adapter = existing
	} else {
		c.adapters[provider] = adapter
	}
	c.mu.Unlock()
	return adapter, nil
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
	release, _ := c.acquireLifecycleLockContext(context.Background(), roomID, agentSessionID)
	return release
}

func (c *Controller) acquireLifecycleLockContext(ctx context.Context, roomID, agentSessionID string) (func(), error) {
	if c == nil {
		return func() {}, nil
	}
	key := sessionKey(strings.TrimSpace(roomID), strings.TrimSpace(agentSessionID))
	c.mu.Lock()
	lock := c.lifecycleLocks[key]
	if lock == nil {
		lock = &sessionLifecycleLock{gate: make(chan struct{}, 1)}
		lock.gate <- struct{}{}
		c.lifecycleLocks[key] = lock
	}
	lock.refs++
	c.mu.Unlock()

	select {
	case <-ctx.Done():
		c.releaseLifecycleLockReference(key, lock)
		return func() {}, ctx.Err()
	case <-lock.gate:
	}
	if err := ctx.Err(); err != nil {
		lock.gate <- struct{}{}
		c.releaseLifecycleLockReference(key, lock)
		return func() {}, err
	}
	return func() {
		lock.gate <- struct{}{}
		c.releaseLifecycleLockReference(key, lock)
	}, nil
}

func (c *Controller) releaseLifecycleLockReference(key string, lock *sessionLifecycleLock) {
	c.mu.Lock()
	lock.refs--
	if lock.refs <= 0 && c.lifecycleLocks[key] == lock {
		delete(c.lifecycleLocks, key)
	}
	c.mu.Unlock()
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
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.sessions[key] = session
	c.notifySessionAvailableLocked(key)
	c.mu.Unlock()
}

func (c *Controller) notifySessionAvailableLocked(key string) {
	waiter := c.sessionAvailabilityWaiters[key]
	if waiter == nil {
		return
	}
	delete(c.sessionAvailabilityWaiters, key)
	close(waiter.changed)
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

func (c *Controller) applyTurnCommandSnapshot(session Session, turnID string, snapshot AgentSessionCommandSnapshot) {
	if c == nil {
		return
	}
	roomID := strings.TrimSpace(session.RoomID)
	agentSessionID := strings.TrimSpace(firstNonEmpty(snapshot.AgentSessionID, session.AgentSessionID))
	turnID = strings.TrimSpace(turnID)
	if roomID == "" || agentSessionID == "" || turnID == "" {
		return
	}
	snapshot.AgentSessionID = agentSessionID
	snapshot.Commands = cloneAgentSessionCommands(snapshot.Commands)
	key := sessionKey(roomID, agentSessionID)
	c.mu.Lock()
	active, ok := c.turns[key]
	if !ok || strings.TrimSpace(active.turnID) != turnID {
		c.mu.Unlock()
		return
	}
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
	provisional := false
	for key, candidate := range c.sessions {
		if strings.TrimSpace(candidate.AgentSessionID) == agentSessionID {
			session = candidate
			found = true
			provisional = c.provisionalSessions[key]
			break
		}
	}
	if !found || provisional {
		snapshot.AgentSessionID = agentSessionID
		snapshot.Commands = cloneAgentSessionCommands(snapshot.Commands)
		c.pendingCommandSnapshots[agentSessionID] = snapshot
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
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
	stateEvents := eventsOwnedBySession(events, session.AgentSessionID)
	// Cursor mirrors agent-driven plan entry/exit through a separate settings
	// path that locks internally. Only break the atomic window when such an
	// event is actually present, otherwise the unlock re-opens the lost-update
	// race the surrounding lock guards against.
	if hasACPCurrentModeUpdatedEvent(stateEvents) {
		c.mu.Unlock()
		c.syncCursorPlanModeFromEvents(session, stateEvents)
		c.mu.Lock()
		var stillPresent bool
		session, stillPresent = c.sessions[foundKey]
		if !stillPresent {
			c.mu.Unlock()
			return
		}
	}
	if session.LifecycleAuthority || eventsCarryAdapterLifecycleSnapshot(stateEvents) {
		// ADR 0008: copy snapshots and derive purely — no ready-guard, no
		// reconcile; the snapshot IS the truth.
		session = applySessionEventsBase(session, stateEvents)
		session = applyTurnLifecycleSnapshots(session, stateEvents)
		session.Status = statusForAuthoritySession(session, sessionLevelStatusFromEvents(stateEvents))
		session.SubmitAvailability = submitAvailabilityForAuthoritySession(session)
	} else {
		previousStatus := session.Status
		session = applySessionEvents(session, stateEvents)
		session = applyTurnLifecycleFromEvents(session, stateEvents)
		session.Status = deriveSessionStatusFromEvents(stateEvents, session.Status)
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
	if shouldAdvanceSessionUpdatedAtFromEvents(stateEvents) {
		session.UpdatedAtUnixMS = unixMS(now())
	}
	c.sessions[foundKey] = session
	provisional := c.provisionalSessions[foundKey]
	c.mu.Unlock()
	if provisional {
		return
	}
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
	provisional := false
	if roomID != "" {
		key := sessionKey(roomID, agentSessionID)
		if candidate, ok := c.sessions[key]; ok {
			session = candidate
			found = true
			provisional = c.provisionalSessions[key]
		}
	} else {
		for key, candidate := range c.sessions {
			if strings.TrimSpace(candidate.AgentSessionID) == agentSessionID {
				session = candidate
				found = true
				provisional = c.provisionalSessions[key]
				break
			}
		}
	}
	if !found || provisional {
		pendingRoomID := firstNonEmpty(roomID, session.RoomID)
		if pendingRoomID != "" {
			key := sessionKey(pendingRoomID, agentSessionID)
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
