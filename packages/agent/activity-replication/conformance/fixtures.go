package conformance

import (
	"encoding/json"

	activityreplication "github.com/tutti-os/tutti/packages/agent/activity-replication"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

// ProjectionFixtures exercise canonical snapshot construction. Tutti SQLite
// and tsh's local projection builder run these cases through RunProjection.
func ProjectionFixtures() []ProjectionFixture {
	mutations := allProjectionMutations("projection", 100)
	return []ProjectionFixture{{
		Name:      "all canonical projection snapshots preserve wire shape",
		Canonical: canonicalSeeds(mutations),
		WantBatch: batch(mutations...),
	}}
}

func canonicalSeeds(mutations []activityreplication.Mutation) []CanonicalSeed {
	seeds := make([]CanonicalSeed, 0, len(mutations))
	for _, mutation := range mutations {
		seeds = append(seeds, CanonicalSeed{
			WorkspaceID: mutation.WorkspaceID, EntityType: mutation.EntityType, Key: mutation.Key,
			Target: mutation.Target, TargetScope: mutation.TargetScope, Session: mutation.Session,
			SessionScope: mutation.SessionScope, Turn: mutation.Turn, Interaction: mutation.Interaction, Message: mutation.Message,
		})
	}
	return seeds
}

// SinkFixtures exercise acknowledgement and final read-model semantics. The
// tsh-server MySQL sink runs these cases through RunSink.
func SinkFixtures() []SinkFixture {
	return []SinkFixture{
		retryAfterLostResponseFixture(),
		staleSnapshotsRemainNoOpsFixture(),
		staleSessionDoesNotBlockOrderedActivityFixture(),
		duplicateIdentityConflictFixture(),
		permanentSchemaRejectionFixture(),
	}
}

func retryAfterLostResponseFixture() SinkFixture {
	mutation := sessionMutation("retry-session", "transaction-original", "Retry title", 100)
	retry := mutation
	retry.TransactionID = "transaction-retry"
	return SinkFixture{
		Name: "committed response lost then identical mutation retry",
		Steps: []SinkStep{
			{
				Name: "original commit", Batch: batch(mutation),
				WantResult:           activityreplication.ApplyResult{AcceptedCount: 1, Cursor: 1},
				WantAcknowledgements: []activityreplication.MutationAcknowledgement{activityreplication.AcknowledgeApplied(mutation, 1)},
			},
			{
				Name: "rebuilt batch retry", Batch: batch(retry),
				WantResult:           activityreplication.ApplyResult{AcceptedCount: 1, Cursor: 1},
				WantAcknowledgements: []activityreplication.MutationAcknowledgement{activityreplication.AcknowledgeDuplicate(retry, 1)},
			},
		},
		WantSnapshots: []SnapshotExpectation{presentSnapshot(mutation)},
	}
}

func staleSnapshotsRemainNoOpsFixture() SinkFixture {
	current := allProjectionMutations("current", 200)
	current[1].Session.MessageVersion = 2
	settledAt := int64(200)
	outcome := canonical.TurnOutcomeCompleted
	current[2].Turn.Phase = canonical.TurnPhaseSettled
	current[2].Turn.Outcome = &outcome
	current[2].Turn.SettledAtUnixMS = &settledAt
	current[3].Interaction.Status = canonical.InteractionStatusAnswered
	current[4].Message.Version = 2

	staleTarget := targetMutation("stale-target", "transaction-stale", 100)
	staleSession := sessionMutation("stale-session", "transaction-stale", "Regressed title", 300)
	staleSession.Session.MessageVersion = 1
	staleTurn := turnMutation("stale-turn", "transaction-stale", canonical.TurnPhaseRunning, nil, 300)
	staleInteraction := interactionMutation("stale-interaction", "transaction-stale", 300)
	staleMessage := messageMutation("stale-message", "transaction-stale", 100)
	staleMessage.Message.Version = 2
	later := targetMutation("later-target", "transaction-stale", 400)
	later.Target.ID = "target-2"
	later.Target.Name = "Claude"
	later.Key.AgentTargetID = "target-2"

	stale := []activityreplication.Mutation{staleTarget, staleSession, staleTurn, staleInteraction, staleMessage, later}
	wantAcknowledgements := make([]activityreplication.MutationAcknowledgement, 0, len(stale))
	for _, mutation := range stale[:len(stale)-1] {
		wantAcknowledgements = append(wantAcknowledgements, activityreplication.AcknowledgeStale(mutation))
	}
	wantAcknowledgements = append(wantAcknowledgements, activityreplication.AcknowledgeApplied(later, 6))

	return SinkFixture{
		Name: "stale target session turn interaction and message snapshots remain no-ops",
		Steps: []SinkStep{
			{
				Name: "seed current projections", Batch: batch(current...),
				WantResult:           activityreplication.ApplyResult{AcceptedCount: 5, Cursor: 5},
				WantAcknowledgements: appliedAcknowledgements(current, 1),
			},
			{
				Name: "acknowledge stale snapshots and continue", Batch: batch(stale...),
				WantResult:           activityreplication.ApplyResult{AcceptedCount: 6, Cursor: 6},
				WantAcknowledgements: wantAcknowledgements,
			},
		},
		WantSnapshots: []SnapshotExpectation{
			presentSnapshot(current[0]), presentSnapshot(current[1]), presentSnapshot(current[2]),
			presentSnapshot(current[3]), presentSnapshot(current[4]), presentSnapshot(later),
		},
	}
}

func staleSessionDoesNotBlockOrderedActivityFixture() SinkFixture {
	currentSession := sessionMutation("ordered-current-session", "transaction-ordered-seed", "Active conversation", 200)
	currentSession.Session.MessageVersion = 2
	currentTurn := turnMutation("ordered-current-turn", "transaction-ordered-seed", canonical.TurnPhaseRunning, nil, 200)

	staleSession := sessionMutation("ordered-stale-session", "transaction-ordered", "Regressed title", 300)
	staleSession.Session.MessageVersion = 1
	completedAt := int64(310)
	completedOutcome := canonical.TurnOutcomeCompleted
	completedTurn := turnMutation("ordered-completed-turn", "transaction-ordered", canonical.TurnPhaseSettled, &completedOutcome, completedAt)
	completedTurn.Turn.SettledAtUnixMS = &completedAt
	correctedSession := sessionMutation("ordered-corrected-session", "transaction-ordered", "Completed conversation", 320)
	correctedSession.Session.MessageVersion = 2
	message := messageMutation("ordered-message", "transaction-ordered", 330)
	message.Message.Version = 3
	finalSession := correctedSession
	finalSessionSnapshot := *correctedSession.Session
	finalSessionSnapshot.MessageVersion = message.Message.Version
	finalSessionSnapshot.UpdatedAtUnixMS = message.Message.UpdatedAtUnixMS
	finalSession.Session = &finalSessionSnapshot

	seed := []activityreplication.Mutation{currentSession, currentTurn}
	ordered := []activityreplication.Mutation{staleSession, completedTurn, correctedSession, message}
	return SinkFixture{
		Name: "stale session does not block later completed turn title and message",
		Steps: []SinkStep{
			{
				Name: "seed active conversation", Batch: batch(seed...),
				WantResult:           activityreplication.ApplyResult{AcceptedCount: 2, Cursor: 2},
				WantAcknowledgements: appliedAcknowledgements(seed, 1),
			},
			{
				Name: "acknowledge stale session and continue ordered batch", Batch: batch(ordered...),
				WantResult: activityreplication.ApplyResult{AcceptedCount: 4, Cursor: 5},
				WantAcknowledgements: []activityreplication.MutationAcknowledgement{
					activityreplication.AcknowledgeStale(staleSession),
					activityreplication.AcknowledgeApplied(completedTurn, 3),
					activityreplication.AcknowledgeApplied(correctedSession, 4),
					activityreplication.AcknowledgeApplied(message, 5),
				},
			},
		},
		WantSnapshots: []SnapshotExpectation{
			presentSnapshot(finalSession), presentSnapshot(completedTurn), presentSnapshot(message),
		},
	}
}

func duplicateIdentityConflictFixture() SinkFixture {
	original := sessionMutation("collision", "transaction-original", "Original", 100)
	conflict := original
	conflict.TransactionID = "transaction-conflict"
	conflict.SourceDeviceID = "other-device"
	conflict.SessionScope = sessionScope("other-device")
	return SinkFixture{
		Name: "duplicate mutation id with different identity is rejected",
		Steps: []SinkStep{
			{
				Name: "original commit", Batch: batch(original),
				WantResult:           activityreplication.ApplyResult{AcceptedCount: 1, Cursor: 1},
				WantAcknowledgements: []activityreplication.MutationAcknowledgement{activityreplication.AcknowledgeApplied(original, 1)},
			},
			{
				Name: "identity collision", Batch: batch(conflict),
				WantRejection: &RejectionExpectation{
					Kind: activityreplication.RejectionIdentity, MutationID: "collision", TransactionID: "transaction-conflict",
				},
			},
		},
		WantSnapshots: []SnapshotExpectation{presentSnapshot(original)},
	}
}

func permanentSchemaRejectionFixture() SinkFixture {
	invalid := turnMutation("invalid-turn", "transaction-invalid", "unknown", nil, 100)
	return SinkFixture{
		Name: "invalid canonical vocabulary is permanently rejected without a write",
		Steps: []SinkStep{{
			Name: "invalid phase", Batch: batch(invalid),
			WantRejection: &RejectionExpectation{
				Kind: activityreplication.RejectionSchema, MutationID: "invalid-turn", TransactionID: "transaction-invalid",
			},
		}},
		WantSnapshots: []SnapshotExpectation{{EntityType: invalid.EntityType, Key: invalid.Key, Present: false}},
	}
}

func allProjectionMutations(prefix string, updatedAt int64) []activityreplication.Mutation {
	target := targetMutation(prefix+"-target", "transaction-"+prefix, updatedAt)
	session := sessionMutation(prefix+"-session", "transaction-"+prefix, "Canonical conversation", updatedAt)
	targetID := target.Target.ID
	turnID := "turn-1"
	session.Session.AgentTargetID = &targetID
	session.Session.ActiveTurnID = &turnID
	turn := turnMutation(prefix+"-turn", "transaction-"+prefix, canonical.TurnPhaseRunning, nil, updatedAt)
	interaction := interactionMutation(prefix+"-interaction", "transaction-"+prefix, updatedAt)
	message := messageMutation(prefix+"-message", "transaction-"+prefix, updatedAt)
	session.Session.MessageVersion = message.Message.Version
	return []activityreplication.Mutation{target, session, turn, interaction, message}
}

func appliedAcknowledgements(mutations []activityreplication.Mutation, firstCursor uint64) []activityreplication.MutationAcknowledgement {
	acknowledgements := make([]activityreplication.MutationAcknowledgement, 0, len(mutations))
	for index, mutation := range mutations {
		acknowledgements = append(acknowledgements, activityreplication.AcknowledgeApplied(mutation, firstCursor+uint64(index)))
	}
	return acknowledgements
}

func batch(mutations ...activityreplication.Mutation) activityreplication.ChangeBatch {
	return activityreplication.ChangeBatch{SchemaVersion: activityreplication.SchemaVersion, ProjectionEpoch: activityreplication.ProjectionEpoch, Mutations: mutations}
}

func targetMutation(mutationID, transactionID string, updatedAt int64) activityreplication.Mutation {
	iconKey := "codex"
	target := &activityreplication.Target{
		ID: "target-1", Provider: "codex", LaunchRef: json.RawMessage(`{"type":"local_cli","provider":"codex"}`),
		Name: "Codex", IconKey: &iconKey, Enabled: true, Source: "local", SortOrder: 1,
		CreatedAtUnixMS: 50, UpdatedAtUnixMS: updatedAt,
	}
	return activityreplication.Mutation{
		SchemaVersion: activityreplication.SchemaVersion, MutationID: mutationID, TransactionID: transactionID,
		SourceDeviceID: "device-1", WorkspaceID: "workspace-1", EntityType: activityreplication.EntityTarget,
		Operation: activityreplication.OperationUpsert, Key: activityreplication.EntityKey{AgentTargetID: target.ID},
		Target: target, TargetScope: &activityreplication.TargetScope{OwnerUserID: "owner-1", OwnerDeviceID: "device-1"},
	}
}

func sessionMutation(mutationID, transactionID, title string, updatedAt int64) activityreplication.Mutation {
	session := &activityreplication.Session{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", Kind: canonical.SessionKindRoot,
		Origin: "runtime", UserID: "owner-1", Provider: "codex", ProviderSessionID: "provider-session-1",
		Settings:               json.RawMessage(`{}`),
		SessionMetadata:        json.RawMessage(`{"visible":true,"imported":false,"capabilities":[]}`),
		InternalRuntimeContext: json.RawMessage(`{}`),
		RailSectionKind:        "conversations", RailSectionKey: "conversations", Title: title,
		CreatedAtUnixMS: 50, UpdatedAtUnixMS: updatedAt, LastEventAtUnixMS: updatedAt,
	}
	return activityreplication.Mutation{
		SchemaVersion: activityreplication.SchemaVersion, MutationID: mutationID, TransactionID: transactionID,
		SourceDeviceID: "device-1", WorkspaceID: "workspace-1", EntityType: activityreplication.EntitySession,
		Operation: activityreplication.OperationUpsert, Key: activityreplication.EntityKey{AgentSessionID: "session-1"},
		Session: session, SessionScope: sessionScope("device-1"),
	}
}

func turnMutation(mutationID, transactionID, phase string, outcome *string, updatedAt int64) activityreplication.Mutation {
	turn := &activityreplication.Turn{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-1", Phase: phase, Outcome: outcome,
		Origin: canonical.TurnOriginUserPrompt, StartedAtUnixMS: updatedAt, CreatedAtUnixMS: 50, UpdatedAtUnixMS: updatedAt,
	}
	return activityreplication.Mutation{
		SchemaVersion: activityreplication.SchemaVersion, MutationID: mutationID, TransactionID: transactionID,
		SourceDeviceID: "device-1", WorkspaceID: "workspace-1", EntityType: activityreplication.EntityTurn,
		Operation: activityreplication.OperationUpsert,
		Key:       activityreplication.EntityKey{AgentSessionID: "session-1", TurnID: "turn-1"},
		Turn:      turn, SessionScope: sessionScope("device-1"),
	}
}

func interactionMutation(mutationID, transactionID string, updatedAt int64) activityreplication.Mutation {
	interaction := &activityreplication.Interaction{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", RequestID: "request-1", TurnID: "turn-1",
		Kind: canonical.InteractionKindQuestion, Status: canonical.InteractionStatusPending, ToolName: "request_user_input",
		Input: json.RawMessage(`{"question":"Continue?"}`), Output: json.RawMessage(`{}`), Metadata: json.RawMessage(`{}`),
		CreatedAtUnixMS: 50, UpdatedAtUnixMS: updatedAt,
	}
	return activityreplication.Mutation{
		SchemaVersion: activityreplication.SchemaVersion, MutationID: mutationID, TransactionID: transactionID,
		SourceDeviceID: "device-1", WorkspaceID: "workspace-1", EntityType: activityreplication.EntityInteraction,
		Operation:   activityreplication.OperationUpsert,
		Key:         activityreplication.EntityKey{AgentSessionID: "session-1", TurnID: "turn-1", RequestID: "request-1"},
		Interaction: interaction, SessionScope: sessionScope("device-1"),
	}
}

func messageMutation(mutationID, transactionID string, updatedAt int64) activityreplication.Mutation {
	turnID := "turn-1"
	message := &activityreplication.Message{
		ID: 1, WorkspaceID: "workspace-1", AgentSessionID: "session-1", MessageID: "message-1", Version: 1,
		TurnID: &turnID, Role: "assistant", Kind: "text", Status: "completed", Semantics: json.RawMessage(`null`),
		Payload: json.RawMessage(`{"text":"done"}`), OccurredAtUnixMS: updatedAt, CompletedAtUnixMS: updatedAt,
		CreatedAtUnixMS: 50, UpdatedAtUnixMS: updatedAt,
	}
	return activityreplication.Mutation{
		SchemaVersion: activityreplication.SchemaVersion, MutationID: mutationID, TransactionID: transactionID,
		SourceDeviceID: "device-1", WorkspaceID: "workspace-1", EntityType: activityreplication.EntityMessage,
		Operation: activityreplication.OperationUpsert,
		Key:       activityreplication.EntityKey{AgentSessionID: "session-1", MessageID: "message-1"},
		Message:   message, SessionScope: sessionScope("device-1"),
	}
}

func sessionScope(deviceID string) *activityreplication.SessionScope {
	return &activityreplication.SessionScope{
		InitiatorUserID: "caller-1", ExecutorOwnerUserID: "owner-1", SourceDeviceID: deviceID,
		LaunchKind: "shared-agent", Visibility: activityreplication.VisibilityMembers,
	}
}

func presentSnapshot(mutation activityreplication.Mutation) SnapshotExpectation {
	var snapshot any
	switch mutation.EntityType {
	case activityreplication.EntityTarget:
		snapshot = mutation.Target
	case activityreplication.EntitySession:
		snapshot = mutation.Session
	case activityreplication.EntityTurn:
		snapshot = mutation.Turn
	case activityreplication.EntityInteraction:
		snapshot = mutation.Interaction
	case activityreplication.EntityMessage:
		snapshot = mutation.Message
	default:
		panic("unsupported fixture snapshot entity")
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		panic(err)
	}
	return SnapshotExpectation{EntityType: mutation.EntityType, Key: mutation.Key, Present: true, Snapshot: raw}
}
