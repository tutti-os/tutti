package agentsessionstore

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

func RuntimeSnapshotForDisplay(
	upstream WorkspaceAgentSnapshot,
	local WorkspaceAgentSnapshot,
) WorkspaceAgentSnapshot {
	sessions := make([]ProviderActivitySessionProjection, 0, len(upstream.Sessions)+len(local.Sessions))
	bySessionID := make(map[string]int, len(upstream.Sessions)+len(local.Sessions))
	byProviderSessionID := make(map[string]int, len(upstream.Sessions)+len(local.Sessions))
	for _, session := range upstream.Sessions {
		session = normalizeRuntimeSessionForDisplay(session)
		sessionID := strings.TrimSpace(session.AgentSessionID)
		providerSessionID := strings.TrimSpace(session.ProviderSessionID)
		if sessionID == "" && providerSessionID == "" {
			sessions = append(sessions, session)
			continue
		}
		index := len(sessions)
		sessions = append(sessions, session)
		if sessionID != "" {
			bySessionID[sessionID] = index
		}
		if providerSessionID != "" {
			byProviderSessionID[providerSessionID] = index
		}
	}
	for _, localSession := range local.Sessions {
		localSession = normalizeRuntimeSessionForDisplay(localSession)
		sessionID := strings.TrimSpace(localSession.AgentSessionID)
		providerSessionID := strings.TrimSpace(localSession.ProviderSessionID)
		if sessionID == "" && providerSessionID == "" {
			sessions = append(sessions, localSession)
			continue
		}
		if existingIndex, ok := bySessionID[sessionID]; ok {
			sessions[existingIndex] = mergeRuntimeAgentSession(sessions[existingIndex], localSession)
			continue
		}
		if existingIndex, ok := byProviderSessionID[providerSessionID]; ok {
			sessions[existingIndex] = mergeRuntimeAgentSession(sessions[existingIndex], localSession)
			continue
		}
		index := len(sessions)
		sessions = append(sessions, localSession)
		if sessionID != "" {
			bySessionID[sessionID] = index
		}
		if providerSessionID != "" {
			byProviderSessionID[providerSessionID] = index
		}
	}
	return WorkspaceAgentSnapshot{
		Presences: upstream.Presences,
		Sessions:  sessions,
	}
}

