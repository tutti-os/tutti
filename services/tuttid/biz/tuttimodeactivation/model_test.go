package tuttimodeactivation

import (
	"testing"
	"time"
)

func TestNormalizeActivationRequiresMatchingCurrentRevision(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	_, err := NormalizeActivation(Activation{
		ID: "activation-1", WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		CurrentRevision: Revision{
			ID: "revision-1", ActivationID: "another-activation", Revision: 1,
			State: StateActive, Source: SourceSlashCommand, CreatedAt: now,
		},
		CreatedAt: now, UpdatedAt: now,
	})
	if err == nil {
		t.Fatal("NormalizeActivation() error = nil, want mismatched revision error")
	}
}

func TestNormalizeRevisionEnforcesStateSourcePairs(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	for _, tc := range []struct {
		name   string
		state  State
		source Source
		valid  bool
	}{
		{name: "activate by slash command", state: StateActive, source: SourceSlashCommand, valid: true},
		{name: "deactivate by badge removal", state: StateInactive, source: SourceBadgeRemove, valid: true},
		{name: "active from removal", state: StateActive, source: SourceBadgeRemove},
		{name: "inactive from slash", state: StateInactive, source: SourceSlashCommand},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NormalizeRevision(Revision{
				ID: "revision-1", ActivationID: "activation-1", Revision: 1,
				State: tc.state, Source: tc.source, CreatedAt: now,
			})
			if tc.valid && err != nil {
				t.Fatalf("NormalizeRevision() error = %v", err)
			}
			if !tc.valid && err == nil {
				t.Fatal("NormalizeRevision() error = nil, want invalid pair error")
			}
		})
	}
}

func TestNormalizeTurnSnapshotAllowsExplicitUnconfiguredInactiveState(t *testing.T) {
	t.Parallel()
	snapshot, err := NormalizeTurnSnapshot(TurnSnapshot{State: StateInactive})
	if err != nil {
		t.Fatalf("NormalizeTurnSnapshot() error = %v", err)
	}
	if snapshot.ActivationID != "" || snapshot.RevisionID != "" || snapshot.Revision != 0 || snapshot.Source != "" {
		t.Fatalf("NormalizeTurnSnapshot() = %#v", snapshot)
	}
}

func TestNormalizeTurnSnapshotRejectsPartialRevisionIdentity(t *testing.T) {
	t.Parallel()
	_, err := NormalizeTurnSnapshot(TurnSnapshot{
		ActivationID: "activation-1",
		State:        StateActive,
		Source:       SourceSlashCommand,
	})
	if err == nil {
		t.Fatal("NormalizeTurnSnapshot() error = nil, want incomplete identity error")
	}
}
