//revive:disable:file-length-limit
//nolint:unused // Retain migrated helpers until the next agent-daemon decomposition pass.
package agentsessionstore

import (
	"context"
	"log/slog"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

type State struct {
	Presences []WorkspaceAgentPresence `json:"presences"`
	Sessions  []WorkspaceAgentSession  `json:"sessions"`
}

type Messages struct {
	AgentSessionID string
	Messages       []WorkspaceAgentMessageUpdate
}

const (
	WorkspaceAgentSyncStatusPending = "pending"
	WorkspaceAgentSyncStatusSynced  = "synced"
	WorkspaceAgentSyncStatusFailed  = "failed"
)

type agentSessionSyncState struct {
	state          WorkspaceAgentSyncState
	pendingReports int
	failedReports  int
}

type sessionEntry struct {
	mu       sync.Mutex
	refCount int

	state                         State
	sessionMessages               map[string][]WorkspaceAgentSessionMessage
	messageVersionBySession       map[string]uint64
	remoteMessageVersionBySession map[string]uint64
	syncStates                    map[string]*agentSessionSyncState
	hiddenSessions                map[string]struct{}
}

type Store struct {
	mu             sync.RWMutex
	rooms          map[string]*sessionEntry
	client         ReadRepository
	syncer         *sessionSyncer
	syncStateStore SyncStateStore
	updateListener func(roomID string, snapshot WorkspaceAgentSnapshot)
	startOnce      sync.Once
}

type Option func(*Store)

func WithSyncStateStore(store SyncStateStore) Option {
	return func(svc *Store) {
		if svc != nil {
			svc.syncStateStore = store
		}
	}
}

func New(client ReadRepository, opts ...Option) *Store {
	svc := &Store{
		rooms:  make(map[string]*sessionEntry),
		client: client,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(svc)
		}
	}
	svc.syncer = newSessionSyncer(svc, client)
	return svc
}

func (s *Store) Start(ctx context.Context) {
	if s == nil || s.syncer == nil {
		return
	}
	s.startOnce.Do(func() {
		go s.syncer.run(ctx)
	})
}

func (s *Store) TrackRoom(roomID string) {
	roomID = strings.TrimSpace(roomID)
	if s == nil || roomID == "" {
		return
	}
	loadedSyncStates := s.loadStoredSyncStates(roomID)

	s.mu.Lock()
	defer s.mu.Unlock()

	entry := s.rooms[roomID]
	if entry == nil {
		entry = &sessionEntry{
			sessionMessages:               make(map[string][]WorkspaceAgentSessionMessage),
			messageVersionBySession:       make(map[string]uint64),
			remoteMessageVersionBySession: make(map[string]uint64),
			syncStates:                    make(map[string]*agentSessionSyncState),
			hiddenSessions:                make(map[string]struct{}),
		}
		for agentSessionID, syncState := range loadedSyncStates {
			entry.syncStates[agentSessionID] = syncEntryFromState(syncState)
		}
		s.rooms[roomID] = entry
	}
	entry.refCount++
}

func (s *Store) SetUpdateListener(listener func(roomID string, snapshot WorkspaceAgentSnapshot)) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.updateListener = listener
}