func mergeRuntimeAgentSession(
	upstream ProviderActivitySessionProjection,
	local ProviderActivitySessionProjection,
) ProviderActivitySessionProjection {
	if shouldKeepLocalCompletedTurn(upstream, local) {
		merged := local
		merged.AgentSessionID = preferredMergedAgentSessionID(upstream, local)
		merged.AgentTargetID = firstNonEmptyString(local.AgentTargetID, upstream.AgentTargetID)
		merged.Provider = firstNonEmptyString(local.Provider, upstream.Provider)
		merged.ProviderSessionID = firstNonEmptyString(local.ProviderSessionID, upstream.ProviderSessionID)
		merged.SessionOrigin = firstNonEmptyString(upstream.SessionOrigin, local.SessionOrigin)
		merged.CWD = firstNonEmptyString(local.CWD, upstream.CWD)
		merged.Title = firstNonEmptyString(local.Title, upstream.Title)
		syncCanonicalSessionStatus(&merged)
		merged.StartedAtUnixMS = firstNonZeroInt64(local.StartedAtUnixMS, upstream.StartedAtUnixMS)
		merged.CreatedAtUnixMS = firstNonZeroInt64(local.CreatedAtUnixMS, upstream.CreatedAtUnixMS)
		if strings.TrimSpace(merged.UserID) == "" {
			merged.UserID = upstream.UserID
		}
		if merged.PresenceID == 0 {
			merged.PresenceID = upstream.PresenceID
		}
		if merged.ID == 0 {
			merged.ID = upstream.ID
		}
		if local.SyncState != nil {
			merged.SyncState = cloneSyncState(local.SyncState)
		}
		return normalizeRuntimeSessionForDisplay(merged)
	}
	if shouldKeepLocalBusyState(upstream, local) {
		merged := local
		merged.AgentSessionID = preferredMergedAgentSessionID(upstream, local)
		merged.AgentTargetID = firstNonEmptyString(local.AgentTargetID, upstream.AgentTargetID)
		merged.Provider = firstNonEmptyString(local.Provider, upstream.Provider)
		merged.ProviderSessionID = firstNonEmptyString(local.ProviderSessionID, upstream.ProviderSessionID)
		merged.SessionOrigin = firstNonEmptyString(upstream.SessionOrigin, local.SessionOrigin)
		merged.CWD = firstNonEmptyString(local.CWD, upstream.CWD)
		merged.Title = firstNonEmptyString(local.Title, upstream.Title)
		syncCanonicalSessionStatus(&merged)
		merged.StartedAtUnixMS = firstNonZeroInt64(local.StartedAtUnixMS, upstream.StartedAtUnixMS)
		merged.CreatedAtUnixMS = firstNonZeroInt64(local.CreatedAtUnixMS, upstream.CreatedAtUnixMS)
		merged.UpdatedAtUnixMS = firstNonZeroInt64(local.UpdatedAtUnixMS, upstream.UpdatedAtUnixMS)
		if strings.TrimSpace(merged.UserID) == "" {
			merged.UserID = upstream.UserID
		}
		if merged.PresenceID == 0 {
			merged.PresenceID = upstream.PresenceID
		}
		if merged.ID == 0 {
			merged.ID = upstream.ID
		}
		if local.SyncState != nil {
			merged.SyncState = cloneSyncState(local.SyncState)
		}
		return normalizeRuntimeSessionForDisplay(merged)
	}
	if local.UpdatedAtUnixMS <= 0 || (upstream.UpdatedAtUnixMS > 0 && local.UpdatedAtUnixMS < upstream.UpdatedAtUnixMS) {
		if local.SyncState != nil {
			upstream.SyncState = cloneSyncState(local.SyncState)
		}
		return normalizeRuntimeSessionForDisplay(upstream)
	}
	merged := upstream
	merged.AgentSessionID = preferredMergedAgentSessionID(upstream, local)
	merged.AgentTargetID = firstNonEmptyString(local.AgentTargetID, upstream.AgentTargetID)
	merged.Provider = firstNonEmptyString(local.Provider, upstream.Provider)
	merged.ProviderSessionID = firstNonEmptyString(local.ProviderSessionID, upstream.ProviderSessionID)
	merged.SessionOrigin = firstNonEmptyString(upstream.SessionOrigin, local.SessionOrigin)
	merged.CWD = firstNonEmptyString(local.CWD, upstream.CWD)
	merged.LifecycleStatus = firstNonEmptyString(local.LifecycleStatus, upstream.LifecycleStatus)
	merged.TurnPhase = firstNonEmptyString(local.TurnPhase, upstream.TurnPhase)
	merged.Status = firstNonEmptyString(local.Status, upstream.Status)
	merged.EffectiveStatus = firstNonEmptyString(local.EffectiveStatus, upstream.EffectiveStatus)
	merged.Title = firstNonEmptyString(local.Title, upstream.Title)
	merged.StartedAtUnixMS = firstNonZeroInt64(local.StartedAtUnixMS, upstream.StartedAtUnixMS)
	merged.EndedAtUnixMS = firstNonZeroInt64(local.EndedAtUnixMS, upstream.EndedAtUnixMS)
	merged.CreatedAtUnixMS = firstNonZeroInt64(local.CreatedAtUnixMS, upstream.CreatedAtUnixMS)
	merged.UpdatedAtUnixMS = firstNonZeroInt64(local.UpdatedAtUnixMS, upstream.UpdatedAtUnixMS)
	if strings.TrimSpace(merged.UserID) == "" {
		merged.UserID = local.UserID
	}
	if merged.PresenceID == 0 {
		merged.PresenceID = local.PresenceID
	}
	if merged.ID == 0 {
		merged.ID = local.ID
	}
	if local.SyncState != nil {
		merged.SyncState = cloneSyncState(local.SyncState)
	}
	syncCanonicalSessionStatus(&merged)
	return normalizeRuntimeSessionForDisplay(merged)
}

