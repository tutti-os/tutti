package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

var ErrSubmitClaimTurnConflict = errors.New("workspace agent submit claim canonical turn conflict")

type SubmitClaim struct {
	WorkspaceID     string
	AgentSessionID  string
	ClientSubmitID  string
	Status          string
	CanonicalTurnID string
	TurnID          string
	MetadataJSON    string
	CreatedAtUnixMS int64
	UpdatedAtUnixMS int64
}

type SubmitClaimPrepare struct {
	WorkspaceID     string
	AgentSessionID  string
	ClientSubmitID  string
	CanonicalTurnID string
	MetadataJSON    string
	NowUnixMS       int64
}

func (s *Store) PrepareSubmitClaim(ctx context.Context, input SubmitClaimPrepare) (SubmitClaim, bool, error) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.ClientSubmitID = strings.TrimSpace(input.ClientSubmitID)
	input.CanonicalTurnID = strings.TrimSpace(input.CanonicalTurnID)
	if strings.TrimSpace(input.MetadataJSON) == "" {
		input.MetadataJSON = "{}"
	}
	var metadata map[string]any
	metadataErr := json.Unmarshal([]byte(input.MetadataJSON), &metadata)
	if input.WorkspaceID == "" || input.AgentSessionID == "" || input.ClientSubmitID == "" || input.CanonicalTurnID == "" || input.NowUnixMS <= 0 {
		return SubmitClaim{}, false, fmt.Errorf("invalid workspace agent submit claim")
	}
	if metadataErr != nil || metadata == nil {
		return SubmitClaim{}, false, fmt.Errorf("invalid workspace agent submit claim metadata")
	}
	// Enforce the privacy boundary at the durable API as well as at Host call
	// sites: claims retain only the closed provenance needed before the full
	// submission envelope is available.
	claimMetadata := make(map[string]any, 1)
	if mode, ok := metadata["uiMode"].(string); ok && (mode == "os" || mode == "agent") {
		claimMetadata["uiMode"] = mode
	}
	encodedMetadata, err := json.Marshal(claimMetadata)
	if err != nil {
		return SubmitClaim{}, false, fmt.Errorf("encode workspace agent submit claim metadata: %w", err)
	}
	input.MetadataJSON = string(encodedMetadata)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SubmitClaim{}, false, fmt.Errorf("begin prepare submit claim: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if claim, found, err := getSubmitClaimTx(
		ctx,
		tx,
		input.WorkspaceID,
		input.AgentSessionID,
		input.ClientSubmitID,
	); err != nil {
		return SubmitClaim{}, false, err
	} else if found {
		if err := tx.Commit(); err != nil {
			return SubmitClaim{}, false, fmt.Errorf("commit duplicate submit claim read: %w", err)
		}
		return claim, false, nil
	}
	if err := requireSessionForkSourceWritableTx(
		ctx,
		tx,
		input.WorkspaceID,
		input.AgentSessionID,
	); err != nil {
		return SubmitClaim{}, false, err
	}
	result, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO workspace_agent_submit_claims
		(workspace_id, agent_session_id, client_submit_id, status, turn_id, created_at_unix_ms, updated_at_unix_ms, canonical_turn_id, metadata_json)
		VALUES (?, ?, ?, 'prepared', NULL, ?, ?, ?, ?)`, input.WorkspaceID, input.AgentSessionID, input.ClientSubmitID, input.NowUnixMS, input.NowUnixMS, input.CanonicalTurnID, input.MetadataJSON)
	if err != nil {
		return SubmitClaim{}, false, fmt.Errorf("prepare submit claim: %w", err)
	}
	created, err := rowsWereAffected(result, "prepare submit claim")
	if err != nil {
		return SubmitClaim{}, false, err
	}
	claim, ok, err := getSubmitClaimTx(
		ctx,
		tx,
		input.WorkspaceID,
		input.AgentSessionID,
		input.ClientSubmitID,
	)
	if err != nil {
		return SubmitClaim{}, false, err
	}
	if !ok {
		return SubmitClaim{}, false, fmt.Errorf("prepared submit claim disappeared before it could be read")
	}
	if err := tx.Commit(); err != nil {
		return SubmitClaim{}, false, fmt.Errorf("commit prepare submit claim: %w", err)
	}
	return claim, created, nil
}

func (s *Store) AcceptSubmitClaim(ctx context.Context, workspaceID, agentSessionID, clientSubmitID, turnID string, nowUnixMS int64) (SubmitClaim, bool, error) {
	workspaceID, agentSessionID, clientSubmitID, turnID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID), strings.TrimSpace(clientSubmitID), strings.TrimSpace(turnID)
	if workspaceID == "" || agentSessionID == "" || clientSubmitID == "" || turnID == "" || nowUnixMS <= 0 {
		return SubmitClaim{}, false, fmt.Errorf("invalid accepted submit claim")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SubmitClaim{}, false, fmt.Errorf("begin accept submit claim: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	claim, ok, err := getSubmitClaimTx(ctx, tx, workspaceID, agentSessionID, clientSubmitID)
	if err != nil {
		return SubmitClaim{}, false, err
	}
	if !ok {
		return SubmitClaim{}, false, fmt.Errorf("accepted submit claim does not exist")
	}
	if claim.CanonicalTurnID == "" || claim.CanonicalTurnID != turnID || (claim.Status == "accepted" && claim.TurnID != turnID) {
		return claim, false, fmt.Errorf(
			"%w: claim canonical=%q accepted=%q returned=%q",
			ErrSubmitClaimTurnConflict,
			claim.CanonicalTurnID,
			claim.TurnID,
			turnID,
		)
	}
	if claim.Status == "accepted" {
		if err := tx.Commit(); err != nil {
			return SubmitClaim{}, false, fmt.Errorf("commit accepted submit claim replay: %w", err)
		}
		return claim, false, nil
	}
	if claim.Status == "rejected" {
		return claim, false, fmt.Errorf("%w: rejected submit claim cannot be accepted", ErrSubmitClaimTurnConflict)
	}
	if claim.Status != "prepared" {
		return claim, false, fmt.Errorf("%w: unsupported submit claim status %q", ErrSubmitClaimTurnConflict, claim.Status)
	}
	if err := requireSessionForkSourceWritableTx(ctx, tx, workspaceID, agentSessionID); err != nil {
		return SubmitClaim{}, false, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE workspace_agent_submit_claims SET status='accepted', turn_id=?, updated_at_unix_ms=?
	WHERE workspace_id=? AND agent_session_id=? AND client_submit_id=? AND status='prepared' AND canonical_turn_id=?`, turnID, nowUnixMS, workspaceID, agentSessionID, clientSubmitID, turnID)
	if err != nil {
		return SubmitClaim{}, false, fmt.Errorf("accept submit claim: %w", err)
	}
	updated, err := rowsWereAffected(result, "accept submit claim")
	if err != nil {
		return SubmitClaim{}, false, err
	}
	claim, ok, err = getSubmitClaimTx(ctx, tx, workspaceID, agentSessionID, clientSubmitID)
	if err != nil {
		return SubmitClaim{}, false, err
	}
	if !ok {
		return SubmitClaim{}, false, fmt.Errorf("accepted submit claim disappeared before it could be read")
	}
	if err := tx.Commit(); err != nil {
		return SubmitClaim{}, false, fmt.Errorf("commit accept submit claim: %w", err)
	}
	return claim, updated, nil
}

