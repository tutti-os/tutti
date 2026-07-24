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
	n.thinkingContent.Reset()
	_, _ = n.thinkingContent.WriteString(text)
	event := n.thinkingSnapshotEvent(session, turnID, messageStreamStateStreaming)
	value, _ := json.Marshal(text)
	attachTextLiveOperation(&event, &liveprotocol.MessageContentOperation{Operation: "set", Value: value}, RoleAssistantThinking, "reasoning")
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
	n.assistantContent.Reset()
	_, _ = n.assistantContent.WriteString(text)
	event := n.assistantSnapshotEvent(session, turnID, messageStreamStateStreaming)
	value, _ := json.Marshal(text)
	attachTextLiveOperation(&event, &liveprotocol.MessageContentOperation{Operation: "set", Value: value}, RoleAssistant, "text")
	return []activityshared.Event{event}
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
