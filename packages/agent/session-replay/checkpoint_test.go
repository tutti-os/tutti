package sessionreplay

import (
	"strings"
	"testing"
)

func TestValidateReplayCheckpoints(t *testing.T) {
	checkpoints := []ReplayCheckpoint{
		{
			SchemaVersion: CassetteSchemaVersion,
			Index:         0,
			Kind:          ReplayCheckpointKindBootstrap,
		},
		{
			SchemaVersion:              CassetteSchemaVersion,
			Index:                      1,
			Kind:                       ReplayCheckpointKindAfterActivityEvent,
			AfterActivityEventSequence: 1,
			ExpectedActivityProjection: ActivityProjection{
				QueuedPromptIDs:  []string{"prompt-2"},
				DrainingPromptID: "prompt-1",
				QueueStatus:      "draining",
			},
			ProviderMarker: ProviderCursorMarker{
				Connections: []ProviderConnectionCursor{
					{ConnectionID: "connection-1", Cursor: "opaque:3"},
					{ConnectionID: "connection-2", Cursor: "opaque:1"},
				},
			},
		},
		{
			SchemaVersion:              CassetteSchemaVersion,
			Index:                      2,
			Kind:                       ReplayCheckpointKindAfterActivityEvent,
			AfterActivityEventSequence: 3,
		},
	}
	if err := ValidateReplayCheckpoints(checkpoints, 3); err != nil {
		t.Fatal(err)
	}
}

func TestValidateReplayCheckpointsAcceptsBootstrapOnlyCassette(t *testing.T) {
	err := ValidateReplayCheckpoints([]ReplayCheckpoint{{
		SchemaVersion: CassetteSchemaVersion,
		Kind:          ReplayCheckpointKindBootstrap,
	}}, 0)
	if err != nil {
		t.Fatal(err)
	}
}

func TestValidateReplayCheckpointsRejectsInvalidInventories(t *testing.T) {
	validBootstrap := ReplayCheckpoint{
		SchemaVersion: CassetteSchemaVersion,
		Kind:          ReplayCheckpointKindBootstrap,
	}
	validStable := ReplayCheckpoint{
		SchemaVersion:              CassetteSchemaVersion,
		Index:                      1,
		Kind:                       ReplayCheckpointKindAfterActivityEvent,
		AfterActivityEventSequence: 1,
	}
	tests := []struct {
		name        string
		checkpoints []ReplayCheckpoint
		count       uint64
		want        string
	}{
		{name: "empty", want: "empty"},
		{
			name: "unsupported schema",
			checkpoints: []ReplayCheckpoint{{
				SchemaVersion: CassetteSchemaVersion - 1,
				Kind:          ReplayCheckpointKindBootstrap,
			}},
			want: "unsupported schema",
		},
		{
			name: "missing bootstrap",
			checkpoints: []ReplayCheckpoint{{
				SchemaVersion:              CassetteSchemaVersion,
				Kind:                       ReplayCheckpointKindAfterActivityEvent,
				AfterActivityEventSequence: 1,
			}},
			count: 1,
			want:  "checkpoint 0 must be bootstrap",
		},
		{
			name: "non-contiguous index",
			checkpoints: []ReplayCheckpoint{
				validBootstrap,
				{
					SchemaVersion:              CassetteSchemaVersion,
					Index:                      2,
					Kind:                       ReplayCheckpointKindAfterActivityEvent,
					AfterActivityEventSequence: 1,
				},
			},
			count: 1,
			want:  "not contiguous",
		},
		{
			name: "non-monotonic event",
			checkpoints: []ReplayCheckpoint{
				validBootstrap,
				validStable,
				{
					SchemaVersion:              CassetteSchemaVersion,
					Index:                      2,
					Kind:                       ReplayCheckpointKindAfterActivityEvent,
					AfterActivityEventSequence: 1,
				},
			},
			count: 1,
			want:  "later recorded activity event",
		},
		{
			name:        "missing final boundary",
			checkpoints: []ReplayCheckpoint{validBootstrap, validStable},
			count:       2,
			want:        "final checkpoint",
		},
		{
			name: "unsorted provider cursors",
			checkpoints: []ReplayCheckpoint{
				validBootstrap,
				{
					SchemaVersion:              CassetteSchemaVersion,
					Index:                      1,
					Kind:                       ReplayCheckpointKindAfterActivityEvent,
					AfterActivityEventSequence: 1,
					ProviderMarker: ProviderCursorMarker{
						Connections: []ProviderConnectionCursor{
							{ConnectionID: "connection-2", Cursor: "1"},
							{ConnectionID: "connection-1", Cursor: "2"},
						},
					},
				},
			},
			count: 1,
			want:  "unique and sorted",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateReplayCheckpoints(test.checkpoints, test.count)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want containing %q", err, test.want)
			}
		})
	}
}
