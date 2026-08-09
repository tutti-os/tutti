package sessionreplay

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestProviderEntityAddressIsStableAcrossRuntimeIDs(t *testing.T) {
	position := ProviderObservationPosition{
		ConnectionID: "provider-connection",
		ChunkSeq:     4,
		UnitIndex:    2,
		EventIndex:   1,
	}
	firstRegistry := newReplayEntityRegistry("record-runtime-session")
	secondRegistry := newReplayEntityRegistry("replay-runtime-session")

	first, firstOK := firstRegistry.providerAddresses(
		position,
		ProviderObservationEvent{
			EventIndex:     1,
			Type:           "call.started",
			AgentSessionID: "record-runtime-session",
			TurnID:         "record-runtime-turn",
			CallID:         "record-runtime-call",
		},
	)
	second, secondOK := secondRegistry.providerAddresses(
		position,
		ProviderObservationEvent{
			EventIndex:     1,
			Type:           "call.started",
			AgentSessionID: "replay-runtime-session",
			TurnID:         "replay-runtime-turn",
			CallID:         "replay-runtime-call",
		},
	)
	if !firstOK || !secondOK || len(first) != 1 || len(second) != 1 {
		t.Fatalf(
			"provider addresses missing: first=%#v/%v second=%#v/%v",
			first,
			firstOK,
			second,
			secondOK,
		)
	}
	if !EntityAddressesEqual(first[0], second[0]) {
		t.Fatalf(
			"runtime IDs changed portable address: first=%#v second=%#v",
			first[0],
			second[0],
		)
	}
	encoded, err := json.Marshal(first[0])
	if err != nil {
		t.Fatalf("marshal EntityAddress: %v", err)
	}
	for _, runtimeID := range []string{
		"record-runtime-session",
		"record-runtime-turn",
		"record-runtime-call",
	} {
		if strings.Contains(string(encoded), runtimeID) {
			t.Fatalf(
				"serialized EntityAddress contains runtime ID %q: %s",
				runtimeID,
				encoded,
			)
		}
	}
}

func TestDescribeProviderEventFoldsTurnPhaseToCanonicalVocabulary(
	t *testing.T,
) {
	tests := map[string]string{
		"":                 "running",
		"working":          "running",
		"streaming":        "running",
		"running":          "running",
		"waiting_approval": "waiting",
		"waiting_input":    "waiting",
		"waiting":          "waiting",
		"settled":          "settled",
	}
	for observed, want := range tests {
		predicate, kind, ok := describeProviderEvent(
			ProviderObservationEvent{
				Type:      "turn.updated",
				TurnPhase: observed,
			},
		)
		if !ok || kind != "turn.working" {
			t.Fatalf("turn.updated %q: kind=%q ok=%v", observed, kind, ok)
		}
		if predicate.Type != "turn.phase" || predicate.Equals != want {
			t.Fatalf(
				"turn.updated %q predicate = %#v, want turn.phase %q",
				observed,
				predicate,
				want,
			)
		}
	}
}

func TestTerminalCorrelationPrefersOutcomeOverIdleStatus(t *testing.T) {
	event := ProviderObservationEvent{
		Type:        "turn.completed",
		TurnPhase:   "idle",
		TurnOutcome: "completed",
		Status:      "idle",
	}
	if got := correlationExpected(event); got != "completed" {
		t.Fatalf("terminal correlation expected = %q, want completed", got)
	}
}

func providerPosition(eventIndex uint64) ProviderObservationPosition {
	return ProviderObservationPosition{
		ConnectionID: "provider-1",
		ChunkSeq:     eventIndex,
		UnitIndex:    1,
		EventIndex:   eventIndex,
	}
}