// RejectSubmitClaim records a definitive provider rejection against the
// canonical Turn that already owns the submit. Rejection is terminal and
// idempotent: a replay of the same claim never downgrades an accepted claim or
// allocates a second Turn.
func (s *Store) RejectSubmitClaim(ctx context.Context, workspaceID, agentSessionID, clientSubmitID, turnID string, nowUnixMS int64) (SubmitClaim, bool, error) {
	workspaceID, agentSessionID, clientSubmitID, turnID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID), strings.TrimSpace(clientSubmitID), strings.TrimSpace(turnID)
	if workspaceID == "" || agentSessionID == "" || clientSubmitID == "" || turnID == "" || nowUnixMS <= 0 {
		return SubmitClaim{}, false, fmt.Errorf("invalid rejected submit claim")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SubmitClaim{}, false, fmt.Errorf("begin reject submit claim: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	claim, ok, err := getSubmitClaimTx(ctx, tx, workspaceID, agentSessionID, clientSubmitID)
	if err != nil {
		return SubmitClaim{}, false, err
	}
	if !ok {
		return SubmitClaim{}, false, fmt.Errorf("rejected submit claim does not exist")
	}
	if claim.CanonicalTurnID == "" || claim.CanonicalTurnID != turnID ||
		(claim.Status != "prepared" && claim.TurnID != turnID) {
		return claim, false, fmt.Errorf(
			"%w: claim canonical=%q rejected=%q returned=%q",
			ErrSubmitClaimTurnConflict,
			claim.CanonicalTurnID,
			claim.TurnID,
			turnID,
		)
	}
	if claim.Status == "accepted" {
		return claim, false, fmt.Errorf("%w: accepted submit claim cannot be rejected", ErrSubmitClaimTurnConflict)
	}
	if claim.Status == "rejected" {
		if err := tx.Commit(); err != nil {
			return SubmitClaim{}, false, fmt.Errorf("commit rejected submit claim replay: %w", err)
		}
		return claim, false, nil
	}
	if claim.Status != "prepared" {
		return claim, false, fmt.Errorf("%w: unsupported submit claim status %q", ErrSubmitClaimTurnConflict, claim.Status)
	}
	if err := requireSessionForkSourceWritableTx(ctx, tx, workspaceID, agentSessionID); err != nil {
		return SubmitClaim{}, false, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE workspace_agent_submit_claims SET status='rejected', turn_id=?, updated_at_unix_ms=?
	WHERE workspace_id=? AND agent_session_id=? AND client_submit_id=? AND status='prepared' AND canonical_turn_id=?`, turnID, nowUnixMS, workspaceID, agentSessionID, clientSubmitID, turnID)
	if err != nil {
		return SubmitClaim{}, false, fmt.Errorf("reject submit claim: %w", err)
	}
	updated, err := rowsWereAffected(result, "reject submit claim")
	if err != nil {
		return SubmitClaim{}, false, err
	}
	claim, ok, err = getSubmitClaimTx(ctx, tx, workspaceID, agentSessionID, clientSubmitID)
	if err != nil {
		return SubmitClaim{}, false, err
	}
	if !ok {
		return SubmitClaim{}, false, fmt.Errorf("rejected submit claim disappeared before it could be read")
	}
	if !updated && claim.Status == "prepared" {
		return claim, false, fmt.Errorf("%w: prepared submit claim was not rejected", ErrSubmitClaimTurnConflict)
	}
	if err := tx.Commit(); err != nil {
		return SubmitClaim{}, false, fmt.Errorf("commit reject submit claim: %w", err)
	}
	return claim, updated, nil
}

func (s *Store) DeleteSubmitClaim(ctx context.Context, workspaceID, agentSessionID, clientSubmitID string) (bool, error) {
	workspaceID, agentSessionID, clientSubmitID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID), strings.TrimSpace(clientSubmitID)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin delete submit claim: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, found, err := getSubmitClaimTx(ctx, tx, workspaceID, agentSessionID, clientSubmitID); err != nil {
		return false, err
	} else if !found {
		if err := tx.Commit(); err != nil {
			return false, fmt.Errorf("commit absent submit claim delete: %w", err)
		}
		return false, nil
	}
	if err := requireSessionForkSourceWritableTx(ctx, tx, workspaceID, agentSessionID); err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_submit_claims WHERE workspace_id=? AND agent_session_id=? AND client_submit_id=?`, workspaceID, agentSessionID, clientSubmitID)
	if err != nil {
		return false, fmt.Errorf("delete submit claim: %w", err)
	}
	deleted, err := rowsWereAffected(result, "delete submit claim")
	if err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit delete submit claim: %w", err)
	}
	return deleted, nil
}

