package liveprotocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"
)

func TestRecipientProjectorProjectsRuntimeActivityIdentity(t *testing.T) {
	t.Parallel()
	event, err := NewRuntimeActivityUpdateEvent(RuntimeActivityUpdateData{
		WorkspaceID: "owner-workspace", AgentSessionID: "owner-session",
		EventType: EventTypeRuntimeActivityUpdate, State: "running", OccurredAtUnixMS: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	projector, err := NewRecipientProjector(ProjectionContext{
		OwnerWorkspaceID: "owner-workspace", OwnerAgentSessionID: "owner-session",
		RecipientWorkspaceID: "recipient-workspace", RecipientAgentSessionID: "recipient-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	projected, err := projector.Project(event)
	if err != nil {
		t.Fatal(err)
	}
	var data RuntimeActivityUpdateData
	if err := json.Unmarshal(projected.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.WorkspaceID != "recipient-workspace" || data.AgentSessionID != "recipient-session" {
		t.Fatalf("projected runtime activity identity = %#v", data)
	}
}

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

func TestRecipientProjectorProjectsCompleteInteractionSnapshot(t *testing.T) {
	t.Parallel()
	event, err := NewInteractionSnapshotEvent(InteractionSnapshotData{
		WorkspaceID: "owner-workspace", AgentSessionID: "owner-session",
		EventType: EventTypeInteractionSnapshot, OccurredAtUnixMS: 10, RootTurnID: "owner-turn",
		Interactions: []EventInteraction{{
			RequestID: "request-1", AgentSessionID: "owner-session", TurnID: "owner-turn",
			Kind: "approval", Status: "pending", Input: json.RawMessage(`null`),
			Output: json.RawMessage(`null`), Metadata: json.RawMessage(`null`),
			CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	projector, err := NewRecipientProjector(ProjectionContext{
		OwnerWorkspaceID: "owner-workspace", OwnerAgentSessionID: "owner-session",
		CanonicalTurnID: "owner-turn", RecipientWorkspaceID: "caller-workspace",
		RecipientAgentSessionID: "caller-session", CallerTurnID: "caller-turn",
	})
	if err != nil {
		t.Fatal(err)
	}
	projected, err := projector.Project(event)
	if err != nil {
		t.Fatal(err)
	}
	var data InteractionSnapshotData
	if err := json.Unmarshal(projected.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.AgentSessionID != "caller-session" || data.RootTurnID != "caller-turn" || len(data.Interactions) != 1 ||
		data.Interactions[0].AgentSessionID != "caller-session" ||
		data.Interactions[0].TurnID != "caller-turn" {
		t.Fatalf("projected interaction snapshot = %#v", data)
	}
}

func TestRecipientProjectorProjectsContinuationInteractionUpdateAndSnapshot(t *testing.T) {
	t.Parallel()
	update, err := NewInteractionUpdateEvent(InteractionUpdateData{
		WorkspaceID: "owner-workspace", AgentSessionID: "owner-session",
		EventType: EventTypeInteractionUpdate, OccurredAtUnixMS: 10,
		Interaction: EventInteraction{
			RequestID: "child-request", AgentSessionID: "owner-session", TurnID: "child-turn",
			Kind: "approval", Status: "pending", Input: json.RawMessage(`null`),
			Output: json.RawMessage(`null`), Metadata: json.RawMessage(`null`),
			CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := NewInteractionSnapshotEvent(InteractionSnapshotData{
		WorkspaceID: "owner-workspace", AgentSessionID: "owner-session",
		EventType: EventTypeInteractionSnapshot, OccurredAtUnixMS: 10, RootTurnID: "parent-turn",
		Interactions: []EventInteraction{{
			RequestID: "child-request", AgentSessionID: "owner-session", TurnID: "child-turn",
			Kind: "approval", Status: "pending", Input: json.RawMessage(`null`),
			Output: json.RawMessage(`null`), Metadata: json.RawMessage(`null`),
			CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	projector, err := NewRecipientProjector(ProjectionContext{
		OwnerWorkspaceID: "owner-workspace", OwnerAgentSessionID: "owner-session",
		CanonicalTurnID: "parent-turn", CanonicalTurnIDs: []string{"parent-turn", "child-turn"},
		RecipientWorkspaceID: "caller-workspace", RecipientAgentSessionID: "caller-session",
		CallerTurnID: "caller-turn",
	})
	if err != nil {
		t.Fatal(err)
	}
	projectedUpdate, err := projector.Project(update)
	if err != nil {
		t.Fatal(err)
	}
	var updateData InteractionUpdateData
	if err := json.Unmarshal(projectedUpdate.Data, &updateData); err != nil {
		t.Fatal(err)
	}
	if updateData.Interaction.TurnID != "caller-turn" || updateData.Interaction.RequestID != "child-request" {
		t.Fatalf("projected continuation interaction update = %#v", updateData.Interaction)
	}
	projectedSnapshot, err := projector.Project(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	var snapshotData InteractionSnapshotData
	if err := json.Unmarshal(projectedSnapshot.Data, &snapshotData); err != nil {
		t.Fatal(err)
	}
	if snapshotData.RootTurnID != "caller-turn" || len(snapshotData.Interactions) != 1 ||
		snapshotData.Interactions[0].TurnID != "caller-turn" ||
		snapshotData.Interactions[0].RequestID != "child-request" {
		t.Fatalf("projected continuation interaction snapshot = %#v", snapshotData.Interactions)
	}
}

func TestRecipientProjectorRejectsUnauthorizedInteractionSnapshotRoot(t *testing.T) {
	t.Parallel()
	snapshot, err := NewInteractionSnapshotEvent(InteractionSnapshotData{
		WorkspaceID: "owner-workspace", AgentSessionID: "owner-session",
		EventType: EventTypeInteractionSnapshot, OccurredAtUnixMS: 10, RootTurnID: "stale-turn",
	})
	if err != nil {
		t.Fatal(err)
	}
	projector, err := NewRecipientProjector(ProjectionContext{
		OwnerWorkspaceID: "owner-workspace", OwnerAgentSessionID: "owner-session",
		CanonicalTurnIDs:     []string{"goal-turn-1", "goal-turn-2"},
		RecipientWorkspaceID: "caller-workspace", RecipientAgentSessionID: "caller-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := projector.Project(snapshot); !errors.Is(err, ErrInvalidLiveEvent) {
		t.Fatalf("unauthorized root error = %v, want ErrInvalidLiveEvent", err)
	}
}

func TestRecipientProjectorProjectsDurablyAuthorizedContinuationTurns(t *testing.T) {
	t.Parallel()
	outcome := "completed"
	settledAt := int64(20)
	turnEvent, err := NewTurnUpdateEvent(TurnUpdateData{
		WorkspaceID: "owner-workspace", AgentSessionID: "owner-session",
		EventType: EventTypeTurnUpdate, OccurredAtUnixMS: 20,
		ActiveTurnID: nil,
		Turn: EventTurn{
			TurnID: "child-turn", AgentSessionID: "owner-session", Phase: "settled",
			Origin: "user_prompt", Outcome: &outcome, StartedAtUnixMS: 10,
			SettledAtUnixMS: &settledAt, UpdatedAtUnixMS: 20,
			FileChanges: json.RawMessage(`null`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	messageEvent, err := NewMessageDeltaEvent(MessageDeltaData{
		WorkspaceID: "owner-workspace", AgentSessionID: "owner-session",
		MessageID: "message-1", TurnID: "child-turn", Role: "assistant", Kind: "text",
		OccurredAtUnixMS: 20,
		Content:          &MessageContentOperation{Operation: "set", Value: json.RawMessage(`"done"`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	projector, err := NewRecipientProjector(ProjectionContext{
		OwnerWorkspaceID: "owner-workspace", OwnerAgentSessionID: "owner-session",
		CanonicalTurnID: "parent-turn", CanonicalTurnIDs: []string{"parent-turn", "child-turn"},
		RecipientWorkspaceID: "caller-workspace", RecipientAgentSessionID: "caller-session",
		CallerTurnID: "caller-turn",
	})
	if err != nil {
		t.Fatal(err)
	}
	projectedTurn, err := projector.Project(turnEvent)
	if err != nil {
		t.Fatal(err)
	}
	var turnData TurnUpdateData
	if err := json.Unmarshal(projectedTurn.Data, &turnData); err != nil {
		t.Fatal(err)
	}
	if turnData.Turn.TurnID != "caller-turn" || turnData.ActiveTurnID != nil {
		t.Fatalf("continuation turn was not projected: %#v", turnData)
	}
	projectedMessage, err := projector.Project(messageEvent)
	if err != nil {
		t.Fatal(err)
	}
	var messageData MessageDeltaData
	if err := json.Unmarshal(projectedMessage.Data, &messageData); err != nil {
		t.Fatal(err)
	}
	if messageData.TurnID != "caller-turn" {
		t.Fatalf("continuation message turn = %q, want caller-turn", messageData.TurnID)
	}
	unknownEvent := messageEvent
	unknownData := MessageDeltaData{}
	if err := json.Unmarshal(unknownEvent.Data, &unknownData); err != nil {
		t.Fatal(err)
	}
	unknownData.TurnID = "unproven-turn"
	unknownEvent.Data, err = json.Marshal(unknownData)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := projector.Project(unknownEvent); err == nil {
		t.Fatal("unproven turn was projected")
	}
}

func TestRecipientProjectorPreservesHostProvenTurnlessGoalTurn(t *testing.T) {
	t.Parallel()
	event, err := NewMessageDeltaEvent(MessageDeltaData{
		WorkspaceID: "owner-workspace", AgentSessionID: "owner-session",
		MessageID: "message-1", TurnID: "goal-turn-2", Role: "assistant", Kind: "text",
		OccurredAtUnixMS: 20,
		Content:          &MessageContentOperation{Operation: "append_text", Text: "working"},
	})
	if err != nil {
		t.Fatal(err)
	}
	projector, err := NewRecipientProjector(ProjectionContext{
		OwnerWorkspaceID: "owner-workspace", OwnerAgentSessionID: "owner-session",
		CanonicalTurnIDs:     []string{"goal-turn-1", "goal-turn-2"},
		RecipientWorkspaceID: "caller-workspace", RecipientAgentSessionID: "caller-session",
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
	if data.WorkspaceID != "caller-workspace" || data.AgentSessionID != "caller-session" ||
		data.TurnID != "goal-turn-2" {
		t.Fatalf("projected turnless Goal delta = %#v", data)
	}
}