func normalizeRuntimeSessionForDisplay(session ProviderActivitySessionProjection) ProviderActivitySessionProjection {
	lifecycleStatus := strings.ToLower(strings.TrimSpace(session.LifecycleStatus))
	effectiveStatus := strings.ToLower(strings.TrimSpace(session.EffectiveStatus))
	turnPhase := strings.ToLower(strings.TrimSpace(session.TurnPhase))

	switch lifecycleStatus {
	case "failed":
		session.EffectiveStatus = "failed"
		session.Status = "failed"
		return session
	case "completed", "canceled", "ended":
		session.EffectiveStatus = canonicalWorkspaceAgentSessionStatus(session)
		session.Status = session.EffectiveStatus
		return session
	}

	switch turnPhase {
	case "working", "running", "streaming":
		if effectiveStatus == "" || effectiveStatus == "active" || effectiveStatus == "idle" || effectiveStatus == "ready" {
			session.EffectiveStatus = "working"
		}
	case "waiting", "waiting_approval", "waiting_input":
		if effectiveStatus == "" || effectiveStatus == "active" || effectiveStatus == "idle" || effectiveStatus == "ready" || effectiveStatus == "working" || effectiveStatus == "running" || effectiveStatus == "streaming" {
			session.EffectiveStatus = "waiting"
		}
	case "failed":
		session.EffectiveStatus = "failed"
	case "completed":
		if effectiveStatus == "" || effectiveStatus == "active" || effectiveStatus == "working" || effectiveStatus == "running" || effectiveStatus == "streaming" {
			session.EffectiveStatus = "completed"
		}
	case "idle", "ready":
		if effectiveStatus == "" || effectiveStatus == "active" || effectiveStatus == "working" || effectiveStatus == "running" || effectiveStatus == "streaming" {
			session.EffectiveStatus = "idle"
		}
	}

	syncCanonicalSessionStatus(&session)
	return session
}

func preferredMergedAgentSessionID(
	upstream ProviderActivitySessionProjection,
	local ProviderActivitySessionProjection,
) string {
	return firstNonEmptyString(upstream.AgentSessionID, local.AgentSessionID)
}

func shouldKeepLocalCompletedTurn(
	upstream ProviderActivitySessionProjection,
	local ProviderActivitySessionProjection,
) bool {
	if local.EndedAtUnixMS <= 0 {
		return false
	}
	if !isWorkingRuntimeSession(upstream) {
		return false
	}
	if upstream.StartedAtUnixMS > local.EndedAtUnixMS {
		return false
	}
	return isIdleOrTerminalRuntimeSession(local)
}

func shouldKeepLocalBusyState(
	upstream ProviderActivitySessionProjection,
	local ProviderActivitySessionProjection,
) bool {
	if !isBusyRuntimeSession(local) {
		return false
	}
	if isBusyRuntimeSession(upstream) || isTerminalRuntimeSession(upstream) {
		return false
	}
	return isIdleLikeRuntimeSession(upstream)
}

func isWorkingRuntimeSession(session ProviderActivitySessionProjection) bool {
	switch strings.ToLower(strings.TrimSpace(firstNonEmptyString(session.EffectiveStatus, session.TurnPhase))) {
	case "working", "running", "streaming":
		return true
	default:
		return false
	}
}

func isBusyRuntimeSession(session ProviderActivitySessionProjection) bool {
	switch strings.ToLower(strings.TrimSpace(firstNonEmptyString(session.EffectiveStatus, session.TurnPhase))) {
	case "working", "running", "streaming", "waiting", "waiting_approval", "waiting_input", "awaiting_approval":
		return true
	default:
		return false
	}
}

func isIdleOrTerminalRuntimeSession(session ProviderActivitySessionProjection) bool {
	switch strings.ToLower(strings.TrimSpace(session.EffectiveStatus)) {
	case "idle", "completed", "canceled", "ended", "failed":
		return true
	}
	switch strings.ToLower(strings.TrimSpace(session.TurnPhase)) {
	case "idle", "completed", "failed":
		return true
	default:
		return false
	}
}