func (s *Store) UntrackRoom(roomID string) {
	roomID = strings.TrimSpace(roomID)
	if s == nil || roomID == "" {
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	entry := s.rooms[roomID]
	if entry == nil {
		return
	}
	entry.refCount--
	if entry.refCount <= 0 {
		delete(s.rooms, roomID)
	}
}

func (s *Store) TriggerSync(roomID string) {
	if s == nil || s.syncer == nil {
		return
	}
	s.syncer.triggerRoom(roomID)
}

func (s *Store) GetAgentState(roomID string) (State, bool) {
	entry := s.roomEntry(roomID)
	if entry == nil {
		return State{}, false
	}

	entry.mu.Lock()
	defer entry.mu.Unlock()

	return State{
		Presences: clonePresences(entry.state.Presences),
		Sessions:  sessionsWithSyncStates(entry.state.Sessions, entry.syncStates),
	}, true
}

func (s *Store) GetAgentSnapshot(roomID string) (WorkspaceAgentSnapshot, bool) {
	entry := s.roomEntry(roomID)
	if entry == nil {
		return WorkspaceAgentSnapshot{}, false
	}

	entry.mu.Lock()
	defer entry.mu.Unlock()

	return snapshotFromEntryLocked(entry), true
}

func (s *Store) RestoreSnapshot(roomID string, snapshot WorkspaceAgentSnapshot) {
	roomID = strings.TrimSpace(roomID)
	if s == nil || roomID == "" {
		return
	}
	s.updateState(roomID, snapshot)
}

func (s *Store) GetAgentMessages(roomID, agentSessionID string) (Messages, bool) {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID == "" {
		return Messages{}, false
	}
	entry := s.roomEntry(roomID)
	if entry == nil {
		return Messages{}, false
	}

	entry.mu.Lock()
	defer entry.mu.Unlock()

	return Messages{
		AgentSessionID: agentSessionID,
		Messages:       sessionMessageUpdatesForLegacyReads(entry.sessionMessages[agentSessionID]),
	}, true
}

func (s *Store) ListSessionMessages(
	roomID string,
	agentSessionID string,
	afterVersion uint64,
	limit int,
) (ListSessionMessagesReply, bool) {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID == "" {
		return ListSessionMessagesReply{}, false
	}
	entry := s.roomEntry(roomID)
	if entry == nil {
		return ListSessionMessagesReply{}, false
	}

	entry.mu.Lock()
	defer entry.mu.Unlock()

	all := entry.sessionMessages[agentSessionID]
	latestVersion := entry.messageVersionBySession[agentSessionID]
	if latestVersion == 0 {
		latestVersion = maxSessionMessageVersion(0, all)
	}
	filtered := make([]WorkspaceAgentSessionMessage, 0, len(all))
	for _, message := range all {
		if message.Version <= afterVersion {
			continue
		}
		filtered = append(filtered, cloneSessionMessage(message))
	}
	hasMore := false
	if limit > 0 && len(filtered) > limit {
		// Page membership must be contiguous in version space: deliver the
		// lowest `limit` undelivered versions. Stored order is display order
		// (occurredAt), so truncating it directly could return version N while
		// omitting an undelivered version < N; cursor-based consumers would
		// then advance past the omitted row and lose it permanently.
		sort.SliceStable(filtered, func(i, j int) bool {
			return filtered[i].Version < filtered[j].Version
		})
		filtered = filtered[:limit]
		hasMore = true
		// Advertise the page boundary, not the store head, so cursors advance
		// exactly to the end of this page.
		latestVersion = maxSessionMessageVersion(0, filtered)
	}
	return ListSessionMessagesReply{
		Messages:      sortSessionMessages(filtered),
		LatestVersion: latestVersion,
		HasMore:       hasMore,
	}, true
}

func (s *Store) ApplyEvents(roomID string, source EventSource, events []activityshared.Event) {
	roomID = strings.TrimSpace(roomID)
	if s == nil || roomID == "" || len(events) == 0 {
		return
	}
	var ok bool
	source, ok = normalizeRuntimeEventSource(source)
	if !ok {
		return
	}
	entry := s.roomEntry(roomID)
	if entry == nil {
		return
	}

	entry.mu.Lock()
	before := snapshotFromEntryLocked(entry)

	now := time.Now().UnixMilli()
	for _, event := range events {
		s.applyEventLocked(entry, roomID, source, event, now)
	}
	changed := !workspaceAgentSnapshotBusinessEqual(before, snapshotFromEntryLocked(entry))
	entry.mu.Unlock()
	if changed {
		s.notifyRoomUpdate(roomID)
	}
}

func (s *Store) ApplyActivity(
	roomID string,
	source EventSource,
	timelineItems []WorkspaceAgentTimelineItem,
	statePatches []WorkspaceAgentStatePatch,
	messageUpdateBatches ...[]WorkspaceAgentMessageUpdate,
) {
	var messageUpdates []WorkspaceAgentMessageUpdate
	if len(messageUpdateBatches) > 0 {
		messageUpdates = messageUpdateBatches[0]
	}
	roomID = strings.TrimSpace(roomID)
	if s == nil || roomID == "" || (len(timelineItems) == 0 && len(statePatches) == 0 && len(messageUpdates) == 0) {
		return
	}
	var ok bool
	source, ok = normalizeRuntimeEventSource(source)
	if !ok {
		return
	}
	entry := s.roomEntry(roomID)
	if entry == nil {
		return
	}

	entry.mu.Lock()
	before := snapshotFromEntryLocked(entry)

	now := time.Now().UnixMilli()
	for _, patch := range statePatches {
		applyStatePatchLocked(entry, source, patch, now)
	}
	appendMessageUpdatesLocked(entry, source, messageUpdates)
	changed := !workspaceAgentSnapshotBusinessEqual(before, snapshotFromEntryLocked(entry))
	entry.mu.Unlock()
	if changed {
		s.notifyRoomUpdate(roomID)
	}
}

func (s *Store) ApplySessionState(
	roomID string,
	source EventSource,
	agentSessionID string,
	state WorkspaceAgentSessionStateUpdate,
) {
	roomID = strings.TrimSpace(roomID)
	agentSessionID = strings.TrimSpace(firstNonEmptyString(agentSessionID, source.AgentID, source.ProviderSessionID))
	if s == nil || roomID == "" || agentSessionID == "" {
		return
	}
	var ok bool
	source, ok = normalizeRuntimeEventSource(source)
	if !ok {
		return
	}
	entry := s.roomEntry(roomID)
	if entry == nil {
		return
	}
	if strings.TrimSpace(source.AgentID) == "" {
		source.AgentID = agentSessionID
	}

	entry.mu.Lock()
	before := snapshotFromEntryLocked(entry)

	applyStatePatchLocked(entry, source, statePatchFromSessionState(agentSessionID, state), time.Now().UnixMilli())
	applySessionStateTimesLocked(entry, agentSessionID, state)
	changed := !workspaceAgentSnapshotBusinessEqual(before, snapshotFromEntryLocked(entry))
	entry.mu.Unlock()
	if changed {
		s.notifyRoomUpdate(roomID)
	}
}

func (s *Store) ApplySessionMessages(
	roomID string,
	source EventSource,
	agentSessionID string,
	updates []WorkspaceAgentSessionMessageUpdate,
) {
	roomID = strings.TrimSpace(roomID)
	agentSessionID = strings.TrimSpace(firstNonEmptyString(agentSessionID, source.AgentID, source.ProviderSessionID))
	if s == nil || roomID == "" || agentSessionID == "" || len(updates) == 0 {
		return
	}
	var ok bool
	source, ok = normalizeRuntimeEventSource(source)
	if !ok {
		return
	}
	entry := s.roomEntry(roomID)
	if entry == nil {
		return
	}
	if strings.TrimSpace(source.AgentID) == "" {
		source.AgentID = agentSessionID
	}

	entry.mu.Lock()
	changed := appendMessageUpdatesLocked(entry, source, messageUpdatesFromSessionMessages(agentSessionID, updates))
	entry.mu.Unlock()

	if changed {
		s.notifyRoomUpdate(roomID)
	}
}

func normalizeRuntimeEventSource(source EventSource) (EventSource, bool) {
	origin := NormalizeSessionOrigin(source.SessionOrigin)
	if origin == "" {
		return EventSource{}, false
	}
	source.SessionOrigin = origin
	return source, true
}

func (s *Store) HideAgentSession(roomID string, agentSessionID string) {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if s == nil || agentSessionID == "" {
		return
	}
	entry := s.roomEntry(roomID)
	if entry == nil {
		return
	}

	entry.mu.Lock()
	before := snapshotFromEntryLocked(entry)

	if entry.hiddenSessions == nil {
		entry.hiddenSessions = make(map[string]struct{})
	}
	entry.hiddenSessions[agentSessionID] = struct{}{}
	entry.state.Sessions = removeSessionByID(entry.state.Sessions, agentSessionID)
	delete(entry.sessionMessages, agentSessionID)
	delete(entry.messageVersionBySession, agentSessionID)
	delete(entry.remoteMessageVersionBySession, agentSessionID)
	delete(entry.syncStates, agentSessionID)
	if s.syncStateStore != nil {
		if err := s.syncStateStore.DeleteAgentSyncState(context.Background(), roomID, agentSessionID); err != nil {
			slog.Warn("agent activity sync state delete failed",
				"event", "agent_activity.sync_state.delete_failed",
				"room_id", roomID,
				"agent_session_id", agentSessionID,
				"error", err,
			)
		}
	}
	changed := !workspaceAgentSnapshotBusinessEqual(before, snapshotFromEntryLocked(entry))
	entry.mu.Unlock()
	if changed {
		s.notifyRoomUpdate(roomID)
	}
}

func statePatchFromSessionState(agentSessionID string, state WorkspaceAgentSessionStateUpdate) WorkspaceAgentStatePatch {
	patch := WorkspaceAgentStatePatch{
		AgentSessionID:     strings.TrimSpace(agentSessionID),
		AgentTargetID:      strings.TrimSpace(state.AgentTargetID),
		Provider:           strings.TrimSpace(state.Provider),
		ProviderSessionID:  strings.TrimSpace(state.ProviderSessionID),
		Model:              strings.TrimSpace(state.Model),
		Settings:           clonePayloadMap(state.Settings),
		RuntimeContext:     clonePayloadMap(state.RuntimeContext),
		TurnLifecycle:      cloneTurnLifecycle(state.TurnLifecycle),
		SubmitAvailability: cloneSubmitAvailability(state.SubmitAvailability),
		PendingInteractive: cloneInteractivePrompt(state.PendingInteractive),
		CWD:                strings.TrimSpace(state.CWD),
		Title:              strings.TrimSpace(state.Title),
		LifecycleStatus:    strings.TrimSpace(state.LifecycleStatus),
		CurrentPhase:       strings.TrimSpace(state.CurrentPhase),
		OccurredAtUnixMS:   state.OccurredAtUnixMS,
	}
	if state.PendingInteractive != nil {
		patch.PendingInteractivePresent = true
	}
	if state.Turn != nil {
		patch.Turn = &WorkspaceAgentTurnPatch{
			TurnID:             strings.TrimSpace(state.Turn.TurnID),
			ActiveTurnID:       cloneStringPointer(state.Turn.ActiveTurnID),
			Phase:              strings.TrimSpace(state.Turn.Phase),
			Outcome:            strings.TrimSpace(state.Turn.Outcome),
			Settling:           state.Turn.Settling,
			CompletedCommand:   cloneCompletedCommand(state.Turn.CompletedCommand),
			SubmitAvailability: cloneSubmitAvailability(state.Turn.SubmitAvailability),
			FileChanges:        clonePayloadMap(state.Turn.FileChanges),
			StartedAtUnixMS:    state.Turn.StartedAtUnixMS,
			CompletedAtUnixMS:  state.Turn.CompletedAtUnixMS,
		}
	}
	return patch
}

func messageUpdatesFromSessionMessages(agentSessionID string, updates []WorkspaceAgentSessionMessageUpdate) []WorkspaceAgentMessageUpdate {
	if len(updates) == 0 {
		return nil
	}
	out := make([]WorkspaceAgentMessageUpdate, 0, len(updates))
	for _, update := range updates {
		out = append(out, WorkspaceAgentMessageUpdate{
			AgentSessionID:    strings.TrimSpace(agentSessionID),
			MessageID:         strings.TrimSpace(update.MessageID),
			TurnID:            strings.TrimSpace(update.TurnID),
			Role:              strings.TrimSpace(update.Role),
			Kind:              strings.TrimSpace(update.Kind),
			Status:            strings.TrimSpace(update.Status),
			Semantics:         cloneMessageSemantics(update.Semantics),
			Payload:           clonePayloadMap(update.Payload),
			OccurredAtUnixMS:  update.OccurredAtUnixMS,
			StartedAtUnixMS:   update.StartedAtUnixMS,
			CompletedAtUnixMS: update.CompletedAtUnixMS,
		})
	}
	return out
}

func applySessionStateTimesLocked(entry *sessionEntry, agentSessionID string, state WorkspaceAgentSessionStateUpdate) {
	if entry == nil || (state.StartedAtUnixMS <= 0 && state.EndedAtUnixMS <= 0) {
		return
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	for index := range entry.state.Sessions {
		if strings.TrimSpace(entry.state.Sessions[index].AgentSessionID) != agentSessionID {
			continue
		}
		if state.StartedAtUnixMS > 0 {
			entry.state.Sessions[index].StartedAtUnixMS = state.StartedAtUnixMS
		}
		if state.EndedAtUnixMS > 0 {
			entry.state.Sessions[index].EndedAtUnixMS = state.EndedAtUnixMS
		}
		return
	}
}

func (s *Store) MarkActivitySyncPending(
	roomID string,
	agentSessionID string,
	timelineItemCount int,
	statePatchCount int,
	messageUpdateCount int,
) (WorkspaceAgentSyncState, bool) {
	return s.updateActivitySyncState(roomID, agentSessionID, func(current *agentSessionSyncState, now int64) WorkspaceAgentSyncState {
		current.pendingReports++
		current.state.AgentSessionID = strings.TrimSpace(agentSessionID)
		current.state.Status = WorkspaceAgentSyncStatusPending
		current.state.PendingTimelineItemCount += max(0, timelineItemCount)
		current.state.PendingStatePatchCount += max(0, statePatchCount)
		current.state.PendingMessageUpdateCount += max(0, messageUpdateCount)
		current.state.AttemptCount++
		current.state.FailedReportCount = current.failedReports
		current.state.LastAttemptAtUnixMS = now
		current.state.UpdatedAtUnixMS = now
		return current.state
	})
}

func (s *Store) MarkActivitySyncSucceeded(
	roomID string,
	agentSessionID string,
	timelineItemCount int,
	statePatchCount int,
	messageUpdateCount int,
) (WorkspaceAgentSyncState, bool) {
	return s.updateActivitySyncState(roomID, agentSessionID, func(current *agentSessionSyncState, now int64) WorkspaceAgentSyncState {
		if current.pendingReports > 0 {
			current.pendingReports--
		}
		current.state.AgentSessionID = strings.TrimSpace(agentSessionID)
		current.state.PendingTimelineItemCount = max(0, current.state.PendingTimelineItemCount-max(0, timelineItemCount))
		current.state.PendingStatePatchCount = max(0, current.state.PendingStatePatchCount-max(0, statePatchCount))
		current.state.PendingMessageUpdateCount = max(0, current.state.PendingMessageUpdateCount-max(0, messageUpdateCount))
		current.failedReports = 0
		current.state.FailedReportCount = 0
		current.state.LastError = ""
		if current.pendingReports == 0 {
			current.state.Status = WorkspaceAgentSyncStatusSynced
			current.state.PendingTimelineItemCount = 0
			current.state.PendingStatePatchCount = 0
			current.state.PendingMessageUpdateCount = 0
			current.state.LastSyncedAtUnixMS = now
		} else {
			current.state.Status = WorkspaceAgentSyncStatusPending
		}
		current.state.UpdatedAtUnixMS = now
		return current.state
	})
}

func (s *Store) MarkActivitySyncFailed(
	roomID string,
	agentSessionID string,
	_ int,
	_ int,
	_ int,
	err error,
) (WorkspaceAgentSyncState, bool) {
	return s.updateActivitySyncState(roomID, agentSessionID, func(current *agentSessionSyncState, now int64) WorkspaceAgentSyncState {
		if current.pendingReports > 0 {
			current.pendingReports--
		}
		current.failedReports++
		current.state.AgentSessionID = strings.TrimSpace(agentSessionID)
		current.state.Status = WorkspaceAgentSyncStatusFailed
		current.state.FailedReportCount = current.failedReports
		if err != nil {
			current.state.LastError = strings.TrimSpace(err.Error())
		}
		current.state.UpdatedAtUnixMS = now
		return current.state
	})
}

func (*Store) applyEventLocked(entry *sessionEntry, _ string, source EventSource, event activityshared.Event, now int64) {
	sessionID := firstNonEmptyString(event.AgentSessionID, source.AgentID, event.ProviderSessionID, source.ProviderSessionID)
	if sessionID == "" {
		return
	}
	if isHiddenAgentSession(entry, sessionID) {
		return
	}
	timestamp := event.OccurredAtUnixMS
	if timestamp <= 0 {
		timestamp = now
	}
	if isAgentStatusEvent(event.Type) {
		index := findSessionIndex(entry.state.Sessions, sessionID, event.ProviderSessionID, source.ProviderSessionID, source.SessionOrigin)
		if index < 0 {
			session := WorkspaceAgentSession{
				AgentSessionID:    sessionID,
				UserID:            strings.TrimSpace(source.UserID),
				Provider:          firstNonEmptyString(string(event.Provider), source.Provider),
				ProviderSessionID: firstNonEmptyString(event.ProviderSessionID, source.ProviderSessionID),
				SessionOrigin:     strings.TrimSpace(source.SessionOrigin),
				CWD:               firstNonEmptyString(event.Payload.CWD, source.CWD),
				Status:            string(activityshared.SessionStatusIdle),
				LifecycleStatus:   string(activityshared.SessionLifecycleStatusActive),
				TurnPhase:         string(activityshared.TurnPhaseIdle),
				EffectiveStatus:   string(activityshared.SessionStatusIdle),
				StartedAtUnixMS:   timestamp,
				CreatedAtUnixMS:   timestamp,
				UpdatedAtUnixMS:   timestamp,
				Title:             strings.TrimSpace(event.Payload.Title),
			}
			entry.state.Sessions = append(entry.state.Sessions, session)
			slog.Info("agent activity local event created session",
				"event", "agent_activity.local_event.created",
				"source_agent_session_id", strings.TrimSpace(source.AgentID),
				"source_provider_session_id", strings.TrimSpace(source.ProviderSessionID),
				"source_origin", strings.TrimSpace(source.SessionOrigin),
				"activity_event_summary", summarizeWorkspaceAgentEventForLog(event),
				"session_after", summarizeWorkspaceAgentSessionForLog(session),
			)
			index = len(entry.state.Sessions) - 1
		}

		session := entry.state.Sessions[index]
		before := session
		if strings.TrimSpace(session.UserID) == "" {
			session.UserID = strings.TrimSpace(source.UserID)
		}
		if event.OccurredAtUnixMS > 0 && session.UpdatedAtUnixMS > event.OccurredAtUnixMS {
			entry.state.Sessions[index] = session
			slog.Info("agent activity local event ignored stale session update",
				"event", "agent_activity.local_event.ignored_stale",
				"source_agent_session_id", strings.TrimSpace(source.AgentID),
				"source_provider_session_id", strings.TrimSpace(source.ProviderSessionID),
				"source_origin", strings.TrimSpace(source.SessionOrigin),
				"activity_event_summary", summarizeWorkspaceAgentEventForLog(event),
				"session_before", summarizeWorkspaceAgentSessionForLog(before),
			)
			return
		}
		session.AgentSessionID = firstNonEmptyString(session.AgentSessionID, event.AgentSessionID, source.AgentID, event.ProviderSessionID, source.ProviderSessionID)
		session.Provider = firstNonEmptyString(string(event.Provider), session.Provider, source.Provider)
		session.ProviderSessionID = firstNonEmptyString(event.ProviderSessionID, session.ProviderSessionID, source.ProviderSessionID)
		session.SessionOrigin = firstNonEmptyString(strings.TrimSpace(source.SessionOrigin), session.SessionOrigin)
		session.CWD = firstNonEmptyString(event.Payload.CWD, session.CWD, source.CWD)
		if title := strings.TrimSpace(event.Payload.Title); title != "" {
			session.Title = title
		}
		if session.CreatedAtUnixMS <= 0 {
			session.CreatedAtUnixMS = timestamp
		}
		if session.StartedAtUnixMS <= 0 {
			session.StartedAtUnixMS = timestamp
		}

		applyStatusPayload(&session, event)
		syncCanonicalSessionStatus(&session)
		if shouldAdvanceSessionUpdatedAtFromActivityEvent(event) {
			session.UpdatedAtUnixMS = timestamp
		}
		entry.state.Sessions[index] = session
		slog.Info("agent activity local event updated session",
			"event", "agent_activity.local_event.updated",
			"source_agent_session_id", strings.TrimSpace(source.AgentID),
			"source_provider_session_id", strings.TrimSpace(source.ProviderSessionID),
			"source_origin", strings.TrimSpace(source.SessionOrigin),
			"activity_event_summary", summarizeWorkspaceAgentEventForLog(event),
			"session_before", summarizeWorkspaceAgentSessionForLog(before),
			"session_after", summarizeWorkspaceAgentSessionForLog(session),
		)
	}
	if update, ok := sessionMessageUpdateFromActivityEvent(sessionID, event, timestamp); ok {
		appendMessageUpdatesLocked(entry, source, []WorkspaceAgentMessageUpdate{update})
	}
}

func sessionMessageUpdateFromActivityEvent(
	sessionID string,
	event activityshared.Event,
	timestamp int64,
) (WorkspaceAgentMessageUpdate, bool) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" || timestamp <= 0 {
		return WorkspaceAgentMessageUpdate{}, false
	}
	switch event.Type {
	case activityshared.EventMessageAppended, activityshared.EventMessageCreated:
		messageID := firstNonEmptyString(payloadFirstStringValue(event.Payload.Metadata, "messageId"), event.EventID)
		if strings.TrimSpace(messageID) == "" {
			return WorkspaceAgentMessageUpdate{}, false
		}
		role := strings.TrimSpace(string(event.Payload.Role))
		if role == "" {
			role = string(activityshared.MessageRoleAssistant)
		}
		kind := "text"
		if role == string(activityshared.MessageRoleAssistantThinking) {
			role = string(activityshared.MessageRoleAssistant)
			kind = "reasoning"
		}
		payload := clonePayloadMap(event.Payload.Metadata)
		if payload == nil {
			payload = map[string]any{}
		}
		if event.Payload.Content != "" {
			if _, ok := payload["content"]; !ok {
				payload["content"] = event.Payload.Content
			}
			payload["text"] = event.Payload.Content
		}
		return WorkspaceAgentMessageUpdate{
			AgentSessionID:   sessionID,
			MessageID:        messageID,
			TurnID:           strings.TrimSpace(event.Payload.TurnID),
			Role:             role,
			Kind:             kind,
			Status:           firstNonEmptyString(payloadFirstStringValue(event.Payload.Metadata, "streamState"), event.Payload.Status),
			Payload:          payload,
			OccurredAtUnixMS: timestamp,
		}, true
	case activityshared.EventCallStarted, activityshared.EventCallCompleted, activityshared.EventCallFailed:
		callID := strings.TrimSpace(event.Payload.CallID)
		if callID == "" {
			return WorkspaceAgentMessageUpdate{}, false
		}
		status := firstNonEmptyString(payloadFirstStringValue(event.Payload.Metadata, "status"), event.Payload.Status)
		if status == "" {
			switch event.Type {
			case activityshared.EventCallStarted:
				status = string(activityshared.ActivityStatusRunning)
			case activityshared.EventCallCompleted:
				status = string(activityshared.ActivityStatusCompleted)
			case activityshared.EventCallFailed:
				status = string(activityshared.ActivityStatusFailed)
			}
		}
		payload := clonePayloadMap(event.Payload.Metadata)
		if payload == nil {
			payload = map[string]any{}
		}
		switch event.Type {
		case activityshared.EventCallStarted:
			payload["input"] = clonePayloadMap(event.Payload.Input)
		case activityshared.EventCallCompleted:
			payload["output"] = clonePayloadMap(event.Payload.Output)
		case activityshared.EventCallFailed:
			payload["error"] = clonePayloadMap(event.Payload.Error)
		}
		return WorkspaceAgentMessageUpdate{
			AgentSessionID:   sessionID,
			MessageID:        "toolcall:" + callID,
			TurnID:           strings.TrimSpace(event.Payload.TurnID),
			Role:             string(activityshared.MessageRoleAssistant),
			Kind:             "tool_call",
			Status:           status,
			CallID:           callID,
			Title:            strings.TrimSpace(event.Payload.Name),
			Payload:          payload,
			OccurredAtUnixMS: timestamp,
		}, true
	default:
		return WorkspaceAgentMessageUpdate{}, false
	}
}

