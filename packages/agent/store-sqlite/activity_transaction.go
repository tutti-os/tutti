package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	agentactivityprojection "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func (s *Store) upsertAgentSession(
	ctx context.Context,
	input SessionStateReport,
	now int64,
) (bool, bool, int64, Session, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, false, 0, Session{}, fmt.Errorf("begin workspace agent session state report: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	accepted, stateApplied, lastEventUnixMS, session, err := s.upsertAgentSessionTx(ctx, tx, input, now)
	if err != nil {
		return false, false, 0, Session{}, err
	}
	mutations := []TransactionMutation{}
	if accepted {
		mutations = append(mutations, transactionMutation(input.WorkspaceID, input.AgentSessionID, MutationEntitySession, input.AgentSessionID, "upsert", session.UpdatedAtUnixMS))
	}
	delta, err := s.commitTransaction(ctx, tx, input.WorkspaceID, mutations)
	if err != nil {
		return false, false, 0, Session{}, fmt.Errorf("commit workspace agent session state report: %w", err)
	}
	committed = true
	session.CommitTransactionID = delta.TransactionID
	session.CommitDelta = delta
	return accepted, stateApplied, lastEventUnixMS, session, nil
}

func (s *Store) upsertAgentSessionTx(
	ctx context.Context,
	tx *sql.Tx,
	input SessionStateReport,
	now int64,
) (bool, bool, int64, Session, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return false, false, 0, Session{}, nil
	}
	input.WorkspaceID = workspaceID
	input.AgentSessionID = agentSessionID
	existing, hasExisting, err := getAgentSessionForUpdate(ctx, tx, workspaceID, agentSessionID)
	if err != nil {
		return false, false, 0, Session{}, err
	}
	if err := prepareSessionRelation(&input, existing, hasExisting); err != nil {
		return false, false, 0, Session{}, err
	}
	if !hasExisting && input.Kind == SessionKindChild {
		if err := validateChildSessionParentsTx(ctx, tx, input); err != nil {
			return false, false, 0, Session{}, err
		}
	}
	projected := agentactivityprojection.ProjectSessionState(
		existing,
		hasExisting,
		agentactivityprojection.SessionStateReport{
			WorkspaceID:          workspaceID,
			AgentSessionID:       agentSessionID,
			Kind:                 input.Kind,
			RootAgentSessionID:   input.RootAgentSessionID,
			RootTurnID:           input.RootTurnID,
			ParentAgentSessionID: input.ParentAgentSessionID,
			ParentTurnID:         input.ParentTurnID,
			ParentToolCallID:     input.ParentToolCallID,
			Origin:               input.Origin,
			UserID:               input.UserID,
			AgentTargetID:        input.AgentTargetID,
			Provider:             input.Provider,
			ProviderSessionID:    input.ProviderSessionID,
			Model:                input.Model,
			Settings:             cloneJSONMap(input.Settings),
			RuntimeContext:       cloneJSONMap(input.RuntimeContext),
			CWD:                  input.Cwd,
			Title:                input.Title,
			Status:               input.Status,
			CurrentPhase:         input.CurrentPhase,
			LastError:            input.LastError,
			OccurredAtUnixMS:     input.OccurredAtUnixMS,
			StartedAtUnixMS:      input.StartedAtUnixMS,
			EndedAtUnixMS:        input.EndedAtUnixMS,
			CreatedAtUnixMS:      input.CreatedAtUnixMS,
		},
		now,
	)
	if !projected.Accepted {
		existingRail, railErr := getExistingAgentSessionRailSectionTx(
			ctx,
			tx,
			workspaceID,
			agentSessionID,
		)
		if railErr != nil {
			return false, false, 0, Session{}, railErr
		}
		dto, dtoErr := projectionSessionToDTO(projected.Session)
		if dtoErr != nil {
			return false, false, projected.LastEventUnixMS, Session{}, dtoErr
		}
		if !existingRail.Found || !existingRail.Valid {
			return false, false, projected.LastEventUnixMS, Session{}, fmt.Errorf(
				"workspace agent session %q has no valid rail section",
				agentSessionID,
			)
		}
		dto.RailSectionKind = existingRail.Section.Kind
		dto.RailProjectPath = existingRail.Section.ProjectPath
		dto.RailSectionKey = existingRail.Section.Key
		return false, false, projected.LastEventUnixMS, dto, nil
	}
	session := projected.Session
	settingsJSON, err := marshalJSONMap(session.Settings)
	if err != nil {
		return false, false, 0, Session{}, err
	}
	metadata, internalRuntimeContext, err := splitSessionRuntimeContext(session.RuntimeContext)
	if err != nil {
		return false, false, 0, Session{}, fmt.Errorf("split workspace agent session runtime context: %w", err)
	}
	metadataJSON, err := marshalSessionMetadata(metadata)
	if err != nil {
		return false, false, 0, Session{}, fmt.Errorf("encode workspace agent session metadata: %w", err)
	}
	internalRuntimeContextJSON, err := marshalJSONMap(internalRuntimeContext)
	if err != nil {
		return false, false, 0, Session{}, err
	}
	railSection, err := s.resolveAgentSessionRailSectionTx(
		ctx,
		tx,
		workspaceID,
		agentSessionID,
		session.CWD,
		session.RuntimeContext,
		input.ImportProjectPath,
		input.RailPlacement,
	)
	if err != nil {
		return false, false, 0, Session{}, err
	}
	result, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_sessions (
  workspace_id, agent_session_id, session_kind, root_agent_session_id, root_turn_id,
  parent_agent_session_id, parent_turn_id, parent_tool_call_id,
  origin, user_id, agent_target_id, provider, provider_session_id, model,
  settings_json, session_metadata_json, internal_runtime_context_json,
  cwd, rail_section_kind, rail_project_path, rail_section_key,
  title, last_event_at_unix_ms, started_at_unix_ms,
  ended_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id) DO UPDATE SET
  origin = excluded.origin,
  user_id = excluded.user_id,
  agent_target_id = excluded.agent_target_id,
  provider = excluded.provider,
  provider_session_id = excluded.provider_session_id,
  model = excluded.model,
  settings_json = excluded.settings_json,
  session_metadata_json = excluded.session_metadata_json,
  internal_runtime_context_json = excluded.internal_runtime_context_json,
  cwd = excluded.cwd,
  rail_section_kind = excluded.rail_section_kind,
  rail_project_path = excluded.rail_project_path,
  rail_section_key = excluded.rail_section_key,
  title = excluded.title,
  last_event_at_unix_ms = excluded.last_event_at_unix_ms,
  started_at_unix_ms = excluded.started_at_unix_ms,
  ended_at_unix_ms = excluded.ended_at_unix_ms,
  deleted_at_unix_ms = 0,
  updated_at_unix_ms = excluded.updated_at_unix_ms
WHERE workspace_agent_sessions.deleted_at_unix_ms = 0
`, session.WorkspaceID, session.AgentSessionID, session.Kind, nullString(session.RootAgentSessionID), nullString(session.RootTurnID),
		nullString(session.ParentAgentSessionID), nullString(session.ParentTurnID), nullString(session.ParentToolCallID),
		session.Origin, session.UserID, nullString(session.AgentTargetID), session.Provider,
		session.ProviderSessionID, session.Model, settingsJSON, metadataJSON, internalRuntimeContextJSON,
		session.CWD, railSection.Kind, railSection.ProjectPath, railSection.Key, session.Title,
		session.LastEventUnixMS, session.StartedAtUnixMS, session.EndedAtUnixMS, session.CreatedAtUnixMS,
		session.UpdatedAtUnixMS)
	if err != nil {
		return false, false, 0, Session{}, fmt.Errorf("upsert workspace agent session: %w", err)
	}
	accepted, err := rowsWereAffected(result, "upsert workspace agent session")
	if err != nil {
		return false, false, 0, Session{}, err
	}
	if accepted && len(input.RuntimeContext) > 0 {
		if err := reconcileObservedGoalFromSessionTx(ctx, tx, session, input.OccurredAtUnixMS); err != nil {
			return false, false, 0, Session{}, err
		}
	}
	dto, err := projectionSessionToDTO(projected.Session)
	if err != nil {
		return false, false, 0, Session{}, err
	}
	dto.RailSectionKind = railSection.Kind
	dto.RailProjectPath = railSection.ProjectPath
	dto.RailSectionKey = railSection.Key
	return accepted, sessionStateReportApplied(input, projected.Session), projected.LastEventUnixMS, dto, nil
}
