package agentsessionstore

import (
	"reflect"
	"strings"
)

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

func removeSessionByID(sessions []ProviderActivitySessionProjection, agentSessionID string) []ProviderActivitySessionProjection {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID == "" || len(sessions) == 0 {
		return sessions
	}
	next := make([]ProviderActivitySessionProjection, 0, len(sessions))
	for _, session := range sessions {
		if strings.TrimSpace(session.AgentSessionID) == agentSessionID {
			continue
		}
		next = append(next, session)
	}
	return next
}

func filterHiddenSessions(
	sessions []ProviderActivitySessionProjection,
	hiddenSessions map[string]struct{},
) []ProviderActivitySessionProjection {
	if len(sessions) == 0 || len(hiddenSessions) == 0 {
		return sessions
	}
	next := make([]ProviderActivitySessionProjection, 0, len(sessions))
	for _, session := range sessions {
		if _, hidden := hiddenSessions[strings.TrimSpace(session.AgentSessionID)]; hidden {
			continue
		}
		next = append(next, session)
	}
	return next
}

func cloneSessions(sessions []ProviderActivitySessionProjection) []ProviderActivitySessionProjection {
	if len(sessions) == 0 {
		return nil
	}
	cloned := make([]ProviderActivitySessionProjection, len(sessions))
	for index, session := range sessions {
		cloned[index] = cloneSession(session)
	}
	return cloned
}

func sessionsWithSyncStates(
	sessions []ProviderActivitySessionProjection,
	syncStates map[string]*agentSessionSyncState,
) []ProviderActivitySessionProjection {
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

func cloneSession(session ProviderActivitySessionProjection) ProviderActivitySessionProjection {
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

func sessionBusinessProjection(sessions []ProviderActivitySessionProjection) []ProviderActivitySessionProjection {
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