func applyStatePatchLocked(entry *sessionEntry, source EventSource, patch WorkspaceAgentStatePatch, now int64) {
	sessionID := firstNonEmptyString(patch.AgentSessionID, source.AgentID)
	if sessionID != "" {
		sessionID = resolveKnownOrProviderAliasSessionID(
			entry.state.Sessions,
			sessionID,
			firstNonEmptyString(patch.Provider, source.Provider),
			patch.ProviderSessionID,
			source.ProviderSessionID,
			source.SessionOrigin,
		)
	}
	if sessionID == "" {
		sessionID = findUniqueSessionIDByProvider(
			entry.state.Sessions,
			firstNonEmptyString(patch.Provider, source.Provider),
			patch.ProviderSessionID,
			source.ProviderSessionID,
			source.SessionOrigin,
		)
	}
	if sessionID == "" || isHiddenAgentSession(entry, sessionID) {
		return
	}
	patch.AgentSessionID = sessionID
	timestamp := patch.OccurredAtUnixMS
	if timestamp <= 0 {
		timestamp = now
	}
	index := findSessionIndex(entry.state.Sessions, sessionID, patch.ProviderSessionID, source.ProviderSessionID, source.SessionOrigin)
	if index < 0 {
		effectiveStatus := firstNonEmptyString(
			effectiveStatusFromStatePatch(patch),
			string(activityshared.SessionStatusIdle),
		)
		session := WorkspaceAgentSession{
			AgentSessionID:     sessionID,
			AgentTargetID:      firstNonEmptyString(patch.AgentTargetID, source.AgentTargetID),
			UserID:             strings.TrimSpace(source.UserID),
			Provider:           firstNonEmptyString(patch.Provider, source.Provider),
			ProviderSessionID:  firstNonEmptyString(patch.ProviderSessionID, source.ProviderSessionID),
			SessionOrigin:      strings.TrimSpace(source.SessionOrigin),
			CWD:                firstNonEmptyString(patch.CWD, source.CWD),
			Status:             effectiveStatus,
			TurnLifecycle:      cloneTurnLifecycle(patch.TurnLifecycle),
			SubmitAvailability: cloneSubmitAvailability(patch.SubmitAvailability),
			LifecycleStatus:    firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive)),
			TurnPhase:          firstNonEmptyString(statePatchPhase(patch), string(activityshared.TurnPhaseIdle)),
			EffectiveStatus:    effectiveStatus,
			StartedAtUnixMS:    timestamp,
			CreatedAtUnixMS:    timestamp,
			UpdatedAtUnixMS:    timestamp,
			Title:              strings.TrimSpace(patch.Title),
		}
		entry.state.Sessions = append(entry.state.Sessions, session)
		slog.Info("agent activity local state patch created session",
			"event", "agent_activity.local_state_patch.created",
			"source_agent_session_id", strings.TrimSpace(source.AgentID),
			"source_provider_session_id", strings.TrimSpace(source.ProviderSessionID),
			"source_origin", strings.TrimSpace(source.SessionOrigin),
			"patch_summary", summarizeWorkspaceAgentStatePatchForLog(patch),
			"session_after", summarizeWorkspaceAgentSessionForLog(session),
		)
		index = len(entry.state.Sessions) - 1
	}

	session := entry.state.Sessions[index]
	before := session
	if strings.TrimSpace(session.UserID) == "" {
		session.UserID = strings.TrimSpace(source.UserID)
	}
	if patch.OccurredAtUnixMS > 0 && session.UpdatedAtUnixMS > patch.OccurredAtUnixMS {
		entry.state.Sessions[index] = session
		slog.Info("agent activity local state patch ignored stale session update",
			"event", "agent_activity.local_state_patch.ignored_stale",
			"source_agent_session_id", strings.TrimSpace(source.AgentID),
			"source_provider_session_id", strings.TrimSpace(source.ProviderSessionID),
			"source_origin", strings.TrimSpace(source.SessionOrigin),
			"patch_summary", summarizeWorkspaceAgentStatePatchForLog(patch),
			"session_before", summarizeWorkspaceAgentSessionForLog(before),
		)
		return
	}
	session.AgentSessionID = firstNonEmptyString(session.AgentSessionID, sessionID)
	session.AgentTargetID = firstNonEmptyString(patch.AgentTargetID, session.AgentTargetID, source.AgentTargetID)
	session.Provider = firstNonEmptyString(patch.Provider, session.Provider, source.Provider)
	session.ProviderSessionID = firstNonEmptyString(patch.ProviderSessionID, session.ProviderSessionID, source.ProviderSessionID)
	session.SessionOrigin = firstNonEmptyString(strings.TrimSpace(source.SessionOrigin), session.SessionOrigin)
	session.CWD = firstNonEmptyString(patch.CWD, session.CWD, source.CWD)
	if title := strings.TrimSpace(patch.Title); title != "" {
		session.Title = title
	}
	if lifecycle := strings.TrimSpace(patch.LifecycleStatus); lifecycle != "" {
		session.LifecycleStatus = lifecycle
	}
	if patch.TurnLifecycle != nil {
		session.TurnLifecycle = cloneTurnLifecycle(patch.TurnLifecycle)
	}
	if patch.SubmitAvailability != nil {
		session.SubmitAvailability = cloneSubmitAvailability(patch.SubmitAvailability)
	}
	if phase := statePatchPhase(patch); phase != "" {
		session.TurnPhase = phase
	}
	if effectiveStatus := effectiveStatusFromStatePatch(patch); effectiveStatus != "" {
		session.EffectiveStatus = effectiveStatus
	}
	if patch.Turn != nil {
		if patch.Turn.StartedAtUnixMS > 0 && session.StartedAtUnixMS <= 0 {
			session.StartedAtUnixMS = patch.Turn.StartedAtUnixMS
		}
		if patch.Turn.CompletedAtUnixMS > 0 {
			session.EndedAtUnixMS = patch.Turn.CompletedAtUnixMS
		}
	}
	if session.EndedAtUnixMS <= 0 && statePatchSettledEffectiveStatus(patch) != "" {
		session.EndedAtUnixMS = timestamp
	}
	if session.CreatedAtUnixMS <= 0 {
		session.CreatedAtUnixMS = timestamp
	}
	if session.StartedAtUnixMS <= 0 {
		session.StartedAtUnixMS = timestamp
	}
	syncCanonicalSessionStatus(&session)
	if shouldAdvanceSessionUpdatedAtFromStatePatch(patch) {
		session.UpdatedAtUnixMS = timestamp
	}
	entry.state.Sessions[index] = session
	canonicalizeSessionMessageBucketsLocked(entry)
	slog.Info("agent activity local state patch updated session",
		"event", "agent_activity.local_state_patch.updated",
		"source_agent_session_id", strings.TrimSpace(source.AgentID),
		"source_provider_session_id", strings.TrimSpace(source.ProviderSessionID),
		"source_origin", strings.TrimSpace(source.SessionOrigin),
		"patch_summary", summarizeWorkspaceAgentStatePatchForLog(patch),
		"session_before", summarizeWorkspaceAgentSessionForLog(before),
		"session_after", summarizeWorkspaceAgentSessionForLog(session),
	)
}

func statePatchTurnPhase(patch WorkspaceAgentStatePatch) string {
	if patch.Turn == nil {
		return ""
	}
	return strings.TrimSpace(patch.Turn.Phase)
}

func statePatchPhase(patch WorkspaceAgentStatePatch) string {
	phase := strings.ToLower(strings.TrimSpace(firstNonEmptyString(
		patch.CurrentPhase,
		statePatchTurnPhase(patch),
		statePatchPhaseFromEntities(patch),
	)))
	switch phase {
	case "ready":
		return string(activityshared.TurnPhaseIdle)
	default:
		return firstNonEmptyString(
			patch.CurrentPhase,
			statePatchTurnPhase(patch),
			statePatchPhaseFromEntities(patch),
		)
	}
}

func effectiveStatusFromStatePatch(patch WorkspaceAgentStatePatch) string {
	if terminal := statePatchTerminalEffectiveStatus(patch); terminal != "" {
		return terminal
	}
	phase := strings.ToLower(strings.TrimSpace(statePatchPhase(patch)))
	switch phase {
	case "submitted", "working", "running", "streaming":
		return string(activityshared.SessionStatusWorking)
	case "awaiting_approval", "waiting", "waiting_approval", "waiting_input":
		return string(activityshared.SessionStatusWaiting)
	case "failed":
		return string(activityshared.SessionStatusFailed)
	case "completed", "idle", "ready":
		return string(activityshared.SessionStatusIdle)
	}
	return ""
}

func statePatchPhaseFromEntities(patch WorkspaceAgentStatePatch) string {
	for _, entity := range patch.Entities {
		switch strings.ToLower(strings.TrimSpace(entity.Status)) {
		case "waiting", "waiting_input", "waiting_approval", "awaiting_approval":
			return "waiting_input"
		case "running", "streaming", "in_progress":
			return "working"
		}
	}
	return ""
}

func statePatchTerminalEffectiveStatus(patch WorkspaceAgentStatePatch) string {
	switch strings.ToLower(strings.TrimSpace(patch.LifecycleStatus)) {
	case "failed":
		return string(activityshared.SessionStatusFailed)
	case "completed", "ended":
		return string(activityshared.SessionStatusCompleted)
	case "canceled":
		return string(activityshared.SessionStatusCanceled)
	default:
		return ""
	}
}

func syncCanonicalSessionStatus(session *WorkspaceAgentSession) {
	if session == nil {
		return
	}
	status := canonicalWorkspaceAgentSessionStatus(*session)
	session.Status = status
	if shouldProjectCanonicalStatusToEffectiveStatus(*session, status) {
		session.EffectiveStatus = status
	}
}

