package liveprotocol

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestFrameRoundTripCarriesReadyAndGoalControls(t *testing.T) {
	t.Parallel()
	frame := Frame{
		ProtocolRevision: ProtocolRevision,
		StreamID:         "stream-1",
		BindingID:        "binding-1",
		Epoch:            7,
		Deliveries: []Delivery{
			{
				Seq:  1,
				Kind: DeliveryKindStreamReady,
				StreamReady: &StreamReady{
					ProtocolRevision: ProtocolRevision,
					StreamID:         "stream-1",
					BindingID:        "binding-1",
				},
			},
			{
				Seq:  2,
				Kind: DeliveryKindGoalChanged,
				GoalChanged: &GoalChanged{
					WorkspaceID:    "workspace-1",
					AgentSessionID: "session-1",
					Revision:       3,
				},
			},
		},
	}
	encoded, err := EncodeFrame(frame)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeFrame(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Epoch != 7 || decoded.Deliveries[0].StreamReady.BindingID != "binding-1" ||
		decoded.Deliveries[1].GoalChanged.Revision != 3 {
		t.Fatalf("decoded frame = %#v", decoded)
	}
}

func TestTypedRevisionRejectionDecodesAcrossRevisionMismatch(t *testing.T) {
	t.Parallel()
	frame := Frame{
		ProtocolRevision: "sha256:older",
		StreamID:         "stream-1",
		BindingID:        "binding-1",
		Epoch:            1,
		Deliveries: []Delivery{{
			Seq:  1,
			Kind: DeliveryKindRejected,
			Rejected: &Rejected{
				Reason:           RejectionProtocolRevisionMismatch,
				ExpectedRevision: ProtocolRevision,
				ReceivedRevision: "sha256:older",
			},
		}},
	}
	encoded, err := EncodeFrame(frame)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeFrame(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Deliveries[0].Rejected.Reason != RejectionProtocolRevisionMismatch {
		t.Fatalf("decoded rejection = %#v", decoded)
	}
}

func TestDecodeEventRejectsDuplicateAndUnknownFields(t *testing.T) {
	t.Parallel()
	duplicate := []byte(`{"workspaceId":"w","workspaceId":"w2","agentSessionId":"s","eventType":"message_delta","data":{}}`)
	if _, err := DecodeEvent(duplicate); !errors.Is(err, ErrInvalidLiveEvent) {
		t.Fatalf("duplicate error = %v", err)
	}
	event := mustMessageDelta(t, "message-1", &MessageContentOperation{
		Operation: "set",
		Value:     json.RawMessage(`"hello"`),
	})
	raw, err := MarshalEvent(event)
	if err != nil {
		t.Fatal(err)
	}
	raw = []byte(strings.Replace(string(raw), `"eventType"`, `"unknown":true,"eventType"`, 1))
	if _, err := DecodeEvent(raw); !errors.Is(err, ErrInvalidLiveEvent) {
		t.Fatalf("unknown-field error = %v", err)
	}
}

func TestPublisherCoalescesAdjacentAppendAndReplays(t *testing.T) {
	t.Parallel()
	now := time.Unix(100, 0)
	publisher, err := NewPublisher(PublisherConfig{
		StreamID:  "stream-1",
		BindingID: "binding-1",
		Epoch:     2,
		Now:       func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	set := mustMessageDelta(t, "message-1", &MessageContentOperation{
		Operation: "set",
		Value:     json.RawMessage(`"H"`),
	})
	if frames, err := publisher.Publish(PublishInput{Event: &set}); err != nil || len(frames) != 0 {
		t.Fatalf("set frames=%#v err=%v", frames, err)
	}
	for _, text := range []string{"el", "lo"} {
		appendEvent := mustMessageDelta(t, "message-1", &MessageContentOperation{
			Operation: "append_text",
			Text:      text,
		})
		if frames, err := publisher.Publish(PublishInput{Event: &appendEvent}); err != nil || len(frames) != 0 {
			t.Fatalf("append frames=%#v err=%v", frames, err)
		}
	}
	frame, err := publisher.Flush()
	if err != nil {
		t.Fatal(err)
	}
	if frame == nil || len(frame.Deliveries) != 2 {
		t.Fatalf("frame = %#v, want set + coalesced append", frame)
	}
	_, appended, ok := messageAppendFromRaw(frame.Deliveries[1].Event)
	if !ok || appended.Content.Text != "ello" {
		t.Fatalf("coalesced append = %#v", appended)
	}
	resume := publisher.Resume(ResumeRequest{Epoch: 2, AfterSeq: 1})
	if !resume.Hit || len(resume.Deliveries) != 1 || resume.Deliveries[0].Seq != 2 {
		t.Fatalf("resume = %#v", resume)
	}
}

func TestSubscriberDetectsGapWithoutAcceptingLaterDelivery(t *testing.T) {
	t.Parallel()
	subscriber, err := NewSubscriber(SubscriberConfig{})
	if err != nil {
		t.Fatal(err)
	}
	event := mustMessageDelta(t, "message-1", &MessageContentOperation{
		Operation: "set",
		Value:     json.RawMessage(`"hello"`),
	})
	raw, _ := MarshalEvent(event)
	result := subscriber.Apply(Frame{
		ProtocolRevision: ProtocolRevision,
		StreamID:         "stream-1",
		BindingID:        "binding-1",
		Epoch:            1,
		Deliveries: []Delivery{{
			Seq:   2,
			Kind:  DeliveryKindEvent,
			Event: raw,
		}},
	})
	if !result.ReconcileRequired || result.Reason != "sequence_gap" || len(result.Accepted) != 0 {
		t.Fatalf("apply = %#v", result)
	}
}

func TestSubscriberDropsDuplicateDelivery(t *testing.T) {
	t.Parallel()
	subscriber, err := NewSubscriber(SubscriberConfig{})
	if err != nil {
		t.Fatal(err)
	}
	event := mustMessageDelta(t, "message-1", &MessageContentOperation{
		Operation: "set",
		Value:     json.RawMessage(`"hello"`),
	})
	raw, _ := MarshalEvent(event)
	frame := Frame{
		ProtocolRevision: ProtocolRevision,
		StreamID:         "stream-1",
		BindingID:        "binding-1",
		Epoch:            1,
		Deliveries:       []Delivery{{Seq: 1, Kind: DeliveryKindEvent, Event: raw}},
	}
	if result := subscriber.Apply(frame); len(result.Accepted) != 1 {
		t.Fatalf("first apply = %#v", result)
	}
	if result := subscriber.Apply(frame); result.DuplicateCount != 1 || len(result.Accepted) != 0 {
		t.Fatalf("duplicate apply = %#v", result)
	}
}

func TestPublisherReplacesOversizeEventWithScopedDiscontinuity(t *testing.T) {
	t.Parallel()
	publisher, err := NewPublisher(PublisherConfig{
		StreamID:         "stream-1",
		BindingID:        "binding-1",
		Epoch:            1,
		DeliveryMaxBytes: 256,
	})
	if err != nil {
		t.Fatal(err)
	}
	event := mustMessageDelta(t, "message-large", &MessageContentOperation{
		Operation: "set",
		Value:     json.RawMessage(`"` + strings.Repeat("x", 1024) + `"`),
	})
	frames, err := publisher.Publish(PublishInput{Event: &event})
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 1 || len(frames[0].Deliveries) != 1 {
		t.Fatalf("frames = %#v", frames)
	}
	delivery := frames[0].Deliveries[0]
	if delivery.Seq != 1 || delivery.Kind != DeliveryKindDiscontinuity ||
		delivery.Discontinuity.Reason != "delivery_too_large" ||
		len(delivery.Discontinuity.ReconcileKeys) != 1 ||
		delivery.Discontinuity.ReconcileKeys[0].MessageID != "message-large" {
		t.Fatalf("oversize delivery = %#v", delivery)
	}
}

func TestPublisherTerminalFenceFlushesAndRejectsLateTurnContent(t *testing.T) {
	t.Parallel()
	publisher, err := NewPublisher(PublisherConfig{
		StreamID:  "stream-1",
		BindingID: "binding-1",
		Epoch:     1,
	})
	if err != nil {
		t.Fatal(err)
	}
	message := mustMessageDelta(t, "message-1", &MessageContentOperation{
		Operation: "set",
		Value:     json.RawMessage(`"hello"`),
	})
	if frames, err := publisher.Publish(PublishInput{Event: &message}); err != nil || len(frames) != 0 {
		t.Fatalf("message frames=%#v err=%v", frames, err)
	}
	terminal := mustTerminalTurnUpdate(t)
	frames, err := publisher.Publish(PublishInput{Event: &terminal})
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 1 || len(frames[0].Deliveries) != 2 ||
		frames[0].Deliveries[1].Seq != 2 {
		t.Fatalf("terminal frame = %#v", frames)
	}
	late := mustMessageDelta(t, "message-1", &MessageContentOperation{
		Operation: "append_text",
		Text:      " too late",
	})
	frames, err = publisher.Publish(PublishInput{Event: &late})
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 1 || frames[0].Deliveries[0].Seq != 3 ||
		frames[0].Deliveries[0].Kind != DeliveryKindDiscontinuity ||
		frames[0].Deliveries[0].Discontinuity.Reason != "late_after_terminal" {
		t.Fatalf("late frame = %#v", frames)
	}
}

func TestRecipientProjectorPreservesNestedBusinessIdentity(t *testing.T) {
	t.Parallel()
	value := json.RawMessage(`{"workspaceId":"owner-workspace","agentSessionId":"owner-session","turnId":"owner-turn","path":"/same/sandbox/file"}`)
	event := mustMessageDelta(t, "message-1", &MessageContentOperation{
		Operation: "set",
		Value:     value,
	})
	projector, err := NewRecipientProjector(ProjectionContext{
		OwnerWorkspaceID:        "owner-workspace",
		OwnerAgentSessionID:     "owner-session",
		CanonicalTurnID:         "owner-turn",
		RecipientWorkspaceID:    "caller-workspace",
		RecipientAgentSessionID: "caller-session",
		CallerTurnID:            "caller-turn",
	})
	if err != nil {
		t.Fatal(err)
	}
	projected, err := projector.Project(event)
	if err != nil {
		t.Fatal(err)
	}
	var data MessageDeltaData
	if err := json.Unmarshal(projected.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.WorkspaceID != "caller-workspace" || data.AgentSessionID != "caller-session" || data.TurnID != "caller-turn" {
		t.Fatalf("projected identity = %#v", data)
	}
	var business map[string]any
	if err := json.Unmarshal(data.Content.Value, &business); err != nil {
		t.Fatal(err)
	}
	if business["workspaceId"] != "owner-workspace" || business["agentSessionId"] != "owner-session" ||
		business["turnId"] != "owner-turn" || business["path"] != "/same/sandbox/file" {
		t.Fatalf("business payload was rewritten: %#v", business)
	}
}

func mustMessageDelta(t *testing.T, messageID string, operation *MessageContentOperation) Event {
	t.Helper()
	event, err := NewMessageDeltaEvent(MessageDeltaData{
		WorkspaceID:      "owner-workspace",
		AgentSessionID:   "owner-session",
		MessageID:        messageID,
		TurnID:           "owner-turn",
		Role:             "assistant",
		Kind:             "text",
		OccurredAtUnixMS: 10,
		Content:          operation,
	})
	if err != nil {
		t.Fatal(err)
	}
	return event
}

func mustTerminalTurnUpdate(t *testing.T) Event {
	t.Helper()
	activeTurnID := "owner-turn"
	outcome := "completed"
	settledAt := int64(20)
	data := TurnUpdateData{
		WorkspaceID:      "owner-workspace",
		AgentSessionID:   "owner-session",
		EventType:        EventTypeTurnUpdate,
		OccurredAtUnixMS: 20,
		ActiveTurnID:     &activeTurnID,
		Turn: EventTurn{
			TurnID:          "owner-turn",
			AgentSessionID:  "owner-session",
			Phase:           "settled",
			Origin:          "user_prompt",
			Outcome:         &outcome,
			FileChanges:     json.RawMessage(`null`),
			StartedAtUnixMS: 10,
			SettledAtUnixMS: &settledAt,
			UpdatedAtUnixMS: 20,
		},
	}
	raw, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	event := Event{
		WorkspaceID:    "owner-workspace",
		AgentSessionID: "owner-session",
		EventType:      EventTypeTurnUpdate,
		Data:           raw,
	}
	if _, err := MarshalEvent(event); err != nil {
		t.Fatal(err)
	}
	return event
}
