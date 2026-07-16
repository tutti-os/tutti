package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrInvalidGoalProvenanceBinding = errors.New("invalid goal provenance binding")
var ErrGoalProvenanceSessionNotFound = errors.New("cannot bind goal provenance for missing session")
var ErrGoalProvenanceSessionDeleted = errors.New("cannot bind goal provenance for deleted session")

func (s *Store) BindGoalProvenance(ctx context.Context, input BindGoalProvenanceInput) (GoalProvenanceBinding, error) {
	if s == nil || s.db == nil {
		return GoalProvenanceBinding{}, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.ProviderSessionID = strings.TrimSpace(input.ProviderSessionID)
	input.Fingerprint = strings.TrimSpace(input.Fingerprint)
	input.OperationID = strings.TrimSpace(input.OperationID)
	if input.WorkspaceID == "" || input.AgentSessionID == "" || input.ProviderSessionID == "" ||
		input.SessionCreatedAtUnixMS <= 0 || input.Fingerprint == "" || input.OperationID == "" || input.Revision <= 0 || input.RepairEpoch < 0 {
		return GoalProvenanceBinding{}, ErrInvalidGoalProvenanceBinding
	}
	now := input.OccurredAtUnixMS
	if now <= 0 {
		now = unixMs(time.Now().UTC())
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GoalProvenanceBinding{}, fmt.Errorf("begin bind goal provenance: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var deletedAt, sessionCreatedAt int64
	err = tx.QueryRowContext(ctx, `
SELECT deleted_at_unix_ms,created_at_unix_ms FROM workspace_agent_sessions
WHERE workspace_id=? AND agent_session_id=?
`, input.WorkspaceID, input.AgentSessionID).Scan(&deletedAt, &sessionCreatedAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return GoalProvenanceBinding{}, fmt.Errorf("check goal provenance session tombstone: %w", err)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return GoalProvenanceBinding{}, ErrGoalProvenanceSessionNotFound
	}
	if err == nil && deletedAt > 0 {
		return GoalProvenanceBinding{}, ErrGoalProvenanceSessionDeleted
	}
	if sessionCreatedAt != input.SessionCreatedAtUnixMS {
		return GoalProvenanceBinding{}, ErrGoalProvenanceSessionNotFound
	}

	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_goal_provenance_ledger (
 workspace_id,agent_session_id,session_created_at_unix_ms,provider_session_id,fingerprint,
 operation_id,goal_revision,repair_epoch,ambiguous,created_at_unix_ms,updated_at_unix_ms
) VALUES (?,?,?,?,?,?,?,?,0,?,?)
ON CONFLICT(workspace_id,agent_session_id,session_created_at_unix_ms,provider_session_id,fingerprint) DO NOTHING
`, input.WorkspaceID, input.AgentSessionID, input.SessionCreatedAtUnixMS, input.ProviderSessionID, input.Fingerprint,
		input.OperationID, input.Revision, input.RepairEpoch, now, now); err != nil {
		return GoalProvenanceBinding{}, fmt.Errorf("insert goal provenance binding: %w", err)
	}

	binding, found, err := lookupGoalProvenance(ctx, tx, LookupGoalProvenanceInput{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		SessionCreatedAtUnixMS: input.SessionCreatedAtUnixMS,
		ProviderSessionID:      input.ProviderSessionID, Fingerprint: input.Fingerprint,
	})
	if err != nil {
		return GoalProvenanceBinding{}, err
	}
	if !found {
		return GoalProvenanceBinding{}, errors.New("goal provenance binding disappeared during bind")
	}
	if !binding.Ambiguous && (binding.OperationID != input.OperationID || binding.Revision != input.Revision || binding.RepairEpoch != input.RepairEpoch) {
		// A collision permanently destroys the association. Clear the old
		// identity so no future caller can accidentally consume it.
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_goal_provenance_ledger
SET operation_id='', goal_revision=0, repair_epoch=0, ambiguous=1, updated_at_unix_ms=?
WHERE workspace_id=? AND agent_session_id=? AND session_created_at_unix_ms=? AND provider_session_id=? AND fingerprint=? AND ambiguous=0
`, now, input.WorkspaceID, input.AgentSessionID, input.SessionCreatedAtUnixMS, input.ProviderSessionID, input.Fingerprint); err != nil {
			return GoalProvenanceBinding{}, fmt.Errorf("tombstone ambiguous goal provenance binding: %w", err)
		}
		binding, found, err = lookupGoalProvenance(ctx, tx, LookupGoalProvenanceInput{
			WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
			SessionCreatedAtUnixMS: input.SessionCreatedAtUnixMS,
			ProviderSessionID:      input.ProviderSessionID, Fingerprint: input.Fingerprint,
		})
		if err != nil || !found {
			return GoalProvenanceBinding{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return GoalProvenanceBinding{}, fmt.Errorf("commit goal provenance binding: %w", err)
	}
	return binding, nil
}

func (s *Store) LookupGoalProvenance(ctx context.Context, input LookupGoalProvenanceInput) (GoalProvenanceBinding, bool, error) {
	if s == nil || s.db == nil {
		return GoalProvenanceBinding{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.ProviderSessionID = strings.TrimSpace(input.ProviderSessionID)
	input.Fingerprint = strings.TrimSpace(input.Fingerprint)
	if input.WorkspaceID == "" || input.AgentSessionID == "" || input.SessionCreatedAtUnixMS <= 0 || input.ProviderSessionID == "" || input.Fingerprint == "" {
		return GoalProvenanceBinding{}, false, nil
	}
	return lookupGoalProvenance(ctx, s.db, input)
}

type goalProvenanceQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func lookupGoalProvenance(ctx context.Context, q goalProvenanceQueryer, input LookupGoalProvenanceInput) (GoalProvenanceBinding, bool, error) {
	var binding GoalProvenanceBinding
	var ambiguous int
	err := q.QueryRowContext(ctx, `
SELECT workspace_id,agent_session_id,session_created_at_unix_ms,provider_session_id,fingerprint,
       operation_id,goal_revision,repair_epoch,ambiguous,created_at_unix_ms,updated_at_unix_ms
FROM workspace_agent_goal_provenance_ledger
WHERE workspace_id=? AND agent_session_id=? AND session_created_at_unix_ms=? AND provider_session_id=? AND fingerprint=?
`, input.WorkspaceID, input.AgentSessionID, input.SessionCreatedAtUnixMS, input.ProviderSessionID, input.Fingerprint).Scan(
		&binding.WorkspaceID, &binding.AgentSessionID, &binding.SessionCreatedAtUnixMS, &binding.ProviderSessionID, &binding.Fingerprint,
		&binding.OperationID, &binding.Revision, &binding.RepairEpoch, &ambiguous,
		&binding.CreatedAtUnixMS, &binding.UpdatedAtUnixMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return GoalProvenanceBinding{}, false, nil
	}
	if err != nil {
		return GoalProvenanceBinding{}, false, fmt.Errorf("lookup goal provenance binding: %w", err)
	}
	binding.Ambiguous = ambiguous != 0
	return binding, true, nil
}
