package sessionreplay

import (
	"errors"
	"fmt"
	"strings"
)

type ActivityEventKind string

const (
	ActivityEventKindIntent         ActivityEventKind = "intent"
	ActivityEventKindEffect         ActivityEventKind = "effect"
	ActivityEventKindDirectStimulus ActivityEventKind = "direct-stimulus"
)

// ActivityEvent is one fact on the ordered user-activity timeline. Intents
// drive an activity engine during replay. Effects verify commands produced by
// that engine. Direct stimuli drive product operations that have no activity
// engine entrypoint.
type ActivityEvent struct {
	SchemaVersion   int               `json:"schemaVersion"`
	Sequence        uint64            `json:"sequence"`
	Kind            ActivityEventKind `json:"kind"`
	Type            string            `json:"type"`
	EventID         string            `json:"eventId"`
	CorrelationID   string            `json:"correlationId,omitempty"`
	CausedByEventID string            `json:"causedByEventId,omitempty"`
	ScopeID         string            `json:"scopeId"`
	AgentSessionID  string            `json:"agentSessionId,omitempty"`
	Payload         map[string]any    `json:"payload,omitempty"`
	OccurredAtMS    int64             `json:"occurredAtUnixMs"`
}

func ValidateActivityEvent(event ActivityEvent) error {
	if event.SchemaVersion != CassetteSchemaVersion {
		return fmt.Errorf("activity event has unsupported schema version %d", event.SchemaVersion)
	}
	if event.Sequence == 0 ||
		strings.TrimSpace(event.Type) == "" ||
		strings.TrimSpace(event.EventID) == "" ||
		strings.TrimSpace(event.ScopeID) == "" ||
		event.OccurredAtMS <= 0 {
		return errors.New("activity event is missing required identity or timing")
	}
	switch event.Kind {
	case ActivityEventKindIntent, ActivityEventKindDirectStimulus:
		if strings.TrimSpace(event.CausedByEventID) != "" {
			return fmt.Errorf("%s activity event cannot have causedByEventId", event.Kind)
		}
	case ActivityEventKindEffect:
		if strings.TrimSpace(event.CausedByEventID) == "" {
			return errors.New("effect activity event requires causedByEventId")
		}
	default:
		return fmt.Errorf("activity event has unsupported kind %q", event.Kind)
	}
	return nil
}

// ValidateActivityEvents validates one complete activity timeline. An effect
// must point to an earlier intent; it is verification evidence, not a second
// replay driver.
func ValidateActivityEvents(events []ActivityEvent) error {
	seen := make(map[string]ActivityEvent, len(events))
	for position, event := range events {
		if err := ValidateActivityEvent(event); err != nil {
			return fmt.Errorf("activity event %d: %w", position, err)
		}
		wantSequence := uint64(position + 1)
		if event.Sequence != wantSequence {
			return fmt.Errorf(
				"activity event sequence %d is not contiguous at position %d",
				event.Sequence,
				position,
			)
		}
		eventID := strings.TrimSpace(event.EventID)
		if _, ok := seen[eventID]; ok {
			return fmt.Errorf("activity event id %q is duplicated", eventID)
		}
		if event.Kind == ActivityEventKindEffect {
			causeID := strings.TrimSpace(event.CausedByEventID)
			cause, ok := seen[causeID]
			if !ok || cause.Kind != ActivityEventKindIntent {
				return fmt.Errorf(
					"effect activity event %q must reference an earlier intent",
					eventID,
				)
			}
			correlationID := strings.TrimSpace(event.CorrelationID)
			causeCorrelationID := strings.TrimSpace(cause.CorrelationID)
			if correlationID != "" && causeCorrelationID != "" &&
				correlationID != causeCorrelationID {
				return fmt.Errorf(
					"effect activity event %q conflicts with its intent correlation",
					eventID,
				)
			}
		}
		seen[eventID] = event
	}
	return nil
}