func canonicalWorkspaceAgentSessionStatus(session WorkspaceAgentSession) string {
	switch normalizeSessionStatusToken(session.LifecycleStatus) {
	case "failed":
		return string(activityshared.SessionStatusFailed)
	case "completed", "ended":
		return string(activityshared.SessionStatusCompleted)
	case "canceled":
		return string(activityshared.SessionStatusCanceled)
	}

	switch normalizeSessionStatusToken(firstNonEmptyString(session.EffectiveStatus, session.Status)) {
	case "failed":
		return string(activityshared.SessionStatusFailed)
	case "completed", "ended", "end":
		return string(activityshared.SessionStatusCompleted)
	case "canceled":
		return string(activityshared.SessionStatusCanceled)
	case "waiting", "waiting_approval", "waiting_input":
		return string(activityshared.SessionStatusWaiting)
	case "submitted", "working", "running", "streaming":
		return string(activityshared.SessionStatusWorking)
	}

	switch normalizeSessionStatusToken(session.TurnPhase) {
	case "waiting", "waiting_approval", "waiting_input":
		return string(activityshared.SessionStatusWaiting)
	case "working", "running", "streaming":
		return string(activityshared.SessionStatusWorking)
	case "failed":
		return string(activityshared.SessionStatusFailed)
	default:
		return string(activityshared.SessionStatusIdle)
	}
}

func shouldProjectCanonicalStatusToEffectiveStatus(session WorkspaceAgentSession, status string) bool {
	effectiveStatus := normalizeSessionStatusToken(session.EffectiveStatus)
	if effectiveStatus == "" {
		return true
	}
	if status == string(activityshared.SessionStatusWaiting) {
		return true
	}
	if status == string(activityshared.SessionStatusCompleted) ||
		status == string(activityshared.SessionStatusFailed) ||
		status == string(activityshared.SessionStatusCanceled) {
		return true
	}
	return false
}

func normalizeSessionStatusToken(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func statePatchSettledEffectiveStatus(patch WorkspaceAgentStatePatch) string {
	if terminal := statePatchTerminalEffectiveStatus(patch); terminal != "" {
		return terminal
	}
	switch strings.ToLower(strings.TrimSpace(statePatchPhase(patch))) {
	case "failed":
		return string(activityshared.SessionStatusFailed)
	case "completed":
		return string(activityshared.SessionStatusCompleted)
	default:
		return ""
	}
}

func shouldAdvanceSessionUpdatedAtFromActivityEvent(event activityshared.Event) bool {
	switch event.Type {
	case activityshared.EventTurnStarted,
		activityshared.EventTurnCompleted,
		activityshared.EventTurnFailed:
		return true
	case activityshared.EventTurnUpdated:
		switch normalizeSessionStatusToken(event.Payload.TurnPhase) {
		case string(activityshared.SessionStatusWaiting),
			string(activityshared.TurnPhaseWaitingApproval),
			string(activityshared.TurnPhaseWaitingInput):
			return true
		}
	default:
		return false
	}
	return false
}

func shouldAdvanceSessionUpdatedAtFromStatePatch(patch WorkspaceAgentStatePatch) bool {
	switch normalizeSessionStatusToken(statePatchPhase(patch)) {
	case string(activityshared.SessionStatusWaiting),
		string(activityshared.TurnPhaseWaitingApproval),
		string(activityshared.TurnPhaseWaitingInput):
		return true
	}
	if patch.Turn == nil {
		return false
	}
	if patch.Turn.StartedAtUnixMS > 0 || patch.Turn.CompletedAtUnixMS > 0 {
		return true
	}
	switch normalizeSessionStatusToken(statePatchPhase(patch)) {
	case string(activityshared.TurnPhaseWorking),
		string(activityshared.TurnPhaseFailed):
		return true
	default:
		return false
	}
}

func isAgentStatusEvent(eventType activityshared.EventType) bool {
	switch eventType {
	case activityshared.EventSessionStarted,
		activityshared.EventSessionUpdated,
		activityshared.EventSessionCompleted,
		activityshared.EventSessionFailed,
		activityshared.EventTurnStarted,
		activityshared.EventTurnUpdated,
		activityshared.EventTurnCompleted,
		activityshared.EventTurnFailed:
		return true
	default:
		return false
	}
}

func summarizeWorkspaceAgentSessionForLog(session WorkspaceAgentSession) string {
	return strings.Join([]string{
		"agent_session_id=" + strings.TrimSpace(session.AgentSessionID),
		"provider_session_id=" + strings.TrimSpace(session.ProviderSessionID),
		"origin=" + strings.TrimSpace(session.SessionOrigin),
		"lifecycle=" + strings.TrimSpace(session.LifecycleStatus),
		"turn=" + strings.TrimSpace(session.TurnPhase),
		"effective=" + strings.TrimSpace(session.EffectiveStatus),
		"title=" + strings.TrimSpace(session.Title),
	}, " ")
}

func summarizeWorkspaceAgentStatePatchForLog(patch WorkspaceAgentStatePatch) string {
	entitySummaries := make([]string, 0, len(patch.Entities))
	for _, entity := range patch.Entities {
		entitySummaries = append(entitySummaries, strings.Join([]string{
			"name=" + strings.TrimSpace(entity.Name),
			"call=" + strings.TrimSpace(entity.CallID),
			"status=" + strings.TrimSpace(entity.Status),
			"turn=" + strings.TrimSpace(entity.TurnID),
		}, " "))
	}
	return strings.Join([]string{
		"agent_session_id=" + strings.TrimSpace(patch.AgentSessionID),
		"provider_session_id=" + strings.TrimSpace(patch.ProviderSessionID),
		"lifecycle=" + strings.TrimSpace(patch.LifecycleStatus),
		"current_phase=" + strings.TrimSpace(patch.CurrentPhase),
		"turn_phase=" + strings.TrimSpace(statePatchTurnPhase(patch)),
		"inferred_phase=" + strings.TrimSpace(statePatchPhaseFromEntities(patch)),
		"title=" + strings.TrimSpace(patch.Title),
		"entities=[" + strings.Join(entitySummaries, " || ") + "]",
	}, " ")
}

func summarizeWorkspaceAgentEventForLog(event activityshared.Event) string {
	return strings.Join([]string{
		"type=" + strings.TrimSpace(string(event.Type)),
		"agent_session_id=" + strings.TrimSpace(event.AgentSessionID),
		"provider_session_id=" + strings.TrimSpace(event.ProviderSessionID),
		"occurred_at_unix_ms=" + strconv.FormatInt(event.OccurredAtUnixMS, 10),
		"lifecycle=" + strings.TrimSpace(event.Payload.LifecycleStatus),
		"effective=" + strings.TrimSpace(event.Payload.EffectiveStatus),
		"turn_id=" + strings.TrimSpace(event.Payload.TurnID),
		"turn_phase=" + strings.TrimSpace(event.Payload.TurnPhase),
		"turn_outcome=" + strings.TrimSpace(event.Payload.TurnOutcome),
		"title=" + strings.TrimSpace(event.Payload.Title),
	}, " ")
}

func findSessionIndex(
	sessions []WorkspaceAgentSession,
	sessionID,
	providerSessionID,
	sourceProviderSessionID,
	sessionOrigin string,
) int {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID != "" {
		for index, session := range sessions {
			if strings.TrimSpace(session.AgentSessionID) == sessionID {
				return index
			}
		}
		return -1
	}

	providerSessionID = strings.TrimSpace(firstNonEmptyString(providerSessionID, sourceProviderSessionID))
	if providerSessionID == "" {
		return -1
	}
	sessionOrigin = NormalizeSessionOrigin(sessionOrigin)
	if sessionOrigin == "" {
		return -1
	}
	for index, session := range sessions {
		if strings.TrimSpace(session.ProviderSessionID) != providerSessionID {
			continue
		}
		if NormalizeSessionOrigin(session.SessionOrigin) != sessionOrigin {
			continue
		}
		return index
	}
	return -1
}

func applyStatusPayload(session *WorkspaceAgentSession, event activityshared.Event) {
	if session == nil {
		return
	}
	switch event.Type {
	case activityshared.EventSessionStarted:
		session.LifecycleStatus = firstNonEmptyString(event.Payload.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		session.EffectiveStatus = firstNonEmptyString(event.Payload.EffectiveStatus, string(activityshared.SessionStatusIdle))
		session.TurnPhase = firstNonEmptyString(event.Payload.TurnPhase, string(activityshared.TurnPhaseIdle))
	case activityshared.EventSessionUpdated:
		if event.Payload.LifecycleStatus != "" {
			session.LifecycleStatus = event.Payload.LifecycleStatus
		}
		if event.Payload.EffectiveStatus != "" {
			session.EffectiveStatus = event.Payload.EffectiveStatus
			if event.Payload.EffectiveStatus == string(activityshared.SessionStatusIdle) {
				session.TurnPhase = string(activityshared.TurnPhaseIdle)
			}
		}
		if event.Payload.TurnPhase != "" {
			session.TurnPhase = event.Payload.TurnPhase
		}
	case activityshared.EventSessionCompleted:
		session.LifecycleStatus = firstNonEmptyString(event.Payload.LifecycleStatus, string(activityshared.SessionLifecycleStatusEnded))
		session.EffectiveStatus = firstNonEmptyString(event.Payload.EffectiveStatus, string(activityshared.SessionStatusCompleted))
		session.TurnPhase = string(activityshared.TurnPhaseIdle)
		if event.OccurredAtUnixMS > 0 {
			session.EndedAtUnixMS = event.OccurredAtUnixMS
		}
	case activityshared.EventSessionFailed:
		session.LifecycleStatus = firstNonEmptyString(event.Payload.LifecycleStatus, string(activityshared.SessionLifecycleStatusFailed))
		session.EffectiveStatus = firstNonEmptyString(event.Payload.EffectiveStatus, string(activityshared.SessionStatusFailed))
		session.TurnPhase = string(activityshared.TurnPhaseFailed)
		if event.OccurredAtUnixMS > 0 {
			session.EndedAtUnixMS = event.OccurredAtUnixMS
		}
	case activityshared.EventTurnStarted:
		session.LifecycleStatus = firstNonEmptyString(session.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		session.EffectiveStatus = string(activityshared.SessionStatusWorking)
		session.TurnPhase = firstNonEmptyString(event.Payload.TurnPhase, string(activityshared.TurnPhaseWorking))
	case activityshared.EventTurnUpdated:
		session.LifecycleStatus = firstNonEmptyString(session.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		if event.Payload.TurnPhase != "" {
			session.TurnPhase = event.Payload.TurnPhase
		}
		switch session.TurnPhase {
		case string(activityshared.TurnPhaseWaitingApproval), string(activityshared.TurnPhaseWaitingInput):
			session.EffectiveStatus = string(activityshared.SessionStatusWaiting)
		case string(activityshared.TurnPhaseIdle):
			session.EffectiveStatus = string(activityshared.SessionStatusIdle)
		default:
			session.EffectiveStatus = string(activityshared.SessionStatusWorking)
		}
	case activityshared.EventTurnCompleted:
		session.TurnPhase = firstNonEmptyString(event.Payload.TurnPhase, string(activityshared.TurnPhaseIdle))
		session.EffectiveStatus = string(activityshared.SessionStatusIdle)
	case activityshared.EventTurnFailed:
		session.TurnPhase = firstNonEmptyString(event.Payload.TurnPhase, string(activityshared.TurnPhaseFailed))
		session.EffectiveStatus = string(activityshared.SessionStatusFailed)
	}
}

func (s *Store) InterruptWorkspaceAgents(ctx context.Context, roomID string, reason string) error {
	return s.interruptWorkspaceAgents(ctx, roomID, reason, nil)
}

func (s *Store) InterruptWorkspaceAgentSessions(ctx context.Context, roomID string, reason string, agentSessionIDs []string) error {
	targets := make(map[string]struct{}, len(agentSessionIDs))
	for _, agentSessionID := range agentSessionIDs {
		agentSessionID = strings.TrimSpace(agentSessionID)
		if agentSessionID != "" {
			targets[agentSessionID] = struct{}{}
		}
	}
	if len(targets) == 0 {
		return nil
	}
	return s.interruptWorkspaceAgents(ctx, roomID, reason, targets)
}

func (s *Store) interruptWorkspaceAgents(ctx context.Context, roomID string, _ string, targets map[string]struct{}) error {
	roomID = strings.TrimSpace(roomID)
	if s == nil || roomID == "" {
		return nil
	}
	entry := s.roomEntry(roomID)
	if entry == nil {
		return nil
	}

	now := time.Now().UnixMilli()
	patches := make([]WorkspaceAgentStatePatch, 0)
	patchOrigins := make([]string, 0)

	entry.mu.Lock()
	allowSingleSessionFallback := targets != nil && len(entry.state.Sessions) == 1
	matchedAgentTargets := make(map[string]struct{})
	providerTargetContexts := make(map[string]WorkspaceAgentSession)
	for index := range entry.state.Sessions {
		session := entry.state.Sessions[index]
		if targets != nil {
			if !matchesAgentSessionTarget(session, targets) && !allowSingleSessionFallback {
				continue
			}
			if _, ok := targets[strings.TrimSpace(session.AgentSessionID)]; ok {
				matchedAgentTargets[strings.TrimSpace(session.AgentSessionID)] = struct{}{}
			}
			if providerSessionID := strings.TrimSpace(session.ProviderSessionID); providerSessionID != "" {
				if _, ok := targets[providerSessionID]; ok {
					providerTargetContexts[providerSessionID] = session
				}
			}
		}
		if !isInterruptibleAgentSession(session, targets != nil) {
			continue
		}

		patches = append(patches, WorkspaceAgentStatePatch{
			AgentSessionID:    strings.TrimSpace(session.AgentSessionID),
			AgentTargetID:     strings.TrimSpace(session.AgentTargetID),
			Provider:          strings.TrimSpace(session.Provider),
			ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
			CWD:               strings.TrimSpace(session.CWD),
			LifecycleStatus:   string(activityshared.SessionStatusCompleted),
			CurrentPhase:      string(activityshared.TurnPhaseIdle),
			OccurredAtUnixMS:  now,
		})
		patchOrigins = append(patchOrigins, NormalizeSessionOrigin(session.SessionOrigin))

		session.LifecycleStatus = string(activityshared.SessionLifecycleStatusEnded)
		session.TurnPhase = string(activityshared.TurnPhaseIdle)
		session.EffectiveStatus = string(activityshared.SessionStatusCompleted)
		session.Status = string(activityshared.SessionStatusCompleted)
		session.EndedAtUnixMS = now
		session.UpdatedAtUnixMS = now
		entry.state.Sessions[index] = session
	}
	if targets != nil && len(providerTargetContexts) == 1 {
		var providerContext WorkspaceAgentSession
		var providerSessionID string
		for key, session := range providerTargetContexts {
			providerSessionID = key
			providerContext = session
		}
		for target := range targets {
			if target == providerSessionID {
				continue
			}
			if _, ok := matchedAgentTargets[target]; ok {
				continue
			}
			patches = append(patches, WorkspaceAgentStatePatch{
				AgentSessionID:    target,
				Provider:          strings.TrimSpace(providerContext.Provider),
				ProviderSessionID: providerSessionID,
				CWD:               strings.TrimSpace(providerContext.CWD),
				LifecycleStatus:   string(activityshared.SessionStatusCompleted),
				CurrentPhase:      string(activityshared.TurnPhaseIdle),
				OccurredAtUnixMS:  now,
			})
			patchOrigins = append(patchOrigins, WorkspaceAgentSessionOriginRuntime)
		}
	}
	entry.mu.Unlock()

	reporter, ok := s.client.(SessionActivityReporter)
	if !ok || reporter == nil {
		return nil
	}
	if len(patches) == 0 {
		return nil
	}
	type interruptReportPatch struct {
		patch  WorkspaceAgentStatePatch
		origin string
	}
	reportPatches := make([]interruptReportPatch, 0, len(patches))
	for index, patch := range patches {
		origin := ""
		if index < len(patchOrigins) {
			origin = patchOrigins[index]
		}
		if origin == "" {
			origin = WorkspaceAgentSessionOriginRuntime
		}
		reportPatches = append(reportPatches, interruptReportPatch{patch: patch, origin: origin})
	}
	sort.SliceStable(reportPatches, func(i, j int) bool {
		return interruptReportOriginRank(reportPatches[i].origin) < interruptReportOriginRank(reportPatches[j].origin)
	})
	for _, reportPatch := range reportPatches {
		patch := reportPatch.patch
		origin := reportPatch.origin
		_, err := ReportActivityAsSessionUpdates(ctx, reporter, ReportActivityInput{
			WorkspaceID: roomID,
			Source: EventSource{
				Provider:          strings.TrimSpace(patch.Provider),
				ProviderSessionID: strings.TrimSpace(patch.ProviderSessionID),
				AgentID:           strings.TrimSpace(patch.AgentSessionID),
				CWD:               strings.TrimSpace(patch.CWD),
				SessionOrigin:     origin,
			},
			StatePatches: []WorkspaceAgentStatePatch{patch},
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func statePatchFromActivityEvent(source EventSource, event activityshared.Event, sessionID string, timestamp int64) (WorkspaceAgentStatePatch, bool) {
	if !isAgentStatusEvent(event.Type) {
		return WorkspaceAgentStatePatch{}, false
	}
	patch := WorkspaceAgentStatePatch{
		AgentSessionID:    strings.TrimSpace(sessionID),
		Provider:          firstNonEmptyString(string(event.Provider), source.Provider),
		ProviderSessionID: firstNonEmptyString(event.ProviderSessionID, source.ProviderSessionID),
		CWD:               firstNonEmptyString(event.Payload.CWD, source.CWD),
		Title:             strings.TrimSpace(event.Payload.Title),
		LifecycleStatus:   strings.TrimSpace(event.Payload.LifecycleStatus),
		CurrentPhase:      firstNonEmptyString(event.Payload.TurnPhase, event.Payload.EffectiveStatus),
		LastError:         statePatchLastError(event),
		OccurredAtUnixMS:  timestamp,
	}
	if turnID := strings.TrimSpace(event.Payload.TurnID); turnID != "" {
		patch.Turn = &WorkspaceAgentTurnPatch{
			TurnID:  turnID,
			Phase:   strings.TrimSpace(event.Payload.TurnPhase),
			Outcome: strings.TrimSpace(event.Payload.TurnOutcome),
		}
	}
	applyExplicitTurnLifecycleToPatch(&patch, event)
	switch event.Type {
	case activityshared.EventSessionStarted:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseIdle))
	case activityshared.EventSessionCompleted:
		patch.LifecycleStatus = string(activityshared.SessionStatusCompleted)
		patch.CurrentPhase = string(activityshared.TurnPhaseIdle)
	case activityshared.EventSessionFailed:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusFailed))
		patch.CurrentPhase = string(activityshared.TurnPhaseFailed)
	case activityshared.EventTurnStarted:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseWorking))
		if patch.Turn != nil {
			patch.Turn.StartedAtUnixMS = timestamp
			patch.Turn.Phase = firstNonEmptyString(patch.Turn.Phase, patch.CurrentPhase)
		}
	case activityshared.EventTurnCompleted:
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseIdle))
		if patch.Turn != nil {
			patch.Turn.CompletedAtUnixMS = timestamp
			patch.Turn.Phase = firstNonEmptyString(patch.Turn.Phase, patch.CurrentPhase)
		}
	case activityshared.EventTurnFailed:
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseFailed))
		if patch.Turn != nil {
			patch.Turn.CompletedAtUnixMS = timestamp
			patch.Turn.Phase = firstNonEmptyString(patch.Turn.Phase, patch.CurrentPhase)
		}
	}
	return patch, true
}

