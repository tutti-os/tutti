package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

const (
	defaultPurgeSessionLimit = 25
	maximumPurgeSessionLimit = 100
	defaultPurgePayloadBytes = int64(32 << 20)
)

// PurgeDeletedSessions permanently removes bounded, complete tombstoned
// trees. It never splits a root/child tree across commits, never considers a
// tree containing a live or too-new member, and fences every member by its
// exact deleted_at value before removing dependent data.
func (s *Store) PurgeDeletedSessions(
	ctx context.Context,
	input PurgeDeletedSessionsInput,
) (PurgeDeletedSessionsResult, error) {
	if s == nil || s.db == nil {
		return PurgeDeletedSessionsResult{}, errors.New("workspace database is not initialized")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PurgeDeletedSessionsResult{}, fmt.Errorf("begin purge deleted agent sessions: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	result, err := s.PurgeDeletedSessionsTx(ctx, tx, input)
	if err != nil {
		return PurgeDeletedSessionsResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return PurgeDeletedSessionsResult{}, fmt.Errorf("commit purge deleted agent sessions: %w", err)
	}
	committed = true
	return result, nil
}

// PurgeDeletedSessionsTx permanently removes the next bounded set of complete
// tombstoned trees using tx. The caller owns commit and rollback. This seam
// lets a workspace store remove product-side state in the same transaction as
// the canonical agent rows.
func (s *Store) PurgeDeletedSessionsTx(
	ctx context.Context,
	tx *sql.Tx,
	input PurgeDeletedSessionsInput,
) (PurgeDeletedSessionsResult, error) {
	if s == nil || tx == nil {
		return PurgeDeletedSessionsResult{}, errors.New("workspace database transaction is not initialized")
	}
	if input.CutoffUnixMS <= 0 {
		return PurgeDeletedSessionsResult{}, nil
	}
	limit := input.MaxSessions
	if limit <= 0 {
		limit = defaultPurgeSessionLimit
	}
	if limit > maximumPurgeSessionLimit {
		limit = maximumPurgeSessionLimit
	}
	maxPayloadBytes := input.MaxPayloadBytes
	if maxPayloadBytes <= 0 {
		maxPayloadBytes = defaultPurgePayloadBytes
	}

	candidates, hasMore, err := listDeletedSessionPurgeCandidatesTx(
		ctx, tx, input.CutoffUnixMS, limit, maxPayloadBytes,
	)
	if err != nil {
		return PurgeDeletedSessionsResult{}, err
	}
	result := PurgeDeletedSessionsResult{Sessions: make([]PurgedSession, 0, len(candidates)), HasMore: hasMore}
	for _, candidate := range candidates {
		removedMessages, removed, err := purgeDeletedSessionTx(ctx, tx, candidate)
		if err != nil {
			return PurgeDeletedSessionsResult{}, err
		}
		if !removed {
			return PurgeDeletedSessionsResult{}, fmt.Errorf("purge deleted agent session tree changed while committing")
		}
		result.Sessions = append(result.Sessions, candidate)
		result.RemovedMessages += removedMessages
		result.PayloadBytes += candidate.PayloadBytes
	}
	return result, nil
}

func listDeletedSessionPurgeCandidatesTx(
	ctx context.Context,
	tx *sql.Tx,
	cutoffUnixMS int64,
	limit int,
	maxPayloadBytes int64,
) ([]PurgedSession, bool, error) {
	candidates := make([]PurgedSession, 0, limit)
	selectedSessions := 0
	var payloadBytes int64
	// Keep recursive tree expansion and payload aggregation bounded to one root
	// page. Keyset paging lets blocked trees be skipped without starving later
	// roots behind an old retention backlog.
	var cursor *purgeRootCursor
	pageSize := limit + 1
	for {
		roots, hasMoreRoots, err := listDeletedSessionPurgeRootPageTx(
			ctx, tx, cutoffUnixMS, cursor, pageSize,
		)
		if err != nil {
			return nil, false, err
		}
		if len(roots) == 0 {
			return candidates, false, nil
		}

		trees, err := listDeletedSessionPurgeTreeCandidatesTx(ctx, tx, cutoffUnixMS, roots)
		if err != nil {
			return nil, false, err
		}
		for _, tree := range trees {
			if len(candidates) > 0 && (selectedSessions+tree.sessionCount > limit || payloadBytes+tree.payloadBytes > maxPayloadBytes) {
				return candidates, true, nil
			}
			members, err := listDeletedSessionPurgeTreeMembersTx(
				ctx, tx, tree.workspaceID, tree.rootSessionID, cutoffUnixMS,
			)
			if err != nil {
				return nil, false, err
			}
			if len(members) != tree.sessionCount {
				return nil, false, fmt.Errorf("deleted agent session purge tree changed while planning")
			}
			candidates = append(candidates, members...)
			selectedSessions += len(members)
			payloadBytes += tree.payloadBytes
		}
		if !hasMoreRoots {
			return candidates, false, nil
		}
		lastRoot := roots[len(roots)-1]
		cursor = &purgeRootCursor{
			deletedAtUnixMS: lastRoot.deletedAtUnixMS,
			workspaceID:     lastRoot.workspaceID,
			rootSessionID:   lastRoot.rootSessionID,
		}
	}
}

type purgeRootCandidate struct {
	workspaceID     string
	rootSessionID   string
	deletedAtUnixMS int64
}

type purgeRootCursor struct {
	deletedAtUnixMS int64
	workspaceID     string
	rootSessionID   string
}

type purgeTreeCandidate struct {
	workspaceID     string
	rootSessionID   string
	deletedAtUnixMS int64
	sessionCount    int
	payloadBytes    int64
}

func listDeletedSessionPurgeRootPageTx(
	ctx context.Context,
	tx *sql.Tx,
	cutoffUnixMS int64,
	cursor *purgeRootCursor,
	limit int,
) ([]purgeRootCandidate, bool, error) {
	args := []any{cutoffUnixMS}
	query := `
SELECT s.workspace_id, s.agent_session_id, s.deleted_at_unix_ms
FROM workspace_agent_sessions s
WHERE s.deleted_at_unix_ms > 0 AND s.deleted_at_unix_ms <= ?
  AND NOT EXISTS (
    SELECT 1
    FROM workspace_agent_sessions parent
    WHERE parent.workspace_id = s.workspace_id
      AND parent.agent_session_id = s.parent_agent_session_id
      AND parent.deleted_at_unix_ms > 0
  )`
	if cursor != nil {
		query += `
  AND (
    s.deleted_at_unix_ms > ?
    OR (
      s.deleted_at_unix_ms = ?
      AND (
        s.workspace_id > ?
        OR (s.workspace_id = ? AND s.agent_session_id > ?)
      )
    )
  )`
		args = append(args,
			cursor.deletedAtUnixMS,
			cursor.deletedAtUnixMS,
			cursor.workspaceID,
			cursor.workspaceID,
			cursor.rootSessionID,
		)
	}
	query += `
ORDER BY s.deleted_at_unix_ms ASC, s.workspace_id ASC, s.agent_session_id ASC
LIMIT ?`
	args = append(args, limit+1)

	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, false, fmt.Errorf("list deleted agent session purge roots: %w", err)
	}
	defer rows.Close()

	roots := make([]purgeRootCandidate, 0, limit)
	for rows.Next() {
		var root purgeRootCandidate
		if err := rows.Scan(&root.workspaceID, &root.rootSessionID, &root.deletedAtUnixMS); err != nil {
			return nil, false, fmt.Errorf("scan deleted agent session purge root: %w", err)
		}
		root.workspaceID = strings.TrimSpace(root.workspaceID)
		root.rootSessionID = strings.TrimSpace(root.rootSessionID)
		roots = append(roots, root)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("iterate deleted agent session purge roots: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, false, fmt.Errorf("close deleted agent session purge roots: %w", err)
	}
	hasMore := len(roots) > limit
	if hasMore {
		roots = roots[:limit]
	}
	return roots, hasMore, nil
}

func listDeletedSessionPurgeTreeCandidatesTx(
	ctx context.Context,
	tx *sql.Tx,
	cutoffUnixMS int64,
	roots []purgeRootCandidate,
) ([]purgeTreeCandidate, error) {
	if len(roots) == 0 {
		return nil, nil
	}
	valueRows := make([]string, len(roots))
	args := make([]any, 0, len(roots)*3+1)
	for index, root := range roots {
		valueRows[index] = "(?, ?, ?)"
		args = append(args, root.workspaceID, root.rootSessionID, root.deletedAtUnixMS)
	}
	args = append(args, cutoffUnixMS)
	query := fmt.Sprintf(`
WITH RECURSIVE
candidate_roots(workspace_id, root_session_id, root_deleted_at_unix_ms) AS (
  VALUES %s
),
candidate_tree(workspace_id, root_session_id, agent_session_id, deleted_at_unix_ms, depth) AS (
  SELECT roots.workspace_id, roots.root_session_id, roots.root_session_id,
         roots.root_deleted_at_unix_ms, 0
  FROM candidate_roots roots
  UNION ALL
  SELECT child.workspace_id, tree.root_session_id, child.agent_session_id,
         child.deleted_at_unix_ms, tree.depth + 1
  FROM workspace_agent_sessions child
  JOIN candidate_tree tree
    ON child.workspace_id = tree.workspace_id
   AND child.parent_agent_session_id = tree.agent_session_id
)
SELECT roots.workspace_id, roots.root_session_id, roots.root_deleted_at_unix_ms,
       COUNT(tree.agent_session_id) AS session_count,
       COALESCE(SUM(COALESCE((
         SELECT SUM(
           length(CAST(m.payload_json AS BLOB)) +
           length(CAST(m.semantics_json AS BLOB))
         )
         FROM workspace_agent_messages m
         WHERE m.workspace_id = tree.workspace_id
           AND m.agent_session_id = tree.agent_session_id
       ), 0)), 0) AS payload_bytes
FROM candidate_roots roots
JOIN candidate_tree tree
  ON tree.workspace_id = roots.workspace_id
 AND tree.root_session_id = roots.root_session_id
GROUP BY roots.workspace_id, roots.root_session_id, roots.root_deleted_at_unix_ms
HAVING SUM(CASE WHEN tree.deleted_at_unix_ms <= 0 OR tree.deleted_at_unix_ms > ? THEN 1 ELSE 0 END) = 0
ORDER BY roots.root_deleted_at_unix_ms ASC, roots.workspace_id ASC, roots.root_session_id ASC
`, strings.Join(valueRows, ",\n  "))
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list deleted agent session purge candidates: %w", err)
	}
	defer rows.Close()

	trees := make([]purgeTreeCandidate, 0, len(roots))
	for rows.Next() {
		var candidate purgeTreeCandidate
		if err := rows.Scan(
			&candidate.workspaceID,
			&candidate.rootSessionID,
			&candidate.deletedAtUnixMS,
			&candidate.sessionCount,
			&candidate.payloadBytes,
		); err != nil {
			return nil, fmt.Errorf("scan deleted agent session purge tree: %w", err)
		}
		candidate.workspaceID = strings.TrimSpace(candidate.workspaceID)
		candidate.rootSessionID = strings.TrimSpace(candidate.rootSessionID)
		trees = append(trees, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate deleted agent session purge trees: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close deleted agent session purge trees: %w", err)
	}
	return trees, nil
}

func listDeletedSessionPurgeTreeMembersTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	rootSessionID string,
	cutoffUnixMS int64,
) ([]PurgedSession, error) {
	rows, err := tx.QueryContext(ctx, `
WITH RECURSIVE tree(agent_session_id, deleted_at_unix_ms, depth) AS (
  SELECT agent_session_id, deleted_at_unix_ms, 0
  FROM workspace_agent_sessions
  WHERE workspace_id = ? AND agent_session_id = ?
  UNION ALL
  SELECT child.agent_session_id, child.deleted_at_unix_ms, tree.depth + 1
  FROM workspace_agent_sessions child
  JOIN tree ON child.parent_agent_session_id = tree.agent_session_id
  WHERE child.workspace_id = ?
)
SELECT tree.agent_session_id, tree.deleted_at_unix_ms,
       COALESCE((
         SELECT SUM(
           length(CAST(m.payload_json AS BLOB)) +
           length(CAST(m.semantics_json AS BLOB))
         )
         FROM workspace_agent_messages m
         WHERE m.workspace_id = ? AND m.agent_session_id = tree.agent_session_id
       ), 0) AS payload_bytes
FROM tree
WHERE tree.deleted_at_unix_ms > 0 AND tree.deleted_at_unix_ms <= ?
ORDER BY tree.depth DESC, tree.agent_session_id ASC
`, workspaceID, rootSessionID, workspaceID, workspaceID, cutoffUnixMS)
	if err != nil {
		return nil, fmt.Errorf("list deleted agent session purge tree members: %w", err)
	}
	defer rows.Close()
	members := make([]PurgedSession, 0)
	for rows.Next() {
		member := PurgedSession{WorkspaceID: workspaceID}
		if err := rows.Scan(&member.AgentSessionID, &member.DeletedAtUnixMS, &member.PayloadBytes); err != nil {
			return nil, fmt.Errorf("scan deleted agent session purge tree member: %w", err)
		}
		member.AgentSessionID = strings.TrimSpace(member.AgentSessionID)
		members = append(members, member)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate deleted agent session purge tree members: %w", err)
	}
	return members, nil
}

func purgeDeletedSessionTx(
	ctx context.Context,
	tx *sql.Tx,
	candidate PurgedSession,
) (int, bool, error) {
	var hasDescendants bool
	if err := tx.QueryRowContext(ctx, `
SELECT EXISTS (
  SELECT 1
  FROM workspace_agent_sessions
  WHERE workspace_id = ?
    AND agent_session_id <> ?
    AND (root_agent_session_id = ? OR parent_agent_session_id = ?)
)
`, candidate.WorkspaceID, candidate.AgentSessionID, candidate.AgentSessionID, candidate.AgentSessionID).Scan(&hasDescendants); err != nil {
		return 0, false, fmt.Errorf("check deleted agent session descendants: %w", err)
	}
	if hasDescendants {
		return 0, false, nil
	}

	// This no-op update acquires the write lock and proves the exact tombstone
	// still exists before any dependent row is removed.
	fence, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET deleted_at_unix_ms = deleted_at_unix_ms
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = ?
`, candidate.WorkspaceID, candidate.AgentSessionID, candidate.DeletedAtUnixMS)
	if err != nil {
		return 0, false, fmt.Errorf("fence deleted agent session purge: %w", err)
	}
	fenced, err := rowsWereAffected(fence, "fence deleted agent session purge")
	if err != nil || !fenced {
		return 0, false, err
	}
	if err := deleteSessionForkRecordsForPurgedSessionTx(
		ctx, tx, candidate.WorkspaceID, candidate.AgentSessionID,
	); err != nil {
		return 0, false, err
	}

	for _, statement := range []struct {
		name  string
		query string
	}{
		{"submit claims", `DELETE FROM workspace_agent_submit_claims WHERE workspace_id = ? AND agent_session_id = ?`},
		{"runtime operation events", `DELETE FROM workspace_agent_runtime_operation_events WHERE workspace_id = ? AND agent_session_id = ?`},
		{"runtime operations", `DELETE FROM workspace_agent_runtime_operations WHERE workspace_id = ? AND agent_session_id = ?`},
		{"goal provenance", `DELETE FROM workspace_agent_goal_provenance_ledger WHERE workspace_id = ? AND agent_session_id = ?`},
		{"goal reconcile inbox", `DELETE FROM workspace_agent_goal_reconcile_inbox WHERE workspace_id = ? AND agent_session_id = ?`},
		{"goal repair incidents", `DELETE FROM workspace_agent_goal_repair_incidents WHERE workspace_id = ? AND agent_session_id = ?`},
		{"goal generation fences", `DELETE FROM workspace_agent_goal_generation_fences WHERE workspace_id = ? AND agent_session_id = ?`},
		{"goal operations", `DELETE FROM workspace_agent_goal_control_operations WHERE workspace_id = ? AND agent_session_id = ?`},
		{"goal state", `DELETE FROM workspace_agent_session_goals WHERE workspace_id = ? AND agent_session_id = ?`},
		{"interactions", `DELETE FROM workspace_agent_interactions WHERE workspace_id = ? AND agent_session_id = ?`},
		{"turn submissions", `DELETE FROM workspace_agent_turn_submissions WHERE workspace_id = ? AND agent_session_id = ?`},
		{"turn history", `DELETE FROM workspace_agent_turn_history WHERE workspace_id = ? AND agent_session_id = ?`},
		{"turn sequences", `DELETE FROM workspace_agent_turn_sequences WHERE workspace_id = ? AND agent_session_id = ?`},
	} {
		if _, err := tx.ExecContext(ctx, statement.query, candidate.WorkspaceID, candidate.AgentSessionID); err != nil {
			return 0, false, fmt.Errorf("purge deleted agent session %s: %w", statement.name, err)
		}
	}
	messageResult, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_messages WHERE workspace_id = ? AND agent_session_id = ?`, candidate.WorkspaceID, candidate.AgentSessionID)
	if err != nil {
		return 0, false, fmt.Errorf("purge deleted agent session messages: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_turns WHERE workspace_id = ? AND agent_session_id = ?`, candidate.WorkspaceID, candidate.AgentSessionID); err != nil {
		return 0, false, fmt.Errorf("purge deleted agent session turns: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_session_history WHERE workspace_id = ? AND agent_session_id = ?`, candidate.WorkspaceID, candidate.AgentSessionID); err != nil {
		return 0, false, fmt.Errorf("purge deleted agent session history: %w", err)
	}
	sessionResult, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_sessions WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = ?`, candidate.WorkspaceID, candidate.AgentSessionID, candidate.DeletedAtUnixMS)
	if err != nil {
		return 0, false, fmt.Errorf("purge deleted agent session: %w", err)
	}
	removed, err := rowsWereAffected(sessionResult, "purge deleted agent session")
	if err != nil || !removed {
		return 0, false, err
	}
	removedMessages, err := messageResult.RowsAffected()
	if err != nil {
		return 0, false, fmt.Errorf("purge deleted agent session messages rows affected: %w", err)
	}
	return int(removedMessages), true, nil
}

// deleteSessionForkRecordsForPurgedSessionTx removes every fork operation that
// captured the permanently deleted Session as either source or target. A fork
// operation snapshot contains the complete source transcript, so retaining it
// after source deletion would violate hard-delete semantics. Target operations
// are also removed so the deleted target id and request cease to be reserved.
// Surviving target Sessions remain canonical and resumable, but intentionally
// lose lineage to a permanently deleted source.
func deleteSessionForkRecordsForPurgedSessionTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
) error {
	operationIDs := `
SELECT operation_id
FROM workspace_agent_session_fork_operations
WHERE workspace_id = ?
  AND (source_agent_session_id = ? OR target_agent_session_id = ?)`
	if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_session_forks
WHERE workspace_id = ? AND (
  source_agent_session_id = ? OR target_agent_session_id = ? OR
  operation_id IN (`+operationIDs+`)
)
`, workspaceID, agentSessionID, agentSessionID,
		workspaceID, agentSessionID, agentSessionID); err != nil {
		return fmt.Errorf("purge deleted agent session fork lineage: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_session_fork_target_reservations
WHERE workspace_id = ? AND (
  target_agent_session_id = ? OR operation_id IN (`+operationIDs+`)
)
`, workspaceID, agentSessionID,
		workspaceID, agentSessionID, agentSessionID); err != nil {
		return fmt.Errorf("purge deleted agent session fork target reservations: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_session_fork_boundary_barriers
WHERE workspace_id = ? AND (
  source_agent_session_id = ? OR operation_id IN (`+operationIDs+`)
)
`, workspaceID, agentSessionID,
		workspaceID, agentSessionID, agentSessionID); err != nil {
		return fmt.Errorf("purge deleted agent session fork boundary barriers: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_session_fork_operations
WHERE workspace_id = ?
  AND (source_agent_session_id = ? OR target_agent_session_id = ?)
`, workspaceID, agentSessionID, agentSessionID); err != nil {
		return fmt.Errorf("purge deleted agent session fork operations: %w", err)
	}
	return nil
}
