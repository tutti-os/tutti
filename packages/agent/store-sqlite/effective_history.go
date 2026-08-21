package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const (
	TurnHistoryStateEffective = "effective"
	TurnHistoryStateRetracted = "retracted"

	SessionHistoryRecoveryReady           = "ready"
	SessionHistoryRecoveryRollbackPending = "rollback_pending"
	SessionHistoryRecoveryResendPending   = "resend_pending"
	SessionHistoryRecoveryRequired        = "recovery_required"
)

var ErrTurnSubmissionConflict = errors.New("workspace agent turn submission conflicts with persisted envelope")

type SessionHistory struct {
	WorkspaceID     string
	AgentSessionID  string
	Revision        uint64
	RecoveryState   string
	OperationID     string
	UpdatedAtUnixMS int64
}

type TurnHistory struct {
	WorkspaceID            string
	AgentSessionID         string
	TurnID                 string
	State                  string
	RetractedByOperationID string
	ReplacementTurnID      string
	UpdatedAtUnixMS        int64
}

// TurnSubmission is the lossless persisted request envelope used for replay.
// ContentJSON retains attachment identifiers, never hydrated image bytes.
type TurnSubmission struct {
	WorkspaceID           string
	AgentSessionID        string
	TurnID                string
	ContentJSON           string
	DisplayPrompt         string
	CapabilityRefsJSON    string
	TuttiModeSnapshotJSON string
	MetadataJSON          string
	ClientSubmitID        string
	CreatedAtUnixMS       int64
	UpdatedAtUnixMS       int64
}

type TurnSubmissionReader interface {
	GetTurnSubmission(context.Context, string, string, string) (TurnSubmission, bool, error)
}