func statePatchLastError(event activityshared.Event) string {
	switch event.Type {
	case activityshared.EventSessionUpdated:
		if strings.TrimSpace(event.Payload.EffectiveStatus) == string(activityshared.SessionStatusPaused) {
			return ""
		}
	case activityshared.EventTurnCompleted:
		if strings.TrimSpace(event.Payload.TurnOutcome) == string(activityshared.TurnOutcomeInterrupted) {
			return ""
		}
	}
	return activityshared.BestEffortErrorMessage(event.Payload)
}

func applyExplicitTurnLifecycleToPatch(patch *WorkspaceAgentStatePatch, event activityshared.Event) {
	if patch == nil || strings.TrimSpace(patch.Provider) != string(activityshared.ProviderCodex) {
		return
	}
	turnID := strings.TrimSpace(event.Payload.TurnID)
	if turnID == "" {
		return
	}
	lifecyclePhase := explicitTurnLifecyclePhaseFromActivityEvent(event)
	if lifecyclePhase == "" {
		return
	}
	activeTurnID := turnID
	turnActive := &activeTurnID
	outcome := strings.TrimSpace(event.Payload.TurnOutcome)
	if lifecyclePhase == "settled" {
		turnActive = nil
		outcome = explicitTurnLifecycleOutcomeFromActivityEvent(event)
	}
	if patch.Turn == nil {
		patch.Turn = &WorkspaceAgentTurnPatch{TurnID: turnID}
	}
	patch.Turn.Phase = lifecyclePhase
	patch.Turn.ActiveTurnID = turnActive
	patch.Turn.Outcome = outcome
	patch.Turn.SubmitAvailability = submitAvailabilityForTurnLifecyclePhase(lifecyclePhase)
	if command := completedCommandFromEventMetadata(event.Payload.Metadata); command != nil {
		patch.Turn.CompletedCommand = command
	}
	patch.SubmitAvailability = cloneSubmitAvailability(patch.Turn.SubmitAvailability)
	patch.TurnLifecycle = &WorkspaceAgentTurnLifecycle{
		ActiveTurnID:     turnActive,
		Phase:            lifecyclePhase,
		CompletedCommand: cloneCompletedCommand(patch.Turn.CompletedCommand),
	}
	if outcome != "" {
		patch.TurnLifecycle.Outcome = &outcome
	}
}

func completedCommandFromEventMetadata(metadata map[string]any) *WorkspaceAgentCompletedCommand {
	kind := firstNonEmptyString(
		stringValueFromPayloadMap(metadata, "completedCommandKind"),
		stringValueFromPayloadMap(metadata, "noticeCommand"),
	)
	status := firstNonEmptyString(
		stringValueFromPayloadMap(metadata, "completedCommandStatus"),
		stringValueFromPayloadMap(metadata, "noticeCommandStatus"),
	)
	if kind == "" || status == "" {
		return nil
	}
	return &WorkspaceAgentCompletedCommand{
		Kind:   kind,
		Status: status,
	}
}

func explicitTurnLifecyclePhaseFromActivityEvent(event activityshared.Event) string {
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
	}
	return ""
}

func explicitTurnLifecycleOutcomeFromActivityEvent(event activityshared.Event) string {
	switch event.Type {
	case activityshared.EventTurnFailed:
		return "failed"
	case activityshared.EventTurnCompleted:
		if strings.TrimSpace(event.Payload.TurnOutcome) == string(activityshared.TurnOutcomeInterrupted) {
			return "canceled"
		}
		return "completed"
	default:
		return strings.TrimSpace(event.Payload.TurnOutcome)
	}
}

func submitAvailabilityForTurnLifecyclePhase(phase string) *WorkspaceAgentSubmitAvailability {
	switch phase {
	case "settled":
		return &WorkspaceAgentSubmitAvailability{State: "available"}
	case "waiting":
		return &WorkspaceAgentSubmitAvailability{State: "blocked", Reason: "waiting"}
	case "submitted", "running":
		return &WorkspaceAgentSubmitAvailability{State: "blocked", Reason: "active_turn"}
	default:
		return nil
	}
}