func TestProviderEntityAddressesReuseUpdatesAndKeepRuntimeScopes(
	t *testing.T,
) {
	registry := newReplayEntityRegistry("root-runtime")
	firstTurn, ok := registry.providerAddresses(
		providerPosition(1),
		ProviderObservationEvent{
			EventIndex:     1,
			Type:           "turn.started",
			AgentSessionID: "root-runtime",
			TurnID:         "turn-shared",
		},
	)
	if !ok {
		t.Fatal("first Turn address was not created")
	}
	updatedTurn, ok := registry.providerAddresses(
		providerPosition(2),
		ProviderObservationEvent{
			EventIndex:     2,
			Type:           "turn.updated",
			AgentSessionID: "root-runtime",
			TurnID:         "turn-shared",
		},
	)
	if !ok || !EntityAddressesEqual(
		firstTurn[0],
		updatedTurn[0],
	) {
		t.Fatalf(
			"Turn update changed address: first=%#v update=%#v",
			firstTurn,
			updatedTurn,
		)
	}

	if _, ok := registry.providerAddresses(
		providerPosition(3),
		ProviderObservationEvent{
			EventIndex:           3,
			Type:                 "session.started",
			AgentSessionID:       "child-runtime",
			SessionKind:          "child",
			RootAgentSessionID:   "root-runtime",
			ParentAgentSessionID: "root-runtime",
		},
	); !ok {
		t.Fatal("child Session address was not created")
	}
	childTurn, ok := registry.providerAddresses(
		providerPosition(4),
		ProviderObservationEvent{
			EventIndex:     4,
			Type:           "turn.started",
			AgentSessionID: "child-runtime",
			SessionKind:    "child",
			TurnID:         "turn-shared",
		},
	)
	if !ok || EntityAddressesEqual(
		firstTurn[0],
		childTurn[0],
	) {
		t.Fatalf(
			"same Turn ID in different Sessions shared address: %#v %#v",
			firstTurn,
			childTurn,
		)
	}

	firstCall, ok := registry.providerAddresses(
		providerPosition(5),
		ProviderObservationEvent{
			EventIndex:     5,
			Type:           "call.started",
			AgentSessionID: "root-runtime",
			TurnID:         "turn-shared",
			CallID:         "call-shared",
		},
	)
	if !ok {
		t.Fatal("first Call address was not created")
	}
	secondTurn, ok := registry.providerAddresses(
		providerPosition(6),
		ProviderObservationEvent{
			EventIndex:     6,
			Type:           "turn.started",
			AgentSessionID: "root-runtime",
			TurnID:         "turn-2",
		},
	)
	if !ok || len(secondTurn) != 1 {
		t.Fatal("second Turn address was not created")
	}
	secondCall, ok := registry.providerAddresses(
		providerPosition(7),
		ProviderObservationEvent{
			EventIndex:     7,
			Type:           "call.started",
			AgentSessionID: "root-runtime",
			TurnID:         "turn-2",
			CallID:         "call-shared",
		},
	)
	if !ok || EntityAddressesEqual(
		firstCall[0],
		secondCall[0],
	) {
		t.Fatal("same Call ID in different Turns shared address")
	}

	firstInteraction, ok := registry.providerAddresses(
		providerPosition(8),
		ProviderObservationEvent{
			EventIndex: 8, Type: "interaction.requested",
			AgentSessionID: "root-runtime", TurnID: "turn-2",
			InteractionID: "request-shared", InteractionKind: "approval",
		},
	)
	if !ok {
		t.Fatal("first Interaction address was not created")
	}
	secondInteraction, ok := registry.providerAddresses(
		providerPosition(9),
		ProviderObservationEvent{
			EventIndex: 9, Type: "interaction.requested",
			AgentSessionID: "root-runtime", TurnID: "turn-2",
			InteractionID: "request-shared", InteractionKind: "question",
		},
	)
	if !ok || EntityAddressesEqual(
		firstInteraction[0],
		secondInteraction[0],
	) {
		t.Fatal("same Interaction ID with different kinds shared address")
	}
}