func isTerminalRuntimeSession(session ProviderActivitySessionProjection) bool {
	switch strings.ToLower(strings.TrimSpace(canonicalWorkspaceAgentSessionStatus(session))) {
	case "completed", "canceled", "failed":
		return true
	default:
		return false
	}
}

func isIdleLikeRuntimeSession(session ProviderActivitySessionProjection) bool {
	switch strings.ToLower(strings.TrimSpace(canonicalWorkspaceAgentSessionStatus(session))) {
	case "idle":
		return true
	default:
		return false
	}
}

func RuntimeTimelineItemsForDisplay(
	upstream []WorkspaceAgentTimelineItem,
	local []WorkspaceAgentTimelineItem,
	afterID uint64,
	limit int,
) []WorkspaceAgentTimelineItem {
	merged := make([]WorkspaceAgentTimelineItem, 0, len(upstream)+len(local))
	byKey := make(map[timelineItemKey]int, len(upstream)+len(local))
	add := func(item WorkspaceAgentTimelineItem, preferLocal bool) {
		keys := dedupeKeys(item)
		if len(keys) == 0 {
			merged = append(merged, item)
			return
		}
		existingIndex := -1
		for _, key := range keys {
			if index, ok := byKey[key]; ok {
				existingIndex = index
				break
			}
		}
		if existingIndex >= 0 {
			if preferLocal {
				merged[existingIndex] = mergeRuntimeTimelineItem(merged[existingIndex], item)
			} else if timelineItemTime(item) >= timelineItemTime(merged[existingIndex]) {
				merged[existingIndex] = item
			}
			for _, key := range dedupeKeys(merged[existingIndex]) {
				byKey[key] = existingIndex
			}
			return
		}
		index := len(merged)
		merged = append(merged, item)
		for _, key := range keys {
			byKey[key] = index
		}
	}
	for _, item := range upstream {
		add(item, false)
	}
	for _, item := range local {
		add(item, true)
	}
	filtered := FilterTimelineItems(merged, afterID, 0)
	if afterID > 0 && len(filtered) == 0 && len(upstream) == 0 && shouldReplayRuntimeLocalTail(local) {
		// Runtime local items can temporarily carry IDs behind the durable cursor
		// after a new streamed turn starts. Replay the local tail so the renderer
		// can merge/dedupe those provisional items instead of showing a stuck turn.
		// Once the local tail is fully settled, replaying it only keeps the cursor
		// artificially non-empty and causes repeated timeline polling.
		filtered = merged
	}
	merged = filtered
	sortTimelineItemsForDisplay(merged)
	return LimitTimelineItems(merged, limit)
}

type timelineItemKey struct {
	kind  string
	value string
}

func dedupeKeys(item WorkspaceAgentTimelineItem) []timelineItemKey {
	keys := make([]timelineItemKey, 0, 4)
	if item.ID > 0 {
		keys = append(keys, timelineItemKey{kind: "id", value: uint64Key(item.ID)})
	}
	if eventID := strings.TrimSpace(item.EventID); eventID != "" {
		keys = append(keys, timelineItemKey{kind: "eventID", value: eventID})
	}
	if callID := timelineItemStableCallID(item); callID != "" {
		keys = append(keys, timelineItemKey{kind: "callID", value: callID})
	}
	if callSignature := timelineItemCallSignature(item); callSignature != "" {
		keys = append(keys, timelineItemKey{kind: "callSignature", value: callSignature})
	}
	return keys
}

func uint64Key(value uint64) string {
	return strconv.FormatUint(value, 10)
}

func timelineItemStableCallID(item WorkspaceAgentTimelineItem) string {
	callID := firstNonEmptyString(
		payloadStringValue(item.Payload, "callId"),
		payloadStringValue(item.Payload, "callID"),
		payloadStringValue(item.Payload, "call_id"),
		item.CallID,
	)
	normalized := strings.ToLower(strings.TrimSpace(callID))
	if normalized == "" || normalized == "tool" || strings.HasPrefix(normalized, "tool.") {
		return ""
	}
	return normalized
}

