package agentruntime

import (
	"context"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

type providerInputTrackingTestTransport struct {
	ProcessTransport
	enabled bool
}

func (t providerInputTrackingTestTransport) TracksProviderInputUnits() bool {
	return t.enabled
}

func TestProviderInputUnitTrackerCompositionIsTransportOptIn(t *testing.T) {
	if tracker := providerInputUnitTrackerForTransport(cassetteTestTransport{}); tracker != nil {
		t.Fatalf("raw transport tracker = %#v, want nil", tracker)
	}
	if tracker := providerInputUnitTrackerForTransport(
		providerInputTrackingTestTransport{enabled: false},
	); tracker != nil {
		t.Fatalf("disabled tracking transport tracker = %#v, want nil", tracker)
	}
	tracking := providerInputTrackingTestTransport{enabled: true}
	if tracker := providerInputUnitTrackerForTransport(tracking); tracker == nil {
		t.Fatal("enabled tracking transport tracker = nil")
	}
	if adapter := NewCodexAppServerAdapter(cassetteTestTransport{}); adapter.inputUnits != nil {
		t.Fatalf("raw Codex adapter tracker = %#v, want nil", adapter.inputUnits)
	}
	if adapter := NewCodexAppServerAdapter(tracking); adapter.inputUnits == nil {
		t.Fatal("tracking Codex adapter tracker = nil")
	}
	for name, transport := range map[string]ProcessTransport{
		"recording":         &RecordingProcessTransport{},
		"replay":            &ReplayProcessTransport{},
		"session recording": &SessionRecordingProcessTransport{},
		"session replay":    &SessionReplayProcessTransport{},
	} {
		if tracker := providerInputUnitTrackerForTransport(transport); tracker == nil {
			t.Fatalf("%s transport tracker = nil", name)
		}
	}
}

func TestProviderInputUnitTrackerStampsOneOrderedEventBatch(t *testing.T) {
	var tracker providerInputUnitTracker
	unit := ProviderInputUnit{
		RecordingID: "recording-1",
		Position: replay.ProviderUnitPosition{
			ConnectionID: "connection-1", ChunkSeq: 64, UnitIndex: 2,
		},
		Kind: replay.ProviderInputUnitProtocolMessage,
	}
	end := tracker.begin(
		contextWithProviderInputUnit(context.Background(), unit),
		"session-1",
	)
	events := tracker.stamp("session-1", []activityshared.Event{
		{Type: activityshared.EventTurnUpdated},
		{Type: activityshared.EventCallStarted},
		{Type: activityshared.EventInteractionRequested},
	})
	end()

	for index, event := range events {
		position := event.ProviderInputUnit
		if position == nil ||
			position.RecordingID != unit.RecordingID ||
			position.ConnectionID != unit.Position.ConnectionID ||
			position.ChunkSeq != unit.Position.ChunkSeq ||
			position.UnitIndex != unit.Position.UnitIndex ||
			position.EventIndex != uint64(index+1) ||
			position.UnitKind != string(unit.Kind) {
			t.Fatalf("event %d position=%#v", index, position)
		}
	}
	if stamped := tracker.stamp(
		"session-1",
		[]activityshared.Event{{Type: activityshared.EventTurnCompleted}},
	); stamped[0].ProviderInputUnit != nil {
		t.Fatalf("event after unit completion retained position=%#v",
			stamped[0].ProviderInputUnit)
	}
}

func TestProcessExitDerivedTurnFailureRetainsExitUnitContext(t *testing.T) {
	unit := ProviderInputUnit{
		RecordingID: "recording-1",
		Position: replay.ProviderUnitPosition{
			ConnectionID: "connection-2", ChunkSeq: 9, UnitIndex: 1,
		},
		Kind: replay.ProviderInputUnitProcessExit,
	}
	err := providerInputUnitError{
		err:  context.Canceled,
		unit: unit,
	}
	events := stampProviderInputUnitFromError(err, []activityshared.Event{
		{Type: activityshared.EventTurnFailed},
		{Type: activityshared.EventRootProviderTurnCompleted},
	})
	for index, event := range events {
		position := event.ProviderInputUnit
		if position == nil ||
			position.RecordingID != unit.RecordingID ||
			position.ConnectionID != unit.Position.ConnectionID ||
			position.ChunkSeq != unit.Position.ChunkSeq ||
			position.UnitIndex != unit.Position.UnitIndex ||
			position.EventIndex != uint64(index+1) ||
			position.UnitKind != string(replay.ProviderInputUnitProcessExit) {
			t.Fatalf("terminal event %d position=%#v", index, position)
		}
	}
}

func TestCompletedPlanMessageProjectsProviderNeutralObservation(t *testing.T) {
	event := activityshared.NewMessageAppended(
		activityshared.EventContext{
			EventID: "plan-message-1", AgentSessionID: "session-1",
			TurnID: "turn-1",
		},
		activityshared.MessageRoleAssistant,
		"# Plan",
		true,
	)
	event.Payload.Metadata = map[string]any{
		"messageId": "plan-message-1", "messageKind": "plan",
		"streamState": "completed",
	}
	event.ProviderInputUnit = &activityshared.ProviderInputUnitContext{
		RecordingID: "recording-1", ConnectionID: "connection-1",
		ChunkSeq: 82, UnitIndex: 1, EventIndex: 1,
		UnitKind: string(replay.ProviderInputUnitProtocolMessage),
	}
	report := reportActivityInput(
		Session{
			RoomID: "workspace-1", AgentSessionID: "session-1",
			Provider: "codex",
		},
		[]activityshared.Event{event},
	)
	if len(report.ProviderObservations) != 1 ||
		len(report.ProviderObservations[0].Events) != 1 {
		t.Fatalf("provider observations=%#v", report.ProviderObservations)
	}
	if report.ProviderObservations[0].RecordingID != "recording-1" {
		t.Fatalf(
			"provider observation recording ID=%q",
			report.ProviderObservations[0].RecordingID,
		)
	}
	observation := report.ProviderObservations[0].Events[0]
	if observation.Type != "plan.proposed" ||
		observation.MessageID != "plan-message-1" ||
		observation.MessageKind != "plan" ||
		observation.Status != "completed" {
		t.Fatalf("plan observation=%#v", observation)
	}
}

func TestCompactionAndAttachmentProjectProviderNeutralObservations(
	t *testing.T,
) {
	tests := []struct {
		name     string
		metadata map[string]any
		wantType string
	}{
		{
			name: "compaction",
			metadata: map[string]any{
				"messageId": "compact-1", "kind": "agent_system_notice",
				"noticeCommand":       "compact",
				"noticeCommandStatus": "completed",
				"streamState":         "completed",
			},
			wantType: "compaction.updated",
		},
		{
			name: "attachments",
			metadata: map[string]any{
				"messageId": "user-1", "streamState": "completed",
				"content": []any{
					map[string]any{"type": "text", "text": "look"},
					map[string]any{
						"type": "image", "attachmentId": "attachment-1",
					},
					map[string]any{
						"type": "image", "attachmentId": "attachment-2",
					},
				},
			},
			wantType: "attachment.materialized",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			event := activityshared.NewMessageAppended(
				activityshared.EventContext{
					EventID: "message-1", AgentSessionID: "session-1",
					TurnID: "turn-1",
				},
				activityshared.MessageRoleUser,
				"look",
				false,
			)
			event.Payload.Metadata = test.metadata
			event.ProviderInputUnit = &activityshared.ProviderInputUnitContext{
				ConnectionID: "connection-1", ChunkSeq: 1, UnitIndex: 1,
				EventIndex: 1,
				UnitKind:   string(replay.ProviderInputUnitProtocolMessage),
			}
			report := reportActivityInput(
				Session{
					RoomID: "workspace-1", AgentSessionID: "session-1",
					Provider: "codex",
				},
				[]activityshared.Event{event},
			)
			observation := report.ProviderObservations[0].Events[0]
			if observation.Type != test.wantType {
				t.Fatalf("observation=%#v", observation)
			}
			if test.wantType == "compaction.updated" &&
				(observation.NoticeCommand != "compact" ||
					observation.NoticeCommandStatus != "completed") {
				t.Fatalf("compaction observation=%#v", observation)
			}
			if test.wantType == "attachment.materialized" &&
				observation.AttachmentCount != 2 {
				t.Fatalf("attachment observation=%#v", observation)
			}
		})
	}
}