func TestProviderEntityAddressRejectsMissingRequiredTurn(t *testing.T) {
	registry := newReplayEntityRegistry("root-runtime")
	for _, event := range []ProviderObservationEvent{
		{
			EventIndex: 1, Type: "turn.started",
			AgentSessionID: "root-runtime",
		},
		{
			EventIndex: 2, Type: "call.started",
			AgentSessionID: "root-runtime", CallID: "call-1",
		},
		{
			EventIndex: 3, Type: "interaction.requested",
			AgentSessionID: "root-runtime", InteractionID: "request-1",
		},
		{
			EventIndex: 4, Type: "compaction.updated",
			AgentSessionID:      "root-runtime",
			NoticeCommand:       "compact",
			NoticeCommandStatus: "completed",
		},
		{
			EventIndex: 5, Type: "attachment.materialized",
			AgentSessionID: "root-runtime",
			MessageID:      "message-1", AttachmentCount: 1,
		},
	} {
		if _, ok := registry.providerAddresses(
			providerPosition(event.EventIndex),
			event,
		); ok {
			t.Fatalf("%s without Turn ID was accepted", event.Type)
		}
	}
}

func TestAttachmentUpdateReusesExistingAddresses(t *testing.T) {
	registry := newReplayEntityRegistry("root-runtime")
	first, ok := registry.providerAddresses(
		providerPosition(1),
		ProviderObservationEvent{
			EventIndex: 1, Type: "attachment.materialized",
			AgentSessionID: "root-runtime", TurnID: "turn-1",
			MessageID: "message-1", AttachmentCount: 1,
		},
	)
	if !ok || len(first) != 1 {
		t.Fatalf("first attachment addresses=%#v ok=%v", first, ok)
	}
	update, ok := registry.providerAddresses(
		providerPosition(2),
		ProviderObservationEvent{
			EventIndex: 2, Type: "attachment.materialized",
			AgentSessionID: "root-runtime", TurnID: "turn-1",
			MessageID: "message-1", AttachmentCount: 2,
		},
	)
	if !ok || len(update) != 2 ||
		!EntityAddressesEqual(first[0], update[0]) ||
		update[1].Origin.ProviderObservation == nil ||
		update[1].Origin.ProviderObservation.EventIndex != 2 {
		t.Fatalf("attachment update addresses=%#v", update)
	}
}

func TestContinueInitialStateSeedsStructuralAddressesAndActivityTargetsChild(
	t *testing.T,
) {
	state := TuttiReplayState{
		SchemaVersion: SchemaVersion,
		Agent: agenthost.HistoricalSessionGraph{
			RootSessionID: "root-runtime",
			Sessions: []agenthost.HistoricalSession{
				{
					ID: "root-runtime", Kind: "root",
					AgentTargetID: "local:codex",
					Provider:      "codex", ProviderSessionID: "provider-root",
					Settings:     map[string]any{},
					Turns:        []agenthost.HistoricalTurn{},
					Messages:     []agenthost.HistoricalMessage{},
					Interactions: []agenthost.HistoricalInteraction{},
				},
				{
					ID: "child-runtime", Kind: "child",
					RootSessionID:   "root-runtime",
					ParentSessionID: "root-runtime",
					AgentTargetID:   "local:codex",
					Provider:        "codex", ProviderSessionID: "provider-child",
					Settings: map[string]any{},
					Turns: []agenthost.HistoricalTurn{{
						ID: "turn-existing",
					}},
					Messages: []agenthost.HistoricalMessage{},
					Interactions: []agenthost.HistoricalInteraction{{
						RequestID: "request-existing",
						TurnID:    "turn-existing", Kind: "approval",
					}},
				},
			},
		},
	}
	var recorder checkpointRecorder
	recorder.reset(Recording{
		ID:                 "recording-1",
		RootAgentSessionID: "root-runtime",
	})
	if err := recorder.entities.seedState(state); err != nil {
		t.Fatal(err)
	}
	kind, address, _, ok := recorder.describeActivity(ActivityEvent{
		SchemaVersion:  CassetteSchemaVersion,
		Sequence:       1,
		Kind:           ActivityEventKindEffect,
		Type:           "interaction/respond",
		AgentSessionID: "child-runtime",
		Payload: map[string]any{
			"outcome":   "succeeded",
			"turnId":    "turn-existing",
			"requestId": "request-existing",
		},
	})
	if !ok || kind != "interaction.resolved" ||
		address.Origin.Source != EntityOriginInitialState ||
		address.Origin.InitialStatePath !=
			"/agent/sessions/1/interactions/0" {
		t.Fatalf("child interaction address=%#v kind=%q ok=%v", address, kind, ok)
	}
	_, settingsAddress, _, ok := recorder.describeActivity(
		ActivityEvent{
			Sequence: 2, Type: "session/updateSettings",
			AgentSessionID: "child-runtime",
			Payload:        map[string]any{"outcome": "succeeded"},
		},
	)
	if !ok ||
		settingsAddress.Origin.InitialStatePath != "/agent/sessions/1" {
		t.Fatalf("child settings address=%#v ok=%v", settingsAddress, ok)
	}
}