func (s *Store) listRoomIDs() []string {
	if s == nil {
		return nil
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	roomIDs := make([]string, 0, len(s.rooms))
	for roomID := range s.rooms {
		roomIDs = append(roomIDs, roomID)
	}
	return roomIDs
}

func matchesAgentSessionTarget(session WorkspaceAgentSession, targets map[string]struct{}) bool {
	if len(targets) == 0 {
		return false
	}
	if _, ok := targets[strings.TrimSpace(session.AgentSessionID)]; ok {
		return true
	}
	if _, ok := targets[strings.TrimSpace(session.ProviderSessionID)]; ok {
		return true
	}
	return false
}

func isInterruptibleAgentSession(session WorkspaceAgentSession, explicitTarget bool) bool {
	switch strings.TrimSpace(session.EffectiveStatus) {
	case "working", "active", "waiting":
		return true
	}
	return explicitTarget && !isTerminalAgentSession(session)
}

func isTerminalAgentSession(session WorkspaceAgentSession) bool {
	switch normalizeSessionStatusToken(session.LifecycleStatus) {
	case "completed", "ended", "failed", "canceled":
		return true
	}
	switch normalizeSessionStatusToken(firstNonEmptyString(session.EffectiveStatus, session.Status)) {
	case "completed", "ended", "failed", "canceled":
		return true
	}
	return false
}

func interruptReportOriginRank(origin string) int {
	switch NormalizeSessionOrigin(origin) {
	case WorkspaceAgentSessionOriginRuntime:
		return 0
	default:
		return 1
	}
}

func (s *Store) markSessionIdle(roomID, agentSessionID string, updatedAtUnixMS int64) {
	agentSessionID = strings.TrimSpace(agentSessionID)
	entry := s.roomEntry(roomID)
	if entry == nil || agentSessionID == "" {
		return
	}

	entry.mu.Lock()
	defer entry.mu.Unlock()

	for index := range entry.state.Sessions {
		session := entry.state.Sessions[index]
		if strings.TrimSpace(session.AgentSessionID) != agentSessionID {
			continue
		}
		session.LifecycleStatus = string(activityshared.SessionLifecycleStatusActive)
		session.TurnPhase = string(activityshared.TurnPhaseIdle)
		session.EffectiveStatus = string(activityshared.SessionStatusIdle)
		if updatedAtUnixMS > 0 {
			session.UpdatedAtUnixMS = updatedAtUnixMS
		}
		entry.state.Sessions[index] = session
		return
	}
}

func (s *Store) updateActivitySyncState(
	roomID string,
	agentSessionID string,
	update func(*agentSessionSyncState, int64) WorkspaceAgentSyncState,
) (WorkspaceAgentSyncState, bool) {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if s == nil || agentSessionID == "" || update == nil {
		return WorkspaceAgentSyncState{}, false
	}
	roomID = strings.TrimSpace(roomID)
	entry := s.roomEntry(roomID)
	if entry == nil {
		return WorkspaceAgentSyncState{}, false
	}

	entry.mu.Lock()
	if isHiddenAgentSession(entry, agentSessionID) {
		entry.mu.Unlock()
		return WorkspaceAgentSyncState{}, false
	}
	if entry.syncStates == nil {
		entry.syncStates = make(map[string]*agentSessionSyncState)
	}
	current := entry.syncStates[agentSessionID]
	if current == nil {
		current = &agentSessionSyncState{
			state: WorkspaceAgentSyncState{AgentSessionID: agentSessionID},
		}
		entry.syncStates[agentSessionID] = current
	}
	next := update(current, time.Now().UnixMilli())
	current.state = next
	entry.mu.Unlock()
	s.saveSyncState(roomID, next)
	s.notifyRoomUpdate(roomID)
	return next, true
}

func (s *Store) loadStoredSyncStates(roomID string) map[string]WorkspaceAgentSyncState {
	if s == nil || s.syncStateStore == nil {
		return nil
	}
	states, err := s.syncStateStore.LoadRoomSyncStates(context.Background(), roomID)
	if err != nil {
		slog.Warn("agent activity sync state load failed",
			"event", "agent_activity.sync_state.load_failed",
			"room_id", strings.TrimSpace(roomID),
			"error", err,
		)
		return nil
	}
	return states
}

func (s *Store) saveSyncState(roomID string, syncState WorkspaceAgentSyncState) {
	if s == nil || s.syncStateStore == nil {
		return
	}
	if err := s.syncStateStore.SaveAgentSyncState(context.Background(), roomID, syncState); err != nil {
		slog.Warn("agent activity sync state save failed",
			"event", "agent_activity.sync_state.save_failed",
			"room_id", strings.TrimSpace(roomID),
			"agent_session_id", strings.TrimSpace(syncState.AgentSessionID),
			"error", err,
		)
	}
}

func syncEntryFromState(syncState WorkspaceAgentSyncState) *agentSessionSyncState {
	agentSessionID := strings.TrimSpace(syncState.AgentSessionID)
	syncState.AgentSessionID = agentSessionID
	failedReports := max(0, syncState.FailedReportCount)
	if syncState.Status == WorkspaceAgentSyncStatusPending {
		syncState.Status = WorkspaceAgentSyncStatusFailed
		if strings.TrimSpace(syncState.LastError) == "" {
			syncState.LastError = "sync result unavailable after desktopd restart"
		}
	}
	if syncState.Status == WorkspaceAgentSyncStatusFailed && failedReports == 0 {
		failedReports = 1
		syncState.FailedReportCount = failedReports
	}
	return &agentSessionSyncState{
		state:         syncState,
		failedReports: failedReports,
	}
}

func (s *Store) updateState(roomID string, snapshot WorkspaceAgentSnapshot) {
	entry := s.roomEntry(roomID)
	if entry == nil {
		return
	}

	entry.mu.Lock()
	before := snapshotFromEntryLocked(entry)

	entry.state.Presences = clonePresences(snapshot.Presences)
	entry.state.Sessions = normalizeSyncedSessions(
		filterHiddenSessions(snapshot.Sessions, entry.hiddenSessions),
		entry.state.Sessions,
	)
	canonicalizeSessionMessageBucketsLocked(entry)
	mergeSnapshotMessagesLocked(entry, snapshot)
	changed := !workspaceAgentSnapshotBusinessEqual(before, snapshotFromEntryLocked(entry))
	entry.mu.Unlock()
	if changed {
		s.notifyRoomUpdate(roomID)
	}
}

func (s *Store) updateStateForOrigin(
	roomID string,
	snapshot WorkspaceAgentSnapshot,
	sessionOrigin string,
) {
	entry := s.roomEntry(roomID)
	if entry == nil {
		return
	}

	entry.mu.Lock()
	before := snapshotFromEntryLocked(entry)

	origin := NormalizeSessionOrigin(sessionOrigin)
	incoming := normalizeSyncedSessions(
		filterHiddenSessions(snapshot.Sessions, entry.hiddenSessions),
		entry.state.Sessions,
	)
	entry.state.Presences = clonePresences(snapshot.Presences)
	entry.state.Sessions = mergeSyncedSessionsForOrigin(entry.state.Sessions, incoming, origin)
	canonicalizeSessionMessageBucketsLocked(entry)
	mergeSnapshotMessagesLocked(entry, snapshot)
	changed := !workspaceAgentSnapshotBusinessEqual(before, snapshotFromEntryLocked(entry))
	entry.mu.Unlock()
	if changed {
		s.notifyRoomUpdate(roomID)
	}
}

func normalizeSyncedSessions(sessions []WorkspaceAgentSession, previous []WorkspaceAgentSession) []WorkspaceAgentSession {
	next := cloneSessions(sessions)
	previousByID := make(map[string]WorkspaceAgentSession, len(previous))
	for _, session := range previous {
		if id := strings.TrimSpace(session.AgentSessionID); id != "" {
			previousByID[id] = session
		}
	}
	for index := range next {
		syncCanonicalSessionStatus(&next[index])
		sessionID := strings.TrimSpace(next[index].AgentSessionID)
		previousSession, ok := previousByID[sessionID]
		if !ok || !shouldPreserveLocalSessionProjection(previousSession, next[index]) {
			continue
		}
		next[index].LifecycleStatus = previousSession.LifecycleStatus
		next[index].TurnPhase = previousSession.TurnPhase
		next[index].Status = previousSession.Status
		next[index].EffectiveStatus = previousSession.EffectiveStatus
		next[index].UpdatedAtUnixMS = previousSession.UpdatedAtUnixMS
		next[index].EndedAtUnixMS = previousSession.EndedAtUnixMS
	}
	return next
}

func mergeSyncedSessionsForOrigin(
	previous []WorkspaceAgentSession,
	incoming []WorkspaceAgentSession,
	sessionOrigin string,
) []WorkspaceAgentSession {
	if sessionOrigin == "" {
		return incoming
	}
	next := cloneSessions(incoming)
	incomingByID := make(map[string]struct{}, len(incoming))
	for _, session := range incoming {
		if id := strings.TrimSpace(session.AgentSessionID); id != "" {
			incomingByID[id] = struct{}{}
		}
	}
	for _, session := range previous {
		sessionID := strings.TrimSpace(session.AgentSessionID)
		if sessionID == "" {
			continue
		}
		if NormalizeSessionOrigin(session.SessionOrigin) == sessionOrigin {
			continue
		}
		if _, ok := incomingByID[sessionID]; ok {
			continue
		}
		next = append(next, cloneSession(session))
	}
	return next
}

func shouldPreserveLocalSessionProjection(previous, incoming WorkspaceAgentSession) bool {
	return shouldPreserveLocalSettledTurn(previous, incoming) ||
		shouldPreserveLocalTerminal(previous, incoming) ||
		shouldPreserveLocalIdle(previous, incoming)
}

func shouldPreserveLocalSettledTurn(previous, incoming WorkspaceAgentSession) bool {
	if previous.EndedAtUnixMS <= 0 {
		return false
	}
	if isTerminalSession(previous) {
		return false
	}
	if !isIdleOrTerminalRuntimeSession(previous) {
		return false
	}
	if !isWorkingRuntimeSession(incoming) {
		return false
	}
	if incoming.StartedAtUnixMS > previous.EndedAtUnixMS {
		return false
	}
	return true
}

func shouldPreserveLocalTerminal(previous, incoming WorkspaceAgentSession) bool {
	if !isTerminalSession(previous) {
		return false
	}
	if isTerminalSession(incoming) {
		return false
	}
	if previous.UpdatedAtUnixMS <= 0 {
		return false
	}
	return incoming.UpdatedAtUnixMS <= previous.UpdatedAtUnixMS
}

func shouldPreserveLocalIdle(previous, incoming WorkspaceAgentSession) bool {
	if strings.ToLower(strings.TrimSpace(previous.EffectiveStatus)) != string(activityshared.SessionStatusIdle) {
		return false
	}
	if strings.ToLower(strings.TrimSpace(previous.TurnPhase)) != string(activityshared.TurnPhaseIdle) {
		return false
	}
	if !isActiveSession(incoming) {
		return false
	}
	if isPassiveSessionUpdate(incoming) {
		return true
	}
	if previous.UpdatedAtUnixMS <= 0 {
		return false
	}
	return incoming.UpdatedAtUnixMS <= previous.UpdatedAtUnixMS
}

func isPassiveSessionUpdate(session WorkspaceAgentSession) bool {
	return strings.ToLower(strings.TrimSpace(session.EffectiveStatus)) == "active" &&
		strings.ToLower(strings.TrimSpace(session.TurnPhase)) == "updated"
}

func (s *Store) appendSessionMessages(
	roomID string,
	agentSessionID string,
	messages []WorkspaceAgentSessionMessage,
	latestVersion uint64,
) {
	agentSessionID = strings.TrimSpace(agentSessionID)
	entry := s.roomEntry(roomID)
	if entry == nil || agentSessionID == "" {
		return
	}

	entry.mu.Lock()
	changed := appendSessionMessagesLocked(entry, agentSessionID, messages, latestVersion)
	entry.mu.Unlock()
	if changed {
		s.notifyRoomUpdate(roomID)
	}
}

func appendMessageUpdatesLocked(entry *sessionEntry, source EventSource, updates []WorkspaceAgentMessageUpdate) bool {
	if entry == nil || len(updates) == 0 {
		return false
	}
	grouped := make(map[string][]WorkspaceAgentSessionMessage)
	for _, update := range updates {
		sessionID := resolveMessageUpdateSessionID(entry, source, update)
		if sessionID == "" || isHiddenAgentSession(entry, sessionID) {
			continue
		}
		message := sessionMessageFromLegacyUpdate(sessionID, update)
		if strings.TrimSpace(message.MessageID) == "" {
			continue
		}
		grouped[sessionID] = append(grouped[sessionID], message)
	}
	changed := false
	for sessionID, messages := range grouped {
		if appendSessionMessagesForProviderLocked(entry, source.Provider, sessionID, messages, 0) {
			changed = true
		}
	}
	return changed
}

func resolveMessageUpdateSessionID(
	entry *sessionEntry,
	source EventSource,
	update WorkspaceAgentMessageUpdate,
) string {
	if entry == nil {
		return ""
	}
	sessionID := firstNonEmptyString(update.AgentSessionID, source.AgentID)
	if sessionID != "" {
		return resolveKnownOrProviderAliasSessionID(
			entry.state.Sessions,
			sessionID,
			source.Provider,
			"",
			source.ProviderSessionID,
			source.SessionOrigin,
		)
	}
	canonicalID := findUniqueSessionIDByProvider(
		entry.state.Sessions,
		source.Provider,
		"",
		source.ProviderSessionID,
		source.SessionOrigin,
	)
	if canonicalID != "" {
		return canonicalID
	}
	return strings.TrimSpace(source.ProviderSessionID)
}

func appendSessionMessagesLocked(
	entry *sessionEntry,
	agentSessionID string,
	messages []WorkspaceAgentSessionMessage,
	latestVersion uint64,
) bool {
	return appendSessionMessagesForProviderLocked(entry, "", agentSessionID, messages, latestVersion)
}

func appendSessionMessagesForProviderLocked(
	entry *sessionEntry,
	provider string,
	agentSessionID string,
	messages []WorkspaceAgentSessionMessage,
	latestVersion uint64,
) bool {
	if entry == nil {
		return false
	}
	agentSessionID = resolveKnownOrProviderAliasSessionID(
		entry.state.Sessions,
		agentSessionID,
		provider,
		"",
		"",
		"",
	)
	if agentSessionID == "" {
		return false
	}
	if entry.sessionMessages == nil {
		entry.sessionMessages = make(map[string][]WorkspaceAgentSessionMessage)
	}
	if entry.messageVersionBySession == nil {
		entry.messageVersionBySession = make(map[string]uint64)
	}
	if entry.remoteMessageVersionBySession == nil {
		entry.remoteMessageVersionBySession = make(map[string]uint64)
	}

	items := entry.sessionMessages[agentSessionID]
	if current := maxSessionMessageVersion(0, items); current > entry.messageVersionBySession[agentSessionID] {
		entry.messageVersionBySession[agentSessionID] = current
	}
	changed := false
	for _, message := range messages {
		message.AgentSessionID = agentSessionID
		message.MessageID = strings.TrimSpace(message.MessageID)
		if message.AgentSessionID == "" || message.MessageID == "" || isHiddenAgentSession(entry, message.AgentSessionID) {
			continue
		}
		for index, existing := range items {
			if strings.TrimSpace(existing.MessageID) != message.MessageID {
				continue
			}
			message.Version = existing.Version
			merged := mergeSessionMessage(existing, message)
			if !sessionMessageBusinessEqual(existing, merged) {
				changed = true
			}
			items[index] = merged
			goto nextMessage
		}
		entry.messageVersionBySession[agentSessionID]++
		message.Version = entry.messageVersionBySession[agentSessionID]
		items = append(items, cloneSessionMessage(message))
		changed = true
	nextMessage:
	}
	entry.sessionMessages[agentSessionID] = sortSessionMessages(items)
	if latestVersion > entry.remoteMessageVersionBySession[agentSessionID] {
		entry.remoteMessageVersionBySession[agentSessionID] = latestVersion
	}
	return changed
}

func mergeSnapshotMessagesLocked(entry *sessionEntry, snapshot WorkspaceAgentSnapshot) bool {
	if entry == nil {
		return false
	}
	changed := false
	for sessionID, messages := range snapshot.SessionMessagesByID {
		sessionID = strings.TrimSpace(sessionID)
		if sessionID == "" {
			continue
		}
		if appendSessionMessagesLocked(entry, sessionID, messages, maxSessionMessageVersion(0, messages)) {
			changed = true
		}
	}
	return changed
}

func canonicalizeSessionMessageBucketsLocked(entry *sessionEntry) bool {
	if entry == nil || len(entry.sessionMessages) == 0 {
		return false
	}
	changed := false
	sessionIDs := make([]string, 0, len(entry.sessionMessages))
	for sessionID := range entry.sessionMessages {
		sessionIDs = append(sessionIDs, sessionID)
	}
	for _, sessionID := range sessionIDs {
		messages := entry.sessionMessages[sessionID]
		sessionID = strings.TrimSpace(sessionID)
		if sessionID == "" {
			continue
		}
		canonicalID := resolveKnownOrProviderAliasSessionID(
			entry.state.Sessions,
			sessionID,
			"",
			"",
			"",
			"",
		)
		if canonicalID == "" || canonicalID == sessionID {
			continue
		}
		remoteVersion := entry.remoteMessageVersionBySession[sessionID]
		if appendSessionMessagesLocked(entry, canonicalID, messages, remoteVersion) {
			changed = true
		}
		if remoteVersion > entry.remoteMessageVersionBySession[canonicalID] {
			entry.remoteMessageVersionBySession[canonicalID] = remoteVersion
		}
		delete(entry.sessionMessages, sessionID)
		delete(entry.messageVersionBySession, sessionID)
		delete(entry.remoteMessageVersionBySession, sessionID)
	}
	return changed
}

func resolveKnownOrProviderAliasSessionID(
	sessions []WorkspaceAgentSession,
	sessionID,
	provider,
	providerSessionID,
	sourceProviderSessionID,
	sessionOrigin string,
) string {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return ""
	}
	if findSessionIndex(sessions, sessionID, "", "", "") >= 0 {
		return sessionID
	}
	aliasProviderSessionID := firstNonEmptyString(providerSessionID, sourceProviderSessionID, sessionID)
	if canonicalID := findUniqueSessionIDByProvider(sessions, provider, aliasProviderSessionID, "", sessionOrigin); canonicalID != "" {
		return canonicalID
	}
	return sessionID
}

