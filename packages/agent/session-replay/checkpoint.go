package sessionreplay

import (
	"errors"
	"fmt"
	"strings"
)

type ReplayCheckpointKind string

const (
	ReplayCheckpointKindBootstrap          ReplayCheckpointKind = "bootstrap"
	ReplayCheckpointKindAfterActivityEvent ReplayCheckpointKind = "after-activity-event"
)

// ProviderCursorMarker is provider-neutral evidence of where each recorded
// process connection stopped at a stable checkpoint. The core treats Cursor as
// opaque and does not define how a transport reaches the marker.
type ProviderCursorMarker struct {
	Connections []ProviderConnectionCursor `json:"connections,omitempty"`
}

type ProviderConnectionCursor struct {
	ConnectionID string `json:"connectionId"`
	Cursor       string `json:"cursor"`
}

// ReplayCheckpoint describes one safe playback boundary. Index is the value
// persisted on ReplayRun. Checkpoint zero is the state after seed import and
// before the first activity event. Every later checkpoint is identified by the
// last fully applied activity-event sequence.
type ReplayCheckpoint struct {
	SchemaVersion              int                  `json:"schemaVersion"`
	Index                      int64                `json:"index"`
	Kind                       ReplayCheckpointKind `json:"kind"`
	AfterActivityEventSequence uint64               `json:"afterActivityEventSequence"`
	ProviderMarker             ProviderCursorMarker `json:"providerMarker"`
	ExpectedActivityProjection ActivityProjection   `json:"expectedActivityProjection"`
}

type ActivityProjection struct {
	QueuedPromptIDs  []string `json:"queuedPromptIds"`
	DrainingPromptID string   `json:"drainingPromptId,omitempty"`
	FailedPromptID   string   `json:"failedPromptId,omitempty"`
	QueueStatus      string   `json:"queueStatus,omitempty"`
}

// ValidateReplayCheckpoints validates the complete checkpoint inventory for a
// Cassette. Stable checkpoints may be sparse, but the final activity event
// must have a checkpoint so full replay completion has a stable boundary.
func ValidateReplayCheckpoints(
	checkpoints []ReplayCheckpoint,
	activityEventCount uint64,
) error {
	if len(checkpoints) == 0 {
		return errors.New("cassette checkpoints are empty")
	}
	for position, checkpoint := range checkpoints {
		if checkpoint.SchemaVersion != CassetteSchemaVersion {
			return fmt.Errorf(
				"checkpoint %d has unsupported schema version %d",
				position,
				checkpoint.SchemaVersion,
			)
		}
		if checkpoint.Index != int64(position) {
			return fmt.Errorf(
				"checkpoint index %d is not contiguous at position %d",
				checkpoint.Index,
				position,
			)
		}
		if err := validateProviderCursorMarker(checkpoint.ProviderMarker); err != nil {
			return fmt.Errorf("checkpoint %d: %w", checkpoint.Index, err)
		}
		if err := validateActivityProjection(checkpoint.ExpectedActivityProjection); err != nil {
			return fmt.Errorf("checkpoint %d: %w", checkpoint.Index, err)
		}
		if position == 0 {
			if checkpoint.Kind != ReplayCheckpointKindBootstrap ||
				checkpoint.AfterActivityEventSequence != 0 {
				return errors.New(
					"checkpoint 0 must be bootstrap before the first activity event",
				)
			}
			continue
		}
		previous := checkpoints[position-1]
		if checkpoint.Kind != ReplayCheckpointKindAfterActivityEvent ||
			checkpoint.AfterActivityEventSequence <= previous.AfterActivityEventSequence ||
			checkpoint.AfterActivityEventSequence > activityEventCount {
			return fmt.Errorf(
				"checkpoint %d must identify a later recorded activity event",
				checkpoint.Index,
			)
		}
	}
	last := checkpoints[len(checkpoints)-1]
	if last.AfterActivityEventSequence != activityEventCount {
		return fmt.Errorf(
			"final checkpoint activity event sequence is %d, want %d",
			last.AfterActivityEventSequence,
			activityEventCount,
		)
	}
	return nil
}

func validateActivityProjection(projection ActivityProjection) error {
	switch projection.QueueStatus {
	case "", "idle", "queued", "draining", "suspended", "failed":
	default:
		return fmt.Errorf("activity projection has unsupported queue status %q", projection.QueueStatus)
	}
	seen := make(map[string]struct{}, len(projection.QueuedPromptIDs))
	for _, promptID := range projection.QueuedPromptIDs {
		promptID = strings.TrimSpace(promptID)
		if promptID == "" {
			return errors.New("activity projection contains an empty queued prompt id")
		}
		if _, ok := seen[promptID]; ok {
			return fmt.Errorf("activity projection contains duplicate queued prompt id %q", promptID)
		}
		seen[promptID] = struct{}{}
	}
	return nil
}

func validateProviderCursorMarker(marker ProviderCursorMarker) error {
	previousID := ""
	for _, connection := range marker.Connections {
		connectionID := strings.TrimSpace(connection.ConnectionID)
		cursor := strings.TrimSpace(connection.Cursor)
		if connectionID == "" || cursor == "" {
			return errors.New("provider cursor marker contains an empty connection or cursor")
		}
		if previousID != "" && connectionID <= previousID {
			return errors.New(
				"provider cursor marker connections must be unique and sorted",
			)
		}
		previousID = connectionID
	}
	return nil
}
