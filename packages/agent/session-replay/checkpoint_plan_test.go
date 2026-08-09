package sessionreplay

import (
	"slices"
	"strings"
	"testing"
)

func activityAddress(kind EntityKind, sequence uint64) EntityAddress {
	return EntityAddress{
		Kind: kind,
		Origin: EntityOrigin{
			Source:                EntityOriginActivityEvent,
			ActivityEventSequence: sequence,
		},
	}
}

func providerAddress(
	kind EntityKind,
	position ProviderObservationPosition,
) EntityAddress {
	return EntityAddress{
		Kind: kind,
		Origin: EntityOrigin{
			Source:              EntityOriginProviderObservation,
			ProviderObservation: &position,
		},
	}
}

func checkpointFingerprint(
	t *testing.T,
	eventType string,
	address EntityAddress,
) string {
	t.Helper()
	fingerprint, err := ObservationFingerprint(ProviderObservation{
		SchemaVersion: ObservationSchemaVersion,
		Type:          eventType,
		Address:       address,
		Stable:        map[string]any{"status": "pending"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return fingerprint
}

func validCheckpointPlan(t *testing.T) CheckpointPlan {
	t.Helper()
	position := ProviderObservationPosition{
		ConnectionID: "connection-1",
		ChunkSeq:     64,
		UnitIndex:    2,
		EventIndex:   3,
	}
	turn := activityAddress(EntityKindTurn, 1)
	interaction := providerAddress(EntityKindInteraction, position)
	return NewCheckpointPlan([]ReplayCheckpoint{
		{
			ID:    "checkpoint-0000",
			Index: 0,
			Kind:  "replay.bootstrap",
			Tags:  []string{"replay.bootstrap"},
			Cursor: ReplayCursor{
				ProviderConnections: []ProviderUnitPosition{{
					ConnectionID: "connection-1",
				}},
			},
			Trigger: CheckpointTrigger{Source: CheckpointTriggerBootstrap},
			Readiness: CheckpointReadiness{
				All: []ReadinessPredicate{},
			},
		},
		{
			ID:    "checkpoint-0001",
			Index: 1,
			Kind:  "interaction.pending",
			Tags: []string{
				"turn.working",
				"interaction.pending",
			},
			Cursor: ReplayCursor{
				ActivityEventSequence: 1,
				ProviderConnections: []ProviderUnitPosition{{
					ConnectionID: "connection-1",
					ChunkSeq:     64,
					UnitIndex:    2,
				}},
			},
			Trigger: CheckpointTrigger{
				Source:      CheckpointTriggerProviderObservation,
				Position:    &position,
				UnitKind:    ProviderInputUnitProtocolMessage,
				Type:        "interaction.requested",
				Fingerprint: checkpointFingerprint(t, "interaction.requested", interaction),
			},
			Subjects: []EntityAddress{turn, interaction},
			Readiness: CheckpointReadiness{All: []ReadinessPredicate{
				{Type: "turn.phase", Subject: 0, Equals: "waiting_approval"},
				{Type: "interaction.status", Subject: 1, Equals: "pending"},
			}},
		},
	})
}

func TestValidateCheckpointPlan(t *testing.T) {
	plan := validCheckpointPlan(t)
	if err := ValidateCheckpointPlan(plan, []string{"connection-1"}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestValidateEntityAddressOrigins(t *testing.T) {
	position := ProviderObservationPosition{
		ConnectionID: "connection-1", ChunkSeq: 1, UnitIndex: 1, EventIndex: 1,
	}
	tests := []struct {
		name    string
		address EntityAddress
		valid   bool
	}{
		{
			name: "recording root",
			address: EntityAddress{
				Kind: EntityKindSession,
				Origin: EntityOrigin{
					Source: EntityOriginRecordingRoot,
				},
			},
			valid: true,
		},
		{
			name: "initial child session",
			address: EntityAddress{
				Kind: EntityKindSession,
				Origin: EntityOrigin{
					Source:           EntityOriginInitialState,
					InitialStatePath: "/agent/sessions/1",
				},
			},
			valid: true,
		},
		{
			name:    "activity turn",
			address: activityAddress(EntityKindTurn, 7),
			valid:   true,
		},
		{
			name:    "provider tool call",
			address: providerAddress(EntityKindToolCall, position),
			valid:   true,
		},
		{
			name: "root cannot be a turn",
			address: EntityAddress{
				Kind:   EntityKindTurn,
				Origin: EntityOrigin{Source: EntityOriginRecordingRoot},
			},
		},
		{
			name: "mixed union",
			address: EntityAddress{
				Kind: EntityKindMessage,
				Origin: EntityOrigin{
					Source:                EntityOriginActivityEvent,
					ActivityEventSequence: 2,
					ProviderObservation:   &position,
				},
			},
		},
		{
			name: "relative initial path",
			address: EntityAddress{
				Kind: EntityKindInteraction,
				Origin: EntityOrigin{
					Source:           EntityOriginInitialState,
					InitialStatePath: "agent/sessions/0/interactions/0",
				},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateEntityAddress(test.address)
			if test.valid && err != nil {
				t.Fatal(err)
			}
			if !test.valid && err == nil {
				t.Fatal("invalid entity address was accepted")
			}
		})
	}
}

func TestEntityAddressKeyUsesProviderPositionValue(t *testing.T) {
	position := ProviderObservationPosition{
		ConnectionID: "connection-1", ChunkSeq: 1, UnitIndex: 2, EventIndex: 3,
	}
	left := providerAddress(EntityKindToolCall, position)
	right := providerAddress(EntityKindToolCall, position)
	leftKey, err := EntityAddressKey(left)
	if err != nil {
		t.Fatal(err)
	}
	rightKey, err := EntityAddressKey(right)
	if err != nil {
		t.Fatal(err)
	}
	if leftKey != rightKey || !EntityAddressesEqual(left, right) {
		t.Fatalf("equal address keys differ: %q != %q", leftKey, rightKey)
	}
}

func TestMergeCheckpointCandidateDeduplicatesEntityAddresses(t *testing.T) {
	cursor := ReplayCursor{
		ActivityEventSequence: 1,
		ProviderConnections: []ProviderUnitPosition{{
			ConnectionID: "connection-1", ChunkSeq: 64, UnitIndex: 2,
		}},
	}
	turn := activityAddress(EntityKindTurn, 1)
	call := providerAddress(EntityKindToolCall, ProviderObservationPosition{
		ConnectionID: "connection-1", ChunkSeq: 64, UnitIndex: 1, EventIndex: 1,
	})
	plan := NewCheckpointPlan(nil)
	for _, checkpoint := range []ReplayCheckpoint{
		{
			Kind: "turn.working", Tags: []string{"turn.working"},
			Cursor:   cursor,
			Subjects: []EntityAddress{turn},
			Readiness: CheckpointReadiness{All: []ReadinessPredicate{{
				Type: "turn.phase", Subject: 0, Equals: "waiting_approval",
			}}},
		},
		{
			Kind: "tool.started", Tags: []string{"tool.started"},
			Cursor:   cursor,
			Subjects: []EntityAddress{turn, call},
			Readiness: CheckpointReadiness{All: []ReadinessPredicate{{
				Type: "call.status", Subject: 1, Equals: "running",
			}}},
		},
	} {
		AppendCheckpoint(&plan, checkpoint)
	}
	checkpoint := plan.Checkpoints[0]
	if len(checkpoint.Subjects) != 2 ||
		checkpoint.Readiness.All[0].Subject != 0 ||
		checkpoint.Readiness.All[1].Subject != 1 {
		t.Fatalf("coalesced checkpoint=%#v", checkpoint)
	}
}

func TestMergeCheckpointCandidateKeepsTurnWorkingOverCompaction(t *testing.T) {
	cursor := ReplayCursor{
		ActivityEventSequence: 5,
		ProviderConnections: []ProviderUnitPosition{{
			ConnectionID: "connection-1", ChunkSeq: 62, UnitIndex: 1,
		}},
	}
	turnPosition := ProviderObservationPosition{
		ConnectionID: "connection-1", ChunkSeq: 62, UnitIndex: 1, EventIndex: 1,
	}
	compactPosition := ProviderObservationPosition{
		ConnectionID: "connection-1", ChunkSeq: 62, UnitIndex: 1, EventIndex: 2,
	}
	turn := providerAddress(EntityKindTurn, turnPosition)
	startedFingerprint, err := ObservationFingerprint(ProviderObservation{
		SchemaVersion: ObservationSchemaVersion,
		Type:          "root_provider_turn.started",
		Address:       turn,
	})
	if err != nil {
		t.Fatal(err)
	}
	compactFingerprint, err := ObservationFingerprint(ProviderObservation{
		SchemaVersion: ObservationSchemaVersion,
		Type:          "compaction.updated",
		Address:       turn,
		Stable: map[string]any{
			"noticeCommand":       "compact",
			"noticeCommandStatus": "completed",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	merged := MergeCheckpointCandidate(
		ReplayCheckpoint{
			Kind: "turn.working", Tags: []string{"turn.working"},
			Cursor: cursor,
			Trigger: CheckpointTrigger{
				Source:      CheckpointTriggerProviderObservation,
				Position:    &turnPosition,
				UnitKind:    ProviderInputUnitProtocolMessage,
				Type:        "root_provider_turn.started",
				Fingerprint: startedFingerprint,
			},
			Subjects: []EntityAddress{turn},
			Readiness: CheckpointReadiness{All: []ReadinessPredicate{{
				Type: "turn.phase", Subject: 0, Equals: "running",
			}}},
		},
		ReplayCheckpoint{
			Kind: "compaction.completed", Tags: []string{"compaction.completed"},
			Cursor: cursor,
			Trigger: CheckpointTrigger{
				Source:      CheckpointTriggerProviderObservation,
				Position:    &compactPosition,
				UnitKind:    ProviderInputUnitProtocolMessage,
				Type:        "compaction.updated",
				Fingerprint: compactFingerprint,
			},
			Subjects: []EntityAddress{turn},
			Readiness: CheckpointReadiness{All: []ReadinessPredicate{{
				Type: "compaction.status", Subject: 0, Equals: "completed",
			}}},
		},
	)
	if merged.Kind != "turn.working" ||
		merged.Trigger.Type != "root_provider_turn.started" ||
		merged.Trigger.Fingerprint != startedFingerprint ||
		!slices.Contains(merged.Tags, "compaction.completed") {
		t.Fatalf("merged=%#v, want turn.working primary with compaction tag", merged)
	}
}

func TestMergeCheckpointCandidatePrefersTerminalOverToolCompleted(t *testing.T) {
	cursor := ReplayCursor{
		ActivityEventSequence: 1,
		ProviderConnections: []ProviderUnitPosition{{
			ConnectionID: "connection-1", ChunkSeq: 60, UnitIndex: 1,
		}},
	}
	turnPosition := ProviderObservationPosition{
		ConnectionID: "connection-1", ChunkSeq: 60, UnitIndex: 1, EventIndex: 2,
	}
	call := providerAddress(EntityKindToolCall, ProviderObservationPosition{
		ConnectionID: "connection-1", ChunkSeq: 60, UnitIndex: 1, EventIndex: 1,
	})
	turn := providerAddress(EntityKindTurn, turnPosition)
	fingerprint, err := ObservationFingerprint(ProviderObservation{
		SchemaVersion: ObservationSchemaVersion,
		Type:          "root_provider_turn.completed",
		Address:       turn,
	})
	if err != nil {
		t.Fatal(err)
	}
	plan := NewCheckpointPlan(nil)
	AppendCheckpoint(&plan, ReplayCheckpoint{
		Kind: "tool.completed", Tags: []string{"tool.completed"},
		Cursor: cursor,
		Trigger: CheckpointTrigger{
			Source: CheckpointTriggerProviderObservation,
			Position: &ProviderObservationPosition{
				ConnectionID: "connection-1", ChunkSeq: 60, UnitIndex: 1,
				EventIndex: 1,
			},
			UnitKind:    ProviderInputUnitProtocolMessage,
			Type:        "call.failed",
			Fingerprint: "sha256:" + strings.Repeat("b", 64),
		},
		Subjects: []EntityAddress{call},
		Readiness: CheckpointReadiness{All: []ReadinessPredicate{{
			Type: "call.status", Subject: 0, Equals: "failed",
		}}},
	})
	AppendCheckpoint(&plan, ReplayCheckpoint{
		Kind: "turn.terminal", Tags: []string{"turn.terminal"},
		Cursor: cursor,
		Trigger: CheckpointTrigger{
			Source:      CheckpointTriggerProviderObservation,
			Position:    &turnPosition,
			UnitKind:    ProviderInputUnitProtocolMessage,
			Type:        "root_provider_turn.completed",
			Fingerprint: fingerprint,
		},
		Subjects: []EntityAddress{turn},
		Readiness: CheckpointReadiness{All: []ReadinessPredicate{{
			Type: "turn.status", Subject: 0, Equals: "completed",
		}}},
	})
	if len(plan.Checkpoints) != 1 {
		t.Fatalf("checkpoints=%#v, want one coalesced terminal", plan.Checkpoints)
	}
	checkpoint := plan.Checkpoints[0]
	if checkpoint.Kind != "turn.terminal" ||
		!slices.Contains(checkpoint.Tags, "tool.completed") ||
		!slices.Contains(checkpoint.Tags, "turn.terminal") {
		t.Fatalf("terminal merge=%#v", checkpoint)
	}
	if err := ValidatePublishedCheckpointPlan(plan); err != nil {
		t.Fatalf("published plan error=%v", err)
	}
}

func TestAppendCheckpointFoldsInteractionResolvedIntoTerminal(t *testing.T) {
	terminalCursor := ReplayCursor{
		ActivityEventSequence: 1,
		ProviderConnections: []ProviderUnitPosition{{
			ConnectionID: "connection-1", ChunkSeq: 60, UnitIndex: 1,
		}},
	}
	resolvedCursor := ReplayCursor{
		ActivityEventSequence: 4,
		ProviderConnections: []ProviderUnitPosition{{
			ConnectionID: "connection-1", ChunkSeq: 60, UnitIndex: 1,
		}},
	}
	turnPosition := ProviderObservationPosition{
		ConnectionID: "connection-1", ChunkSeq: 60, UnitIndex: 1, EventIndex: 1,
	}
	turn := providerAddress(EntityKindTurn, turnPosition)
	interaction := activityAddress(EntityKindInteraction, 4)
	fingerprint, err := ObservationFingerprint(ProviderObservation{
		SchemaVersion: ObservationSchemaVersion,
		Type:          "root_provider_turn.completed",
		Address:       turn,
	})
	if err != nil {
		t.Fatal(err)
	}
	plan := NewCheckpointPlan(nil)
	AppendCheckpoint(&plan, ReplayCheckpoint{
		Kind: "turn.terminal", Tags: []string{"turn.terminal"},
		Cursor: terminalCursor,
		Trigger: CheckpointTrigger{
			Source:      CheckpointTriggerProviderObservation,
			Position:    &turnPosition,
			UnitKind:    ProviderInputUnitProtocolMessage,
			Type:        "root_provider_turn.completed",
			Fingerprint: fingerprint,
		},
		Subjects: []EntityAddress{turn},
		Readiness: CheckpointReadiness{All: []ReadinessPredicate{{
			Type: "turn.status", Subject: 0, Equals: "completed",
		}}},
	})
	AppendCheckpoint(&plan, ReplayCheckpoint{
		Kind: "interaction.resolved", Tags: []string{"interaction.resolved"},
		Cursor: resolvedCursor,
		Trigger: CheckpointTrigger{
			Source:                     CheckpointTriggerActivityBoundary,
			AfterActivityEventSequence: 4,
			BoundaryKind:               ActivityBoundaryIntentEffects,
		},
		Subjects: []EntityAddress{interaction},
		Readiness: CheckpointReadiness{All: []ReadinessPredicate{{
			Type: "interaction.status", Subject: 0, Equals: "answered",
		}}},
	})
	if len(plan.Checkpoints) != 1 {
		t.Fatalf("checkpoints=%#v, want folded terminal", plan.Checkpoints)
	}
	checkpoint := plan.Checkpoints[0]
	if checkpoint.Kind != "turn.terminal" ||
		checkpoint.Cursor.ActivityEventSequence != 4 ||
		!slices.Contains(checkpoint.Tags, "interaction.resolved") {
		t.Fatalf("folded terminal=%#v", checkpoint)
	}
	if err := ValidatePublishedCheckpointPlan(plan); err != nil {
		t.Fatalf("published plan error=%v", err)
	}
}

func TestCheckpointPlanRejectsOldCheckpointSchema(t *testing.T) {
	plan := validCheckpointPlan(t)
	plan.SchemaVersion = 1
	if err := ValidateCheckpointPlan(plan, []string{"connection-1"}, nil); err == nil {
		t.Fatal("v1 checkpoint plan was accepted")
	}
}

func TestCheckpointPlanRejectsFingerprintMismatchShape(t *testing.T) {
	plan := validCheckpointPlan(t)
	plan.Checkpoints[1].Trigger.Fingerprint = "sha256:not-a-digest"
	if err := ValidateCheckpointPlan(plan, []string{"connection-1"}, nil); err == nil ||
		!strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("fingerprint error = %v", err)
	}
}

func TestCheckpointPlanRejectsCursorRegressionAndDuplicateStop(t *testing.T) {
	t.Run("regression", func(t *testing.T) {
		plan := validCheckpointPlan(t)
		lastCheckpoint := plan.Checkpoints[1]
		lastCheckpoint.Cursor.ProviderConnections = append(
			[]ProviderUnitPosition(nil),
			lastCheckpoint.Cursor.ProviderConnections...,
		)
		plan.Checkpoints = append(plan.Checkpoints, lastCheckpoint)
		last := &plan.Checkpoints[2]
		last.ID = "checkpoint-0002"
		last.Index = 2
		last.Cursor.ProviderConnections[0].ChunkSeq = 63
		if err := ValidateCheckpointPlan(plan, []string{"connection-1"}, nil); err == nil ||
			!strings.Contains(err.Error(), "backward") {
			t.Fatalf("regression error = %v", err)
		}
	})
	t.Run("duplicate cursor", func(t *testing.T) {
		plan := validCheckpointPlan(t)
		duplicate := plan.Checkpoints[1]
		duplicate.Cursor.ProviderConnections = append(
			[]ProviderUnitPosition(nil),
			duplicate.Cursor.ProviderConnections...,
		)
		duplicate.ID = "checkpoint-0002"
		duplicate.Index = 2
		plan.Checkpoints = append(plan.Checkpoints, duplicate)
		if err := ValidateCheckpointPlan(plan, []string{"connection-1"}, nil); err == nil ||
			!strings.Contains(err.Error(), "coalesced") {
			t.Fatalf("duplicate cursor error = %v", err)
		}
	})
}

func TestCheckpointPlanRejectsActivityBoundarySplittingEffects(t *testing.T) {
	events := []ActivityEvent{
		{
			SchemaVersion: CassetteSchemaVersion,
			Sequence:      1,
			Kind:          ActivityEventKindIntent,
			Type:          "submit/requested",
			EventID:       "intent-1",
			OccurredAtMS:  1,
		},
		{
			SchemaVersion:   CassetteSchemaVersion,
			Sequence:        2,
			Kind:            ActivityEventKindEffect,
			Type:            "session/activate",
			EventID:         "effect-1",
			CausedByEventID: "intent-1",
			OccurredAtMS:    2,
		},
	}
	plan := validCheckpointPlan(t)
	plan.Checkpoints[1].Cursor.ActivityEventSequence = 1
	plan.Checkpoints[1].Cursor.ProviderConnections[0] = ProviderUnitPosition{
		ConnectionID: "connection-1",
	}
	plan.Checkpoints[1].Trigger = CheckpointTrigger{
		Source:                     CheckpointTriggerActivityBoundary,
		AfterActivityEventSequence: 1,
		BoundaryKind:               ActivityBoundaryIntentEffects,
	}
	if err := ValidateCheckpointPlan(plan, []string{"connection-1"}, events); err == nil ||
		!strings.Contains(err.Error(), "splits") {
		t.Fatalf("split boundary error = %v", err)
	}
}

func TestValidateCheckpointPlanRejectsIncompleteActivityTimeline(t *testing.T) {
	intentType, _ := contractIntentByRequirement(t, true, true)
	events := []ActivityEvent{{
		SchemaVersion: CassetteSchemaVersion,
		Sequence:      1,
		Kind:          ActivityEventKindIntent,
		Type:          intentType,
		EventID:       "intent-1",
		CorrelationID: "correlation-1",
		OccurredAtMS:  1,
	}}
	plan := validCheckpointPlan(t)
	if err := ValidateCheckpointPlan(plan, []string{"connection-1"}, events); err == nil ||
		!strings.Contains(err.Error(), "requires at least one effect") {
		t.Fatalf("incomplete cassette timeline error = %v", err)
	}
}

func TestObservationFingerprintIsStableAcrossMapOrder(t *testing.T) {
	address := activityAddress(EntityKindTurn, 1)
	left, err := ObservationFingerprint(ProviderObservation{
		SchemaVersion: ObservationSchemaVersion,
		Type:          "turn.phase",
		Address:       address,
		Stable:        map[string]any{"phase": "waiting_approval", "status": "running"},
	})
	if err != nil {
		t.Fatal(err)
	}
	right, err := ObservationFingerprint(ProviderObservation{
		SchemaVersion: ObservationSchemaVersion,
		Type:          "turn.phase",
		Address:       address,
		Stable:        map[string]any{"status": "running", "phase": "waiting_approval"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if left != right {
		t.Fatalf("fingerprints differ: %q != %q", left, right)
	}
}

func TestCheckpointJournalRequiresExactConfirmedAddress(t *testing.T) {
	plan := validCheckpointPlan(t)
	trigger := plan.Checkpoints[1].Trigger
	address := plan.Checkpoints[1].Subjects[1]
	entry := ObservationJournalEntry{
		SchemaVersion: ObservationSchemaVersion,
		Position: ProviderUnitPosition{
			ConnectionID: trigger.Position.ConnectionID,
			ChunkSeq:     trigger.Position.ChunkSeq,
			UnitIndex:    trigger.Position.UnitIndex,
		},
		UnitKind: trigger.UnitKind,
		Observations: []JournalObservation{{
			Position:    *trigger.Position,
			Type:        trigger.Type,
			Fingerprint: trigger.Fingerprint,
			Address:     address,
		}},
		Correlations: []CheckpointCommitCorrelation{{
			ID: "interaction-commit", Kind: "interaction.status",
			Address:                activityAddress(EntityKindInteraction, 1),
			ObservationPosition:    *trigger.Position,
			ObservationFingerprint: trigger.Fingerprint,
			Expected:               "pending",
			Confirmed:              true,
			TransactionID:          "transaction-1",
		}},
	}
	err := ValidateCheckpointJournalAnchors(plan, []ObservationJournalEntry{entry})
	if err == nil || !strings.Contains(err.Error(), "no exact commit correlation") {
		t.Fatalf("wrong-address correlation error = %v", err)
	}
	entry.Correlations[0].Address = address
	entry.Correlations[0].Confirmed = false
	if err := ValidateCheckpointJournalAnchors(
		plan,
		[]ObservationJournalEntry{entry},
	); err == nil || !strings.Contains(err.Error(), "checkpoint_commit_unconfirmed") {
		t.Fatalf("unconfirmed correlation error = %v", err)
	}
	entry.Correlations[0].Confirmed = true
	if err := ValidateCheckpointJournalAnchors(
		plan,
		[]ObservationJournalEntry{entry},
	); err != nil {
		t.Fatal(err)
	}
	entry.Correlations[0].ObservationPosition.EventIndex++
	if err := ValidateCheckpointJournalAnchors(
		plan,
		[]ObservationJournalEntry{entry},
	); err == nil || !strings.Contains(err.Error(), "no exact commit correlation") {
		t.Fatalf("wrong observation correlation error = %v", err)
	}
	entry.Correlations[0].ObservationPosition = *trigger.Position
	entry.Correlations[0].ObservationFingerprint = "sha256:" +
		strings.Repeat("a", 64)
	if err := ValidateCheckpointJournalAnchors(
		plan,
		[]ObservationJournalEntry{entry},
	); err == nil || !strings.Contains(err.Error(), "no exact commit correlation") {
		t.Fatalf("wrong fingerprint correlation error = %v", err)
	}
	entry.Correlations[0].ObservationFingerprint = trigger.Fingerprint
	entry.Observations[0].Address = plan.Checkpoints[1].Subjects[0]
	if err := ValidateCheckpointJournalAnchors(
		plan,
		[]ObservationJournalEntry{entry},
	); err == nil || !strings.Contains(err.Error(), "checkpoint_commit_unconfirmed") {
		t.Fatalf("mismatched observation error = %v", err)
	}
}

func TestPublishedCheckpointPlanRequiresTerminalFinalCheckpoint(t *testing.T) {
	plan := validCheckpointPlan(t)
	if err := ValidatePublishedCheckpointPlan(plan); err == nil {
		t.Fatal("non-terminal final checkpoint was accepted")
	}
	last := &plan.Checkpoints[len(plan.Checkpoints)-1]
	last.Kind = "turn.terminal"
	last.Tags = append(last.Tags, "turn.terminal")
	if err := ValidatePublishedCheckpointPlan(plan); err != nil {
		t.Fatalf("terminal plan error=%v", err)
	}
}
