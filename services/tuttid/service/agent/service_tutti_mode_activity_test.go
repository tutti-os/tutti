package agent

import (
	"context"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

type canonicalUserMessageReader struct {
	page SessionMessagesPage
}

func (reader canonicalUserMessageReader) ListSessionMessages(
	input agentactivitybiz.ListSessionMessagesInput,
) (SessionMessagesPage, bool) {
	return reader.page, input.TurnID != ""
}

type recordingTuttiModeSourceActivity struct {
	calls []TuttiModeSourceActivity
}

func TestAcceptedGuidanceActivityUsesCanonicalMessageOccurrenceTime(t *testing.T) {
	observer := &recordingTuttiModeSourceActivity{}
	service := &Service{
		TuttiModeSourceActivity: observer,
		MessageReader: canonicalUserMessageReader{page: SessionMessagesPage{
			AgentSessionID: "session-source",
			Messages: []SessionMessage{{
				MessageID:        "guidance-message",
				TurnID:           "turn-existing",
				Role:             "user",
				Payload:          map[string]any{"clientSubmitId": "guidance-submit"},
				OccurredAtUnixMS: 5678,
				Version:          2,
			}},
		}},
	}

	service.observeTuttiModeSourceUserTurn(
		context.Background(), "workspace-1", "session-source",
		"guidance-submit",
		map[string]any{"clientSubmitId": "guidance-submit"},
		&agentactivitybiz.Turn{
			TurnID:          "turn-existing",
			StartedAtUnixMS: 1234,
		},
	)

	if len(observer.calls) != 1 ||
		observer.calls[0].OccurredAtUnixMS != 5678 {
		t.Fatalf(
			"guidance activity = %#v, want canonical message occurrence 5678",
			observer.calls,
		)
	}
}

func (observer *recordingTuttiModeSourceActivity) ObserveTuttiModeSourceActivity(
	_ context.Context,
	activity TuttiModeSourceActivity,
) error {
	observer.calls = append(observer.calls, activity)
	return nil
}

func TestAcceptedUserTurnActivityUsesCanonicalIdentityAndTimeOnReplay(t *testing.T) {
	observer := &recordingTuttiModeSourceActivity{}
	service := &Service{
		TuttiModeSourceActivity: observer,
		MessageReader: canonicalUserMessageReader{page: SessionMessagesPage{
			Messages: []SessionMessage{{
				MessageID: "message-canonical", TurnID: "turn-canonical",
				Role: "user", OccurredAtUnixMS: 1234,
			}},
		}},
	}
	turn := &agentactivitybiz.Turn{
		TurnID: "turn-canonical", CreatedAtUnixMS: 1200,
		StartedAtUnixMS: 1234,
	}

	for range 2 {
		service.observeTuttiModeSourceUserTurn(
			context.Background(), "workspace-1", "session-source",
			"", nil, turn,
		)
	}
	if len(observer.calls) != 2 {
		t.Fatalf("user activity calls = %#v, want at-least-once replay", observer.calls)
	}
	for _, activity := range observer.calls {
		if activity.WorkspaceID != "workspace-1" ||
			activity.SessionID != "session-source" ||
			activity.Kind != "user_turn" ||
			activity.ActivityID != "message-canonical" ||
			activity.OccurredAtUnixMS != 1234 {
			t.Fatalf("user activity = %#v, want stable canonical identity/time", activity)
		}
	}

	service.observeTuttiModeSourceUserTurn(
		context.Background(), "workspace-1", "session-source",
		"",
		map[string]any{"tuttiModeExecutionWake": true},
		&agentactivitybiz.Turn{
			TurnID: "turn-wake", CreatedAtUnixMS: 5600,
			StartedAtUnixMS: 5678,
		},
	)
	if len(observer.calls) != 2 {
		t.Fatalf("internal wake projected user activity: %#v", observer.calls)
	}
}
