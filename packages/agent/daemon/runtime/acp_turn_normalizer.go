package agentruntime

import (
	"sort"
	"strings"
	"sync"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type pendingToolCallSnapshot struct {
	eventID string
	payload map[string]any
}

type acpTurnNormalizer struct {
	assistantMessageID        string
	assistantContent          strings.Builder
	assistantSegmentCompleted bool
	thinkingMessageID         string
	thinkingContent           strings.Builder
	thinkingSegmentCompleted  bool
	thinkingMessageKind       string
	toolItemIDs               map[string]string
	toolCallsSeen             map[string]bool
	pendingToolCalls          map[string]pendingToolCallSnapshot
	fileChanges               map[string]any
	compactionMu              sync.Mutex
	compactionMessageID       string
	compactionTerminalStatus  string
	suppressAssistantOutput   bool
}

// StartCompactionNotice atomically claims the compaction lifecycle's stable
// message id. The bool reports whether the caller should publish the running
// notice; repeated provider starts reuse the id without emitting another row.
func (n *acpTurnNormalizer) StartCompactionNotice(messageID string) (string, bool) {
	messageID = strings.TrimSpace(messageID)
	if n == nil || messageID == "" {
		return messageID, false
	}
	n.compactionMu.Lock()
	defer n.compactionMu.Unlock()
	if n.compactionMessageID != "" {
		return n.compactionMessageID, false
	}
	n.compactionMessageID = messageID
	return messageID, true
}

// CompleteCompactionNotice selects the provider-reported completed terminal.
// Terminal selection is first-write-wins: a late completion after a locally
// synthesized failed/canceled terminal is ignored.
func (n *acpTurnNormalizer) CompleteCompactionNotice(messageID string) (string, bool) {
	messageID = strings.TrimSpace(messageID)
	if n == nil || messageID == "" {
		return messageID, false
	}
	n.compactionMu.Lock()
	defer n.compactionMu.Unlock()
	if n.compactionMessageID == "" {
		n.compactionMessageID = messageID
	}
	if n.compactionTerminalStatus != "" {
		return n.compactionMessageID, false
	}
	n.compactionTerminalStatus = "completed"
	return n.compactionMessageID, true
}

// settlePendingCompactionEvents replaces a still-in-progress compaction banner
// in place (same messageId) when the turn ends without the compaction item
// completing.
func (n *acpTurnNormalizer) settlePendingCompactionEvents(
	session Session,
	turnID string,
	status string,
) []activityshared.Event {
	if n == nil {
		return nil
	}
	n.compactionMu.Lock()
	if n.compactionMessageID == "" || n.compactionTerminalStatus != "" {
		n.compactionMu.Unlock()
		return nil
	}
	messageID := n.compactionMessageID
	n.compactionTerminalStatus = status
	n.compactionMu.Unlock()
	return []activityshared.Event{appServerCompactionNoticeEvent(session, turnID, messageID, status)}
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

func (n *acpTurnNormalizer) SuppressAssistantOutput() {
	if n == nil {
		return
	}
	n.suppressAssistantOutput = true
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
	if n.suppressAssistantOutput {
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

// CurrentAssistantText returns the text of the assistant segment currently
// accumulating (the turn's most recent one). Exec uses it to inspect the
// trailing output when a turn ends right after an in-band error line. A
// finalized segment returns "": once Finish closed it out (as the
// auto-continue path does before retrying), its text must not leak into the
// next attempt's inspection — a continuation that streams no new assistant
// text would otherwise re-detect the previous attempt's error tail.
func (n *acpTurnNormalizer) CurrentAssistantText() string {
	if n == nil || n.assistantSegmentCompleted {
		return ""
	}
	return n.assistantContent.String()
}

// SeenToolCallCount returns how many distinct tool calls this turn has
// observed. Auto-continue uses it (with CurrentAssistantText) to decide
// whether the failed attempt made useful progress.
func (n *acpTurnNormalizer) SeenToolCallCount() int {
	if n == nil {
		return 0
	}
	return len(n.toolCallsSeen)
}

func (n *acpTurnNormalizer) ApplyAssistantFinalText(finalText string) {
	if n == nil {
		return
	}
	if n.suppressAssistantOutput {
		return
	}
	finalText = strings.TrimSpace(finalText)
	if finalText == "" {
		return
	}
	// Codex may close a streamed assistant segment before item/completed
	// redelivers the same answer with whitespace polish. Preserve the message id
	// for equivalent text so the replay updates one bubble instead of opening a
	// duplicate.
	if n.assistantSegmentCompleted && n.assistantMessageID != "" {
		previous := strings.TrimSpace(n.assistantContent.String())
		if previous == finalText {
			return
		}
		if assistantTextEquivalent(previous, finalText) {
			n.assistantContent.Reset()
			_, _ = n.assistantContent.WriteString(finalText)
			n.assistantSegmentCompleted = false
			return
		}
	}
	if n.assistantMessageID == "" || n.assistantSegmentCompleted {
		n.assistantMessageID = newID()
		n.assistantSegmentCompleted = false
	}
	n.assistantContent.Reset()
	_, _ = n.assistantContent.WriteString(finalText)
}

func assistantTextEquivalent(left, right string) bool {
	return normalizeAssistantCompareText(left) == normalizeAssistantCompareText(right)
}

func normalizeAssistantCompareText(text string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(text)), "")
}

// ApplyAssistantTurnFinalText uses turn/completed text only when no assistant
// segment has already completed. item/completed is authoritative once shown;
// the turn payload commonly replays the same answer with minor polish.
func (n *acpTurnNormalizer) ApplyAssistantTurnFinalText(finalText string) {
	if n == nil || n.assistantSegmentCompleted {
		return
	}
	n.ApplyAssistantFinalText(finalText)
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
	if n.suppressAssistantOutput {
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

func (n *acpTurnNormalizer) FailAssistantSnapshot(
	session Session,
	turnID string,
	text string,
	messageID string,
) []activityshared.Event {
	if n == nil || n.suppressAssistantOutput {
		return nil
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	messageID = strings.TrimSpace(messageID)
	if n.assistantMessageID == "" || (messageID != "" && n.assistantMessageID != messageID) {
		n.assistantMessageID = firstNonEmpty(messageID, newID())
	}
	n.assistantContent.Reset()
	_, _ = n.assistantContent.WriteString(text)
	n.assistantSegmentCompleted = false
	return n.Finish(session, turnID, messageStreamStateFailed)
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
	// A tool call still pending when its own turn reaches a normal terminal
	// state never received its own item/completed (for example codex silently
	// declining a spawnAgent call for a schema conflict, with no further
	// notification tied to that item id for the rest of the turn - confirmed
	// via exported session transcripts). It must not be reported as a
	// successful completion: that would paint a rejected/never-run tool call
	// as having succeeded. Close it out the same way an interrupted or failed
	// turn already does - as a failure - so the GUI can render a clear
	// failed/rejected state instead of an indefinite "running"/"queued" one.
	events = append(events, n.terminalToolCallEvents(session, turnID, messageStreamStateFailed, "turn_completed_without_call_result")...)
	// A turn that completed normally implies the compaction it ran finished;
	// no-op in the usual flow because item/completed already selected the
	// lifecycle terminal state.
	events = append(events, n.settlePendingCompactionEvents(session, turnID, "completed")...)
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
		return appendTurnFileChangesEvent(nil, []activityshared.Event{event}, event), true
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
	event, ok := n.StandardToolCallEvent(session, turnID, updateType, update)
	if !ok {
		return nil, false
	}
	events := n.Finish(session, turnID, messageStreamStateCompleted)
	events = append(events, event)
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

func (n *acpTurnNormalizer) finishTerminal(
	session Session,
	turnID string,
	streamState string,
	toolStatus string,
	reason string,
) []activityshared.Event {
	events := n.Finish(session, turnID, streamState)
	events = append(events, n.terminalToolCallEvents(session, turnID, toolStatus, reason)...)
	events = append(events, n.settlePendingCompactionEvents(session, turnID, toolStatus)...)
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
