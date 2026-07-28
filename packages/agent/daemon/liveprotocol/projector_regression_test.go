package liveprotocol

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestRecipientProjectorPreservesOpaqueJSONNumbers(t *testing.T) {
	t.Parallel()

	event, err := NewMessageDeltaEvent(MessageDeltaData{
		WorkspaceID:      "owner-workspace",
		AgentSessionID:   "owner-session",
		MessageID:        "message-1",
		TurnID:           "owner-turn",
		Role:             "assistant",
		Kind:             "tool",
		OccurredAtUnixMS: 10,
		Content: &MessageContentOperation{
			Operation: "set",
			Value:     json.RawMessage(`{"integer":9007199254740993,"nested":[18446744073709551615]}`),
		},
		PayloadSet: map[string]json.RawMessage{
			"opaque": json.RawMessage(`{"revision":9007199254740995}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
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
	if !bytes.Contains(data.Content.Value, []byte(`9007199254740993`)) ||
		!bytes.Contains(data.Content.Value, []byte(`18446744073709551615`)) {
		t.Fatalf("content value lost numeric precision: %s", data.Content.Value)
	}
	if got := data.PayloadSet["opaque"]; !bytes.Contains(got, []byte(`9007199254740995`)) {
		t.Fatalf("payload-set value lost numeric precision: %s", got)
	}
}

func TestRecipientProjectorPreservesInteractionOpaquePayloads(t *testing.T) {
	t.Parallel()

	event, err := NewInteractionUpdateEvent(InteractionUpdateData{
		WorkspaceID:      "owner-workspace",
		AgentSessionID:   "owner-session",
		EventType:        EventTypeInteractionUpdate,
		OccurredAtUnixMS: 10,
		Interaction: EventInteraction{
			RequestID:       "request-1",
			AgentSessionID:  "owner-session",
			TurnID:          "owner-turn",
			Kind:            "approval",
			Status:          "pending",
			Input:           json.RawMessage(`{"id":9007199254740993}`),
			Output:          json.RawMessage(`{"id":9007199254740995}`),
			Metadata:        json.RawMessage(`{"id":18446744073709551615}`),
			CreatedAtUnixMS: 1,
			UpdatedAtUnixMS: 2,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
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
	var data InteractionUpdateData
	if err := json.Unmarshal(projected.Data, &data); err != nil {
		t.Fatal(err)
	}
	for name, payload := range map[string]json.RawMessage{
		"input": data.Interaction.Input, "output": data.Interaction.Output, "metadata": data.Interaction.Metadata,
	} {
		if !bytes.Contains(payload, []byte(`900719925474099`)) &&
			!bytes.Contains(payload, []byte(`18446744073709551615`)) {
			t.Fatalf("%s lost numeric precision: %s", name, payload)
		}
	}
}
