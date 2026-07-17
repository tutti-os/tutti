package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	activationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
)

type tuttiModeActivationRowQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (s *SQLiteStore) GetTuttiModeActivation(ctx context.Context, workspaceID, agentSessionID string) (activationbiz.Activation, bool, error) {
	if s == nil || s.writeDB == nil {
		return activationbiz.Activation{}, false, errors.New("workspace database is not initialized")
	}
	return getTuttiModeActivation(ctx, s.writeDB, strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID))
}

func (s *SQLiteStore) ListTuttiModeActivations(ctx context.Context, workspaceID string, agentSessionIDs []string) (map[string]activationbiz.Activation, error) {
	result := make(map[string]activationbiz.Activation)
	if s == nil || s.writeDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	seen := make(map[string]struct{}, len(agentSessionIDs))
	ids := make([]string, 0, len(agentSessionIDs))
	for _, sessionID := range agentSessionIDs {
		sessionID = strings.TrimSpace(sessionID)
		if sessionID == "" {
			continue
		}
		if _, ok := seen[sessionID]; !ok {
			seen[sessionID] = struct{}{}
			ids = append(ids, sessionID)
		}
	}
	if workspaceID == "" || len(ids) == 0 {
		return result, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids)+1)
	args = append(args, workspaceID)
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := s.writeDB.QueryContext(ctx, `
SELECT a.agent_session_id, a.activation_id, a.created_at_unix_ms, a.updated_at_unix_ms,
       r.revision_id, r.revision, r.state, r.source, r.orchestration_intensity, r.created_at_unix_ms
FROM tutti_mode_activations a
JOIN tutti_mode_activation_revisions r
  ON r.workspace_id = a.workspace_id
 AND r.activation_id = a.activation_id
 AND r.revision_id = a.current_revision_id
 AND r.revision = a.current_revision
WHERE a.workspace_id = ? AND a.agent_session_id IN (`+placeholders+`)
`, args...)
	if err != nil {
		return nil, fmt.Errorf("list Tutti mode activations: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var value activationbiz.Activation
		var createdAt, updatedAt, revisionCreatedAt int64
		if err := rows.Scan(
			&value.AgentSessionID, &value.ID, &createdAt, &updatedAt,
			&value.CurrentRevision.ID, &value.CurrentRevision.Revision,
			&value.CurrentRevision.State, &value.CurrentRevision.Source,
			&value.CurrentRevision.OrchestrationIntensity, &revisionCreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan Tutti mode activation list: %w", err)
		}
		value.WorkspaceID = workspaceID
		value.CurrentRevision.ActivationID = value.ID
		value.CurrentRevision.CreatedAt = time.UnixMilli(revisionCreatedAt).UTC()
		value.CreatedAt = time.UnixMilli(createdAt).UTC()
		value.UpdatedAt = time.UnixMilli(updatedAt).UTC()
		normalized, err := activationbiz.NormalizeActivation(value)
		if err != nil {
			return nil, fmt.Errorf("normalize listed Tutti mode activation: %w", err)
		}
		result[value.AgentSessionID] = normalized
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate Tutti mode activations: %w", err)
	}
	return result, nil
}

