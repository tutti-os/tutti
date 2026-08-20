package storesqlite

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

// RestoreHistoricalSessionGraph materializes portable canonical history in one
// transaction. It never starts a Provider and is idempotent only for identical
// semantic content.
func (s *Store) RestoreHistoricalSessionGraph(
	ctx context.Context,
	input HistoricalSessionGraphRestoreInput,
) error {
	if s == nil || s.db == nil {
		return errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	userID := strings.TrimSpace(input.UserID)
	graph := input.Graph
	if workspaceID == "" || userID == "" {
		return errors.New("workspace, user, and root Agent Session ids are required")
	}
	existing, err := s.historicalReplayGraphExists(ctx, workspaceID, graph)
	if err != nil {
		return err
	}
	if existing {
		matches, err := s.historicalReplayUserBindingMatches(
			ctx,
			workspaceID,
			graph,
			userID,
		)
		if err != nil {
			return err
		}
		if !matches {
			return ErrHistoricalStateConflict
		}
		captured, err := s.CaptureHistoricalSessionGraph(ctx, workspaceID, graph.RootSessionID)
		if err != nil {
			return err
		}
		equal, err := equalHistoricalSessionGraphs(captured, graph)
		if err != nil {
			return err
		}
		if equal {
			return nil
		}
		return ErrHistoricalStateConflict
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin historical Agent state restore: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	now := time.Now().UTC().UnixMilli()
	ordered, err := orderHistoricalSessions(graph)
	if err != nil {
		return err
	}
	for _, session := range ordered {
		if err := restoreHistoricalSession(ctx, tx, workspaceID, userID, session, now); err != nil {
			return err
		}
	}
	for _, session := range ordered {
		if err := restoreHistoricalTurns(ctx, tx, workspaceID, session, now); err != nil {
			return err
		}
		if err := restoreHistoricalMessages(ctx, tx, workspaceID, session, now); err != nil {
			return err
		}
		if err := restoreHistoricalInteractions(ctx, tx, workspaceID, session, now); err != nil {
			return err
		}
		if err := restoreHistoricalGoal(ctx, tx, workspaceID, session, now); err != nil {
			return err
		}
		if strings.TrimSpace(session.ActiveTurnID) != "" {
			if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET active_turn_id = ?
WHERE workspace_id = ? AND agent_session_id = ?
`, session.ActiveTurnID, workspaceID, session.ID); err != nil {
				return fmt.Errorf("restore historical active Turn: %w", err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit historical Agent state restore: %w", err)
	}
	return nil
}

func (s *Store) historicalReplayUserBindingMatches(
	ctx context.Context,
	workspaceID string,
	graph HistoricalSessionGraph,
	userID string,
) (bool, error) {
	ids := make([]string, 0, len(graph.Sessions))
	for _, session := range graph.Sessions {
		ids = append(ids, session.ID)
	}
	placeholders, args := historicalIdentityArgs(workspaceID, ids)
	args = append(args, userID)
	var mismatches int
	if err := s.db.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id IN (`+placeholders+`)
  AND user_id <> ?
`, args...).Scan(&mismatches); err != nil {
		return false, err
	}
	return mismatches == 0, nil
}

func (s *Store) historicalReplayGraphExists(
	ctx context.Context,
	workspaceID string,
	graph HistoricalSessionGraph,
) (bool, error) {
	ids := make([]string, 0, len(graph.Sessions))
	for _, session := range graph.Sessions {
		ids = append(ids, session.ID)
	}
	placeholders, args := historicalIdentityArgs(workspaceID, ids)
	var count int
	if err := s.db.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id IN (`+placeholders+`)
`, args...).Scan(&count); err != nil {
		return false, err
	}
	if count != 0 && count != len(ids) {
		return false, ErrHistoricalStateConflict
	}
	return count == len(ids), nil
}

func equalHistoricalSessionGraphs(
	left, right HistoricalSessionGraph,
) (bool, error) {
	leftRaw, err := json.Marshal(left)
	if err != nil {
		return false, err
	}
	rightRaw, err := json.Marshal(right)
	if err != nil {
		return false, err
	}
	return bytes.Equal(leftRaw, rightRaw), nil
}

func historicalIdentityArgs(workspaceID string, identities []string) (string, []any) {
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(identities)), ",")
	args := make([]any, 0, len(identities)+1)
	args = append(args, workspaceID)
	for _, identity := range identities {
		args = append(args, identity)
	}
	return placeholders, args
}

func orderHistoricalSessions(
	graph HistoricalSessionGraph,
) ([]HistoricalSession, error) {
	pending := make(map[string]HistoricalSession, len(graph.Sessions))
	for _, session := range graph.Sessions {
		pending[session.ID] = session
	}
	ordered := make([]HistoricalSession, 0, len(graph.Sessions))
	inserted := map[string]struct{}{}
	for len(pending) > 0 {
		ids := make([]string, 0, len(pending))
		for id := range pending {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		progress := false
		for _, id := range ids {
			session := pending[id]
			if session.ParentSessionID != "" {
				if _, ok := inserted[session.ParentSessionID]; !ok {
					continue
				}
			}
			ordered = append(ordered, session)
			inserted[id] = struct{}{}
			delete(pending, id)
			progress = true
		}
		if !progress {
			return nil, ErrHistoricalStateConflict
		}
	}
	return ordered, nil
}

func restoreHistoricalSession(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	userID string,
	session HistoricalSession,
	now int64,
) error {
	settingsJSON, err := json.Marshal(nonNilReplayMap(session.Settings))
	if err != nil {
		return err
	}
	railSectionKind := strings.TrimSpace(session.RailSectionKind)
	railProjectPath := NormalizeProjectPath(session.RailProjectPath)
	railSectionKey := NormalizeRailSectionKey(session.RailSectionKey)
	if railSectionKind == "" && railProjectPath == "" && railSectionKey == "" {
		railSectionKind = RailSectionKindConversations
		railSectionKey = RailSectionKeyConversations
	}
	if railSectionKind == RailSectionKindProject && railProjectPath != "" {
		// Keep restored membership aligned with live classification and with
		// user-project SectionKeyFromPath (both use RailSectionKeyForProject).
		railSectionKey = RailSectionKeyForProject(railProjectPath)
	}
	metadataJSON := `{"visible":true,"imported":true,"capabilities":[]}`
	internalRuntimeContext := map[string]any{
		"externalImportNoProject": railSectionKind != RailSectionKindProject,
	}
	if session.ProviderResumeCheckpoint != nil {
		internalRuntimeContext[canonical.ProviderResumeCheckpointRuntimeContextKey] =
			session.ProviderResumeCheckpoint
	}
	internalRuntimeContextRaw, err := json.Marshal(internalRuntimeContext)
	if err != nil {
		return err
	}
	internalRuntimeContextJSON := string(internalRuntimeContextRaw)
	pinnedAt := int64(0)
	if session.Pinned {
		pinnedAt = now
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_agent_sessions (
  workspace_id, agent_session_id, session_kind, root_agent_session_id,
  root_turn_id, parent_agent_session_id, parent_turn_id, parent_tool_call_id,
  origin, user_id, agent_target_id, provider, provider_session_id, model,
  settings_json, session_metadata_json, internal_runtime_context_json, cwd,
  rail_section_kind, rail_project_path, rail_section_key, title,
  message_version, last_event_at_unix_ms, started_at_unix_ms, ended_at_unix_ms,
  pinned_at_unix_ms, deleted_at_unix_ms, created_at_unix_ms, updated_at_unix_ms,
  active_turn_id
) VALUES (?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''),
          NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, 0, ?, 0, 0, ?, 0, ?, ?, NULL)
`, workspaceID, session.ID, session.Kind, session.RootSessionID,
		session.RootTurnID, session.ParentSessionID, session.ParentTurnID,
		session.ParentToolCallID, session.Origin, userID, session.AgentTargetID,
		session.Provider, session.ProviderSessionID, session.Model, string(settingsJSON),
		metadataJSON, internalRuntimeContextJSON, session.Cwd,
		railSectionKind, railProjectPath, railSectionKey,
		session.Title, now, pinnedAt, now, now,
	)
	if err != nil {
		return fmt.Errorf("restore historical Session %s: %w", session.ID, err)
	}
	return nil
}

func restoreHistoricalTurns(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	session HistoricalSession,
	now int64,
) error {
	for _, turn := range session.Turns {
		errorJSON, err := json.Marshal(nonNilReplayMap(turn.Error))
		if err != nil {
			return err
		}
		filesJSON, err := json.Marshal(nonNilReplayMap(turn.FileChanges))
		if err != nil {
			return err
		}
		commandJSON, err := json.Marshal(nonNilReplayMap(turn.CompletedCommand))
		if err != nil {
			return err
		}
		capabilitiesJSON, err := json.Marshal(turn.CapabilityRefs)
		if err != nil {
			return err
		}
		var settledAt any
		if turn.Phase == "settled" {
			settledAt = now
		}
		rootPhase := any(nil)
		rootOutcome := any(nil)
		if turn.RootProviderTurnID != "" {
			rootPhase = "completed"
			if turn.Phase != "settled" {
				rootPhase = "running"
			} else if turn.Outcome != "" {
				rootOutcome = turn.Outcome
			}
		}
		_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, identity_anchor_turn_id, phase, outcome, error_json,
  file_changes_json, completed_command_json, backfilled, turn_origin,
  source_goal_operation_id, source_goal_revision, source_goal_repair_epoch,
  started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms,
  updated_at_unix_ms, root_provider_turn_id, root_provider_turn_phase,
  root_provider_turn_outcome, root_provider_turn_updated_at_unix_ms,
  capability_refs_json
) VALUES (?, ?, ?, NULLIF(?, ''), ?, NULLIF(?, ''), ?, ?, ?, 0, ?, NULLIF(?, ''),
          NULLIF(?, 0), NULLIF(?, 0), ?, ?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?)
`, workspaceID, session.ID, turn.ID, turn.IdentityAnchorTurnID, turn.Phase, turn.Outcome,
			string(errorJSON), string(filesJSON), string(commandJSON), turn.Origin,
			turn.SourceGoalOperationID, turn.SourceGoalRevision,
			turn.SourceGoalRepairEpoch, now, settledAt, now, now,
			turn.RootProviderTurnID, rootPhase, rootOutcome, now,
			string(capabilitiesJSON),
		)
		if err != nil {
			return fmt.Errorf("restore historical Turn %s: %w", turn.ID, err)
		}
	}
	return nil
}

func restoreHistoricalMessages(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	session HistoricalSession,
	now int64,
) error {
	for index, message := range session.Messages {
		semanticsJSON, err := json.Marshal(nonNilReplayMap(message.Semantics))
		if err != nil {
			return err
		}
		payloadJSON, err := json.Marshal(nonNilReplayMap(message.Payload))
		if err != nil {
			return err
		}
		version := index + 1
		_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, turn_id, role, kind,
  status, semantics_json, payload_json, occurred_at_unix_ms,
  started_at_unix_ms, completed_at_unix_ms, deleted_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
`, workspaceID, session.ID, message.ID, version, message.TurnID, message.Role,
			message.Kind, message.Status, string(semanticsJSON), string(payloadJSON),
			now, now, now,
		)
		if err != nil {
			return fmt.Errorf("restore historical Message %s: %w", message.ID, err)
		}
	}
	if len(session.Messages) > 0 {
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET message_version = ?
WHERE workspace_id = ? AND agent_session_id = ?
`, len(session.Messages), workspaceID, session.ID); err != nil {
			return err
		}
	}
	return nil
}

func restoreHistoricalInteractions(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	session HistoricalSession,
	now int64,
) error {
	for _, interaction := range session.Interactions {
		inputJSON, err := json.Marshal(nonNilReplayMap(interaction.Input))
		if err != nil {
			return err
		}
		outputJSON, err := json.Marshal(nonNilReplayMap(interaction.Output))
		if err != nil {
			return err
		}
		metadataJSON, err := json.Marshal(nonNilReplayMap(interaction.Metadata))
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_agent_interactions (
  workspace_id, agent_session_id, request_id, turn_id, kind, status,
  tool_name, input_json, output_json, metadata_json,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, workspaceID, session.ID, interaction.RequestID, interaction.TurnID,
			interaction.Kind, interaction.Status, interaction.ToolName,
			string(inputJSON), string(outputJSON), string(metadataJSON), now, now,
		)
		if err != nil {
			return fmt.Errorf(
				"restore historical Interaction %s: %w",
				interaction.RequestID,
				err,
			)
		}
	}
	return nil
}

func restoreHistoricalGoal(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	session HistoricalSession,
	now int64,
) error {
	if session.Goal == nil {
		return nil
	}
	desiredJSON, err := json.Marshal(nonNilReplayMap(session.Goal.Desired))
	if err != nil {
		return err
	}
	observedJSON, err := json.Marshal(nonNilReplayMap(session.Goal.Observed))
	if err != nil {
		return err
	}
	evidenceJSON, err := json.Marshal(nonNilReplayMap(session.Goal.LastEvidence))
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_agent_session_goals (
  workspace_id, agent_session_id, desired_json, observed_json, revision,
  tombstoned, sync_status, pending_operation_id, last_evidence_json,
  last_error, observed_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?)
`, workspaceID, session.ID, string(desiredJSON), string(observedJSON),
		session.Goal.Revision, session.Goal.Tombstoned, session.Goal.SyncStatus,
		session.Goal.PendingOperationID, string(evidenceJSON),
		session.Goal.LastError, now, now, now,
	)
	if err != nil {
		return fmt.Errorf("restore historical Goal for %s: %w", session.ID, err)
	}
	return nil
}

func nonNilReplayMap(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	return value
}
