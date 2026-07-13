package agentsessionstore

import (
	"sort"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

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

func normalizeSyncedSessions(sessions []ProviderActivitySessionProjection, previous []ProviderActivitySessionProjection) []ProviderActivitySessionProjection {
	next := cloneSessions(sessions)
	previousByID := make(map[string]ProviderActivitySessionProjection, len(previous))
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
	previous []ProviderActivitySessionProjection,
	incoming []ProviderActivitySessionProjection,
	sessionOrigin string,
) []ProviderActivitySessionProjection {
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

func shouldPreserveLocalSessionProjection(previous, incoming ProviderActivitySessionProjection) bool {
	return shouldPreserveLocalSettledTurn(previous, incoming) ||
		shouldPreserveLocalTerminal(previous, incoming) ||
		shouldPreserveLocalIdle(previous, incoming)
}

func shouldPreserveLocalSettledTurn(previous, incoming ProviderActivitySessionProjection) bool {
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

func shouldPreserveLocalTerminal(previous, incoming ProviderActivitySessionProjection) bool {
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

func shouldPreserveLocalIdle(previous, incoming ProviderActivitySessionProjection) bool {
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

func isPassiveSessionUpdate(session ProviderActivitySessionProjection) bool {
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
	// The locked append resolves provider aliases, so read the cursor under
	// the canonical session id.
	canonicalID := resolveKnownOrProviderAliasSessionID(entry.state.Sessions, agentSessionID, "", "", "", "")
	cursorBefore := entry.remoteMessageVersionBySession[canonicalID]
	changed := appendSessionMessagesLocked(entry, agentSessionID, messages, latestVersion)
	cursorAfter := entry.remoteMessageVersionBySession[canonicalID]
	// Persist while holding entry.mu so cursor writes serialize with
	// HideAgentSession's delete (also under entry.mu): a save must never land
	// after the delete and resurrect a hidden session's cursor.
	if cursorAfter > cursorBefore && !isHiddenAgentSession(entry, canonicalID) {
		s.saveMessageCursor(roomID, canonicalID, cursorAfter)
	}
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
	sessions []ProviderActivitySessionProjection,
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
	sessions []ProviderActivitySessionProjection,
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