func (s *Store) GetSessionHistory(ctx context.Context, workspaceID, agentSessionID string) (SessionHistory, bool, error) {
	if s == nil || s.db == nil {
		return SessionHistory{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID, agentSessionID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return SessionHistory{}, false, nil
	}
	var result SessionHistory
	err := s.db.QueryRowContext(ctx, `
SELECT workspace_id, agent_session_id, history_revision, recovery_state,
       operation_id, updated_at_unix_ms
FROM workspace_agent_session_history
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, agentSessionID).Scan(
		&result.WorkspaceID, &result.AgentSessionID, &result.Revision,
		&result.RecoveryState, &result.OperationID, &result.UpdatedAtUnixMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionHistory{}, false, nil
	}
	if err != nil {
		return SessionHistory{}, false, fmt.Errorf("get workspace agent session history: %w", err)
	}
	return result, true, nil
}

func (s *Store) GetTurnHistory(ctx context.Context, workspaceID, agentSessionID, turnID string) (TurnHistory, bool, error) {
	if s == nil || s.db == nil {
		return TurnHistory{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID, agentSessionID, turnID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID), strings.TrimSpace(turnID)
	if workspaceID == "" || agentSessionID == "" || turnID == "" {
		return TurnHistory{}, false, nil
	}
	var result TurnHistory
	err := s.db.QueryRowContext(ctx, `
SELECT workspace_id, agent_session_id, turn_id, history_state,
       retracted_by_operation_id, replacement_turn_id, updated_at_unix_ms
FROM workspace_agent_turn_history
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, workspaceID, agentSessionID, turnID).Scan(
		&result.WorkspaceID, &result.AgentSessionID, &result.TurnID, &result.State,
		&result.RetractedByOperationID, &result.ReplacementTurnID, &result.UpdatedAtUnixMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return TurnHistory{}, false, nil
	}
	if err != nil {
		return TurnHistory{}, false, fmt.Errorf("get workspace agent turn history: %w", err)
	}
	return result, true, nil
}

func (s *Store) RecordTurnSubmission(ctx context.Context, input TurnSubmission) (TurnSubmission, bool, error) {
	if s == nil || s.db == nil {
		return TurnSubmission{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.TurnID = strings.TrimSpace(input.TurnID)
	input.ClientSubmitID = strings.TrimSpace(input.ClientSubmitID)
	if strings.TrimSpace(input.MetadataJSON) == "" {
		input.MetadataJSON = "{}"
	}
	var metadata map[string]any
	metadataErr := json.Unmarshal([]byte(input.MetadataJSON), &metadata)
	if input.WorkspaceID == "" || input.AgentSessionID == "" || input.TurnID == "" ||
		!json.Valid([]byte(input.ContentJSON)) ||
		!json.Valid([]byte(input.CapabilityRefsJSON)) ||
		!json.Valid([]byte(input.TuttiModeSnapshotJSON)) ||
		metadataErr != nil || metadata == nil {
		return TurnSubmission{}, false, errors.New("record workspace agent turn submission: invalid envelope")
	}
	if input.CreatedAtUnixMS <= 0 {
		input.CreatedAtUnixMS = input.UpdatedAtUnixMS
	}
	if input.UpdatedAtUnixMS <= 0 {
		input.UpdatedAtUnixMS = input.CreatedAtUnixMS
	}
	result, err := s.db.ExecContext(ctx, `
INSERT INTO workspace_agent_turn_submissions (
  workspace_id, agent_session_id, turn_id, content_json, display_prompt,
  capability_refs_json, tutti_mode_snapshot_json, metadata_json, client_submit_id,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id, turn_id) DO NOTHING
`, input.WorkspaceID, input.AgentSessionID, input.TurnID, input.ContentJSON, input.DisplayPrompt,
		input.CapabilityRefsJSON, input.TuttiModeSnapshotJSON, input.MetadataJSON, input.ClientSubmitID,
		input.CreatedAtUnixMS, input.UpdatedAtUnixMS)
	if err != nil {
		return TurnSubmission{}, false, fmt.Errorf("record workspace agent turn submission: %w", err)
	}
	insertedRows, err := result.RowsAffected()
	if err != nil {
		return TurnSubmission{}, false, fmt.Errorf("record workspace agent turn submission rows affected: %w", err)
	}
	stored, ok, err := s.GetTurnSubmission(ctx, input.WorkspaceID, input.AgentSessionID, input.TurnID)
	if err != nil {
		return TurnSubmission{}, false, err
	}
	if !ok {
		return TurnSubmission{}, false, errors.New("record workspace agent turn submission: persisted envelope missing")
	}
	if !sameTurnSubmissionEnvelope(stored, input) {
		return TurnSubmission{}, false, ErrTurnSubmissionConflict
	}
	return stored, insertedRows == 1, nil
}

func (s *Store) GetTurnSubmission(ctx context.Context, workspaceID, agentSessionID, turnID string) (TurnSubmission, bool, error) {
	if s == nil || s.db == nil {
		return TurnSubmission{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID, agentSessionID, turnID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID), strings.TrimSpace(turnID)
	if workspaceID == "" || agentSessionID == "" || turnID == "" {
		return TurnSubmission{}, false, nil
	}
	var result TurnSubmission
	err := s.db.QueryRowContext(ctx, `
SELECT workspace_id, agent_session_id, turn_id, content_json, display_prompt,
       capability_refs_json, tutti_mode_snapshot_json, metadata_json, client_submit_id,
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_turn_submissions
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, workspaceID, agentSessionID, turnID).Scan(
		&result.WorkspaceID, &result.AgentSessionID, &result.TurnID,
		&result.ContentJSON, &result.DisplayPrompt, &result.CapabilityRefsJSON,
		&result.TuttiModeSnapshotJSON, &result.MetadataJSON, &result.ClientSubmitID,
		&result.CreatedAtUnixMS, &result.UpdatedAtUnixMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return TurnSubmission{}, false, nil
	}
	if err != nil {
		return TurnSubmission{}, false, fmt.Errorf("get workspace agent turn submission: %w", err)
	}
	return result, true, nil
}

func sameTurnSubmissionEnvelope(left, right TurnSubmission) bool {
	return left.WorkspaceID == right.WorkspaceID &&
		left.AgentSessionID == right.AgentSessionID &&
		left.TurnID == right.TurnID &&
		left.ContentJSON == right.ContentJSON &&
		left.DisplayPrompt == right.DisplayPrompt &&
		left.CapabilityRefsJSON == right.CapabilityRefsJSON &&
		left.TuttiModeSnapshotJSON == right.TuttiModeSnapshotJSON &&
		left.MetadataJSON == right.MetadataJSON &&
		left.ClientSubmitID == right.ClientSubmitID
}