func findUniqueSessionIDByProvider(
	sessions []WorkspaceAgentSession,
	provider,
	providerSessionID,
	sourceProviderSessionID,
	sessionOrigin string,
) string {
	providerSessionID = strings.TrimSpace(firstNonEmptyString(providerSessionID, sourceProviderSessionID))
	if providerSessionID == "" {
		return ""
	}
	provider = strings.TrimSpace(provider)
	sessionOrigin = NormalizeSessionOrigin(sessionOrigin)
	if sessionOrigin == "" {
		return ""
	}
	matchedID := ""
	for _, session := range sessions {
		if strings.TrimSpace(session.ProviderSessionID) != providerSessionID {
			continue
		}
		if provider != "" && strings.TrimSpace(session.Provider) != provider {
			continue
		}
		if NormalizeSessionOrigin(session.SessionOrigin) != sessionOrigin {
			continue
		}
		agentSessionID := strings.TrimSpace(session.AgentSessionID)
		if agentSessionID == "" {
			continue
		}
		if matchedID != "" && matchedID != agentSessionID {
			return ""
		}
		matchedID = agentSessionID
	}
	return matchedID
}

func mergeMessageUpdate(existing WorkspaceAgentMessageUpdate, incoming WorkspaceAgentMessageUpdate) WorkspaceAgentMessageUpdate {
	merged := cloneMessageUpdate(incoming)
	if merged.AgentSessionID == "" {
		merged.AgentSessionID = existing.AgentSessionID
	}
	if merged.MessageID == "" {
		merged.MessageID = existing.MessageID
	}
	if existing.Seq > 0 {
		merged.Seq = existing.Seq
	}
	if merged.TurnID == "" {
		merged.TurnID = existing.TurnID
	}
	if merged.Role == "" {
		merged.Role = existing.Role
	}
	if merged.Kind == "" {
		merged.Kind = existing.Kind
	}
	if merged.Status == "" {
		merged.Status = existing.Status
	}
	if merged.CallID == "" {
		merged.CallID = existing.CallID
	}
	if merged.ParentCallID == "" {
		merged.ParentCallID = existing.ParentCallID
	}
	if merged.RootCallID == "" {
		merged.RootCallID = existing.RootCallID
	}
	if merged.Title == "" {
		merged.Title = existing.Title
	}
	if merged.Payload == nil {
		merged.Payload = clonePayloadMap(existing.Payload)
	}
	if merged.OccurredAtUnixMS == 0 {
		merged.OccurredAtUnixMS = existing.OccurredAtUnixMS
	}
	if merged.StartedAtUnixMS == 0 {
		merged.StartedAtUnixMS = existing.StartedAtUnixMS
	}
	if merged.CompletedAtUnixMS == 0 {
		merged.CompletedAtUnixMS = existing.CompletedAtUnixMS
	}
	merged.Payload = mergePayloadMissing(merged.Payload, existing.Payload)
	return merged
}

func sortMessageUpdates(items []WorkspaceAgentMessageUpdate) []WorkspaceAgentMessageUpdate {
	sort.SliceStable(items, func(i, j int) bool {
		left := items[i]
		right := items[j]
		leftTime := messageUpdateEffectiveTimestamp(left)
		rightTime := messageUpdateEffectiveTimestamp(right)
		if leftTime != rightTime {
			if leftTime == 0 {
				return false
			}
			if rightTime == 0 {
				return true
			}
			return leftTime < rightTime
		}
		if left.Seq != right.Seq {
			if left.Seq == 0 {
				return false
			}
			if right.Seq == 0 {
				return true
			}
			return left.Seq < right.Seq
		}
		return strings.TrimSpace(left.MessageID) < strings.TrimSpace(right.MessageID)
	})
	return items
}

// sessionMessageEffectiveTimestamp resolves the display timestamp used for
// ordering. Legacy/hydrated rows (older daemons, connectors omitting
// occurredAtUnixMs) may only carry started/completed/created times; falling
// back keeps them at their historical position instead of forcing them after
// every timestamped row.
func sessionMessageEffectiveTimestamp(message WorkspaceAgentSessionMessage) int64 {
	return firstNonZeroInt64(
		message.OccurredAtUnixMS,
		message.StartedAtUnixMS,
		message.CompletedAtUnixMS,
		message.CreatedAtUnixMS,
		message.UpdatedAtUnixMS,
	)
}

func messageUpdateEffectiveTimestamp(update WorkspaceAgentMessageUpdate) int64 {
	return firstNonZeroInt64(
		update.OccurredAtUnixMS,
		update.StartedAtUnixMS,
		update.CompletedAtUnixMS,
	)
}

func sortSessionMessages(items []WorkspaceAgentSessionMessage) []WorkspaceAgentSessionMessage {
	sort.SliceStable(items, func(i, j int) bool {
		left := items[i]
		right := items[j]
		leftTime := sessionMessageEffectiveTimestamp(left)
		rightTime := sessionMessageEffectiveTimestamp(right)
		if leftTime != rightTime {
			if leftTime == 0 {
				return false
			}
			if rightTime == 0 {
				return true
			}
			return leftTime < rightTime
		}
		if left.Version != right.Version {
			if left.Version == 0 {
				return false
			}
			if right.Version == 0 {
				return true
			}
			return left.Version < right.Version
		}
		if left.ID != right.ID {
			if left.ID == 0 {
				return false
			}
			if right.ID == 0 {
				return true
			}
			return left.ID < right.ID
		}
		return strings.TrimSpace(left.MessageID) < strings.TrimSpace(right.MessageID)
	})
	return items
}

func (s *Store) getMessageVersionCursor(roomID, agentSessionID string) uint64 {
	agentSessionID = strings.TrimSpace(agentSessionID)
	entry := s.roomEntry(roomID)
	if entry == nil || agentSessionID == "" {
		return 0
	}

	entry.mu.Lock()
	defer entry.mu.Unlock()

	return entry.remoteMessageVersionBySession[agentSessionID]
}

func (s *Store) notifyRoomUpdate(roomID string) {
	roomID = strings.TrimSpace(roomID)
	if s == nil || roomID == "" {
		return
	}
	s.mu.RLock()
	listener := s.updateListener
	s.mu.RUnlock()
	if listener == nil {
		return
	}
	snapshot, ok := s.GetAgentSnapshot(roomID)
	if !ok {
		return
	}
	listener(roomID, snapshot)
}