func (s *SQLiteStore) SetTuttiModeActivation(ctx context.Context, input SetTuttiModeActivationInput) (activationbiz.Activation, bool, error) {
	if s == nil || s.writeDB == nil {
		return activationbiz.Activation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.ActivationID = strings.TrimSpace(input.ActivationID)
	input.RevisionID = strings.TrimSpace(input.RevisionID)
	input.ChangedAt = input.ChangedAt.UTC()
	if input.WorkspaceID == "" || input.AgentSessionID == "" || input.RevisionID == "" || input.ChangedAt.IsZero() {
		return activationbiz.Activation{}, false, activationbiz.ErrInvalidActivation
	}
	if input.OrchestrationIntensity != nil && !activationbiz.IsOrchestrationIntensity(*input.OrchestrationIntensity) {
		return activationbiz.Activation{}, false, fmt.Errorf("%w: orchestration intensity must be between 0 and 100", activationbiz.ErrInvalidActivation)
	}
	if _, err := activationbiz.NormalizeRevision(activationbiz.Revision{
		ID: input.RevisionID, ActivationID: firstNonBlank(input.ActivationID, "pending"), Revision: 1,
		State: input.State, Source: input.Source, CreatedAt: input.ChangedAt,
	}); err != nil {
		return activationbiz.Activation{}, false, err
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return activationbiz.Activation{}, false, fmt.Errorf("begin set Tutti mode activation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	current, exists, err := getTuttiModeActivation(ctx, tx, input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return activationbiz.Activation{}, false, err
	}
	if input.ExpectedRevision != nil {
		actual := int64(0)
		if exists {
			actual = current.CurrentRevision.Revision
		}
		if actual != *input.ExpectedRevision {
			return activationbiz.Activation{}, false, ErrTuttiModeActivationRevisionConflict
		}
	}
	effectiveIntensity := activationbiz.DefaultOrchestrationIntensity
	if exists {
		effectiveIntensity = current.CurrentRevision.OrchestrationIntensity
	}
	if input.OrchestrationIntensity != nil {
		effectiveIntensity = *input.OrchestrationIntensity
	}
	if exists && current.CurrentRevision.State == input.State && current.CurrentRevision.Source == input.Source &&
		current.CurrentRevision.OrchestrationIntensity == effectiveIntensity {
		return current, false, nil
	}
	if !exists && input.State == activationbiz.StateInactive {
		return activationbiz.Activation{}, false, nil
	}
	if exists && input.ChangedAt.Before(current.UpdatedAt) {
		// Revision order is authoritative, but activation timestamps still form a
		// non-decreasing projection. Clamp a wall-clock rollback so one valid
		// transition cannot make the durable root unreadable on the next GET.
		input.ChangedAt = current.UpdatedAt
	}

	if !exists {
		if input.ActivationID == "" {
			return activationbiz.Activation{}, false, activationbiz.ErrInvalidActivation
		}
		current = activationbiz.Activation{
			ID: input.ActivationID, WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
			CreatedAt: input.ChangedAt,
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO tutti_mode_activations (
  workspace_id, activation_id, agent_session_id, current_revision_id,
  current_revision, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, 1, ?, ?)
`, input.WorkspaceID, input.ActivationID, input.AgentSessionID, input.RevisionID,
			unixMs(input.ChangedAt), unixMs(input.ChangedAt)); err != nil {
			return activationbiz.Activation{}, false, fmt.Errorf("insert Tutti mode activation: %w", err)
		}
	} else {
		input.ActivationID = current.ID
	}

	nextRevision := current.CurrentRevision.Revision + 1
	if !exists {
		nextRevision = 1
	}
	revision := activationbiz.Revision{
		ID: input.RevisionID, ActivationID: input.ActivationID, Revision: nextRevision,
		State: input.State, Source: input.Source,
		OrchestrationIntensity: effectiveIntensity, CreatedAt: input.ChangedAt,
	}
	if _, err := activationbiz.NormalizeRevision(revision); err != nil {
		return activationbiz.Activation{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tutti_mode_activation_revisions (
  workspace_id, activation_id, revision_id, revision, state, source, orchestration_intensity, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`, input.WorkspaceID, input.ActivationID, input.RevisionID, nextRevision,
		string(input.State), string(input.Source), effectiveIntensity, unixMs(input.ChangedAt)); err != nil {
		return activationbiz.Activation{}, false, fmt.Errorf("insert Tutti mode activation revision: %w", err)
	}
	if exists {
		result, err := tx.ExecContext(ctx, `
UPDATE tutti_mode_activations
SET current_revision_id = ?, current_revision = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND activation_id = ? AND current_revision = ?
`, input.RevisionID, nextRevision, unixMs(input.ChangedAt), input.WorkspaceID, input.ActivationID, current.CurrentRevision.Revision)
		if err != nil {
			return activationbiz.Activation{}, false, fmt.Errorf("advance Tutti mode activation revision: %w", err)
		}
		rows, err := result.RowsAffected()
		if err != nil || rows != 1 {
			return activationbiz.Activation{}, false, ErrTuttiModeActivationRevisionConflict
		}
	}
	if err := tx.Commit(); err != nil {
		return activationbiz.Activation{}, false, fmt.Errorf("commit Tutti mode activation: %w", err)
	}
	current.CurrentRevision = revision
	current.UpdatedAt = input.ChangedAt
	if current.CreatedAt.IsZero() {
		current.CreatedAt = input.ChangedAt
	}
	return current, true, nil
}

func getTuttiModeActivation(ctx context.Context, q tuttiModeActivationRowQuerier, workspaceID, agentSessionID string) (activationbiz.Activation, bool, error) {
	if workspaceID == "" || agentSessionID == "" {
		return activationbiz.Activation{}, false, nil
	}
	var value activationbiz.Activation
	var createdAt, updatedAt, revisionCreatedAt int64
	err := q.QueryRowContext(ctx, `
SELECT a.activation_id, a.created_at_unix_ms, a.updated_at_unix_ms,
       r.revision_id, r.revision, r.state, r.source, r.orchestration_intensity, r.created_at_unix_ms
FROM tutti_mode_activations a
JOIN tutti_mode_activation_revisions r
  ON r.workspace_id = a.workspace_id
 AND r.activation_id = a.activation_id
 AND r.revision_id = a.current_revision_id
 AND r.revision = a.current_revision
WHERE a.workspace_id = ? AND a.agent_session_id = ?
`, workspaceID, agentSessionID).Scan(
		&value.ID, &createdAt, &updatedAt,
		&value.CurrentRevision.ID, &value.CurrentRevision.Revision,
		&value.CurrentRevision.State, &value.CurrentRevision.Source,
		&value.CurrentRevision.OrchestrationIntensity, &revisionCreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return activationbiz.Activation{}, false, nil
	}
	if err != nil {
		return activationbiz.Activation{}, false, fmt.Errorf("get Tutti mode activation: %w", err)
	}
	value.WorkspaceID = workspaceID
	value.AgentSessionID = agentSessionID
	value.CurrentRevision.ActivationID = value.ID
	value.CurrentRevision.CreatedAt = time.UnixMilli(revisionCreatedAt).UTC()
	value.CreatedAt = time.UnixMilli(createdAt).UTC()
	value.UpdatedAt = time.UnixMilli(updatedAt).UTC()
	normalized, err := activationbiz.NormalizeActivation(value)
	if err != nil {
		return activationbiz.Activation{}, false, fmt.Errorf("normalize stored Tutti mode activation: %w", err)
	}
	return normalized, true, nil
}

func (s *SQLiteStore) GetTuttiModeTurnSnapshot(ctx context.Context, workspaceID, agentSessionID, turnID string) (activationbiz.TurnSnapshot, bool, error) {
	if s == nil || s.writeDB == nil {
		return activationbiz.TurnSnapshot{}, false, errors.New("workspace database is not initialized")
	}
	var value activationbiz.TurnSnapshot
	err := s.writeDB.QueryRowContext(ctx, `
SELECT activation_id, revision_id, revision, state, source, orchestration_intensity
FROM tutti_mode_turn_snapshots
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID), strings.TrimSpace(turnID)).Scan(
		&value.ActivationID, &value.RevisionID, &value.Revision, &value.State, &value.Source,
		&value.OrchestrationIntensity,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return activationbiz.TurnSnapshot{}, false, nil
	}
	if err != nil {
		return activationbiz.TurnSnapshot{}, false, fmt.Errorf("get Tutti mode turn snapshot: %w", err)
	}
	value, err = activationbiz.NormalizeTurnSnapshot(value)
	return value, err == nil, err
}

func (s *SQLiteStore) PutTuttiModeTurnSnapshot(ctx context.Context, workspaceID, agentSessionID, turnID string, snapshot activationbiz.TurnSnapshot, createdAt time.Time) (activationbiz.TurnSnapshot, bool, error) {
	if s == nil || s.writeDB == nil {
		return activationbiz.TurnSnapshot{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	turnID = strings.TrimSpace(turnID)
	createdAt = createdAt.UTC()
	if workspaceID == "" || agentSessionID == "" || turnID == "" || createdAt.IsZero() {
		return activationbiz.TurnSnapshot{}, false, activationbiz.ErrInvalidActivation
	}
	normalized, err := activationbiz.NormalizeTurnSnapshot(snapshot)
	if err != nil {
		return activationbiz.TurnSnapshot{}, false, err
	}
	existing, ok, err := s.GetTuttiModeTurnSnapshot(ctx, workspaceID, agentSessionID, turnID)
	if err != nil || ok {
		return existing, false, err
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO tutti_mode_turn_snapshots (
  workspace_id, agent_session_id, turn_id, activation_id, revision_id,
  revision, state, source, orchestration_intensity, created_at_unix_ms, dispatch_state
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared')
`, workspaceID, agentSessionID, turnID, normalized.ActivationID, normalized.RevisionID,
		normalized.Revision, string(normalized.State), string(normalized.Source),
		normalized.OrchestrationIntensity, unixMs(createdAt))
	if err != nil {
		if existing, ok, readErr := s.GetTuttiModeTurnSnapshot(ctx, workspaceID, agentSessionID, turnID); readErr == nil && ok {
			return existing, false, nil
		}
		return activationbiz.TurnSnapshot{}, false, fmt.Errorf("insert Tutti mode turn snapshot: %w", err)
	}
	return normalized, true, nil
}

func (s *SQLiteStore) AcceptTuttiModeTurnSnapshot(ctx context.Context, workspaceID, agentSessionID, turnID string, acceptedAt time.Time) (bool, error) {
	if s == nil || s.writeDB == nil {
		return false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	turnID = strings.TrimSpace(turnID)
	acceptedAt = acceptedAt.UTC()
	if workspaceID == "" || agentSessionID == "" || turnID == "" || acceptedAt.IsZero() {
		return false, activationbiz.ErrInvalidActivation
	}
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE tutti_mode_turn_snapshots
SET dispatch_state = 'accepted', accepted_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ? AND dispatch_state = 'prepared'
`, unixMs(acceptedAt), workspaceID, agentSessionID, turnID)
	if err != nil {
		return false, fmt.Errorf("accept Tutti mode turn snapshot: %w", err)
	}
	rows, err := result.RowsAffected()
	return rows > 0, err
}

func (s *SQLiteStore) IsTuttiModeTurnSnapshotAccepted(ctx context.Context, workspaceID, agentSessionID, turnID string) (bool, error) {
	if s == nil || s.writeDB == nil {
		return false, errors.New("workspace database is not initialized")
	}
	var dispatchState string
	err := s.writeDB.QueryRowContext(ctx, `
SELECT dispatch_state
FROM tutti_mode_turn_snapshots
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID), strings.TrimSpace(turnID)).Scan(&dispatchState)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("get Tutti mode turn snapshot dispatch state: %w", err)
	}
	return dispatchState == "accepted", nil
}

func (s *SQLiteStore) AbandonTuttiModeTurnSnapshot(ctx context.Context, workspaceID, agentSessionID, turnID string, snapshot activationbiz.TurnSnapshot) (bool, error) {
	if s == nil || s.writeDB == nil {
		return false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	turnID = strings.TrimSpace(turnID)
	normalized, err := activationbiz.NormalizeTurnSnapshot(snapshot)
	if err != nil || workspaceID == "" || agentSessionID == "" || turnID == "" {
		return false, activationbiz.ErrInvalidActivation
	}
	result, err := s.writeDB.ExecContext(ctx, `
DELETE FROM tutti_mode_turn_snapshots
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
  AND dispatch_state = 'prepared'
  AND activation_id = ? AND revision_id = ? AND revision = ? AND state = ? AND source = ?
  AND orchestration_intensity = ?
`, workspaceID, agentSessionID, turnID, normalized.ActivationID, normalized.RevisionID,
		normalized.Revision, string(normalized.State), string(normalized.Source),
		normalized.OrchestrationIntensity)
	if err != nil {
		return false, fmt.Errorf("abandon Tutti mode turn snapshot: %w", err)
	}
	rows, err := result.RowsAffected()
	return rows > 0, err
}

func (s *SQLiteStore) DeleteTuttiModeActivationSessionState(ctx context.Context, workspaceID, agentSessionID string) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return activationbiz.ErrInvalidActivation
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin delete Tutti mode session state: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM tutti_mode_turn_snapshots WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
		return fmt.Errorf("delete Tutti mode turn snapshots: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM tutti_mode_activations WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
		return fmt.Errorf("delete Tutti mode activation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete Tutti mode session state: %w", err)
	}
	return nil
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
