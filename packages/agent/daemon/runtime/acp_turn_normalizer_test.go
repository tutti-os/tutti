package agentruntime

import (
	"strings"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

func TestFinalizeThinkingItemReplacesWordTokenStream(t *testing.T) {
	t.Parallel()

	session := testSession()
	normalizer := newACPTurnNormalizer()
	normalizer.SetThinkingPresentation("review-process")

	for _, chunk := range []string{"It", "looks", "like", "a", "bug"} {
		if events := normalizer.AppendThinkingChunk(session, "turn-1", chunk); len(events) != 0 {
			t.Fatalf("AppendThinkingChunk(%q) emitted %d events, want deferred review-process stream", chunk, len(events))
		}
	}

	events := normalizer.FinalizeThinkingItem(session, "turn-1", "It looks like a bug")
	if len(events) != 1 {
		t.Fatalf("FinalizeThinkingItem events = %d, want 1", len(events))
	}
	if got := events[0].Payload.Content; got != "It looks like a bug" {
		t.Fatalf("content = %q, want authoritative completed summary", got)
	}
	if got := events[0].Payload.Metadata["messageKind"]; got != "review-process" {
		t.Fatalf("messageKind = %#v, want review-process", got)
	}
	if events[0].Payload.Role != activityshared.MessageRole(RoleAssistantThinking) {
		t.Fatalf("role = %q, want assistant thinking role", events[0].Payload.Role)
	}
}

func TestAppendAssistantChunkIgnoresDuplicateSnapshotChunk(t *testing.T) {
	t.Parallel()

	session := testSession()
	normalizer := newACPTurnNormalizer()
	fullText := "Hello! How can I help you?"

	for _, chunk := range []string{"Hello", "! How can", " I help you?"} {
		events := normalizer.AppendAssistantChunk(session, "turn-1", chunk)
		if len(events) != 1 {
			t.Fatalf("AppendAssistantChunk(%q) events = %d, want 1", chunk, len(events))
		}
	}

	events := normalizer.AppendAssistantChunk(session, "turn-1", fullText)
	if len(events) != 1 {
		t.Fatalf("duplicate snapshot chunk events = %d, want 1", len(events))
	}
	if got := events[0].Payload.Content; got != fullText {
		t.Fatalf("content = %q, want single authoritative snapshot without duplication", got)
	}

	normalizer.ApplyAssistantFinalText(fullText)
	completed := normalizer.FinishCompleted(session, "turn-1")
	for _, event := range completed {
		if event.Type != EventMessage {
			continue
		}
		if got := event.Payload.Content; got != fullText {
			t.Fatalf("completed content = %q, want %q", got, fullText)
		}
	}
}

// TestApplyAssistantFinalTextIgnoresIdenticalReplayAfterCompletedSegment pins
// the Codex app-server double-report contract: the final assistant text
// arrives once via item/completed (agentMessage) and again inside the
// turn/completed payload. Re-applying the identical text after the segment
// completed must not open a second assistant message — a live minimax turn
// (exported session 8eecfc8c) rendered the same reply twice because of this.
func TestApplyAssistantFinalTextIgnoresIdenticalReplayAfterCompletedSegment(t *testing.T) {
	t.Parallel()

	session := testSession()
	normalizer := newACPTurnNormalizer()
	finalText := "你好！有什么我可以帮你的吗？"

	// item/completed(agentMessage) path finalizes the answer segment.
	normalizer.ApplyAssistantFinalText(finalText)
	first := normalizer.Finish(session, "turn-1", messageStreamStateCompleted)
	if got := len(activityMessagesWithRole(first, activityshared.MessageRoleAssistant)); got != 1 {
		t.Fatalf("item/completed assistant messages = %d, want 1", got)
	}

	// turn/completed replays the identical final text.
	normalizer.ApplyAssistantFinalText(finalText)
	completed := normalizer.FinishCompleted(session, "turn-1")
	if duplicates := activityMessagesWithRole(completed, activityshared.MessageRoleAssistant); len(duplicates) != 0 {
		t.Fatalf("turn/completed assistant messages = %#v, want none (identical final text already projected)", duplicates)
	}
}

// TestApplyAssistantFinalTextKeepsDistinctFollowUpSegment guards the other
// side of the contract: a genuinely different agentMessage after a completed
// segment (multi-answer turns) must still surface as its own message.
func TestApplyAssistantFinalTextKeepsDistinctFollowUpSegment(t *testing.T) {
	t.Parallel()

	session := testSession()
	normalizer := newACPTurnNormalizer()

	normalizer.ApplyAssistantFinalText("First answer.")
	if got := len(activityMessagesWithRole(normalizer.Finish(session, "turn-1", messageStreamStateCompleted), activityshared.MessageRoleAssistant)); got != 1 {
		t.Fatalf("first segment assistant messages = %d, want 1", got)
	}

	normalizer.ApplyAssistantFinalText("Second answer.")
	events := normalizer.FinishCompleted(session, "turn-1")
	messages := activityMessagesWithRole(events, activityshared.MessageRoleAssistant)
	if len(messages) != 1 || messages[0].Payload.Content != "Second answer." {
		t.Fatalf("follow-up assistant messages = %#v, want exactly one %q", messages, "Second answer.")
	}
}

func TestApplyAssistantFinalTextReplacesEditedSnapshot(t *testing.T) {
	t.Parallel()

	session := testSession()
	normalizer := newACPTurnNormalizer()
	streamed := "I was just saying hello. You can send the task over, such as changing code, investigating an issue, running a command, or organizing docs."
	finalText := "I was just saying hello. You can send me the task, such as changing code, investigating an issue, running a command, or organizing docs."

	events := normalizer.AppendAssistantChunk(session, "turn-1", streamed)
	if len(events) != 1 {
		t.Fatalf("stream events = %d, want 1", len(events))
	}

	normalizer.ApplyAssistantFinalText(finalText)
	completed := normalizer.FinishCompleted(session, "turn-1")
	for _, event := range completed {
		if event.Type != activityshared.EventMessageAppended {
			continue
		}
		if got := event.Payload.Content; got != finalText {
			t.Fatalf("completed content = %q, want final snapshot only", got)
		}
		return
	}
	t.Fatal("completed assistant message not emitted")
}

func TestAppendAssistantChunkReplacesCumulativeSnapshotChunk(t *testing.T) {
	t.Parallel()

	session := testSession()
	normalizer := newACPTurnNormalizer()
	_ = normalizer.AppendAssistantChunk(session, "turn-1", "Hello")

	events := normalizer.AppendAssistantChunk(session, "turn-1", "Hello world")
	if len(events) != 1 {
		t.Fatalf("cumulative snapshot chunk events = %d, want 1", len(events))
	}
	if got := events[0].Payload.Content; got != "Hello world" {
		t.Fatalf("content = %q, want cumulative snapshot replacement", got)
	}
}

// TestFinishCompletedFailsDanglingToolCall reproduces the sub-agent
// "permanently queued" bug: codex can send tool_call item/started for a
// spawnAgent-style delegation and then reject it out-of-band (a schema
// conflict resolved as plain model-visible text, confirmed via exported
// session transcripts), with no item/completed ever following for that call
// id. Before this fix, a turn that otherwise completed normally silently
// reported such a still-pending call as EventCallCompleted (a false
// success); the GUI has no way to tell that apart from a genuine result, so
// a rejected/never-run delegation rendered as stuck "running"/"queued"
// forever instead of failed. FinishCompleted must close it out as
// EventCallFailed, the same terminal shape an interrupted/failed turn
// already uses.
func TestFinishCompletedFailsDanglingToolCall(t *testing.T) {
	t.Parallel()

	session := testSession()
	normalizer := newACPTurnNormalizer()

	started, ok := normalizer.ToolCallEvents(session, "turn-1", map[string]any{
		"sessionUpdate": "tool_call",
		"toolCallId":    "call_rejected_spawn",
		"status":        "in_progress",
		"title":         "spawnAgent",
		"kind":          "execute",
	})
	if !ok {
		t.Fatalf("ToolCallEvents(started) ok = false")
	}
	var startedEvent *activityshared.Event
	for i := range started {
		if started[i].Type == EventCallStarted {
			startedEvent = &started[i]
		}
	}
	if startedEvent == nil {
		t.Fatalf("expected an EventCallStarted event, got %+v", started)
	}

	completed := normalizer.FinishCompleted(session, "turn-1")

	var callEvent *activityshared.Event
	for i := range completed {
		if completed[i].EventID == startedEvent.EventID {
			callEvent = &completed[i]
		}
	}
	if callEvent == nil {
		t.Fatalf("FinishCompleted did not emit any event for the dangling call %q: %+v", startedEvent.EventID, completed)
	}
	if callEvent.Type != EventCallFailed {
		t.Fatalf("dangling call event type = %q, want %q (a call with no item/completed must never be reported as a successful completion)", callEvent.Type, EventCallFailed)
	}
	if got := callEvent.Payload.Metadata["status"]; got != messageStreamStateFailed {
		t.Fatalf("dangling call payload status = %#v, want %q", got, messageStreamStateFailed)
	}
}

func TestAppendThinkingChunkStillStreamsWithoutReviewPresentation(t *testing.T) {
	t.Parallel()

	session := testSession()
	normalizer := newACPTurnNormalizer()
	events := normalizer.AppendThinkingChunk(session, "turn-1", "Need context.")
	if len(events) != 1 {
		t.Fatalf("AppendThinkingChunk events = %d, want 1", len(events))
	}
	if !strings.Contains(events[0].Payload.Content, "Need context.") {
		t.Fatalf("content = %q", events[0].Payload.Content)
	}
}