func TestCandidateCorrelationCarriesExactObservationIdentity(t *testing.T) {
	var recorder checkpointRecorder
	recorder.reset(Recording{
		ID:                 "recording-1",
		RootAgentSessionID: "root-runtime",
	})
	position := ProviderUnitPosition{
		ConnectionID: "provider-1", ChunkSeq: 1, UnitIndex: 1,
	}
	entry, _, ok, err := recorder.buildCandidate(
		RecordingCursorSnapshot{
			ActivityEventSequence: 1,
		},
		position,
		ProviderObservationBatch{
			ConnectionID: position.ConnectionID,
			ChunkSeq:     position.ChunkSeq, UnitIndex: position.UnitIndex,
			UnitKind: string(ProviderInputUnitProtocolMessage),
			Events: []ProviderObservationEvent{{
				EventIndex: 1, Type: "turn.started",
				AgentSessionID: "root-runtime",
				TurnID:         "turn-runtime", TurnPhase: "working",
			}},
		},
	)
	if err != nil || !ok || len(entry.Correlations) != 1 ||
		len(entry.Observations) != 1 {
		t.Fatalf("candidate entry=%#v ok=%v err=%v", entry, ok, err)
	}
	correlation := entry.Correlations[0]
	observation := entry.Observations[0]
	if correlation.ObservationPosition != observation.Position ||
		correlation.ObservationFingerprint != observation.Fingerprint ||
		!EntityAddressesEqual(
			correlation.Address,
			observation.Address,
		) {
		t.Fatalf(
			"correlation=%#v observation=%#v",
			correlation,
			observation,
		)
	}
}

func TestLateStartInitializationDoesNotOverwriteEarlyProviderState(
	t *testing.T,
) {
	recording := Recording{
		ID:                 "recording-1",
		RootAgentSessionID: "root-runtime",
	}
	var recorder checkpointRecorder
	if err := recorder.ensureInitialized(recording, nil); err != nil {
		t.Fatal(err)
	}
	addresses, ok := recorder.entities.providerAddresses(
		providerPosition(1),
		ProviderObservationEvent{
			EventIndex:     1,
			Type:           "turn.started",
			AgentSessionID: "root-runtime",
			TurnID:         "turn-early",
		},
	)
	if !ok {
		t.Fatal("early Provider address was not recorded")
	}
	recorder.plan.Checkpoints = append(
		recorder.plan.Checkpoints,
		ReplayCheckpoint{ID: "early"},
	)

	if err := recorder.ensureInitialized(recording, nil); err != nil {
		t.Fatal(err)
	}
	reused, ok := recorder.entities.turnAddress(
		"root-runtime",
		"turn-early",
	)
	if !ok || !EntityAddressesEqual(addresses[0], reused) ||
		len(recorder.plan.Checkpoints) != 2 {
		t.Fatalf(
			"late initialization overwrote early state: address=%#v plan=%#v",
			reused,
			recorder.plan,
		)
	}
}

