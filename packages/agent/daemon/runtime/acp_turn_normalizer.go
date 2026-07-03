package agentruntime

import (
	"sort"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

type pendingToolCallSnapshot struct {
	eventID string
	payload map[string]any
}

type acpTurnNormalizer struct {
	assistantMessageID         string
	assistantContent           strings.Builder
	assistantSegmentCompleted  bool
	thinkingMessageID          string
	thinkingContent            strings.Builder
	thinkingSegmentCompleted   bool
	thinkingMessageKind        string
	toolItemIDs                map[string]string
	toolCallsSeen              map[string]bool
	pendingToolCalls           map[string]pendingToolCallSnapshot
	pendingCompactionMessageID string
}

// TrackCompactionNotice remembers the in-flight compaction banner so a turn
// that dies mid-compaction settles the banner instead of leaving a live
// "Compacting context." row ticking in the transcript forever.
func (n *acpTurnNormalizer) TrackCompactionNotice(messageID string, completed bool) {
	if n == nil {
		return
	}
	if completed {
		n.pendingCompactionMessageID = ""
		return
	}
	n.pendingCompactionMessageID = strings.TrimSpace(messageID)
}

// settlePendingCompactionEvents replaces a still-in-progress compaction banner
// in place (same messageId) when the turn ends without the compaction item
// completing.
func (n *acpTurnNormalizer) settlePendingCompactionEvents(session Session, turnID string, title string) []activityshared.Event {
	if n == nil || n.pendingCompactionMessageID == "" {
		return nil
	}
	messageID := n.pendingCompactionMessageID
	n.pendingCompactionMessageID = ""
	event, ok := acpSystemNoticeEvent(session, turnID, map[string]any{
		"kind":       "agent_system_notice",
		"noticeKind": "system_notice",
		"title":      title,
		"messageId":  messageID,
	}, "system_notice", true)
	if !ok {
		return nil
	}
	return []activityshared.Event{event}
}

// SetThinkingPresentation tags thinking snapshots with an optional messageKind
// and adjusts streaming behavior. Review inline turns use messageKind
// review-process so the GUI renders reasoning as direct prose.
func (n *acpTurnNormalizer) SetThinkingPresentation(messageKind string) {
	if n == nil {
		return
	}
	n.thinkingMessageKind = strings.TrimSpace(messageKind)
}

func newACPTurnNormalizer() *acpTurnNormalizer {
	return &acpTurnNormalizer{
		toolItemIDs:      make(map[string]string),
		toolCallsSeen:    make(map[string]bool),
		pendingToolCalls: make(map[string]pendingToolCallSnapshot),
	}
}

func (n *acpTurnNormalizer) AppendAssistantChunk(session Session, turnID string, chunk string) []activityshared.Event {
	if n == nil || chunk == "" {
		return nil
	}
	if n.assistantMessageID == "" || n.assistantSegmentCompleted {
		n.assistantMessageID = newID()
		n.assistantContent.Reset()
		n.assistantSegmentCompleted = false
	}
	n.mergeAssistantText(chunk)
	return []activityshared.Event{n.assistantSnapshotEvent(session, turnID, messageStreamStateStreaming)}
}

func (n *acpTurnNormalizer) AppendThinkingChunk(session Session, turnID string, chunk string) []activityshared.Event {
	if n == nil || chunk == "" {
		return nil
	}
	if n.thinkingMessageID == "" || n.thinkingSegmentCompleted {
		n.thinkingMessageID = newID()
		n.thinkingContent.Reset()
		n.thinkingSegmentCompleted = false
	}
	_, _ = n.thinkingContent.WriteString(chunk)
	if n.thinkingMessageKind == "review-process" {
		// Codex summaryTextDelta often streams word-sized tokens without spaces.
		// Defer emission until item/completed supplies the authoritative summary.
		return nil
	}
	return []activityshared.Event{n.thinkingSnapshotEvent(session, turnID, messageStreamStateStreaming)}
}

func (n *acpTurnNormalizer) ApplyAssistantFinalText(finalText string) {
	if n == nil {
		return
	}
	finalText = strings.TrimSpace(finalText)
	if finalText == "" {
		return
	}
	if n.assistantMessageID == "" || n.assistantSegmentCompleted {
		n.assistantMessageID = newID()
		n.assistantSegmentCompleted = false
	}
	n.assistantContent.Reset()
	_, _ = n.assistantContent.WriteString(finalText)
}

func (n *acpTurnNormalizer) AppendAssistantSnapshot(
	session Session,
	turnID string,
	text string,
	messageID string,
) []activityshared.Event {
	if n == nil {
		return nil
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	current := strings.TrimSpace(n.assistantContent.String())
	if current == text && n.assistantMessageID != "" {
		if n.assistantSegmentCompleted {
			return nil
		}
		return n.Finish(session, turnID, messageStreamStateCompleted)
	}
	if n.assistantMessageID == "" || n.assistantSegmentCompleted {
		n.assistantMessageID = firstNonEmpty(strings.TrimSpace(messageID), newID())
		n.assistantSegmentCompleted = false
	}
	n.assistantContent.Reset()
	_, _ = n.assistantContent.WriteString(text)
	return n.Finish(session, turnID, messageStreamStateCompleted)
}

func (n *acpTurnNormalizer) mergeAssistantText(next string) {
	if n == nil || next == "" {
		return
	}
	current := n.assistantContent.String()
	trimmedCurrent := strings.TrimSpace(current)
	trimmedNext := strings.TrimSpace(next)
	switch {
	case current == "":
		_, _ = n.assistantContent.WriteString(next)
	case next == current || trimmedNext == trimmedCurrent:
		return
	case strings.HasPrefix(next, current) || strings.HasPrefix(trimmedNext, trimmedCurrent):
		n.assistantContent.Reset()
		_, _ = n.assistantContent.WriteString(next)
	case strings.HasPrefix(current, next) || strings.HasPrefix(trimmedCurrent, trimmedNext):
		return
	default:
		_, _ = n.assistantContent.WriteString(next)
	}
}

func (n *acpTurnNormalizer) Finish(session Session, turnID string, streamState string) []activityshared.Event {
	if n == nil {
		return nil
	}
	events := make([]activityshared.Event, 0, 2)
	if n.thinkingMessageID != "" && n.thinkingContent.Len() > 0 && !n.thinkingSegmentCompleted {
		events = append(events, n.thinkingSnapshotEvent(session, turnID, streamState))
		n.thinkingSegmentCompleted = true
	}
	if n.assistantMessageID != "" && n.assistantContent.Len() > 0 && !n.assistantSegmentCompleted {
		events = append(events, n.assistantSnapshotEvent(session, turnID, streamState))
		n.assistantSegmentCompleted = true
	}
	return events
}

// hasStreamingThinkingSegment reports whether an in-flight thinking segment is
// still accumulating chunks (e.g. from reasoning textDelta) and has not been
// finalized yet.
func (n *acpTurnNormalizer) hasStreamingThinkingSegment() bool {
	return n != nil &&
		n.thinkingMessageID != "" &&
		n.thinkingContent.Len() > 0 &&
		!n.thinkingSegmentCompleted
}

// FinalizeThinkingItem closes out the thinking segment for a reasoning
// item/completed payload. When reasoning already streamed as textDelta chunks
// the content is buffered, so it only finalizes; for inline delivery (no
// deltas, e.g. /review) it seeds the segment from fullText first. This keeps
// streaming and inline reasoning from double-appending and makes each reasoning
// item render as exactly one finalized thinking row.
func (n *acpTurnNormalizer) FinalizeThinkingItem(session Session, turnID string, fullText string) []activityshared.Event {
	if n == nil {
		return nil
	}
	if fullText != "" {
		if n.thinkingMessageID == "" || n.thinkingSegmentCompleted {
			n.thinkingMessageID = newID()
			n.thinkingContent.Reset()
			n.thinkingSegmentCompleted = false
		}
		// item/completed summary is authoritative; replace streamed word-token deltas.
		n.thinkingContent.Reset()
		_, _ = n.thinkingContent.WriteString(fullText)
	} else if !n.hasStreamingThinkingSegment() {
		return nil
	}
	return n.Finish(session, turnID, messageStreamStateCompleted)
}

func (n *acpTurnNormalizer) FinishCompleted(session Session, turnID string) []activityshared.Event {
	events := n.Finish(session, turnID, messageStreamStateCompleted)
	events = append(events, n.completedToolCallEvents(session, turnID)...)
	// A turn that completed normally implies the compaction it ran finished;
	// no-op in the usual flow because item/completed already cleared the id.
	events = append(events, n.settlePendingCompactionEvents(session, turnID, appServerContextCompactedTitle)...)
	return events
}

func (n *acpTurnNormalizer) FinishFailed(session Session, turnID string) []activityshared.Event {
	return n.finishTerminal(session, turnID, messageStreamStateFailed, messageStreamStateFailed, "turn_failed")
}

func (n *acpTurnNormalizer) FinishInterrupted(session Session, turnID string, reason string) []activityshared.Event {
	return n.finishTerminal(session, turnID, messageStreamStateFailed, SessionStatusCanceled, reason)
}

func (n *acpTurnNormalizer) ToolCallEvents(session Session, turnID string, update map[string]any) ([]activityshared.Event, bool) {
	if n == nil {
		event, ok := acpToolCallEvent(session, turnID, update)
		if !ok {
			return nil, false
		}
		return []activityshared.Event{event}, true
	}
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
	event, ok := standardACPToolCallEventWithID(session, eventID, turnID, updateType, update)
	if !ok {
		return activityshared.Event{}, false
	}
	if callID != "" {
		n.toolCallsSeen[callID] = true
	}
	n.trackToolCallEvent(event)
	return event, true
}

func (n *acpTurnNormalizer) StandardToolCallEvents(session Session, turnID string, updateType string, update map[string]any) ([]activityshared.Event, bool) {
	if n == nil {
		event, ok := standardACPToolCallEvent(session, turnID, updateType, update)
		if !ok {
			return nil, false
		}
		return []activityshared.Event{event}, true
	}
	event, ok := n.StandardToolCallEvent(session, turnID, updateType, update)
	if !ok {
		return nil, false
	}
	events := n.Finish(session, turnID, messageStreamStateCompleted)
	events = append(events, event)
	return events, true
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

func (n *acpTurnNormalizer) trackToolCallEvent(event activityshared.Event) {
	if n == nil || strings.TrimSpace(event.EventID) == "" {
		return
	}
	switch event.Type {
	case activityshared.EventCallStarted:
		if n.pendingToolCalls == nil {
			n.pendingToolCalls = make(map[string]pendingToolCallSnapshot)
		}
		n.pendingToolCalls[event.EventID] = pendingToolCallSnapshot{
			eventID: event.EventID,
			payload: clonePayload(event.Payload.Metadata),
		}
	case activityshared.EventCallCompleted, activityshared.EventCallFailed:
		delete(n.pendingToolCalls, event.EventID)
	}
}

func (n *acpTurnNormalizer) finishTerminal(
	session Session,
	turnID string,
	streamState string,
	toolStatus string,
	reason string,
) []activityshared.Event {
	events := n.Finish(session, turnID, streamState)
	events = append(events, n.terminalToolCallEvents(session, turnID, toolStatus, reason)...)
	events = append(events, n.settlePendingCompactionEvents(session, turnID, appServerCompactionInterruptedTitle)...)
	return events
}

func (n *acpTurnNormalizer) terminalToolCallEvents(
	session Session,
	turnID string,
	toolStatus string,
	reason string,
) []activityshared.Event {
	if n == nil || len(n.pendingToolCalls) == 0 {
		return nil
	}
	keys := make([]string, 0, len(n.pendingToolCalls))
	for key := range n.pendingToolCalls {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	events := make([]activityshared.Event, 0, len(keys))
	for _, key := range keys {
		snapshot := n.pendingToolCalls[key]
		payload := clonePayload(snapshot.payload)
		if payload == nil {
			payload = map[string]any{}
		}
		payload["status"] = toolStatus
		errorPayload := payloadMap(payload, "error")
		if errorPayload == nil {
			errorPayload = map[string]any{}
		}
		errorPayload["status"] = toolStatus
		if trimmedReason := strings.TrimSpace(reason); trimmedReason != "" {
			errorPayload["reason"] = trimmedReason
			errorPayload["message"] = trimmedReason
		}
		payload["error"] = errorPayload
		events = append(events, newTurnActivityEventWithID(
			session,
			snapshot.eventID,
			EventCallFailed,
			turnID,
			toolStatus,
			"",
			payloadString(payload, "name"),
			payload,
		))
		delete(n.pendingToolCalls, key)
	}
	return events
}

func (n *acpTurnNormalizer) completedToolCallEvents(
	session Session,
	turnID string,
) []activityshared.Event {
	if n == nil || len(n.pendingToolCalls) == 0 {
		return nil
	}
	keys := make([]string, 0, len(n.pendingToolCalls))
	for key := range n.pendingToolCalls {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	events := make([]activityshared.Event, 0, len(keys))
	for _, key := range keys {
		snapshot := n.pendingToolCalls[key]
		payload := clonePayload(snapshot.payload)
		if payload == nil {
			payload = map[string]any{}
		}
		payload["status"] = messageStreamStateCompleted
		events = append(events, newTurnActivityEventWithID(
			session,
			snapshot.eventID,
			EventCallCompleted,
			turnID,
			messageStreamStateCompleted,
			"",
			payloadString(payload, "name"),
			payload,
		))
		delete(n.pendingToolCalls, key)
	}
	return events
}

func (n *acpTurnNormalizer) assistantSnapshotEvent(session Session, turnID string, streamState string) activityshared.Event {
	status := messageStreamStateStreaming
	switch streamState {
	case messageStreamStateCompleted:
		status = messageStreamStateCompleted
	case messageStreamStateFailed:
		status = messageStreamStateFailed
	}
	return newTurnActivityEventWithID(session, n.assistantMessageID, EventMessage, turnID, status, RoleAssistant, n.assistantContent.String(), map[string]any{
		"messageId":   n.assistantMessageID,
		"contentMode": messageContentModeSnapshot,
		"streamState": status,
	})
}

func (n *acpTurnNormalizer) thinkingSnapshotEvent(session Session, turnID string, streamState string) activityshared.Event {
	status := messageStreamStateStreaming
	switch streamState {
	case messageStreamStateCompleted:
		status = messageStreamStateCompleted
	case messageStreamStateFailed:
		status = messageStreamStateFailed
	}
	metadata := map[string]any{
		"messageId":   n.thinkingMessageID,
		"contentMode": messageContentModeSnapshot,
		"streamState": status,
	}
	if messageKind := strings.TrimSpace(n.thinkingMessageKind); messageKind != "" {
		metadata["messageKind"] = messageKind
	}
	return newTurnActivityEventWithID(session, n.thinkingMessageID, EventMessage, turnID, status, RoleAssistantThinking, n.thinkingContent.String(), metadata)
}