func TestChildObservationCarriesExactCanonicalLineageFacts(t *testing.T) {
	event := activityshared.Event{
		EventID:              "child-started",
		Type:                 activityshared.EventSessionStarted,
		AgentSessionID:       "child-runtime",
		SessionKind:          "child",
		RootAgentSessionID:   "root-runtime",
		RootTurnID:           "root-turn",
		ParentAgentSessionID: "root-runtime",
		ParentTurnID:         "root-turn",
		ParentToolCallID:     "call-runtime",
		Payload: activityshared.EventPayload{
			TurnID: "child-turn",
		},
		ProviderInputUnit: &activityshared.ProviderInputUnitContext{
			ConnectionID: "connection-1", ChunkSeq: 1, UnitIndex: 1,
			EventIndex: 1,
			UnitKind:   string(replay.ProviderInputUnitProtocolMessage),
		},
	}
	report := reportActivityInput(
		Session{
			RoomID: "workspace-1", AgentSessionID: "root-runtime",
			Provider: "codex",
		},
		[]activityshared.Event{event},
	)
	observation := report.ProviderObservations[0].Events[0]
	if observation.SessionKind != "child" ||
		observation.RootAgentSessionID != "root-runtime" ||
		observation.RootTurnID != "root-turn" ||
		observation.ParentAgentSessionID != "root-runtime" ||
		observation.ParentTurnID != "root-turn" ||
		observation.ParentToolCallID != "call-runtime" {
		t.Fatalf("child observation=%#v", observation)
	}
}

