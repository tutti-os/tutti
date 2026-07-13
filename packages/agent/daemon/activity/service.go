package agentsessionstore

import (
	"context"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type State struct {
	Presences []WorkspaceAgentPresence            `json:"presences"`
	Sessions  []ProviderActivitySessionProjection `json:"sessions"`
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
	mu                 sync.RWMutex
	rooms              map[string]*sessionEntry
	client             ReadRepository
	syncer             *sessionSyncer
	syncStateStore     SyncStateStore
	messageCursorStore MessageCursorStore
	syncBackoff        SyncBackoffConfig
	updateListener     func(roomID string, snapshot WorkspaceAgentSnapshot)
	startOnce          sync.Once
}

type Option func(*Store)

// WithSyncStateStore injects a persistence backend for per-session activity
// sync states. Loaded states seed TrackRoom, updates are written through on
// every sync-state transition, and entries are deleted when a session is
// hidden. Without this option sync states live in memory only.
//
// Store keys are the scope identifier passed to TrackRoom: tutti side =
// workspace ID, external daemons (tsh) = control-plane room ID; workspace ≡
// room, one-to-one, no implicit translation.
func WithSyncStateStore(store SyncStateStore) Option {
	return func(svc *Store) {
		if svc != nil {
			svc.syncStateStore = store
		}
	}
}

// WithMessageCursorStore injects a persistence backend for per-session message
// sync cursors. Loaded cursors seed TrackRoom so the syncer resumes message
// pulls where it left off, cursor advances are written through, and entries
// are deleted when a session is hidden. Without this option cursors live in
// memory only.
//
// Store keys are the scope identifier passed to TrackRoom: tutti side =
// workspace ID, external daemons (tsh) = control-plane room ID; workspace ≡
// room, one-to-one, no implicit translation.
func WithMessageCursorStore(store MessageCursorStore) Option {
	return func(svc *Store) {
		if svc != nil {
			svc.messageCursorStore = store
		}
	}
}

// WithSyncBackoff enables per-session exponential backoff for failed message
// syncs in the background syncer. The zero config disables backoff, which is
// the default and matches historical behavior (every sync tick retries
// immediately). Use DefaultSyncBackoffConfig for field-proven values.
func WithSyncBackoff(cfg SyncBackoffConfig) Option {
	return func(svc *Store) {
		if svc != nil {
			svc.syncBackoff = cfg
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
	loadedCursors := s.loadStoredMessageCursors(roomID)

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
		for agentSessionID, cursor := range loadedCursors {
			agentSessionID = strings.TrimSpace(agentSessionID)
			if agentSessionID == "" || cursor == 0 {
				continue
			}
			entry.remoteMessageVersionBySession[agentSessionID] = cursor
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
	if s.messageCursorStore != nil {
		if err := s.messageCursorStore.DeleteMessageCursor(context.Background(), roomID, agentSessionID); err != nil {
			slog.Warn("agent activity message cursor delete failed",
				"event", "agent_activity.message_cursor.delete_failed",
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
		DeviceID:           strings.TrimSpace(state.DeviceID),
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
		return applyActivitySyncPending(current, agentSessionID, timelineItemCount, statePatchCount, messageUpdateCount, now)
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
		return applyActivitySyncSucceeded(current, agentSessionID, timelineItemCount, statePatchCount, messageUpdateCount, now)
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
		return applyActivitySyncFailed(current, agentSessionID, err, now)
	})
}
