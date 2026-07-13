package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

type SubmitClaim struct {
	WorkspaceID     string
	AgentSessionID  string
	ClientSubmitID  string
	Status          string
	TurnID          string
	CreatedAtUnixMS int64
	UpdatedAtUnixMS int64
}

type SubmitClaimPrepare struct {
	WorkspaceID    string
	AgentSessionID string
	ClientSubmitID string
	NowUnixMS      int64
}

func (s *Store) PrepareSubmitClaim(ctx context.Context, input SubmitClaimPrepare) (SubmitClaim, bool, error) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.ClientSubmitID = strings.TrimSpace(input.ClientSubmitID)
	if input.WorkspaceID == "" || input.AgentSessionID == "" || input.ClientSubmitID == "" || input.NowUnixMS <= 0 {
		return SubmitClaim{}, false, fmt.Errorf("invalid workspace agent submit claim")
	}
	result, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO workspace_agent_submit_claims
    (workspace_id, agent_session_id, client_submit_id, status, turn_id, created_at_unix_ms, updated_at_unix_ms)
    VALUES (?, ?, ?, 'prepared', NULL, ?, ?)`, input.WorkspaceID, input.AgentSessionID, input.ClientSubmitID, input.NowUnixMS, input.NowUnixMS)
	if err != nil {
		return SubmitClaim{}, false, fmt.Errorf("prepare submit claim: %w", err)
	}
	created, err := rowsWereAffected(result, "prepare submit claim")
	if err != nil {
		return SubmitClaim{}, false, err
	}
	claim, ok, err := s.getSubmitClaim(ctx, input.WorkspaceID, input.AgentSessionID, input.ClientSubmitID)
	if err != nil {
		return SubmitClaim{}, false, err
	}
	if !ok {
		return SubmitClaim{}, false, fmt.Errorf("prepared submit claim disappeared before it could be read")
	}
	return claim, created, nil
}

func (s *Store) AcceptSubmitClaim(ctx context.Context, workspaceID, agentSessionID, clientSubmitID, turnID string, nowUnixMS int64) (SubmitClaim, bool, error) {
	workspaceID, agentSessionID, clientSubmitID, turnID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID), strings.TrimSpace(clientSubmitID), strings.TrimSpace(turnID)
	if workspaceID == "" || agentSessionID == "" || clientSubmitID == "" || turnID == "" || nowUnixMS <= 0 {
		return SubmitClaim{}, false, fmt.Errorf("invalid accepted submit claim")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE workspace_agent_submit_claims SET status='accepted', turn_id=?, updated_at_unix_ms=?
    WHERE workspace_id=? AND agent_session_id=? AND client_submit_id=? AND status='prepared'`, turnID, nowUnixMS, workspaceID, agentSessionID, clientSubmitID)
	if err != nil {
		return SubmitClaim{}, false, fmt.Errorf("accept submit claim: %w", err)
	}
	updated, err := rowsWereAffected(result, "accept submit claim")
	if err != nil {
		return SubmitClaim{}, false, err
	}
	claim, ok, err := s.getSubmitClaim(ctx, workspaceID, agentSessionID, clientSubmitID)
	if err != nil {
		return SubmitClaim{}, false, err
	}
	if !ok {
		return SubmitClaim{}, false, fmt.Errorf("accepted submit claim does not exist")
	}
	return claim, updated, nil
}

func (s *Store) DeleteSubmitClaim(ctx context.Context, workspaceID, agentSessionID, clientSubmitID string) (bool, error) {
	result, err := s.db.ExecContext(ctx, `DELETE FROM workspace_agent_submit_claims WHERE workspace_id=? AND agent_session_id=? AND client_submit_id=?`, strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID), strings.TrimSpace(clientSubmitID))
	if err != nil {
		return false, fmt.Errorf("delete submit claim: %w", err)
	}
	return rowsWereAffected(result, "delete submit claim")
}

func (s *Store) getSubmitClaim(ctx context.Context, workspaceID, agentSessionID, clientSubmitID string) (SubmitClaim, bool, error) {
	var claim SubmitClaim
	var turnID sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT workspace_id, agent_session_id, client_submit_id, status, turn_id, created_at_unix_ms, updated_at_unix_ms
    FROM workspace_agent_submit_claims WHERE workspace_id=? AND agent_session_id=? AND client_submit_id=?`, workspaceID, agentSessionID, clientSubmitID).Scan(&claim.WorkspaceID, &claim.AgentSessionID, &claim.ClientSubmitID, &claim.Status, &turnID, &claim.CreatedAtUnixMS, &claim.UpdatedAtUnixMS)
	if err == sql.ErrNoRows {
		return SubmitClaim{}, false, nil
	}
	if err != nil {
		return SubmitClaim{}, false, fmt.Errorf("get submit claim: %w", err)
	}
	if turnID.Valid {
		claim.TurnID = turnID.String
	}
	return claim, true, nil
}