func timelineItemCallSignature(item WorkspaceAgentTimelineItem) string {
	if !isCallTimelineItem(item) {
		return ""
	}
	tool := normalizeTimelineToolName(firstNonEmptyString(
		payloadStringValue(item.Payload, "toolName"),
		payloadStringValue(item.Payload, "tool"),
		item.Name,
		item.CallType,
	))
	if tool == "" {
		return ""
	}
	inputSignature := timelineItemInputSignature(item)
	if inputSignature == "" {
		return ""
	}
	return tool + "|" + inputSignature
}

func isCallTimelineItem(item WorkspaceAgentTimelineItem) bool {
	itemType := strings.ToLower(strings.TrimSpace(item.ItemType))
	return itemType == "call" || strings.HasPrefix(itemType, "call.")
}

func normalizeTimelineToolName(tool string) string {
	tool = strings.ToLower(strings.TrimSpace(tool))
	tool = strings.TrimPrefix(tool, "tool.")
	tool = strings.ReplaceAll(tool, " ", "_")
	return tool
}

func timelineItemInputSignature(item WorkspaceAgentTimelineItem) string {
	if len(item.Payload) == 0 {
		return ""
	}
	input, hasInput := item.Payload["input"]
	command := firstNonEmptyString(
		payloadStringValue(item.Payload, "command"),
		payloadStringValue(item.Payload, "cmd"),
	)
	if !hasInput && command == "" {
		return ""
	}
	signature := map[string]any{}
	if hasInput {
		signature["input"] = clonePayloadValue(input)
	}
	if command != "" {
		signature["command"] = command
	}
	encoded, err := json.Marshal(signature)
	if err != nil || len(encoded) == 0 {
		return ""
	}
	return string(encoded)
}

func RuntimeTimelineItemsForSummaryDisplay(
	local []WorkspaceAgentTimelineItem,
	limit int,
) []WorkspaceAgentTimelineItem {
	if len(local) == 0 {
		return nil
	}
	ordered := append([]WorkspaceAgentTimelineItem(nil), local...)
	sortTimelineItemsForDisplay(ordered)
	latestUserIndex := -1
	latestAgentIndex := -1
	for index := len(ordered) - 1; index >= 0; index-- {
		item := ordered[index]
		role := timelineDisplayMessageRole(item)
		if role == "" || timelineDisplayMessageContent(item) == "" {
			continue
		}
		if role == "assistant" && latestAgentIndex < 0 {
			latestAgentIndex = index
		}
		if role == "user" && latestUserIndex < 0 {
			latestUserIndex = index
		}
		if latestUserIndex >= 0 && latestAgentIndex >= 0 {
			break
		}
	}
	if latestUserIndex < 0 && latestAgentIndex < 0 {
		return nil
	}
	indices := make([]int, 0, 2)
	if latestUserIndex >= 0 {
		indices = append(indices, latestUserIndex)
	}
	if latestAgentIndex >= 0 && latestAgentIndex != latestUserIndex {
		indices = append(indices, latestAgentIndex)
	}
	sort.Ints(indices)
	items := make([]WorkspaceAgentTimelineItem, 0, len(indices))
	for _, index := range indices {
		items = append(items, ordered[index])
	}
	return LimitTimelineItems(items, limit)
}

func shouldReplayRuntimeLocalTail(local []WorkspaceAgentTimelineItem) bool {
	for _, item := range local {
		if !isTerminalRuntimeTimelineItem(item) {
			return true
		}
	}
	return false
}

func sortTimelineItemsForDisplay(items []WorkspaceAgentTimelineItem) {
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].ID != items[j].ID {
			if items[i].ID == 0 {
				return false
			}
			if items[j].ID == 0 {
				return true
			}
			return items[i].ID < items[j].ID
		}
		if timelineItemTime(items[i]) != timelineItemTime(items[j]) {
			return timelineItemTime(items[i]) < timelineItemTime(items[j])
		}
		return strings.TrimSpace(items[i].EventID) < strings.TrimSpace(items[j].EventID)
	})
}

