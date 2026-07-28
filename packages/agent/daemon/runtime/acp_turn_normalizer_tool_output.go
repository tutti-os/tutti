package agentruntime

import (
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
)

type earlyToolOutputSnapshot struct {
	turnID  string
	text    string
	dropped bool
}

const maxEarlyToolOutputCalls = 64

// AppendToolOutputDelta projects an explicit provider-ordered tool output
// chunk onto the stable tool_call message created by the corresponding start
// event. Some providers can deliver the first output notification immediately
// before item/started. That prefix is buffered, within one live-delivery frame,
// and emitted only after the real anchor arrives; an anchor is never invented.
// The cumulative snapshot remains on the activity event for local persistence
// while only the semantic operation is attached to the live fast lane. Callers
// must not feed inferred or arbitrary structured payloads into this method.
func (n *acpTurnNormalizer) AppendToolOutputDelta(
	session Session,
	turnID string,
	rawToolCallID string,
	delta string,
) []activityshared.Event {
	if n == nil || delta == "" {
		return nil
	}
	eventID := n.knownToolItemID(rawToolCallID)
	pending, ok := n.pendingToolCalls[eventID]
	if !ok || strings.TrimSpace(eventID) == "" {
		n.bufferEarlyToolOutput(turnID, rawToolCallID, delta)
		return nil
	}
	current := n.toolOutputText[eventID]
	next := current + delta
	payload := clonePayload(pending.payload)
	if payload == nil {
		payload = map[string]any{}
	}
	output := payloadMap(payload, "output")
	output = clonePayload(output)
	if output == nil {
		output = map[string]any{}
	}
	output["text"] = next
	payload["output"] = output
	payload["status"] = string(activityshared.ActivityStatusRunning)

	operation := &liveprotocol.MessageToolOutputOperation{
		Operation: "set",
		Text:      next,
	}
	if current != "" {
		offset := int64(len(current))
		operation = &liveprotocol.MessageToolOutputOperation{
			Operation:   "append_text",
			Text:        delta,
			OffsetBytes: &offset,
		}
	}
	event := newTurnActivityEventWithID(
		session,
		eventID,
		EventCallStarted,
		turnID,
		messageStreamStateStreaming,
		"",
		stringFromPayload(payload, "name"),
		payload,
	)
	attachToolOutputLiveOperation(&event, operation)
	n.toolOutputText[eventID] = next
	n.trackToolCallEvent(event)
	return []activityshared.Event{event}
}

func (n *acpTurnNormalizer) bufferEarlyToolOutput(turnID string, rawToolCallID string, delta string) {
	if n == nil || delta == "" {
		return
	}
	turnID = strings.TrimSpace(turnID)
	rawToolCallID = strings.TrimSpace(rawToolCallID)
	if turnID == "" || rawToolCallID == "" {
		return
	}
	current, exists := n.earlyToolOutput[rawToolCallID]
	if !exists && len(n.earlyToolOutput) >= maxEarlyToolOutputCalls {
		slog.Warn(
			"agent tool output arrived before too many unresolved anchors",
			"event", "agent_session.tool_output.pre_anchor_dropped",
			"reason", "call_limit",
			"limit", maxEarlyToolOutputCalls,
		)
		return
	}
	if exists && current.turnID != turnID {
		n.earlyToolOutputBytes -= len(current.text)
		current = earlyToolOutputSnapshot{turnID: turnID}
	}
	if current.dropped {
		return
	}
	if n.earlyToolOutputBytes+len(delta) > liveprotocol.DefaultDeliveryMaxBytes {
		n.earlyToolOutputBytes -= len(current.text)
		current.text = ""
		current.dropped = true
		n.earlyToolOutput[rawToolCallID] = current
		slog.Warn(
			"agent tool output before its anchor exceeded the live delivery limit",
			"event", "agent_session.tool_output.pre_anchor_dropped",
			"reason", "byte_limit",
			"limit_bytes", liveprotocol.DefaultDeliveryMaxBytes,
		)
		return
	}
	current.turnID = turnID
	current.text += delta
	n.earlyToolOutputBytes += len(delta)
	n.earlyToolOutput[rawToolCallID] = current
}

func (n *acpTurnNormalizer) consumeEarlyToolOutput(
	session Session,
	turnID string,
	rawToolCallID string,
) []activityshared.Event {
	if n == nil {
		return nil
	}
	rawToolCallID = strings.TrimSpace(rawToolCallID)
	pending, ok := n.earlyToolOutput[rawToolCallID]
	if !ok {
		return nil
	}
	delete(n.earlyToolOutput, rawToolCallID)
	n.earlyToolOutputBytes -= len(pending.text)
	if pending.dropped || pending.turnID != strings.TrimSpace(turnID) || pending.text == "" {
		return nil
	}
	return n.AppendToolOutputDelta(session, turnID, rawToolCallID, pending.text)
}
