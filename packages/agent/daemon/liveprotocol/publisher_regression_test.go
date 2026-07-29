package liveprotocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestPublisherInvalidControlDoesNotPoisonPendingOrSequence(t *testing.T) {
	t.Parallel()

	publisher, err := NewPublisher(PublisherConfig{
		StreamID: "stream-1", BindingID: "binding-1", Epoch: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := publisher.Publish(PublishInput{GoalChanged: &GoalChanged{}}); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("invalid control error = %v", err)
	}

	frames, err := publisher.Publish(PublishInput{
		StreamReady: &StreamReady{
			ProtocolRevision: ProtocolRevision,
			StreamID:         "stream-1",
			BindingID:        "binding-1",
		},
		Immediate: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 1 || len(frames[0].Deliveries) != 1 ||
		frames[0].Deliveries[0].Seq != 1 ||
		frames[0].Deliveries[0].Kind != DeliveryKindStreamReady {
		t.Fatalf("valid publish after rejected control = %#v", frames)
	}
}

func TestPublisherFlushFailureDoesNotPoisonPendingOrSequence(t *testing.T) {
	t.Parallel()

	publisher, err := NewPublisher(PublisherConfig{
		StreamID: "stream-1", BindingID: "binding-1", Epoch: 1,
		FrameMaxBytes: 512,
	})
	if err != nil {
		t.Fatal(err)
	}
	large := mustMessageDelta(t, "message-1", &MessageContentOperation{
		Operation: "set", Value: json.RawMessage(`"` + strings.Repeat("x", 1024) + `"`),
	})
	if _, err := publisher.Publish(PublishInput{Event: &large, Immediate: true}); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("large frame error = %v", err)
	}
	if publisher.nextSeq != 0 || len(publisher.pending) != 0 {
		t.Fatalf("failed flush left state: seq=%d pending=%d", publisher.nextSeq, len(publisher.pending))
	}

	small := mustMessageDelta(t, "message-2", &MessageContentOperation{
		Operation: "append_text", Text: "ok",
	})
	frames, err := publisher.Publish(PublishInput{Event: &small, Immediate: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 1 || frames[0].Deliveries[0].Seq != 1 {
		t.Fatalf("valid publish after failed flush = %#v", frames)
	}
}

func TestPublisherReturnedControlFrameDoesNotAliasInputOrReplay(t *testing.T) {
	t.Parallel()

	publisher, err := NewPublisher(PublisherConfig{
		StreamID: "stream-1", BindingID: "binding-1", Epoch: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	control := &GoalChanged{
		WorkspaceID: "workspace-1", AgentSessionID: "session-original", Revision: 1,
	}
	frames, err := publisher.Publish(PublishInput{GoalChanged: control, Immediate: true})
	if err != nil {
		t.Fatal(err)
	}
	control.AgentSessionID = "session-mutated-input"
	if got := frames[0].Deliveries[0].GoalChanged.AgentSessionID; got != "session-original" {
		t.Fatalf("published frame aliased input control: %q", got)
	}
	frames[0].Deliveries[0].GoalChanged.AgentSessionID = "session-mutated-frame"

	resume, err := publisher.Resume(ResumeRequest{Epoch: 1, AfterSeq: 0})
	if err != nil {
		t.Fatal(err)
	}
	if !resume.Hit || len(resume.Frames) != 1 ||
		len(resume.Frames[0].Deliveries) != 1 {
		t.Fatalf("resume = %#v", resume)
	}
	if got := resume.Frames[0].Deliveries[0].GoalChanged.AgentSessionID; got != "session-original" {
		t.Fatalf("replay aliased published frame: %q", got)
	}
}

func TestPublisherDoesNotCoalesceAppendWithOtherMutations(t *testing.T) {
	t.Parallel()

	publisher, err := NewPublisher(PublisherConfig{
		StreamID: "stream-1", BindingID: "binding-1", Epoch: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	first := mustMessageDelta(t, "message-1", &MessageContentOperation{
		Operation: "append_text", Text: "hello",
	})
	status := "completed"
	second, err := NewMessageDeltaEvent(MessageDeltaData{
		WorkspaceID:      "owner-workspace",
		AgentSessionID:   "owner-session",
		MessageID:        "message-1",
		TurnID:           "owner-turn",
		Role:             "assistant",
		Kind:             "text",
		OccurredAtUnixMS: 11,
		Content:          &MessageContentOperation{Operation: "append_text", Text: " world"},
		Status:           &status,
		PayloadSet: map[string]json.RawMessage{
			"result": json.RawMessage(`{"id":9007199254740993}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := publisher.Publish(PublishInput{Event: &first}); err != nil {
		t.Fatal(err)
	}
	if _, err := publisher.Publish(PublishInput{Event: &second}); err != nil {
		t.Fatal(err)
	}
	frame, err := publisher.Flush()
	if err != nil {
		t.Fatal(err)
	}
	if frame == nil || len(frame.Deliveries) != 2 {
		t.Fatalf("mutating append deliveries were coalesced: %#v", frame)
	}
}

func TestPublisherBoundsPureAppendCoalescingByInputCount(t *testing.T) {
	t.Parallel()

	publisher, err := NewPublisher(PublisherConfig{
		StreamID: "stream-1", BindingID: "binding-1", Epoch: 1,
		BatchDeliveries:  4,
		BatchTargetBytes: DefaultBatchTargetBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	var frames []Frame
	for index := 0; index < 4; index++ {
		event := mustMessageDelta(t, "message-1", &MessageContentOperation{
			Operation: "append_text", Text: "x",
		})
		published, err := publisher.Publish(PublishInput{Event: &event})
		if err != nil {
			t.Fatal(err)
		}
		frames = append(frames, published...)
	}
	if len(frames) != 1 || len(frames[0].Deliveries) != 1 {
		t.Fatalf("coalesced count did not force flush: %#v", frames)
	}
	_, data, ok := messageAppendFromRaw(frames[0].Deliveries[0].Event)
	if !ok || data.Content.Text != strings.Repeat("x", 4) {
		t.Fatalf("coalesced delivery = %#v", data)
	}
}

func TestPublisherCoalescesContiguousToolOutputAndPreservesByteOffset(t *testing.T) {
	t.Parallel()

	publisher, err := NewPublisher(PublisherConfig{
		StreamID: "stream-1", BindingID: "binding-1", Epoch: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	firstOffset := int64(len("你"))
	secondOffset := int64(len("你好"))
	for _, operation := range []*MessageToolOutputOperation{
		{Operation: "append_text", Text: "好", OffsetBytes: &firstOffset},
		{Operation: "append_text", Text: "\n", OffsetBytes: &secondOffset},
	} {
		event, err := NewMessageDeltaEvent(MessageDeltaData{
			WorkspaceID: "owner-workspace", AgentSessionID: "owner-session",
			MessageID: "tool-1", TurnID: "owner-turn", Role: "assistant",
			Kind: "tool_call", OccurredAtUnixMS: 10, ToolOutput: operation,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := publisher.Publish(PublishInput{Event: &event}); err != nil {
			t.Fatal(err)
		}
	}
	frame, err := publisher.Flush()
	if err != nil {
		t.Fatal(err)
	}
	if frame == nil || len(frame.Deliveries) != 1 {
		t.Fatalf("frame = %#v", frame)
	}
	_, data, ok := messageAppendFromRaw(frame.Deliveries[0].Event)
	if !ok || data.ToolOutput == nil ||
		data.ToolOutput.Text != "好\n" ||
		data.ToolOutput.OffsetBytes == nil ||
		*data.ToolOutput.OffsetBytes != firstOffset {
		t.Fatalf("coalesced tool output = %#v", data.ToolOutput)
	}
}

func TestPublisherDoesNotCoalesceDiscontinuousToolOutput(t *testing.T) {
	t.Parallel()

	publisher, err := NewPublisher(PublisherConfig{
		StreamID: "stream-1", BindingID: "binding-1", Epoch: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, offset := range []int64{0, 99} {
		offset := offset
		event, eventErr := NewMessageDeltaEvent(MessageDeltaData{
			WorkspaceID: "owner-workspace", AgentSessionID: "owner-session",
			MessageID: "tool-1", TurnID: "owner-turn", Role: "assistant",
			Kind: "tool_call", OccurredAtUnixMS: 10,
			ToolOutput: &MessageToolOutputOperation{
				Operation: "append_text", Text: "x", OffsetBytes: &offset,
			},
		})
		if eventErr != nil {
			t.Fatal(eventErr)
		}
		if _, eventErr = publisher.Publish(PublishInput{Event: &event}); eventErr != nil {
			t.Fatal(eventErr)
		}
	}
	frame, err := publisher.Flush()
	if err != nil {
		t.Fatal(err)
	}
	if frame == nil || len(frame.Deliveries) != 2 {
		t.Fatalf("discontinuous tool output coalesced: %#v", frame)
	}
}

func TestPublisherClearsPrunedReplayBackingEntries(t *testing.T) {
	t.Parallel()

	now := time.Unix(100, 0)
	publisher, err := NewPublisher(PublisherConfig{
		StreamID: "stream-1", BindingID: "binding-1", Epoch: 1,
		ReplayTTL: time.Second,
		Now:       func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	event := mustMessageDelta(t, "message-1", &MessageContentOperation{
		Operation: "set", Value: json.RawMessage(`"` + strings.Repeat("x", 4096) + `"`),
	})
	if _, err := publisher.Publish(PublishInput{Event: &event, Immediate: true}); err != nil {
		t.Fatal(err)
	}
	if len(publisher.replay) != 1 {
		t.Fatalf("replay entries = %d", len(publisher.replay))
	}
	backing := publisher.replay[:cap(publisher.replay)]

	now = now.Add(2 * time.Second)
	result, err := publisher.Resume(ResumeRequest{Epoch: 1, AfterSeq: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Hit || len(publisher.replay) != 0 {
		t.Fatalf("expired replay was not pruned: result=%#v entries=%d", result, len(publisher.replay))
	}
	if backing[0].delivery.Event != nil {
		t.Fatalf("pruned replay backing entry retained %d payload bytes", len(backing[0].delivery.Event))
	}
}

func TestPublisherAllowsCommittedInteractionAndDuplicateTerminalAfterFence(t *testing.T) {
	t.Parallel()

	publisher, err := NewPublisher(PublisherConfig{
		StreamID: "stream-1", BindingID: "binding-1", Epoch: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	terminal := mustTerminalTurnUpdate(t)
	if _, err := publisher.Publish(PublishInput{Event: &terminal}); err != nil {
		t.Fatal(err)
	}

	duplicateFrames, err := publisher.Publish(PublishInput{Event: &terminal})
	if err != nil {
		t.Fatal(err)
	}
	if len(duplicateFrames) != 1 ||
		duplicateFrames[0].Deliveries[0].Kind != DeliveryKindEvent {
		t.Fatalf("duplicate committed terminal was rejected: %#v", duplicateFrames)
	}

	interaction, err := NewInteractionUpdateEvent(InteractionUpdateData{
		WorkspaceID:      "owner-workspace",
		AgentSessionID:   "owner-session",
		EventType:        EventTypeInteractionUpdate,
		OccurredAtUnixMS: 21,
		Interaction: EventInteraction{
			RequestID:       "request-1",
			AgentSessionID:  "owner-session",
			TurnID:          "owner-turn",
			Kind:            "approval",
			Status:          "answered",
			Input:           json.RawMessage(`null`),
			Output:          json.RawMessage(`{"approved":true}`),
			Metadata:        json.RawMessage(`null`),
			CreatedAtUnixMS: 11,
			UpdatedAtUnixMS: 21,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	interactionFrames, err := publisher.Publish(PublishInput{Event: &interaction, Immediate: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(interactionFrames) != 1 ||
		interactionFrames[0].Deliveries[0].Kind != DeliveryKindEvent {
		t.Fatalf("committed interaction was rejected after terminal: %#v", interactionFrames)
	}

	late := mustMessageDelta(t, "message-1", &MessageContentOperation{
		Operation: "append_text", Text: "late",
	})
	lateFrames, err := publisher.Publish(PublishInput{Event: &late})
	if err != nil {
		t.Fatal(err)
	}
	if len(lateFrames) != 1 ||
		lateFrames[0].Deliveries[0].Kind != DeliveryKindDiscontinuity ||
		lateFrames[0].Deliveries[0].Discontinuity.Reason != "late_after_terminal" {
		t.Fatalf("late message was not fenced: %#v", lateFrames)
	}
}

func TestPublisherBoundsSettledTurnFences(t *testing.T) {
	t.Parallel()

	publisher, err := NewPublisher(PublisherConfig{
		StreamID: "stream-1", BindingID: "binding-1", Epoch: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < settledTurnRetention+1; index++ {
		turnID := fmt.Sprintf("turn-%d", index)
		outcome := "completed"
		settledAt := int64(index + 1)
		event, eventErr := NewTurnUpdateEvent(TurnUpdateData{
			WorkspaceID:      "owner-workspace",
			AgentSessionID:   "owner-session",
			EventType:        EventTypeTurnUpdate,
			OccurredAtUnixMS: int64(index + 1),
			Turn: EventTurn{
				TurnID:          turnID,
				AgentSessionID:  "owner-session",
				Phase:           "settled",
				Origin:          "user_prompt",
				Outcome:         &outcome,
				StartedAtUnixMS: 1,
				UpdatedAtUnixMS: int64(index + 1),
				SettledAtUnixMS: &settledAt,
				FileChanges:     json.RawMessage(`null`),
			},
		})
		if eventErr != nil {
			t.Fatal(eventErr)
		}
		if _, eventErr = publisher.Publish(PublishInput{Event: &event}); eventErr != nil {
			t.Fatal(eventErr)
		}
	}
	if len(publisher.settledTurns) != settledTurnRetention ||
		len(publisher.settledTurnOrder) != settledTurnRetention {
		t.Fatalf(
			"settled fences = map:%d order:%d, want %d",
			len(publisher.settledTurns),
			len(publisher.settledTurnOrder),
			settledTurnRetention,
		)
	}
	if _, retained := publisher.settledTurns["turn-0"]; retained {
		t.Fatal("oldest settled turn fence was not evicted")
	}
	if _, retained := publisher.settledTurns[fmt.Sprintf("turn-%d", settledTurnRetention)]; !retained {
		t.Fatal("newest settled turn fence was not retained")
	}
}