func (s *Store) roomEntry(roomID string) *sessionEntry {
	roomID = strings.TrimSpace(roomID)
	if s == nil || roomID == "" {
		return nil
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	return s.rooms[roomID]
}

func isHiddenAgentSession(entry *sessionEntry, agentSessionID string) bool {
	if entry == nil || len(entry.hiddenSessions) == 0 {
		return false
	}
	_, ok := entry.hiddenSessions[strings.TrimSpace(agentSessionID)]
	return ok
}

func removeSessionByID(sessions []WorkspaceAgentSession, agentSessionID string) []WorkspaceAgentSession {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID == "" || len(sessions) == 0 {
		return sessions
	}
	next := make([]WorkspaceAgentSession, 0, len(sessions))
	for _, session := range sessions {
		if strings.TrimSpace(session.AgentSessionID) == agentSessionID {
			continue
		}
		next = append(next, session)
	}
	return next
}

func filterHiddenSessions(
	sessions []WorkspaceAgentSession,
	hiddenSessions map[string]struct{},
) []WorkspaceAgentSession {
	if len(sessions) == 0 || len(hiddenSessions) == 0 {
		return sessions
	}
	next := make([]WorkspaceAgentSession, 0, len(sessions))
	for _, session := range sessions {
		if _, hidden := hiddenSessions[strings.TrimSpace(session.AgentSessionID)]; hidden {
			continue
		}
		next = append(next, session)
	}
	return next
}

func cloneSessions(sessions []WorkspaceAgentSession) []WorkspaceAgentSession {
	if len(sessions) == 0 {
		return nil
	}
	cloned := make([]WorkspaceAgentSession, len(sessions))
	for index, session := range sessions {
		cloned[index] = cloneSession(session)
	}
	return cloned
}

func sessionsWithSyncStates(
	sessions []WorkspaceAgentSession,
	syncStates map[string]*agentSessionSyncState,
) []WorkspaceAgentSession {
	cloned := cloneSessions(sessions)
	if len(cloned) == 0 || len(syncStates) == 0 {
		return cloned
	}
	for index := range cloned {
		sessionID := strings.TrimSpace(cloned[index].AgentSessionID)
		if syncState := syncStates[sessionID]; syncState != nil {
			cloned[index].SyncState = cloneSyncState(&syncState.state)
		}
	}
	return cloned
}

func cloneSession(session WorkspaceAgentSession) WorkspaceAgentSession {
	session.SyncState = cloneSyncState(session.SyncState)
	return session
}

func cloneSyncState(syncState *WorkspaceAgentSyncState) *WorkspaceAgentSyncState {
	if syncState == nil {
		return nil
	}
	cloned := *syncState
	return &cloned
}

func clonePresences(presences []WorkspaceAgentPresence) []WorkspaceAgentPresence {
	if len(presences) == 0 {
		return nil
	}
	cloned := make([]WorkspaceAgentPresence, len(presences))
	copy(cloned, presences)
	return cloned
}

func snapshotFromEntryLocked(entry *sessionEntry) WorkspaceAgentSnapshot {
	if entry == nil {
		return WorkspaceAgentSnapshot{}
	}
	messages := make(map[string][]WorkspaceAgentSessionMessage)
	for sessionID, items := range entry.sessionMessages {
		if len(items) == 0 {
			continue
		}
		messages[sessionID] = cloneSessionMessages(items)
	}
	return WorkspaceAgentSnapshot{
		Presences:           clonePresences(entry.state.Presences),
		Sessions:            sessionsWithSyncStates(entry.state.Sessions, entry.syncStates),
		SessionMessagesByID: nonEmptySessionMessageMap(messages),
	}
}

func workspaceAgentSnapshotBusinessEqual(left, right WorkspaceAgentSnapshot) bool {
	return reflect.DeepEqual(clonePresences(left.Presences), clonePresences(right.Presences)) &&
		reflect.DeepEqual(sessionBusinessProjection(left.Sessions), sessionBusinessProjection(right.Sessions)) &&
		reflect.DeepEqual(sessionMessageBusinessMap(left.SessionMessagesByID), sessionMessageBusinessMap(right.SessionMessagesByID))
}

func sessionBusinessProjection(sessions []WorkspaceAgentSession) []WorkspaceAgentSession {
	if len(sessions) == 0 {
		return nil
	}
	out := cloneSessions(sessions)
	for index := range out {
		out[index].ID = 0
		out[index].SyncState = nil
	}
	return out
}

func sessionMessageBusinessMap(
	messages map[string][]WorkspaceAgentSessionMessage,
) map[string][]WorkspaceAgentSessionMessage {
	if len(messages) == 0 {
		return nil
	}
	out := make(map[string][]WorkspaceAgentSessionMessage, len(messages))
	for sessionID, items := range messages {
		if len(items) == 0 {
			continue
		}
		out[sessionID] = sessionMessageBusinessProjection(items)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func sessionMessageBusinessProjection(
	messages []WorkspaceAgentSessionMessage,
) []WorkspaceAgentSessionMessage {
	if len(messages) == 0 {
		return nil
	}
	out := cloneSessionMessages(messages)
	for index := range out {
		out[index] = sessionMessageBusinessFields(out[index])
	}
	return out
}

func sessionMessageBusinessEqual(
	left WorkspaceAgentSessionMessage,
	right WorkspaceAgentSessionMessage,
) bool {
	return reflect.DeepEqual(
		sessionMessageBusinessFields(left),
		sessionMessageBusinessFields(right),
	)
}

func sessionMessageBusinessFields(message WorkspaceAgentSessionMessage) WorkspaceAgentSessionMessage {
	message.ID = 0
	message.Version = 0
	message.CreatedAtUnixMS = 0
	message.UpdatedAtUnixMS = 0
	message.Payload = clonePayloadMap(message.Payload)
	return message
}

func nonEmptySessionMessageMap(
	items map[string][]WorkspaceAgentSessionMessage,
) map[string][]WorkspaceAgentSessionMessage {
	if len(items) == 0 {
		return nil
	}
	return items
}

func cloneMessageUpdates(items []WorkspaceAgentMessageUpdate) []WorkspaceAgentMessageUpdate {
	if len(items) == 0 {
		return nil
	}
	cloned := make([]WorkspaceAgentMessageUpdate, len(items))
	for i, item := range items {
		cloned[i] = cloneMessageUpdate(item)
	}
	return cloned
}

func cloneMessageUpdate(item WorkspaceAgentMessageUpdate) WorkspaceAgentMessageUpdate {
	item.Payload = clonePayloadMap(item.Payload)
	return item
}

func cloneSessionMessages(items []WorkspaceAgentSessionMessage) []WorkspaceAgentSessionMessage {
	if len(items) == 0 {
		return nil
	}
	cloned := make([]WorkspaceAgentSessionMessage, len(items))
	for i, item := range items {
		cloned[i] = cloneSessionMessage(item)
	}
	return cloned
}

func cloneSessionMessage(item WorkspaceAgentSessionMessage) WorkspaceAgentSessionMessage {
	item.Payload = clonePayloadMap(item.Payload)
	return item
}

func sessionMessagesFromUpdates(
	agentSessionID string,
	updates []WorkspaceAgentMessageUpdate,
) []WorkspaceAgentSessionMessage {
	if len(updates) == 0 {
		return nil
	}
	messages := make([]WorkspaceAgentSessionMessage, 0, len(updates))
	for _, update := range updates {
		message := sessionMessageFromLegacyUpdate(agentSessionID, update)
		if strings.TrimSpace(message.MessageID) == "" {
			continue
		}
		messages = append(messages, message)
	}
	return sortSessionMessages(messages)
}

func sessionMessageFromLegacyUpdate(
	agentSessionID string,
	update WorkspaceAgentMessageUpdate,
) WorkspaceAgentSessionMessage {
	payload := clonePayloadMap(update.Payload)
	payload = withPayloadStringIfMissing(payload, "callId", update.CallID)
	payload = withPayloadStringIfMissing(payload, "parentCallId", update.ParentCallID)
	payload = withPayloadStringIfMissing(payload, "rootCallId", update.RootCallID)
	payload = withPayloadStringIfMissing(payload, "title", update.Title)
	return WorkspaceAgentSessionMessage{
		AgentSessionID:    firstNonEmptyString(update.AgentSessionID, agentSessionID),
		MessageID:         strings.TrimSpace(update.MessageID),
		TurnID:            strings.TrimSpace(update.TurnID),
		Role:              strings.TrimSpace(update.Role),
		Kind:              strings.TrimSpace(update.Kind),
		Status:            strings.TrimSpace(update.Status),
		Payload:           payload,
		OccurredAtUnixMS:  firstNonZeroInt64(update.OccurredAtUnixMS, update.StartedAtUnixMS, update.CompletedAtUnixMS),
		StartedAtUnixMS:   update.StartedAtUnixMS,
		CompletedAtUnixMS: update.CompletedAtUnixMS,
		Version:           update.Seq,
	}
}

func sessionMessageUpdatesForLegacyReads(
	messages []WorkspaceAgentSessionMessage,
) []WorkspaceAgentMessageUpdate {
	if len(messages) == 0 {
		return nil
	}
	updates := make([]WorkspaceAgentMessageUpdate, len(messages))
	for index, message := range messages {
		updates[index] = messageUpdateFromSessionMessage(message)
	}
	return sortMessageUpdates(updates)
}

func messageUpdateFromSessionMessage(
	message WorkspaceAgentSessionMessage,
) WorkspaceAgentMessageUpdate {
	payload := clonePayloadMap(message.Payload)
	return WorkspaceAgentMessageUpdate{
		AgentSessionID:    strings.TrimSpace(message.AgentSessionID),
		MessageID:         strings.TrimSpace(message.MessageID),
		Seq:               message.Version,
		TurnID:            strings.TrimSpace(message.TurnID),
		Role:              strings.TrimSpace(message.Role),
		Kind:              strings.TrimSpace(message.Kind),
		Status:            strings.TrimSpace(message.Status),
		CallID:            payloadFirstStringValue(payload, "callId", "call_id"),
		ParentCallID:      payloadFirstStringValue(payload, "parentCallId", "parent_call_id"),
		RootCallID:        payloadFirstStringValue(payload, "rootCallId", "root_call_id"),
		Title:             payloadFirstStringValue(payload, "title"),
		Payload:           payload,
		OccurredAtUnixMS:  message.OccurredAtUnixMS,
		StartedAtUnixMS:   message.StartedAtUnixMS,
		CompletedAtUnixMS: message.CompletedAtUnixMS,
	}
}

func mergeSessionMessages(
	left []WorkspaceAgentSessionMessage,
	right []WorkspaceAgentSessionMessage,
) []WorkspaceAgentSessionMessage {
	if len(left) == 0 {
		return cloneSessionMessages(right)
	}
	merged := cloneSessionMessages(left)
	for _, message := range right {
		messageID := strings.TrimSpace(message.MessageID)
		if messageID == "" {
			continue
		}
		for index, existing := range merged {
			if strings.TrimSpace(existing.MessageID) != messageID {
				continue
			}
			merged[index] = mergeSessionMessage(existing, message)
			goto nextMessage
		}
		merged = append(merged, cloneSessionMessage(message))
	nextMessage:
	}
	return sortSessionMessages(merged)
}

func mergeSessionMessage(
	existing WorkspaceAgentSessionMessage,
	incoming WorkspaceAgentSessionMessage,
) WorkspaceAgentSessionMessage {
	merged := cloneSessionMessage(incoming)
	if merged.ID == 0 {
		merged.ID = existing.ID
	}
	if merged.AgentSessionID == "" {
		merged.AgentSessionID = existing.AgentSessionID
	}
	if merged.MessageID == "" {
		merged.MessageID = existing.MessageID
	}
	if merged.TurnID == "" {
		merged.TurnID = existing.TurnID
	}
	if merged.Role == "" {
		merged.Role = existing.Role
	}
	if merged.Kind == "" {
		merged.Kind = existing.Kind
	}
	if merged.Status == "" {
		merged.Status = existing.Status
	}
	if merged.Payload == nil {
		merged.Payload = clonePayloadMap(existing.Payload)
	}
	if merged.OccurredAtUnixMS == 0 {
		merged.OccurredAtUnixMS = existing.OccurredAtUnixMS
	}
	if merged.StartedAtUnixMS == 0 {
		merged.StartedAtUnixMS = existing.StartedAtUnixMS
	}
	if merged.CompletedAtUnixMS == 0 {
		merged.CompletedAtUnixMS = existing.CompletedAtUnixMS
	}
	if merged.CreatedAtUnixMS == 0 {
		merged.CreatedAtUnixMS = existing.CreatedAtUnixMS
	}
	if merged.UpdatedAtUnixMS == 0 {
		merged.UpdatedAtUnixMS = existing.UpdatedAtUnixMS
	}
	if existing.Version > 0 {
		merged.Version = existing.Version
	}
	merged.Payload = mergePayloadMissing(merged.Payload, existing.Payload)
	return merged
}

func maxSessionMessageVersion(current uint64, messages []WorkspaceAgentSessionMessage) uint64 {
	for _, message := range messages {
		if message.Version > current {
			current = message.Version
		}
	}
	return current
}

func clonePayloadMap(payload map[string]any) map[string]any {
	if len(payload) == 0 {
		return nil
	}
	cloned := make(map[string]any, len(payload))
	for key, value := range payload {
		cloned[key] = clonePayloadValue(value)
	}
	return cloned
}

func clonePayloadValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return clonePayloadMap(typed)
	case []any:
		if len(typed) == 0 {
			return []any{}
		}
		cloned := make([]any, len(typed))
		for i, item := range typed {
			cloned[i] = clonePayloadValue(item)
		}
		return cloned
	default:
		return value
	}
}

func withPayloadStringIfMissing(payload map[string]any, key string, value string) map[string]any {
	value = strings.TrimSpace(value)
	if value == "" {
		return payload
	}
	if payload == nil {
		payload = make(map[string]any)
	}
	if existing := payloadFirstStringValue(payload, key); existing != "" {
		return payload
	}
	payload[key] = value
	return payload
}

func payloadFirstStringValue(payload map[string]any, keys ...string) string {
	if len(payload) == 0 {
		return ""
	}
	for _, key := range keys {
		value, _ := payload[key].(string)
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func mergePayloadMissing(base map[string]any, incoming map[string]any) map[string]any {
	out := clonePayloadMap(base)
	if out == nil {
		out = map[string]any{}
	}
	for key, incomingValue := range incoming {
		if existing, ok := out[key]; ok {
			existingMap, existingIsMap := existing.(map[string]any)
			incomingMap, incomingIsMap := incomingValue.(map[string]any)
			if existingIsMap && incomingIsMap {
				out[key] = mergePayloadMissing(existingMap, incomingMap)
			}
			continue
		}
		out[key] = clonePayloadValue(incomingValue)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