func TestCompletedFirstTurnBindsBirthAddressFromPlan(t *testing.T) {
	startedPos := ProviderObservationPosition{
		ConnectionID: "connection-1",
		ChunkSeq:     21,
		UnitIndex:    1,
		EventIndex:   1,
	}
	completedPos := ProviderObservationPosition{
		ConnectionID: "connection-1",
		ChunkSeq:     30,
		UnitIndex:    1,
		EventIndex:   1,
	}
	plan := NewCheckpointPlan([]ReplayCheckpoint{
		{
			ID:    "checkpoint-0001",
			Index: 0,
			Kind:  "turn.working",
			Trigger: CheckpointTrigger{
				Source:   CheckpointTriggerProviderObservation,
				Position: &startedPos,
				UnitKind: ProviderInputUnitProtocolMessage,
				Type:     "root_provider_turn.started",
			},
			Subjects: []EntityAddress{{
				Kind: EntityKindTurn,
				Origin: EntityOrigin{
					Source:              EntityOriginProviderObservation,
					ProviderObservation: &startedPos,
				},
			}},
		},
		{
			ID:    "checkpoint-0003",
			Index: 1,
			Kind:  "turn.terminal",
			Trigger: CheckpointTrigger{
				Source:   CheckpointTriggerProviderObservation,
				Position: &completedPos,
				UnitKind: ProviderInputUnitProtocolMessage,
				Type:     "root_provider_turn.completed",
			},
			Subjects: []EntityAddress{{
				Kind: EntityKindTurn,
				Origin: EntityOrigin{
					Source:              EntityOriginProviderObservation,
					ProviderObservation: &startedPos,
				},
			}},
		},
	})

	registry := newReplayEntityRegistry("session-1")
	completedAddresses, ok := registry.providerAddressesForPlan(
		completedPos,
		ProviderObservationEvent{
			EventIndex:     1,
			Type:           "root_provider_turn.completed",
			AgentSessionID: "session-1",
			TurnID:         "turn-1",
			TurnPhase:      "settled",
			TurnOutcome:    "canceled",
		},
		plan,
	)
	if !ok || len(completedAddresses) != 1 {
		t.Fatalf("completed bind failed: %#v ok=%v", completedAddresses, ok)
	}
	wantAddress := replayProviderAddress(EntityKindTurn, startedPos, "")
	if !EntityAddressesEqual(completedAddresses[0], wantAddress) {
		t.Fatalf(
			"completed-first address=%#v want birth %#v",
			completedAddresses[0],
			wantAddress,
		)
	}

	startedFP, err := ObservationFingerprint(ProviderObservation{
		SchemaVersion: ObservationSchemaVersion,
		Type:          "root_provider_turn.completed",
		Address:       wantAddress,
		Stable: map[string]any{
			"turnOutcome": "canceled",
			"turnPhase":   "settled",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	actualFP, err := ObservationFingerprint(ProviderObservation{
		SchemaVersion: ObservationSchemaVersion,
		Type:          "root_provider_turn.completed",
		Address:       completedAddresses[0],
		Stable: map[string]any{
			"turnOutcome": "canceled",
			"turnPhase":   "settled",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if actualFP != startedFP {
		t.Fatalf("fingerprint diverged: got %s want %s", actualFP, startedFP)
	}
}

func TestQueuedSubmitActivityBoundaryWaitsForDrainEffect(t *testing.T) {
	if !activityIntentRequiresEffect("submit/requested") {
		t.Fatal("submit/requested must require an effect for checkpoint boundaries")
	}
	if !activityIntentRequiresEffect("activation/requested") {
		t.Fatal("activation/requested still requires an effect")
	}
	if !activityIntentRequiresEffect("session/stopRequested") {
		t.Fatal("stopRequested declares turn/cancel and must defer checkpoint cuts")
	}
	if !activityIntentRequiresEffect("session/cancelRequested") {
		t.Fatal("cancelRequested declares turn/cancel and must defer checkpoint cuts")
	}
	if activityIntentRequiresEffect("queue/enqueued") {
		t.Fatal("queue/enqueued has no declared effects")
	}
	var recorder checkpointRecorder
	queued := ActivityEvent{
		Kind:           ActivityEventKindIntent,
		Type:           "submit/requested",
		EventID:        "submit-queued",
		AgentSessionID: "session-1",
		Payload: map[string]any{
			"submitDiagnostics": map[string]any{"queued": true},
		},
	}
	if got := recorder.completeActivityBoundary([]ActivityEvent{queued}); got != nil {
		t.Fatalf("queued submit without drain effect must suppress boundary: %#v", got)
	}
	drain := ActivityEvent{
		Kind:            ActivityEventKindEffect,
		Type:            "queue/sendPrompt",
		EventID:         "send-1",
		CausedByEventID: "submit-queued",
		AgentSessionID:  "session-1",
	}
	got := recorder.completeActivityBoundary([]ActivityEvent{drain})
	if len(got) != 2 {
		t.Fatalf("drain should complete queued submit boundary: %#v", got)
	}
}

func TestActivityBoundaryDefersWhileEarlierIntentPending(t *testing.T) {
	ctx := context.Background()
	artifacts := &activityEventArtifactStore{}
	store := &serviceMetadataStore{}
	service := &Service{Workflow: &Workflow{
		States:    serviceFixtureStore{},
		Artifacts: artifacts,
		Transport: serviceRecorder{},
		Store:     store,
		NewID:     func() string { return "recording-pending-intent" },
	}}
	recording, err := service.Start(ctx, StartInput{
		WorkspaceID: "workspace-1", AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Bind(ctx, BindInput{
		RecordingID: recording.ID, WorkspaceID: "workspace-1",
		AgentTargetID: "local:codex", AgentSessionID: "session-1",
	}); err != nil {
		t.Fatal(err)
	}
	if err := service.RecordActivityEvent(ctx, RecordingActivityEvent{
		Kind: ActivityEventKindIntent, Type: "session/stopRequested",
		EventID: "cancel-intent", WorkspaceID: "workspace-1",
		AgentSessionID: "session-1",
	}); err != nil {
		t.Fatal(err)
	}
	if err := service.RecordActivityEvent(ctx, RecordingActivityEvent{
		Kind: ActivityEventKindIntent, Type: "activation/requested",
		EventID: "activation-intent", WorkspaceID: "workspace-1",
		AgentSessionID: "session-1",
	}); err != nil {
		t.Fatal(err)
	}
	if err := service.RecordActivityEvent(ctx, RecordingActivityEvent{
		Kind: ActivityEventKindEffect, Type: "session/activate",
		EventID: "activate-1", CausedByEventID: "activation-intent",
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		Payload: map[string]any{"outcome": "succeeded"},
	}); err != nil {
		t.Fatal(err)
	}
	for _, checkpoint := range service.checkpoints.plan.Checkpoints {
		if checkpoint.Trigger.Source == CheckpointTriggerActivityBoundary {
			t.Fatalf(
				"must not cut activity boundary while cancel intent is pending: %#v",
				checkpoint,
			)
		}
	}
	if _, pending := service.checkpoints.pendingActivityIntents["cancel-intent"]; !pending {
		t.Fatal("cancel intent should remain pending across interleaved activation")
	}
	if got := service.checkpoints.completeActivityBoundary([]ActivityEvent{{
		Kind:            ActivityEventKindEffect,
		Type:            "turn/cancel",
		EventID:         "cancel-effect",
		CausedByEventID: "cancel-intent",
		AgentSessionID:  "session-1",
	}}); len(got) != 2 {
		t.Fatalf("cancel effect should complete pending cancel intent: %#v", got)
	}
	if len(service.checkpoints.pendingActivityIntents) != 0 {
		t.Fatalf(
			"pending intents after cancel effect = %#v",
			service.checkpoints.pendingActivityIntents,
		)
	}
}

func TestReconciledGoalKeepsActivationAsEntityOrigin(t *testing.T) {
	ctx := context.Background()
	service := &Service{Workflow: &Workflow{
		States:    serviceFixtureStore{},
		Artifacts: &activityEventArtifactStore{},
		Transport: serviceRecorder{},
		Store:     &serviceMetadataStore{},
		NewID:     func() string { return "recording-goal-origin" },
	}}
	recording, err := service.Start(ctx, StartInput{
		WorkspaceID: "workspace-1", AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Bind(ctx, BindInput{
		RecordingID: recording.ID, WorkspaceID: "workspace-1",
		AgentTargetID: "local:codex", AgentSessionID: "session-1",
	}); err != nil {
		t.Fatal(err)
	}
	for _, event := range []RecordingActivityEvent{
		{
			Kind: ActivityEventKindIntent, Type: "activation/requested",
			EventID: "activation-intent", WorkspaceID: "workspace-1",
			AgentSessionID: "session-1",
		},
		{
			Kind: ActivityEventKindEffect, Type: "session/activate",
			EventID: "activation-effect", CausedByEventID: "activation-intent",
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			Payload: map[string]any{
				"outcome": "succeeded",
				"initialGoalControl": map[string]any{
					"action": "set", "objective": "count",
				},
			},
		},
		{
			Kind: ActivityEventKindDirectStimulus,
			Type: "session.settings.update", EventID: "unrelated-settings",
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		},
	} {
		if err := service.RecordActivityEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	if err := service.ObserveCommitted(ctx, agenthost.CommittedDelta{
		TransactionID: "transaction-goal-complete",
		GoalOperation: &agenthost.GoalOperationCommitted{
			Stage: agenthost.GoalOperationReconciled,
			State: storesqlite.SessionGoalState{
				AgentSessionID: "session-1",
				Observed: map[string]any{
					"status": "complete", "objective": "count",
				},
			},
		},
	}); err != nil {
		t.Fatal(err)
	}
	var completed *ReplayCheckpoint
	for index := range service.checkpoints.plan.Checkpoints {
		checkpoint := &service.checkpoints.plan.Checkpoints[index]
		if containsString(checkpoint.Tags, "goal.completed") {
			completed = checkpoint
		}
	}
	if completed == nil {
		t.Fatalf("goal.completed checkpoint missing from %#v", service.checkpoints.plan.Checkpoints)
	}
	var goalAddress *EntityAddress
	for index := range completed.Subjects {
		if completed.Subjects[index].Kind == EntityKindGoal {
			goalAddress = &completed.Subjects[index]
		}
	}
	if goalAddress == nil {
		t.Fatalf("goal.completed subjects = %#v", completed.Subjects)
	}
	if got := goalAddress.Origin.ActivityEventSequence; got != 2 {
		t.Fatalf("Goal origin sequence = %d, want activation effect sequence 2", got)
	}
}

func TestGoalCheckpointForCommittedMapsCompleteObservation(t *testing.T) {
	kind, status, ok := goalCheckpointForCommitted(agenthost.GoalOperationCommitted{
		Stage: agenthost.GoalOperationReconciled,
		State: storesqlite.SessionGoalState{
			AgentSessionID: "session-1",
			Observed:       map[string]any{"status": "complete", "objective": "count"},
		},
	})
	if !ok || kind != "goal.completed" || status != "completed" {
		t.Fatalf("kind=%q status=%q ok=%v", kind, status, ok)
	}
}