func (s *Store) GetSubmitClaim(ctx context.Context, workspaceID, agentSessionID, clientSubmitID string) (SubmitClaim, bool, error) {
	return s.getSubmitClaim(
		ctx,
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(agentSessionID),
		strings.TrimSpace(clientSubmitID),
	)
}

// FindSubmitClaimByCanonicalTurn resolves the opaque provider recovery token
// owned by Tutti. More than one claim for a canonical Turn is ambiguous and
// fails closed instead of selecting by creation order.
func (s *Store) FindSubmitClaimByCanonicalTurn(
	ctx context.Context,
	workspaceID, agentSessionID, canonicalTurnID string,
) (SubmitClaim, bool, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	canonicalTurnID = strings.TrimSpace(canonicalTurnID)
	if s == nil || s.db == nil || workspaceID == "" ||
		agentSessionID == "" || canonicalTurnID == "" {
		return SubmitClaim{}, false, nil
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT workspace_id, agent_session_id, client_submit_id, status,
	       canonical_turn_id, turn_id, metadata_json, created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_submit_claims
WHERE workspace_id = ? AND agent_session_id = ? AND canonical_turn_id = ?
  AND status IN ('prepared', 'accepted')
ORDER BY client_submit_id
LIMIT 2
`, workspaceID, agentSessionID, canonicalTurnID)
	if err != nil {
		return SubmitClaim{}, false, fmt.Errorf(
			"find submit claim by canonical turn: %w",
			err,
		)
	}
	defer rows.Close()
	var result SubmitClaim
	count := 0
	for rows.Next() {
		claim, _, scanErr := scanSubmitClaim(rows)
		if scanErr != nil {
			return SubmitClaim{}, false, scanErr
		}
		result = claim
		count++
	}
	if err := rows.Err(); err != nil {
		return SubmitClaim{}, false, fmt.Errorf(
			"iterate submit claims by canonical turn: %w",
			err,
		)
	}
	if count > 1 {
		return SubmitClaim{}, false, ErrSubmitClaimTurnConflict
	}
	return result, count == 1, nil
}

func (s *Store) getSubmitClaim(ctx context.Context, workspaceID, agentSessionID, clientSubmitID string) (SubmitClaim, bool, error) {
	return scanSubmitClaim(s.db.QueryRowContext(
		ctx,
		`SELECT workspace_id, agent_session_id, client_submit_id, status, canonical_turn_id, turn_id, metadata_json, created_at_unix_ms, updated_at_unix_ms
		FROM workspace_agent_submit_claims WHERE workspace_id=? AND agent_session_id=? AND client_submit_id=?`,
		workspaceID,
		agentSessionID,
		clientSubmitID,
	))
}

func getSubmitClaimTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID, agentSessionID, clientSubmitID string,
) (SubmitClaim, bool, error) {
	return scanSubmitClaim(tx.QueryRowContext(
		ctx,
		`SELECT workspace_id, agent_session_id, client_submit_id, status, canonical_turn_id, turn_id, metadata_json, created_at_unix_ms, updated_at_unix_ms
		FROM workspace_agent_submit_claims WHERE workspace_id=? AND agent_session_id=? AND client_submit_id=?`,
		workspaceID,
		agentSessionID,
		clientSubmitID,
	))
}

func scanSubmitClaim(row rowScanner) (SubmitClaim, bool, error) {
	var claim SubmitClaim
	var canonicalTurnID sql.NullString
	var turnID sql.NullString
	err := row.Scan(
		&claim.WorkspaceID,
		&claim.AgentSessionID,
		&claim.ClientSubmitID,
		&claim.Status,
		&canonicalTurnID,
		&turnID,
		&claim.MetadataJSON,
		&claim.CreatedAtUnixMS,
		&claim.UpdatedAtUnixMS,
	)
	if err == sql.ErrNoRows {
		return SubmitClaim{}, false, nil
	}
	if err != nil {
		return SubmitClaim{}, false, fmt.Errorf("get submit claim: %w", err)
	}
	if turnID.Valid {
		claim.TurnID = turnID.String
	}
	if canonicalTurnID.Valid {
		claim.CanonicalTurnID = canonicalTurnID.String
	}
	return claim, true, nil
}