func timelineDisplayMessageRole(item WorkspaceAgentTimelineItem) string {
	role := strings.ToLower(strings.TrimSpace(item.Role))
	switch role {
	case "assistant", "agent":
		return "assistant"
	case "user":
		return "user"
	}
	itemType := strings.ToLower(strings.TrimSpace(item.ItemType))
	switch itemType {
	case "message.assistant", "message.agent":
		return "assistant"
	case "message.user":
		return "user"
	}
	if itemType == "message" {
		return role
	}
	return ""
}

func timelineDisplayMessageContent(item WorkspaceAgentTimelineItem) string {
	if item.Payload != nil {
		if displayPrompt, ok := item.Payload["displayPrompt"].(string); ok && strings.TrimSpace(displayPrompt) != "" {
			return displayPrompt
		}
		if text, ok := item.Payload["text"].(string); ok && strings.TrimSpace(text) != "" {
			return text
		}
		if content, ok := item.Payload["content"].(string); ok && strings.TrimSpace(content) != "" {
			return content
		}
	}
	return ""
}

func mergeRuntimeTimelineItem(
	durable WorkspaceAgentTimelineItem,
	local WorkspaceAgentTimelineItem,
) WorkspaceAgentTimelineItem {
	preferred := local
	fallback := durable
	if shouldPreferDurableTimelineState(durable, local) {
		preferred = durable
		fallback = local
	}
	merged := durable
	merged.TurnID = firstNonEmptyString(preferred.TurnID, fallback.TurnID)
	merged.EventSource = firstNonEmptyString(durable.EventSource, local.EventSource)
	merged.ActorType = firstNonEmptyString(preferred.ActorType, fallback.ActorType)
	merged.ActorID = firstNonEmptyString(preferred.ActorID, fallback.ActorID)
	merged.ItemType = firstNonEmptyString(preferred.ItemType, fallback.ItemType)
	merged.Role = firstNonEmptyString(preferred.Role, fallback.Role)
	merged.CallType = firstNonEmptyString(preferred.CallType, fallback.CallType)
	merged.CallID = firstNonEmptyString(preferred.CallID, fallback.CallID)
	merged.Name = firstNonEmptyString(preferred.Name, fallback.Name)
	merged.Status = firstNonEmptyString(preferred.Status, fallback.Status)
	merged.Payload = mergeWorkspaceAgentPayload(durable.Payload, local.Payload)
	merged.OccurredAtUnixMS = firstNonZeroInt64(preferred.OccurredAtUnixMS, fallback.OccurredAtUnixMS)
	merged.CreatedAtUnixMS = firstNonZeroInt64(durable.CreatedAtUnixMS, local.CreatedAtUnixMS)
	return merged
}

func shouldPreferDurableTimelineState(
	durable WorkspaceAgentTimelineItem,
	local WorkspaceAgentTimelineItem,
) bool {
	return isTerminalRuntimeTimelineItem(durable) && !isTerminalRuntimeTimelineItem(local)
}

func isTerminalRuntimeTimelineItem(item WorkspaceAgentTimelineItem) bool {
	switch normalizeRuntimeTimelineStatus(item) {
	case "completed", "done", "success", "succeeded", "failed", "error", "canceled":
		return true
	default:
		return false
	}
}

func normalizeRuntimeTimelineStatus(item WorkspaceAgentTimelineItem) string {
	status := strings.ToLower(strings.TrimSpace(firstNonEmptyString(
		item.Status,
		payloadStringValue(item.Payload, "status"),
		payloadStringValue(item.Payload, "activityStatus"),
	)))
	return strings.ReplaceAll(status, "-", "_")
}

