package storesqlite

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

var ErrProviderTurnBindingConflict = errors.New(
	"workspace agent provider turn binding conflicts with canonical identity",
)

type ProviderTurnBindingRecovery struct {
	WorkspaceID               string
	AgentSessionID            string
	TurnID                    string
	ExpectedProviderSessionID string
	ProviderTurnID            string
	ProviderTurnBindingJSON   json.RawMessage
	OccurredAtUnixMS          int64
}

type ProviderTurnBindingRecoveryResult struct {
	Turn        Turn
	Changed     bool
	CommitDelta TransactionDelta
}

// RecoverProviderTurnBinding installs authoritative provider-history evidence
// without replaying lifecycle. The selected canonical Turn must already be
// settled; the empty binding is filled with a compare-and-swap and one
// provider Turn may belong to only one canonical Turn in the Session.
func (s *Store) RecoverProviderTurnBinding(
	ctx context.Context,
	input ProviderTurnBindingRecovery,
) (ProviderTurnBindingRecoveryResult, error) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.TurnID = strings.TrimSpace(input.TurnID)
	input.ExpectedProviderSessionID = strings.TrimSpace(
		input.ExpectedProviderSessionID,
	)
	input.ProviderTurnID = strings.TrimSpace(input.ProviderTurnID)
	bindingJSON, bindingErr := normalizeProviderTurnBindingJSON(
		input.ProviderTurnBindingJSON,
	)
	if s == nil || s.db == nil || input.WorkspaceID == "" ||
		input.AgentSessionID == "" || input.TurnID == "" ||
		input.ExpectedProviderSessionID == "" || input.ProviderTurnID == "" ||
		input.ProviderTurnID == input.TurnID ||
		bindingErr != nil || len(bindingJSON) == 0 ||
		input.OccurredAtUnixMS <= 0 {
		return ProviderTurnBindingRecoveryResult{}, errors.New(
			"invalid provider turn binding recovery",
		)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ProviderTurnBindingRecoveryResult{}, fmt.Errorf(
			"begin provider turn binding recovery: %w",
			err,
		)
	}
	defer func() { _ = tx.Rollback() }()
	var kind, providerSessionID string
	if err := tx.QueryRowContext(ctx, `
SELECT session_kind, COALESCE(provider_session_id, '')
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, input.WorkspaceID, input.AgentSessionID).Scan(
		&kind,
		&providerSessionID,
	); err != nil {
		return ProviderTurnBindingRecoveryResult{}, fmt.Errorf(
			"read provider turn recovery session: %w",
			err,
		)
	}
	if kind != SessionKindRoot ||
		strings.TrimSpace(providerSessionID) != input.ExpectedProviderSessionID {
		return ProviderTurnBindingRecoveryResult{},
			ErrProviderTurnBindingConflict
	}
	turn, found, err := getAgentTurnTx(
		ctx,
		tx,
		input.WorkspaceID,
		input.AgentSessionID,
		input.TurnID,
	)
	if err != nil {
		return ProviderTurnBindingRecoveryResult{}, err
	}
	if !found || turn.Phase != TurnPhaseSettled {
		return ProviderTurnBindingRecoveryResult{},
			ErrProviderTurnBindingConflict
	}
	if HasPersistedProviderTurnBinding(turn) &&
		turn.RootProviderTurnID != input.ProviderTurnID {
		return ProviderTurnBindingRecoveryResult{},
			ErrProviderTurnBindingConflict
	}
	var conflictingTurnID string
	err = tx.QueryRowContext(ctx, `
SELECT turn.turn_id
FROM workspace_agent_turns AS turn
JOIN workspace_agent_sessions AS session
  ON session.workspace_id = turn.workspace_id
 AND session.agent_session_id = turn.agent_session_id
WHERE turn.workspace_id = ?
  AND session.provider_session_id = ?
  AND turn.root_provider_turn_id = ?
  AND NOT (turn.agent_session_id = ? AND turn.turn_id = ?)
LIMIT 1
`, input.WorkspaceID,
		input.ExpectedProviderSessionID,
		input.ProviderTurnID,
		input.AgentSessionID,
		input.TurnID,
	).
		Scan(&conflictingTurnID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return ProviderTurnBindingRecoveryResult{}, fmt.Errorf(
			"check provider turn binding uniqueness: %w",
			err,
		)
	}
	if conflictingTurnID != "" {
		return ProviderTurnBindingRecoveryResult{},
			ErrProviderTurnBindingConflict
	}
	if HasPersistedProviderTurnBinding(turn) &&
		turn.RootProviderTurnID == input.ProviderTurnID &&
		bytes.Equal(turn.ProviderTurnBindingJSON, bindingJSON) {
		if err := tx.Commit(); err != nil {
			return ProviderTurnBindingRecoveryResult{}, fmt.Errorf(
				"commit provider turn binding replay: %w",
				err,
			)
		}
		return ProviderTurnBindingRecoveryResult{Turn: turn}, nil
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET root_provider_turn_id = ?,
    provider_turn_binding_json = ?,
    root_provider_turn_phase = CASE
      WHEN root_provider_turn_phase IS NULL OR TRIM(root_provider_turn_phase) = ''
      THEN 'completed'
      ELSE root_provider_turn_phase
    END,
    root_provider_turn_outcome = CASE
      WHEN root_provider_turn_outcome IS NULL OR TRIM(root_provider_turn_outcome) = ''
      THEN outcome
      ELSE root_provider_turn_outcome
    END,
    root_provider_turn_updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
  AND (root_provider_turn_id IS NULL OR TRIM(root_provider_turn_id) = ?
       OR root_provider_turn_id = ?
       OR root_provider_turn_id = turn_id
       OR provider_turn_binding_json = '{}')
`, input.ProviderTurnID,
		string(bindingJSON),
		input.OccurredAtUnixMS,
		input.WorkspaceID,
		input.AgentSessionID,
		input.TurnID,
		"",
		input.ProviderTurnID,
	)
	if err != nil {
		return ProviderTurnBindingRecoveryResult{}, fmt.Errorf(
			"recover provider turn binding: %w",
			err,
		)
	}
	changed, err := rowsWereAffected(result, "recover provider turn binding")
	if err != nil {
		return ProviderTurnBindingRecoveryResult{}, err
	}
	if !changed {
		return ProviderTurnBindingRecoveryResult{},
			ErrProviderTurnBindingConflict
	}
	turn, found, err = getAgentTurnTx(
		ctx,
		tx,
		input.WorkspaceID,
		input.AgentSessionID,
		input.TurnID,
	)
	if err != nil || !found {
		return ProviderTurnBindingRecoveryResult{}, errors.Join(
			ErrProviderTurnBindingConflict,
			err,
		)
	}
	delta, err := s.commitTransaction(
		ctx,
		tx,
		input.WorkspaceID,
		[]TransactionMutation{
			transactionMutation(
				input.WorkspaceID,
				input.AgentSessionID,
				MutationEntityTurn,
				input.TurnID,
				"upsert",
				input.OccurredAtUnixMS,
			),
		},
	)
	if err != nil {
		return ProviderTurnBindingRecoveryResult{}, fmt.Errorf(
			"commit provider turn binding recovery: %w",
			err,
		)
	}
	return ProviderTurnBindingRecoveryResult{
		Turn:        turn,
		Changed:     true,
		CommitDelta: delta,
	}, nil
}