func TestToolOutputDeltaCallStartedDoesNotMintCheckpointObservation(
	t *testing.T,
) {
	session := Session{
		RoomID: "workspace-1", AgentSessionID: "session-1",
		Provider: "codex",
	}
	started := newTurnActivityEventWithID(
		session,
		"command-1",
		EventCallStarted,
		"turn-1",
		messageStreamStateStreaming,
		"",
		"printf hello",
		map[string]any{
			"toolCallId": "command-1",
			"status":     "running",
		},
	)
	started.ProviderInputUnit = &activityshared.ProviderInputUnitContext{
		RecordingID: "recording-1", ConnectionID: "connection-1",
		ChunkSeq: 42, UnitIndex: 1, EventIndex: 1,
		UnitKind: string(replay.ProviderInputUnitProtocolMessage),
	}
	delta := newTurnActivityEventWithID(
		session,
		"command-1",
		EventCallStarted,
		"turn-1",
		messageStreamStateStreaming,
		"",
		"printf hello",
		map[string]any{
			"toolCallId": "command-1",
			"status":     "running",
			"output":     map[string]any{"text": "hello"},
		},
	)
	attachToolOutputLiveOperation(&delta, &liveprotocol.MessageToolOutputOperation{
		Operation: "set",
		Text:      "hello",
	})
	delta.ProviderInputUnit = &activityshared.ProviderInputUnitContext{
		RecordingID: "recording-1", ConnectionID: "connection-1",
		ChunkSeq: 43, UnitIndex: 1, EventIndex: 1,
		UnitKind: string(replay.ProviderInputUnitProtocolMessage),
	}

	startReport := reportActivityInput(session, []activityshared.Event{started})
	if len(startReport.ProviderObservations) != 1 ||
		len(startReport.ProviderObservations[0].Events) != 1 ||
		startReport.ProviderObservations[0].Events[0].Type != "call.started" {
		t.Fatalf("start observations=%#v", startReport.ProviderObservations)
	}

	deltaReport := reportActivityInput(session, []activityshared.Event{delta})
	if len(deltaReport.ProviderObservations) != 0 {
		t.Fatalf(
			"outputDelta observations=%#v, want none",
			deltaReport.ProviderObservations,
		)
	}
	if len(deltaReport.MessageUpdates) == 0 {
		t.Fatal("outputDelta should still project a durable message update")
	}
}

func TestClaudeToolUpdatedCallStartedDoesNotMintCheckpointObservation(
	t *testing.T,
) {
	session := Session{
		RoomID: "workspace-1", AgentSessionID: "session-1",
		Provider: ProviderClaudeCode,
	}
	progress := newTurnActivityEventWithID(
		session,
		"command-1",
		EventCallStarted,
		"turn-1",
		messageStreamStateStreaming,
		"",
		"Bash",
		map[string]any{
			"toolCallId": "command-1",
			"status":     "running",
			"input": map[string]any{
				"command": "sleep 20",
			},
		},
	)
	markClaudeSDKToolProgressUpdate(&progress)
	progress.ProviderInputUnit = &activityshared.ProviderInputUnitContext{
		RecordingID: "recording-1", ConnectionID: "connection-1",
		ChunkSeq: 64, UnitIndex: 1, EventIndex: 1,
		UnitKind: string(replay.ProviderInputUnitProtocolMessage),
	}

	report := reportActivityInput(session, []activityshared.Event{progress})
	if len(report.ProviderObservations) != 0 {
		t.Fatalf(
			"tool_updated observations=%#v, want none",
			report.ProviderObservations,
		)
	}
	if len(report.MessageUpdates) == 0 {
		t.Fatal("tool_updated should still project a durable message update")
	}
}
