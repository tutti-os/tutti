package agentruntime

import (
	"encoding/json"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
)

// ApplyStreamingThinkingSnapshot replaces the open thinking segment with a full
// snapshot (Claude SDK style) while keeping a stable message id so cancel and
// completed updates rewrite the same row instead of opening a duplicate.
func (n *acpTurnNormalizer) ApplyStreamingThinkingSnapshot(
	session Session,
	turnID string,
	text string,
	messageID string,
) []activityshared.Event {
	if n == nil || text == "" {
		return nil
	}
	if n.thinkingMessageID == "" || n.thinkingSegmentCompleted {
		n.thinkingMessageID = firstNonEmpty(strings.TrimSpace(messageID), newID())
		n.thinkingSegmentCompleted = false
	}
	operation := mergeTextSnapshot(&n.thinkingContent, text)
	if operation == nil {
		return nil
	}
	event := n.thinkingSnapshotEvent(session, turnID, messageStreamStateStreaming)
	attachTextLiveOperation(&event, operation, RoleAssistantThinking, "reasoning")
	return []activityshared.Event{event}
}

// CompleteThinkingSnapshot finalizes thinking from an authoritative full-text
// snapshot, preserving messageID when opening a brand-new segment.
func (n *acpTurnNormalizer) CompleteThinkingSnapshot(
	session Session,
	turnID string,
	text string,
	messageID string,
) []activityshared.Event {
	if n == nil {
		return nil
	}
	if text != "" {
		if n.thinkingMessageID == "" || n.thinkingSegmentCompleted {
			n.thinkingMessageID = firstNonEmpty(strings.TrimSpace(messageID), newID())
			n.thinkingSegmentCompleted = false
		}
		n.thinkingContent.Reset()
		_, _ = n.thinkingContent.WriteString(text)
	} else if !n.hasStreamingThinkingSegment() {
		return nil
	}
	return n.Finish(session, turnID, messageStreamStateCompleted)
}

// ApplyStreamingAssistantSnapshot replaces the open assistant segment with a
// full snapshot while keeping a stable message id for later completed/cancel
// settlement.
func (n *acpTurnNormalizer) ApplyStreamingAssistantSnapshot(
	session Session,
	turnID string,
	text string,
	messageID string,
) []activityshared.Event {
	if n == nil || text == "" {
		return nil
	}
	if n.suppressAssistantOutput {
		return nil
	}
	if n.assistantMessageID == "" || n.assistantSegmentCompleted {
		n.assistantMessageID = firstNonEmpty(strings.TrimSpace(messageID), newID())
		n.assistantSegmentCompleted = false
	}
	operation := mergeTextSnapshot(&n.assistantContent, text)
	if operation == nil {
		return nil
	}
	event := n.assistantSnapshotEvent(session, turnID, messageStreamStateStreaming)
	attachTextLiveOperation(&event, operation, RoleAssistant, "text")
	return []activityshared.Event{event}
}

// mergeTextSnapshot keeps cumulative provider snapshots semantic at the
// normalizer boundary. A monotonic snapshot becomes a suffix append; only the
// first snapshot or a real rewrite/backtrack carries the full replacement.
func mergeTextSnapshot(
	content *strings.Builder,
	next string,
) *liveprotocol.MessageContentOperation {
	if content == nil || next == "" {
		return nil
	}
	current := content.String()
	if next == current {
		return nil
	}
	content.Reset()
	_, _ = content.WriteString(next)
	if current != "" && strings.HasPrefix(next, current) {
		return &liveprotocol.MessageContentOperation{
			Operation: "append_text",
			Text:      strings.TrimPrefix(next, current),
		}
	}
	value, _ := json.Marshal(next)
	return &liveprotocol.MessageContentOperation{
		Operation: "set",
		Value:     value,
	}
}

// CompleteAssistantSnapshot finalizes assistant text from an authoritative
// snapshot. Empty content finalizes an already-open streaming segment; non-empty
// content reuses AppendAssistantSnapshot.
func (n *acpTurnNormalizer) CompleteAssistantSnapshot(
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
	if text == "" {
		if n.assistantMessageID == "" || n.assistantSegmentCompleted || n.assistantContent.Len() == 0 {
			return nil
		}
		return n.Finish(session, turnID, messageStreamStateCompleted)
	}
	return n.AppendAssistantSnapshot(session, turnID, text, messageID)
}
