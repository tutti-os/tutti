package storesqlite_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	activityreplication "github.com/tutti-os/tutti/packages/agent/activity-replication"
	"github.com/tutti-os/tutti/packages/agent/activity-replication/conformance"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

type projectionDescriptor struct {
	workspaceID  string
	entityType   activityreplication.EntityType
	key          activityreplication.EntityKey
	targetScope  *activityreplication.TargetScope
	sessionScope *activityreplication.SessionScope
}

type sqliteProjectionBuilder struct {
	db          *sql.DB
	store       *storesqlite.Store
	descriptors []projectionDescriptor
}

func TestSQLiteCanonicalProjectionConformance(t *testing.T) {
	t.Parallel()

	for _, fixture := range conformance.ProjectionFixtures() {
		fixture := fixture
		t.Run(fixture.Name, func(t *testing.T) {
			t.Parallel()
			builder := newSQLiteProjectionBuilder(t)
			if err := conformance.RunProjection(context.Background(), builder, fixture); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func newSQLiteProjectionBuilder(t *testing.T) *sqliteProjectionBuilder {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "activity.db"))
	if err != nil {
		t.Fatalf("open SQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("enable foreign keys: %v", err)
	}
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	return &sqliteProjectionBuilder{db: db, store: store}
}

func (b *sqliteProjectionBuilder) Reset(ctx context.Context) error {
	for _, table := range []string{
		"workspace_agent_messages", "workspace_agent_interactions", "workspace_agent_turns",
		"workspace_agent_sessions", "agent_targets",
	} {
		if _, err := b.db.ExecContext(ctx, "DELETE FROM "+table); err != nil {
			return fmt.Errorf("clear %s: %w", table, err)
		}
	}
	b.descriptors = nil
	return nil
}

func (b *sqliteProjectionBuilder) Seed(ctx context.Context, seeds []conformance.CanonicalSeed) error {
	for _, seed := range seeds {
		mutation := seedWireMutation(seed)
		if err := activityreplication.ValidateMutation(mutation); err != nil {
			return err
		}
		if mutation.Operation != activityreplication.OperationUpsert {
			return errors.New("SQLite projection fixture seeds must be upserts")
		}
		if err := b.seedMutation(ctx, mutation); err != nil {
			return fmt.Errorf("seed %s: %w", mutation.EntityType, err)
		}
		b.descriptors = append(b.descriptors, projectionDescriptor{
			workspaceID: mutation.WorkspaceID, entityType: mutation.EntityType, key: mutation.Key,
			targetScope: cloneTargetScope(mutation.TargetScope), sessionScope: cloneSessionScope(mutation.SessionScope),
		})
	}
	return nil
}

func seedWireMutation(seed conformance.CanonicalSeed) activityreplication.Mutation {
	sourceDevice := ""
	if seed.TargetScope != nil {
		sourceDevice = seed.TargetScope.OwnerDeviceID
	} else if seed.SessionScope != nil {
		sourceDevice = seed.SessionScope.SourceDeviceID
	}
	return activityreplication.Mutation{
		SchemaVersion: activityreplication.SchemaVersion, MutationID: "canonical-seed", TransactionID: "canonical-seed",
		SourceDeviceID: sourceDevice, WorkspaceID: seed.WorkspaceID, EntityType: seed.EntityType,
		Operation: activityreplication.OperationUpsert, Key: seed.Key,
		Target: seed.Target, TargetScope: seed.TargetScope, Session: seed.Session, SessionScope: seed.SessionScope,
		Turn: seed.Turn, Interaction: seed.Interaction, Message: seed.Message,
	}
}

func (b *sqliteProjectionBuilder) Build(ctx context.Context) (activityreplication.ChangeBatch, error) {
	mutations := make([]activityreplication.Mutation, 0, len(b.descriptors))
	for index, descriptor := range b.descriptors {
		mutation, found, err := b.buildMutation(ctx, descriptor)
		if err != nil {
			return activityreplication.ChangeBatch{}, err
		}
		if !found {
			return activityreplication.ChangeBatch{}, fmt.Errorf("canonical %s snapshot is missing", descriptor.entityType)
		}
		mutation.SchemaVersion = activityreplication.SchemaVersion
		mutation.MutationID = fmt.Sprintf("sqlite-projection-%d", index+1)
		mutation.TransactionID = "sqlite-projection"
		mutations = append(mutations, mutation)
	}
	return activityreplication.ChangeBatch{
		SchemaVersion:   activityreplication.SchemaVersion,
		ProjectionEpoch: activityreplication.ProjectionEpoch,
		Mutations:       mutations,
	}, nil
}

func (b *sqliteProjectionBuilder) seedMutation(ctx context.Context, mutation activityreplication.Mutation) error {
	switch mutation.EntityType {
	case activityreplication.EntityTarget:
		target := mutation.Target
		if _, err := b.store.PutAgentTarget(ctx, storesqlite.Target{
			ID: target.ID, Provider: target.Provider, LaunchRefJSON: string(target.LaunchRef), Name: target.Name,
			IconKey: dereference(target.IconKey), IconURL: target.IconURL, MaskIconURL: target.MaskIconURL, HeroImageURL: target.HeroImageURL,
			Enabled: target.Enabled, Source: target.Source, SortOrder: int(target.SortOrder), CreatedAtUnixMS: target.CreatedAtUnixMS,
		}); err != nil {
			return err
		}
		_, err := b.db.ExecContext(ctx, `UPDATE agent_targets SET created_at_ms=?,updated_at_ms=? WHERE id=?`,
			target.CreatedAtUnixMS, target.UpdatedAtUnixMS, target.ID)
		return err
	case activityreplication.EntitySession:
		session := mutation.Session
		settings, err := decodeObject(session.Settings)
		if err != nil {
			return err
		}
		runtimeContext, err := decodeObject(session.InternalRuntimeContext)
		if err != nil {
			return err
		}
		result, err := b.store.ReportSessionState(ctx, storesqlite.SessionStateReport{
			WorkspaceID: session.WorkspaceID, AgentSessionID: session.AgentSessionID, Kind: session.Kind,
			RootAgentSessionID: dereference(session.RootAgentSessionID), RootTurnID: dereference(session.RootTurnID),
			ParentAgentSessionID: dereference(session.ParentAgentSessionID), ParentTurnID: dereference(session.ParentTurnID),
			ParentToolCallID: dereference(session.ParentToolCallID), Origin: session.Origin, UserID: session.UserID,
			AgentTargetID: dereference(session.AgentTargetID), Provider: session.Provider, ProviderSessionID: session.ProviderSessionID,
			Model: session.Model, Settings: settings, RuntimeContext: runtimeContext, Cwd: session.CWD, Title: session.Title,
			OccurredAtUnixMS: session.LastEventAtUnixMS, StartedAtUnixMS: session.StartedAtUnixMS,
			EndedAtUnixMS: session.EndedAtUnixMS, CreatedAtUnixMS: session.CreatedAtUnixMS,
		})
		if err != nil {
			return err
		}
		if !result.Accepted {
			return errors.New("SQLite canonical store rejected session seed")
		}
		_, err = b.db.ExecContext(ctx, `UPDATE workspace_agent_sessions SET rail_section_kind=?,rail_project_path=?,rail_section_key=?,message_version=0,last_event_at_unix_ms=?,pinned_at_unix_ms=?,deleted_at_unix_ms=?,created_at_unix_ms=?,updated_at_unix_ms=?,active_turn_id=NULL WHERE workspace_id=? AND agent_session_id=?`,
			session.RailSectionKind, session.RailProjectPath, session.RailSectionKey, session.LastEventAtUnixMS,
			session.PinnedAtUnixMS, session.DeletedAtUnixMS, session.CreatedAtUnixMS, session.UpdatedAtUnixMS,
			session.WorkspaceID, session.AgentSessionID)
		return err
	case activityreplication.EntityTurn:
		turn := mutation.Turn
		_, accepted, err := b.store.RecordTurnTransition(ctx, storesqlite.TurnTransition{
			WorkspaceID: turn.WorkspaceID, AgentSessionID: turn.AgentSessionID, TurnID: turn.TurnID,
			Phase: turn.Phase, Outcome: dereference(turn.Outcome), Origin: turn.Origin,
			SourceGoalOperationID: dereference(turn.SourceGoalOperationID), SourceGoalRevision: dereferenceInt64(turn.SourceGoalRevision),
			SourceGoalRepairEpoch: dereferenceInt64(turn.SourceGoalRepairEpoch), StartedAtUnixMS: turn.StartedAtUnixMS,
			SettledAtUnixMS: dereferenceInt64(turn.SettledAtUnixMS), OccurredAtUnixMS: turn.UpdatedAtUnixMS,
		})
		if err != nil {
			return err
		}
		if !accepted {
			return errors.New("SQLite canonical store rejected turn seed")
		}
		_, err = b.db.ExecContext(ctx, `UPDATE workspace_agent_turns SET backfilled=?,created_at_unix_ms=?,updated_at_unix_ms=? WHERE workspace_id=? AND agent_session_id=? AND turn_id=?`,
			turn.Backfilled, turn.CreatedAtUnixMS, turn.UpdatedAtUnixMS, turn.WorkspaceID, turn.AgentSessionID, turn.TurnID)
		if err != nil {
			return err
		}
		activeTurnID := any(turn.TurnID)
		if turn.Phase == storesqlite.TurnPhaseSettled {
			activeTurnID = nil
		}
		_, err = b.db.ExecContext(ctx, `UPDATE workspace_agent_sessions SET active_turn_id=? WHERE workspace_id=? AND agent_session_id=?`,
			activeTurnID, turn.WorkspaceID, turn.AgentSessionID)
		return err
	case activityreplication.EntityInteraction:
		interaction := mutation.Interaction
		input, err := decodeObject(interaction.Input)
		if err != nil {
			return err
		}
		output, err := decodeObject(interaction.Output)
		if err != nil {
			return err
		}
		metadata, err := decodeObject(interaction.Metadata)
		if err != nil {
			return err
		}
		_, result, err := b.store.UpsertInteraction(ctx, storesqlite.InteractionUpsert{
			WorkspaceID: interaction.WorkspaceID, AgentSessionID: interaction.AgentSessionID, RequestID: interaction.RequestID,
			TurnID: interaction.TurnID, Kind: interaction.Kind, Status: interaction.Status, ToolName: interaction.ToolName,
			Input: input, Output: output, Metadata: metadata, OccurredAtUnixMS: interaction.UpdatedAtUnixMS,
		})
		if err != nil {
			return err
		}
		if result == storesqlite.InteractionTransitionConflict {
			return errors.New("SQLite canonical store rejected interaction seed")
		}
		_, err = b.db.ExecContext(ctx, `UPDATE workspace_agent_interactions SET created_at_unix_ms=?,updated_at_unix_ms=? WHERE workspace_id=? AND agent_session_id=? AND turn_id=? AND request_id=?`,
			interaction.CreatedAtUnixMS, interaction.UpdatedAtUnixMS, interaction.WorkspaceID, interaction.AgentSessionID,
			interaction.TurnID, interaction.RequestID)
		return err
	case activityreplication.EntityMessage:
		message := mutation.Message
		payload, err := decodeObject(message.Payload)
		if err != nil {
			return err
		}
		result, err := b.store.ReportSessionMessages(ctx, storesqlite.SessionMessageReport{
			WorkspaceID: message.WorkspaceID, AgentSessionID: message.AgentSessionID,
			Messages: []storesqlite.MessageUpdate{{
				MessageID: message.MessageID, TurnID: dereference(message.TurnID), Role: message.Role, Kind: message.Kind,
				Status: message.Status, Payload: payload, OccurredAtUnixMS: message.OccurredAtUnixMS,
				StartedAtUnixMS: message.StartedAtUnixMS, CompletedAtUnixMS: message.CompletedAtUnixMS,
			}},
		})
		if err != nil {
			return err
		}
		if result.AcceptedCount != 1 {
			return fmt.Errorf("SQLite canonical store accepted %d messages, want 1", result.AcceptedCount)
		}
		_, err = b.db.ExecContext(ctx, `UPDATE workspace_agent_messages SET id=?,version=?,semantics_json=?,deleted_at_unix_ms=?,created_at_unix_ms=?,updated_at_unix_ms=? WHERE workspace_id=? AND agent_session_id=? AND message_id=?`,
			message.ID, message.Version, string(message.Semantics), message.DeletedAtUnixMS, message.CreatedAtUnixMS,
			message.UpdatedAtUnixMS, message.WorkspaceID, message.AgentSessionID, message.MessageID)
		if err != nil {
			return err
		}
		_, err = b.db.ExecContext(ctx, `UPDATE workspace_agent_sessions SET message_version=?,last_event_at_unix_ms=?,updated_at_unix_ms=? WHERE workspace_id=? AND agent_session_id=?`,
			message.Version, message.UpdatedAtUnixMS, message.UpdatedAtUnixMS, message.WorkspaceID, message.AgentSessionID)
		return err
	default:
		return fmt.Errorf("unsupported SQLite projection seed entity %q", mutation.EntityType)
	}
}

func (b *sqliteProjectionBuilder) buildMutation(ctx context.Context, descriptor projectionDescriptor) (activityreplication.Mutation, bool, error) {
	mutation := activityreplication.Mutation{
		WorkspaceID: descriptor.workspaceID, SourceDeviceID: sourceDeviceID(descriptor), EntityType: descriptor.entityType,
		Operation: activityreplication.OperationUpsert, Key: descriptor.key,
		TargetScope: cloneTargetScope(descriptor.targetScope), SessionScope: cloneSessionScope(descriptor.sessionScope),
	}
	switch descriptor.entityType {
	case activityreplication.EntityTarget:
		stored, err := b.store.GetAgentTarget(ctx, descriptor.key.AgentTargetID)
		if errors.Is(err, storesqlite.ErrAgentTargetNotFound) {
			return activityreplication.Mutation{}, false, nil
		}
		if err != nil {
			return activityreplication.Mutation{}, false, err
		}
		mutation.Target = &activityreplication.Target{
			ID: stored.ID, Provider: stored.Provider, LaunchRef: json.RawMessage(stored.LaunchRefJSON), Name: stored.Name,
			IconKey: nullable(stored.IconKey), IconURL: stored.IconURL, MaskIconURL: stored.MaskIconURL, HeroImageURL: stored.HeroImageURL,
			Enabled: stored.Enabled, Source: stored.Source, SortOrder: int64(stored.SortOrder),
			CreatedAtUnixMS: stored.CreatedAtUnixMS, UpdatedAtUnixMS: stored.UpdatedAtUnixMS,
		}
	case activityreplication.EntitySession:
		stored, found, err := b.store.GetSession(ctx, descriptor.workspaceID, descriptor.key.AgentSessionID)
		if err != nil || !found {
			return activityreplication.Mutation{}, found, err
		}
		metadata, err := json.Marshal(stored.Metadata)
		if err != nil {
			return activityreplication.Mutation{}, false, err
		}
		settings, err := marshalObject(stored.Settings)
		if err != nil {
			return activityreplication.Mutation{}, false, err
		}
		runtimeContext, err := marshalObject(stored.InternalRuntimeContext)
		if err != nil {
			return activityreplication.Mutation{}, false, err
		}
		var railKind, railProjectPath string
		var deletedAt int64
		if err := b.db.QueryRowContext(ctx, `SELECT rail_section_kind,rail_project_path,deleted_at_unix_ms FROM workspace_agent_sessions WHERE workspace_id=? AND agent_session_id=?`,
			descriptor.workspaceID, descriptor.key.AgentSessionID).Scan(&railKind, &railProjectPath, &deletedAt); err != nil {
			return activityreplication.Mutation{}, false, err
		}
		mutation.Session = &activityreplication.Session{
			WorkspaceID: stored.WorkspaceID, AgentSessionID: stored.ID, Kind: stored.Kind,
			RootAgentSessionID: nullable(stored.RootAgentSessionID), RootTurnID: nullable(stored.RootTurnID),
			ParentAgentSessionID: nullable(stored.ParentAgentSessionID), ParentTurnID: nullable(stored.ParentTurnID),
			ParentToolCallID: nullable(stored.ParentToolCallID), Origin: stored.Origin, UserID: stored.UserID,
			AgentTargetID: nullable(stored.AgentTargetID), Provider: stored.Provider, ProviderSessionID: stored.ProviderSessionID,
			Model: stored.Model, Settings: settings, SessionMetadata: metadata, InternalRuntimeContext: runtimeContext,
			CWD: stored.Cwd, RailSectionKind: railKind, RailProjectPath: railProjectPath, RailSectionKey: stored.RailSectionKey,
			Title: stored.Title, MessageVersion: stored.MessageVersion, LastEventAtUnixMS: stored.LastEventUnixMS,
			StartedAtUnixMS: stored.StartedAtUnixMS, EndedAtUnixMS: stored.EndedAtUnixMS, PinnedAtUnixMS: stored.PinnedAtUnixMS,
			DeletedAtUnixMS: deletedAt, CreatedAtUnixMS: stored.CreatedAtUnixMS, UpdatedAtUnixMS: stored.UpdatedAtUnixMS,
			ActiveTurnID: nullable(stored.ActiveTurnID),
		}
	case activityreplication.EntityTurn:
		stored, found, err := b.store.GetTurn(ctx, descriptor.workspaceID, descriptor.key.AgentSessionID, descriptor.key.TurnID)
		if err != nil || !found {
			return activityreplication.Mutation{}, found, err
		}
		mutation.Turn = turnSnapshot(stored)
	case activityreplication.EntityInteraction:
		items, err := b.store.ListSessionInteractions(ctx, storesqlite.ListSessionInteractionsInput{
			WorkspaceID: descriptor.workspaceID, AgentSessionID: descriptor.key.AgentSessionID,
		})
		if err != nil {
			return activityreplication.Mutation{}, false, err
		}
		for _, stored := range items {
			if stored.TurnID == descriptor.key.TurnID && stored.RequestID == descriptor.key.RequestID {
				mutation.Interaction, err = interactionSnapshot(stored)
				return mutation, err == nil, err
			}
		}
		return activityreplication.Mutation{}, false, nil
	case activityreplication.EntityMessage:
		page, found, err := b.store.ListSessionMessages(ctx, storesqlite.ListSessionMessagesInput{
			WorkspaceID: descriptor.workspaceID, AgentSessionID: descriptor.key.AgentSessionID, Limit: 100,
		})
		if err != nil || !found {
			return activityreplication.Mutation{}, found, err
		}
		for _, stored := range page.Messages {
			if stored.MessageID == descriptor.key.MessageID {
				mutation.Message, err = messageSnapshot(descriptor.workspaceID, stored)
				return mutation, err == nil, err
			}
		}
		return activityreplication.Mutation{}, false, nil
	default:
		return activityreplication.Mutation{}, false, fmt.Errorf("unsupported SQLite projection entity %q", descriptor.entityType)
	}
	return mutation, true, nil
}

func turnSnapshot(stored storesqlite.Turn) *activityreplication.Turn {
	return &activityreplication.Turn{
		WorkspaceID: stored.WorkspaceID, AgentSessionID: stored.AgentSessionID, TurnID: stored.TurnID,
		Phase: stored.Phase, Outcome: nullable(stored.Outcome), Error: structuredResult(stored.ErrorMessage, stored.ErrorCode),
		FileChanges: rawObject(stored.FileChanges), CompletedCommand: structuredResult(stored.CompletedCommandKind, stored.CompletedCommandStatus),
		Backfilled: stored.Backfilled, Origin: stored.Origin, SourceGoalOperationID: nullable(stored.SourceGoalOperationID),
		SourceGoalRevision:    nullableInt64(stored.SourceGoalOperationID, stored.SourceGoalRevision),
		SourceGoalRepairEpoch: nullableInt64(stored.SourceGoalOperationID, stored.SourceGoalRepairEpoch),
		StartedAtUnixMS:       stored.StartedAtUnixMS, SettledAtUnixMS: nullableInt64(stored.Outcome, stored.SettledAtUnixMS),
		CreatedAtUnixMS: stored.CreatedAtUnixMS, UpdatedAtUnixMS: stored.UpdatedAtUnixMS,
		RootProviderTurnID: nullable(stored.RootProviderTurnID), RootProviderTurnPhase: nullable(stored.RootProviderTurnPhase),
		RootProviderTurnOutcome:          nullable(stored.RootProviderTurnOutcome),
		RootProviderTurnError:            structuredResult(stored.RootProviderTurnErrorMessage, stored.RootProviderTurnErrorCode),
		RootProviderTurnCompletedCommand: structuredResult(stored.RootProviderTurnCompletedCommandKind, stored.RootProviderTurnCompletedCommandStatus),
		RootProviderTurnUpdatedAtUnixMS:  stored.RootProviderTurnUpdatedAtUnixMS,
	}
}

func interactionSnapshot(stored storesqlite.Interaction) (*activityreplication.Interaction, error) {
	input, err := marshalObject(stored.Input)
	if err != nil {
		return nil, err
	}
	output, err := marshalObject(stored.Output)
	if err != nil {
		return nil, err
	}
	metadata, err := marshalObject(stored.Metadata)
	if err != nil {
		return nil, err
	}
	return &activityreplication.Interaction{
		WorkspaceID: stored.WorkspaceID, AgentSessionID: stored.AgentSessionID, RequestID: stored.RequestID,
		TurnID: stored.TurnID, Kind: stored.Kind, Status: stored.Status, ToolName: stored.ToolName,
		Input: input, Output: output, Metadata: metadata, CreatedAtUnixMS: stored.CreatedAtUnixMS, UpdatedAtUnixMS: stored.UpdatedAtUnixMS,
	}, nil
}

func messageSnapshot(workspaceID string, stored storesqlite.Message) (*activityreplication.Message, error) {
	semantics, err := json.Marshal(stored.Semantics)
	if err != nil {
		return nil, err
	}
	payload, err := marshalObject(stored.Payload)
	if err != nil {
		return nil, err
	}
	return &activityreplication.Message{
		ID: stored.ID, WorkspaceID: workspaceID, AgentSessionID: stored.AgentSessionID, MessageID: stored.MessageID,
		Version: stored.Version, TurnID: nullable(stored.TurnID), Role: stored.Role, Kind: stored.Kind, Status: stored.Status,
		Semantics: semantics, Payload: payload, OccurredAtUnixMS: stored.OccurredAtUnixMS,
		StartedAtUnixMS: stored.StartedAtUnixMS, CompletedAtUnixMS: stored.CompletedAtUnixMS,
		CreatedAtUnixMS: stored.CreatedAtUnixMS, UpdatedAtUnixMS: stored.UpdatedAtUnixMS,
	}, nil
}

func sourceDeviceID(descriptor projectionDescriptor) string {
	if descriptor.targetScope != nil {
		return descriptor.targetScope.OwnerDeviceID
	}
	if descriptor.sessionScope != nil {
		return descriptor.sessionScope.SourceDeviceID
	}
	return ""
}

func decodeObject(raw json.RawMessage) (map[string]any, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return value, nil
}

func marshalObject(value map[string]any) (json.RawMessage, error) {
	if value == nil {
		return json.RawMessage(`{}`), nil
	}
	return json.Marshal(value)
}

func rawObject(value map[string]any) json.RawMessage {
	if len(value) == 0 {
		return nil
	}
	raw, _ := json.Marshal(value)
	return raw
}

func structuredResult(first, second string) json.RawMessage {
	if first == "" && second == "" {
		return nil
	}
	raw, _ := json.Marshal(map[string]string{"kind": first, "status": second})
	return raw
}

func dereference(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nullable(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func dereferenceInt64(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func nullableInt64(presence string, value int64) *int64 {
	if presence == "" {
		return nil
	}
	return &value
}

func cloneTargetScope(scope *activityreplication.TargetScope) *activityreplication.TargetScope {
	if scope == nil {
		return nil
	}
	copy := *scope
	return &copy
}

func cloneSessionScope(scope *activityreplication.SessionScope) *activityreplication.SessionScope {
	if scope == nil {
		return nil
	}
	copy := *scope
	return &copy
}