func payloadStringValue(payload map[string]any, key string) string {
	if len(payload) == 0 {
		return ""
	}
	value, ok := payload[key]
	if !ok {
		return ""
	}
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func timelineItemTime(item WorkspaceAgentTimelineItem) int64 {
	if item.OccurredAtUnixMS > 0 {
		return item.OccurredAtUnixMS
	}
	return item.CreatedAtUnixMS
}

func firstNonZeroInt64(values ...int64) int64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func mergeWorkspaceAgentPayload(base map[string]any, incoming map[string]any) map[string]any {
	out := cloneWorkspaceAgentPayload(base)
	if out == nil {
		out = map[string]any{}
	}
	for key, incomingValue := range incoming {
		if runtimePayloadValueIsEmpty(incomingValue) {
			continue
		}
		if existingValue, ok := out[key]; ok {
			existingMap, existingOK := existingValue.(map[string]any)
			incomingMap, incomingOK := incomingValue.(map[string]any)
			if existingOK && incomingOK {
				out[key] = mergeWorkspaceAgentPayload(existingMap, incomingMap)
				continue
			}
		}
		out[key] = cloneWorkspaceAgentPayloadValue(incomingValue)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func runtimePayloadValueIsEmpty(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(typed) == ""
	case []any:
		return len(typed) == 0
	case map[string]any:
		return len(typed) == 0
	default:
		return false
	}
}

func cloneWorkspaceAgentPayload(payload map[string]any) map[string]any {
	if len(payload) == 0 {
		return nil
	}
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		out[key] = cloneWorkspaceAgentPayloadValue(value)
	}
	return out
}

func cloneWorkspaceAgentPayloadValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return cloneWorkspaceAgentPayload(typed)
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = cloneWorkspaceAgentPayloadValue(item)
		}
		return out
	default:
		return value
	}
}

func FilterTimelineItems(items []WorkspaceAgentTimelineItem, afterID uint64, limit int) []WorkspaceAgentTimelineItem {
	if len(items) == 0 {
		return nil
	}
	filtered := make([]WorkspaceAgentTimelineItem, 0, len(items))
	for _, item := range items {
		if afterID > 0 {
			if item.ID == 0 || item.ID <= afterID {
				continue
			}
		}
		filtered = append(filtered, item)
		if limit > 0 && len(filtered) >= limit {
			break
		}
	}
	return filtered
}

func LimitTimelineItems(items []WorkspaceAgentTimelineItem, limit int) []WorkspaceAgentTimelineItem {
	if limit <= 0 || len(items) <= limit {
		return items
	}
	return items[:limit]
}

func FilterSessionsByUserID(
	sessions []ProviderActivitySessionProjection,
	userID string,
) []ProviderActivitySessionProjection {
	userID = strings.TrimSpace(userID)
	if userID == "" || len(sessions) == 0 {
		return sessions
	}
	filtered := make([]ProviderActivitySessionProjection, 0, len(sessions))
	for _, session := range sessions {
		if strings.TrimSpace(session.UserID) == userID {
			filtered = append(filtered, session)
		}
	}
	return filtered
}

func NormalizeSessionOrigin(origin string) string {
	switch strings.TrimSpace(origin) {
	case "", WorkspaceAgentSessionOriginRuntime:
		return WorkspaceAgentSessionOriginRuntime
	default:
		return ""
	}
}

func canonicalSessionOriginValue(origin string) string {
	origin = strings.TrimSpace(origin)
	if normalized := NormalizeSessionOrigin(origin); normalized != "" {
		return normalized
	}
	return origin
}

func NonNilPresences(presences []WorkspaceAgentPresence) []WorkspaceAgentPresence {
	if presences == nil {
		return []WorkspaceAgentPresence{}
	}
	return presences
}

func NonNilSessions(sessions []ProviderActivitySessionProjection) []ProviderActivitySessionProjection {
	if sessions == nil {
		return []ProviderActivitySessionProjection{}
	}
	return sessions
}

func NonNilTimelineItems(items []WorkspaceAgentTimelineItem) []WorkspaceAgentTimelineItem {
	if items == nil {
		return []WorkspaceAgentTimelineItem{}
	}
	return items
}

func NonNilMessageUpdates(items []WorkspaceAgentMessageUpdate) []WorkspaceAgentMessageUpdate {
	if items == nil {
		return []WorkspaceAgentMessageUpdate{}
	}
	return items
}
