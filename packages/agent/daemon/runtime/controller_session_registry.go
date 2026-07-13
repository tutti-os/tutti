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
	// Cursor mirrors agent-driven plan entry/exit through a separate settings
	// path that locks internally. Only break the atomic window when such an
	// event is actually present, otherwise the unlock re-opens the lost-update
	// race the surrounding lock guards against.
	if hasACPCurrentModeUpdatedEvent(events) {
		c.mu.Unlock()
		c.syncCursorPlanModeFromEvents(session, events)
		c.mu.Lock()
		var stillPresent bool
		session, stillPresent = c.sessions[foundKey]
		if !stillPresent {
			c.mu.Unlock()
			return
		}
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
