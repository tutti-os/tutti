package agentruntime

import (
	"encoding/json"
	"sort"
	"strings"
	"sync"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
)

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
	toolOutputText            map[string]string
	toolOutputTruncated       map[string]bool
	earlyToolOutput           map[string]earlyToolOutputSnapshot
	earlyToolOutputBytes      int
	fileChanges               map[string]any
	authoritativeFileChanges  map[string]struct{}
	compactionMu              sync.Mutex
	compactionMessageID       string
	compactionTerminalStatus  string
	suppressAssistantOutput   bool
	systemNoticeOutputSeen    bool
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

func (n *acpTurnNormalizer) HasCompactionNotice() bool {
	if n == nil {
		return false
	}
	n.compactionMu.Lock()
	defer n.compactionMu.Unlock()
	return n.compactionMessageID != ""
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
		toolItemIDs:              make(map[string]string),
		toolCallsSeen:            make(map[string]bool),
		pendingToolCalls:         make(map[string]pendingToolCallSnapshot),
		toolOutputText:           make(map[string]string),
		toolOutputTruncated:      make(map[string]bool),
		earlyToolOutput:          make(map[string]earlyToolOutputSnapshot),
		authoritativeFileChanges: make(map[string]struct{}),
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
	liveOperation := n.mergeAssistantText(chunk)
	if liveOperation == nil {
		// Duplicate and backtracking provider snapshots do not change the
		// normalized message. Suppress them here so they cannot fall through
		// the stream projection as full precommit message_update snapshots.
		return nil
	}
	event := n.assistantSnapshotEvent(session, turnID, messageStreamStateStreaming)
	attachTextLiveOperation(&event, liveOperation, RoleAssistant, "text")
	return []activityshared.Event{event}
}

func (n *acpTurnNormalizer) AppendThinkingChunk(session Session, turnID string, chunk string) []activityshared.Event {
	if n == nil || chunk == "" {
		return nil
	}
	firstChunk := n.thinkingMessageID == "" || n.thinkingSegmentCompleted
	if firstChunk {
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
	event := n.thinkingSnapshotEvent(session, turnID, messageStreamStateStreaming)
	operation := &liveprotocol.MessageContentOperation{Operation: "append_text", Text: chunk}
	if firstChunk {
		value, _ := json.Marshal(chunk)
		operation = &liveprotocol.MessageContentOperation{Operation: "set", Value: value}
	}
	attachTextLiveOperation(&event, operation, RoleAssistantThinking, "reasoning")
	return []activityshared.Event{event}
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

// HasObservableOutput reports whether the current provider turn produced
// anything the user can observe. Thinking and system notices are valid
// assistant output even when the provider emits no final assistant text.
func (n *acpTurnNormalizer) HasObservableOutput() bool {
	if n == nil {
		return false
	}
	return strings.TrimSpace(n.CurrentAssistantText()) != "" ||
		(!n.thinkingSegmentCompleted && strings.TrimSpace(n.thinkingContent.String()) != "") ||
		n.SeenToolCallCount() > 0 ||
		n.systemNoticeOutputSeen
}

func (n *acpTurnNormalizer) MarkSystemNoticeOutput() {
	if n == nil {
		return
	}
	n.systemNoticeOutputSeen = true
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

func (n *acpTurnNormalizer) mergeAssistantText(next string) *liveprotocol.MessageContentOperation {
	if n == nil || next == "" {
		return nil
	}
	current := n.assistantContent.String()
	trimmedCurrent := strings.TrimSpace(current)
	trimmedNext := strings.TrimSpace(next)
	switch {
	case current == "":
		_, _ = n.assistantContent.WriteString(next)
		value, _ := json.Marshal(next)
		return &liveprotocol.MessageContentOperation{Operation: "set", Value: value}
	case next == current || trimmedNext == trimmedCurrent:
		return nil
	case strings.HasPrefix(next, current):
		suffix := strings.TrimPrefix(next, current)
		n.assistantContent.Reset()
		_, _ = n.assistantContent.WriteString(next)
		return &liveprotocol.MessageContentOperation{Operation: "append_text", Text: suffix}
	case strings.HasPrefix(trimmedNext, trimmedCurrent):
		n.assistantContent.Reset()
		_, _ = n.assistantContent.WriteString(next)
		value, _ := json.Marshal(next)
		return &liveprotocol.MessageContentOperation{Operation: "set", Value: value}
	case strings.HasPrefix(current, next) || strings.HasPrefix(trimmedCurrent, trimmedNext):
		return nil
	default:
		_, _ = n.assistantContent.WriteString(next)
		return &liveprotocol.MessageContentOperation{Operation: "append_text", Text: next}
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
	event := newTurnActivityEventWithID(session, n.assistantMessageID, EventMessage, turnID, status, RoleAssistant, n.assistantContent.String(), map[string]any{
		"messageId":   n.assistantMessageID,
		"contentMode": messageContentModeSnapshot,
		"streamState": status,
	})
	return event
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
	event := newTurnActivityEventWithID(session, n.thinkingMessageID, EventMessage, turnID, status, RoleAssistantThinking, n.thinkingContent.String(), metadata)
	return event
}

const (
	liveContentOperationMetadataKey    = "_tuttiLiveContentOperation"
	liveToolOutputOperationMetadataKey = "_tuttiLiveToolOutputOperation"
	// liveToolProgressMetadataKey marks Claude tool_updated call.started
	// events that stream input/progress onto an already-open tool call. Those
	// must still project durable message updates, but must not mint another
	// tool.started checkpoint (no matching commit → checkpoint_commit_unconfirmed).
	liveToolProgressMetadataKey = "_tuttiLiveToolProgress"
	liveMessageRoleMetadataKey  = "_tuttiLiveMessageRole"
	liveMessageKindMetadataKey  = "_tuttiLiveMessageKind"
)

func attachTextLiveOperation(
	event *activityshared.Event,
	operation *liveprotocol.MessageContentOperation,
	role string,
	kind string,
) {
	if event == nil || operation == nil {
		return
	}
	if event.Payload.Metadata == nil {
		event.Payload.Metadata = map[string]any{}
	}
	event.Payload.Metadata[liveContentOperationMetadataKey] = operation
	event.Payload.Metadata[liveMessageRoleMetadataKey] = role
	event.Payload.Metadata[liveMessageKindMetadataKey] = kind
}

func attachToolOutputLiveOperation(
	event *activityshared.Event,
	operation *liveprotocol.MessageToolOutputOperation,
) {
	if event == nil || operation == nil {
		return
	}
	if event.Payload.Metadata == nil {
		event.Payload.Metadata = map[string]any{}
	}
	event.Payload.Metadata[liveToolOutputOperationMetadataKey] = operation
	event.Payload.Metadata[liveMessageRoleMetadataKey] = RoleAssistant
	event.Payload.Metadata[liveMessageKindMetadataKey] = "tool_call"
}
