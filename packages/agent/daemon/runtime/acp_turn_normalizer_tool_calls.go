package agentruntime

import (
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type pendingToolCallSnapshot struct {
	eventID string
	payload map[string]any
}

func (n *acpTurnNormalizer) ToolCallEvents(session Session, turnID string, update map[string]any) ([]activityshared.Event, bool) {
	if n == nil {
		event, ok := acpToolCallEvent(session, turnID, update)
		if !ok {
			return nil, false
		}
		return appendTurnFileChangesEvent(nil, []activityshared.Event{event}, event), true
	}
	rawToolCallID := firstNonEmpty(asString(update["toolCallId"]), asString(update["id"]))
	eventID := n.toolItemID(update)
	if eventID == "" {
		return nil, false
	}
	event, ok := acpToolCallEventWithID(session, eventID, turnID, update)
	if !ok {
		return nil, false
	}
	n.trackToolCallEvent(event)
	events := n.Finish(session, turnID, messageStreamStateCompleted)
	events = append(events, event)
	events = append(events, n.consumeEarlyToolOutput(session, turnID, rawToolCallID)...)
	events = appendTurnFileChangesEvent(n, events, event)
	return events, true
}

func (n *acpTurnNormalizer) StandardToolCallEvent(session Session, turnID string, updateType string, update map[string]any) (activityshared.Event, bool) {
	if n == nil {
		return standardACPToolCallEvent(session, turnID, updateType, update)
	}
	callID := firstNonEmpty(asString(update["toolCallId"]), asString(update["callId"]), asString(update["id"]))
	eventID := n.toolItemID(update)
	if eventID == "" {
		return activityshared.Event{}, false
	}
	update = n.standardToolUpdateWithStableIdentity(eventID, update)
	event, ok := standardACPToolCallEventWithID(session, eventID, turnID, updateType, update)
	if !ok {
		return activityshared.Event{}, false
	}
	if callID != "" {
		n.toolCallsSeen[callID] = true
	}
	n.mergePendingToolCallSnapshot(&event)
	n.trackToolCallEvent(event)
	return event, true
}

func (n *acpTurnNormalizer) standardToolUpdateWithStableIdentity(eventID string, update map[string]any) map[string]any {
	if n == nil || strings.TrimSpace(eventID) == "" {
		return update
	}
	pending, ok := n.pendingToolCalls[eventID]
	if !ok {
		return update
	}
	toolName := strings.TrimSpace(asString(pending.payload["toolName"]))
	if toolName == "" {
		return update
	}
	result := clonePayload(update)
	result["toolName"] = toolName
	return result
}

func (n *acpTurnNormalizer) StandardToolCallEvents(session Session, turnID string, updateType string, update map[string]any) ([]activityshared.Event, bool) {
	if n == nil {
		event, ok := standardACPToolCallEvent(session, turnID, updateType, update)
		if !ok {
			return nil, false
		}
		return appendTurnFileChangesEvent(nil, []activityshared.Event{event}, event), true
	}
	rawToolCallID := firstNonEmpty(asString(update["toolCallId"]), asString(update["callId"]), asString(update["id"]))
	event, ok := n.StandardToolCallEvent(session, turnID, updateType, update)
	if !ok {
		return nil, false
	}
	events := n.Finish(session, turnID, messageStreamStateCompleted)
	events = append(events, event)
	events = append(events, n.consumeEarlyToolOutput(session, turnID, rawToolCallID)...)
	events = appendTurnFileChangesEvent(n, events, event)
	return events, true
}

func appendTurnFileChangesEvent(
	normalizer *acpTurnNormalizer,
	events []activityshared.Event,
	event activityshared.Event,
) []activityshared.Event {
	if event.Type != activityshared.EventCallCompleted {
		return events
	}
	fileChanges := fileChangesFromActivityEvent(event)
	if fileChanges == nil {
		return events
	}
	if normalizer != nil {
		fileChanges = withoutAuthoritativeFileChangeDetails(
			fileChanges,
			normalizer.authoritativeFileChanges,
		)
		normalizer.fileChanges = mergeCanonicalFileChanges(normalizer.fileChanges, fileChanges)
		fileChanges = clonePayload(normalizer.fileChanges)
	}
	ctx := activityshared.EventContext{
		EventID:              newID(),
		Provider:             event.Provider,
		ProviderSessionID:    event.ProviderSessionID,
		AgentSessionID:       event.AgentSessionID,
		SessionKind:          event.SessionKind,
		RootAgentSessionID:   event.RootAgentSessionID,
		RootTurnID:           event.RootTurnID,
		ParentAgentSessionID: event.ParentAgentSessionID,
		ParentTurnID:         event.ParentTurnID,
		ParentToolCallID:     event.ParentToolCallID,
		TurnID:               event.Payload.TurnID,
		CWD:                  event.Payload.CWD,
		OccurredAtUnixMS:     nextEventUnixMS(),
	}
	updated := activityshared.NewTurnUpdated(ctx, event.Payload.TurnID, activityshared.TurnPhaseWorking)
	updated.Payload.Metadata = map[string]any{"fileChanges": fileChanges}
	return append(events, updated)
}

func (n *acpTurnNormalizer) recordFileChangesEvents(
	session Session,
	turnID string,
	files []map[string]any,
) []activityshared.Event {
	if n == nil || strings.TrimSpace(turnID) == "" {
		return nil
	}
	canonical := make([]any, 0, len(files))
	for _, file := range files {
		if file = canonicalToolFileChange(file, ""); file != nil {
			canonical = append(canonical, file)
		}
	}
	if len(canonical) == 0 {
		return nil
	}
	n.fileChanges = mergeCanonicalFileChanges(n.fileChanges, map[string]any{
		"files": canonical,
	})
	if n.authoritativeFileChanges == nil {
		n.authoritativeFileChanges = make(map[string]struct{})
	}
	for _, file := range canonical {
		fileMap, _ := file.(map[string]any)
		path := strings.TrimSpace(asString(fileMap["path"]))
		if path != "" {
			n.authoritativeFileChanges[path] = struct{}{}
		}
	}
	ctx, ok := activityEventContext(session, newID(), turnID)
	if !ok {
		return nil
	}
	ctx.RootAgentSessionID = strings.TrimSpace(session.RootAgentSessionID)
	updated := activityshared.NewTurnUpdated(ctx, turnID, activityshared.TurnPhaseWorking)
	updated.Payload.Metadata = map[string]any{"fileChanges": clonePayload(n.fileChanges)}
	return []activityshared.Event{updated}
}

func withoutAuthoritativeFileChangeDetails(
	fileChanges map[string]any,
	authoritativePaths map[string]struct{},
) map[string]any {
	if len(authoritativePaths) == 0 {
		return fileChanges
	}
	files := payloadArray(fileChanges["files"])
	if len(files) == 0 {
		return fileChanges
	}
	sanitized := make([]any, 0, len(files))
	for _, file := range files {
		copy := clonePayload(file)
		path := strings.TrimSpace(asString(copy["path"]))
		if _, authoritative := authoritativePaths[path]; authoritative {
			delete(copy, "oldString")
			delete(copy, "newString")
			delete(copy, "content")
			delete(copy, "diff")
			delete(copy, "unifiedDiff")
		}
		sanitized = append(sanitized, copy)
	}
	return map[string]any{"files": sanitized}
}

func (n *acpTurnNormalizer) toolItemID(update map[string]any) string {
	key := firstNonEmpty(asString(update["toolCallId"]), asString(update["id"]), asString(update["title"]), asString(update["name"]))
	if key == "" {
		key = newID()
	}
	if n.toolItemIDs == nil {
		n.toolItemIDs = make(map[string]string)
	}
	if existing := n.toolItemIDs[key]; existing != "" {
		return existing
	}
	id := newID()
	n.toolItemIDs[key] = id
	return id
}

func (n *acpTurnNormalizer) knownToolItemID(rawToolCallID string) string {
	if n == nil {
		return ""
	}
	return n.toolItemIDs[strings.TrimSpace(rawToolCallID)]
}

// KnownToolCallInput returns the last recorded normalized input for a raw ACP
// toolCallId, if the normalizer has already seen a `tool_call`/`tool_call_update`
// for it in this turn. Some ACP providers (Cursor) omit `rawInput` on the
// `toolCall` embedded in `session/request_permission`, repeating only
// `toolCallId`/`title`/`kind`; the earlier tool_call notification for the same
// id is the only place the command/path/query detail exists. Later empty
// `tool_call_update` snapshots merge into that prior input instead of replacing
// it, so this lookup still sees the original detail. This lookup does not
// create a new id mapping, so it must not be used before the tool_call it
// targets has actually streamed.
func (n *acpTurnNormalizer) KnownToolCallInput(rawToolCallID string) map[string]any {
	if n == nil {
		return nil
	}
	rawToolCallID = strings.TrimSpace(rawToolCallID)
	if rawToolCallID == "" || n.toolItemIDs == nil {
		return nil
	}
	eventID, ok := n.toolItemIDs[rawToolCallID]
	if !ok {
		return nil
	}
	pending, ok := n.pendingToolCalls[eventID]
	if !ok {
		return nil
	}
	return payloadMap(pending.payload, "input")
}

func (n *acpTurnNormalizer) trackToolCallEvent(event activityshared.Event) {
	if n == nil || strings.TrimSpace(event.EventID) == "" {
		return
	}
	switch event.Type {
	case activityshared.EventCallStarted:
		if n.pendingToolCalls == nil {
			n.pendingToolCalls = make(map[string]pendingToolCallSnapshot)
		}
		incoming := clonePayload(event.Payload.Metadata)
		if previous, ok := n.pendingToolCalls[event.EventID]; ok {
			// Cursor often streams tool_call with rawInput, then a later
			// tool_call_update that repeats only title/kind/status (no input).
			// Replacing the snapshot wholesale dropped command/path/query and
			// left session/request_permission with nothing to backfill.
			incoming = mergePendingToolCallPayload(previous.payload, incoming)
		}
		n.pendingToolCalls[event.EventID] = pendingToolCallSnapshot{
			eventID: event.EventID,
			payload: incoming,
		}
	case activityshared.EventCallCompleted, activityshared.EventCallFailed:
		delete(n.pendingToolCalls, event.EventID)
		delete(n.toolOutputText, event.EventID)
		delete(n.toolOutputTruncated, event.EventID)
	}
}

func (n *acpTurnNormalizer) mergePendingToolCallSnapshot(event *activityshared.Event) {
	if n == nil || event == nil || event.Type != activityshared.EventCallCompleted {
		return
	}
	snapshot, ok := n.pendingToolCalls[event.EventID]
	if !ok || len(snapshot.payload) == 0 {
		return
	}
	merged := mergePendingToolCallPayload(snapshot.payload, event.Payload.Metadata)
	if len(merged) == 0 {
		return
	}
	normalizeMergedACPToolPayload(merged)
	event.Payload.Metadata = merged
	event.Payload.Input = payloadMap(merged, "input")
	event.Payload.Output = payloadMap(merged, "output")
	if name := strings.TrimSpace(asString(merged["name"])); name != "" {
		event.Payload.Name = name
	}
}

func mergePendingToolCallPayload(started map[string]any, completed map[string]any) map[string]any {
	merged := clonePayload(started)
	if merged == nil {
		merged = map[string]any{}
	}
	for key, value := range completed {
		if key == "input" {
			if mergedInput := mergePendingToolCallInput(
				payloadMap(merged, "input"),
				payloadObject(value),
			); len(mergedInput) > 0 {
				merged[key] = mergedInput
			}
			continue
		}
		if payloadValueIsEmpty(value) {
			continue
		}
		merged[key] = clonePayloadValue(value)
	}
	return merged
}

// mergePendingToolCallInput keeps earlier structured fields (command/path/query)
// when a later ACP tool_call_update omits or only partially repeats input.
func mergePendingToolCallInput(base map[string]any, incoming map[string]any) map[string]any {
	merged := clonePayload(base)
	if merged == nil {
		merged = map[string]any{}
	}
	for key, value := range incoming {
		if payloadValueIsEmpty(value) {
			continue
		}
		merged[key] = clonePayloadValue(value)
	}
	if len(merged) == 0 {
		return nil
	}
	return merged
}

func normalizeMergedACPToolPayload(payload map[string]any) {
	if len(payload) == 0 {
		return
	}
	input := payloadMap(payload, "input")
	output := payloadMap(payload, "output")
	kind := firstNonEmpty(
		asString(payload["kind"]),
		asString(input["kind"]),
		asString(payloadMap(payload, "acp")["kind"]),
	)
	callID := asString(payload["callId"])
	priorToolName := strings.TrimSpace(asString(payload["toolName"]))
	name := firstNonEmpty(
		asString(input["title"]),
		asString(payload["title"]),
	)
	if candidate := strings.TrimSpace(asString(payload["name"])); candidate != "" && !isOpaqueCallIdentifierString(candidate, callID) {
		if name == "" {
			name = candidate
		}
	}
	if name == "" && priorToolName != "" && !isOpaqueCallIdentifierString(priorToolName, callID) {
		name = priorToolName
	}
	toolName := acpToolNameWithOutput(callID, name, kind, input, output)
	if toolName == "" {
		toolName = priorToolName
	}
	// Prefer a stable prior identity when re-derivation collapses to a generic
	// Tool/Bash label but we already knew a more specific Cursor tool name.
	if priorToolName != "" && priorToolName != "Tool" && priorToolName != "Bash" &&
		(toolName == "" || toolName == "Tool" || toolName == "Bash") &&
		acpToolNameLooksSpecific(priorToolName) {
		toolName = priorToolName
	}
	if toolName != "" {
		payload["toolName"] = toolName
		payload["name"] = toolName
	}
	if strings.TrimSpace(asString(payload["kind"])) == "" && strings.TrimSpace(kind) != "" {
		payload["kind"] = kind
	}
	if strings.TrimSpace(asString(payload["callType"])) == "" && strings.TrimSpace(kind) != "" {
		payload["callType"] = kind
	}
	if fileChanges := canonicalFileChangesFromToolPayload(payload); fileChanges != nil {
		payload["fileChanges"] = fileChanges
	}
}

func acpToolNameLooksSpecific(toolName string) bool {
	switch strings.TrimSpace(toolName) {
	case "Glob", "Grep", "Read", "Write", "Edit", "WebSearch", "WebFetch", "TodoWrite", "Agent", "Think":
		return true
	default:
		return false
	}
}
