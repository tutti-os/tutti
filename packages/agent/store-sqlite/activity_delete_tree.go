package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

func expandSessionTreeIDsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	seeds []string,
) ([]string, error) {
	result := make([]string, 0, len(seeds))
	seen := make(map[string]struct{}, len(seeds))
	for _, seed := range seeds {
		rows, err := tx.QueryContext(ctx, `
WITH RECURSIVE session_tree(agent_session_id, depth) AS (
  SELECT agent_session_id, 0
  FROM workspace_agent_sessions
  WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
  UNION ALL
  SELECT child.agent_session_id, parent.depth + 1
  FROM workspace_agent_sessions child
  INNER JOIN session_tree parent
    ON child.parent_agent_session_id = parent.agent_session_id
  WHERE child.workspace_id = ? AND child.session_kind = 'child'
)
SELECT agent_session_id
FROM session_tree
ORDER BY depth DESC, agent_session_id ASC
`, workspaceID, strings.TrimSpace(seed), workspaceID)
		if err != nil {
			return nil, fmt.Errorf("resolve workspace agent session tree: %w", err)
		}
		for rows.Next() {
			var sessionID string
			if err := rows.Scan(&sessionID); err != nil {
				rows.Close()
				return nil, fmt.Errorf("scan workspace agent session tree: %w", err)
			}
			sessionID = strings.TrimSpace(sessionID)
			if sessionID == "" {
				continue
			}
			if _, exists := seen[sessionID]; exists {
				continue
			}
			seen[sessionID] = struct{}{}
			result = append(result, sessionID)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, fmt.Errorf("iterate workspace agent session tree: %w", err)
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("close workspace agent session tree: %w", err)
		}
	}
	return result, nil
}

func deleteSessionTreeRowsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	sessionIDs []string,
	now int64,
) (int, int, []string, []TransactionMutation, error) {
	removedMessages := int64(0)
	removedSessions := int64(0)
	removedSessionIDs := make([]string, 0, len(sessionIDs))
	terminalMutations := make([]TransactionMutation, 0)
	plan, err := recoverableDeletePlanTx(ctx, tx, workspaceID, sessionIDs)
	if err != nil {
		return 0, 0, nil, nil, err
	}
	for _, agentSessionID := range sessionIDs {
		if plan.activeBySession[agentSessionID] {
			var messageCount int64
			if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*) FROM workspace_agent_messages
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, agentSessionID).Scan(&messageCount); err != nil {
				return 0, 0, nil, nil, fmt.Errorf("count workspace agent session tree messages: %w", err)
			}
			removedMessages += messageCount
			settledTurns, err := settleDeletedSessionWorkTx(ctx, tx, workspaceID, agentSessionID, now)
			if err != nil {
				return 0, 0, nil, nil, err
			}
			terminalMutations = append(terminalMutations, settledTurns...)
		}
		if !plan.activeBySession[agentSessionID] && !plan.mergeBySession[agentSessionID] {
			continue
		}

		deletedPredicate := ""
		if !plan.mergeBySession[agentSessionID] {
			deletedPredicate = " AND deleted_at_unix_ms = 0"
		}
		sessionResult, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET deleted_at_unix_ms = ?,
	 recoverable_delete_version = ?,
	 recoverable_delete_tree_size = ?,
    active_turn_id = NULL
WHERE workspace_id = ? AND agent_session_id = ?`+deletedPredicate,
			now, recoverableDeleteVersionCurrent, plan.sizeBySession[agentSessionID], workspaceID, agentSessionID,
		)
		if err != nil {
			return 0, 0, nil, nil, fmt.Errorf("delete workspace agent session tree member: %w", err)
		}
		sessionCount, err := sessionResult.RowsAffected()
		if err != nil {
			return 0, 0, nil, nil, fmt.Errorf("delete workspace agent session tree rows affected: %w", err)
		}
		if sessionCount == 0 {
			return 0, 0, nil, nil, fmt.Errorf("delete workspace agent session tree member %q: row disappeared", agentSessionID)
		}
		if plan.activeBySession[agentSessionID] {
			removedSessions++
			removedSessionIDs = append(removedSessionIDs, agentSessionID)
		}
	}
	return int(removedMessages), int(removedSessions), removedSessionIDs, terminalMutations, nil
}

type recoverableDeleteMember struct {
	parentSessionID string
	deletedAtUnixMS int64
	version         int64
	treeSize        int
}

type recoverableDeletePlan struct {
	sizeBySession   map[string]int
	activeBySession map[string]bool
	mergeBySession  map[string]bool
}

// recoverableDeletePlanTx groups rows changed by one delete transaction by
// connectivity inside that exact deletion set. A selected Session whose parent
// is not selected is the component anchor. This deliberately does not group by
// canonical root: deleting sibling child subtrees in one batch creates
// independently restorable components.
//
// When a new live ancestor encloses already-deleted descendants, their prior
// components are absorbed into the new generation only if each is complete and
// lossless. Legacy or incomplete descendants retain their old tombstones, so
// the new topmost component fails closed instead of claiming recoverability.
func recoverableDeletePlanTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	sessionIDs []string,
) (recoverableDeletePlan, error) {
	selected := make(map[string]struct{}, len(sessionIDs))
	for _, sessionID := range sessionIDs {
		sessionID = strings.TrimSpace(sessionID)
		if sessionID != "" {
			selected[sessionID] = struct{}{}
		}
	}
	members := make(map[string]recoverableDeleteMember, len(selected))
	for _, sessionID := range sessionIDs {
		sessionID = strings.TrimSpace(sessionID)
		if sessionID == "" {
			continue
		}
		var member recoverableDeleteMember
		if err := tx.QueryRowContext(ctx, `
SELECT COALESCE(parent_agent_session_id, ''), deleted_at_unix_ms,
       recoverable_delete_version, recoverable_delete_tree_size
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, sessionID).Scan(
			&member.parentSessionID, &member.deletedAtUnixMS, &member.version, &member.treeSize,
		); err != nil {
			return recoverableDeletePlan{}, fmt.Errorf("read workspace agent recoverable deletion component identity: %w", err)
		}
		member.parentSessionID = strings.TrimSpace(member.parentSessionID)
		members[sessionID] = member
	}
	anchorBySession := make(map[string]string, len(sessionIDs))
	membersByAnchor := make(map[string][]string)
	for _, sessionID := range sessionIDs {
		sessionID = strings.TrimSpace(sessionID)
		if sessionID == "" {
			continue
		}
		anchorID := sessionID
		visited := make(map[string]struct{})
		for {
			if _, cycle := visited[anchorID]; cycle {
				return recoverableDeletePlan{}, fmt.Errorf("workspace agent recoverable deletion component contains a parent cycle at %q", anchorID)
			}
			visited[anchorID] = struct{}{}
			parentID := members[anchorID].parentSessionID
			if _, parentSelected := selected[parentID]; !parentSelected {
				break
			}
			anchorID = parentID
		}
		anchorBySession[sessionID] = anchorID
		membersByAnchor[anchorID] = append(membersByAnchor[anchorID], sessionID)
	}

	mergeByAnchor := make(map[string]bool, len(membersByAnchor))
	for anchorID, componentMembers := range membersByAnchor {
		mergeable := true
		coveredDeletedMembers := make(map[string]struct{})
		for _, sessionID := range componentMembers {
			member := members[sessionID]
			if member.deletedAtUnixMS <= 0 {
				continue
			}
			parent, parentSelected := members[member.parentSessionID]
			if parentSelected && parent.deletedAtUnixMS > 0 {
				continue
			}
			reason, oldComponentIDs, err := deletedSessionRestorabilityTx(
				ctx,
				tx,
				workspaceID,
				sessionID,
				member.deletedAtUnixMS,
				member.version,
				member.treeSize,
			)
			if err != nil {
				return recoverableDeletePlan{}, err
			}
			if reason != "" {
				mergeable = false
				continue
			}
			for _, oldComponentID := range oldComponentIDs {
				if anchorBySession[oldComponentID] != anchorID || members[oldComponentID].deletedAtUnixMS <= 0 {
					mergeable = false
					continue
				}
				coveredDeletedMembers[oldComponentID] = struct{}{}
			}
		}
		for _, sessionID := range componentMembers {
			if members[sessionID].deletedAtUnixMS <= 0 {
				continue
			}
			if _, covered := coveredDeletedMembers[sessionID]; !covered {
				mergeable = false
			}
		}
		mergeByAnchor[anchorID] = mergeable
	}

	plan := recoverableDeletePlan{
		sizeBySession:   make(map[string]int, len(members)),
		activeBySession: make(map[string]bool, len(members)),
		mergeBySession:  make(map[string]bool, len(members)),
	}
	for sessionID, anchorID := range anchorBySession {
		plan.sizeBySession[sessionID] = len(membersByAnchor[anchorID])
		plan.activeBySession[sessionID] = members[sessionID].deletedAtUnixMS == 0
		plan.mergeBySession[sessionID] = mergeByAnchor[anchorID]
	}
	return plan, nil
}

// settleDeletedSessionWorkTx terminates only executable state. The historical
// rows, lossless submission payloads, provider identities, and attachment
// references remain available for restore and audit.
func settleDeletedSessionWorkTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
	now int64,
) ([]TransactionMutation, error) {
	rows, err := tx.QueryContext(ctx, `
SELECT turn_id
FROM workspace_agent_turns
WHERE workspace_id = ? AND agent_session_id = ? AND phase <> 'settled'
ORDER BY turn_id
`, workspaceID, agentSessionID)
	if err != nil {
		return nil, fmt.Errorf("list live turns for deleted workspace agent session: %w", err)
	}
	terminalMutations := make([]TransactionMutation, 0)
	for rows.Next() {
		var turnID string
		if err := rows.Scan(&turnID); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan live turn for deleted workspace agent session: %w", err)
		}
		terminalMutations = append(terminalMutations, terminalTurnMutation(
			workspaceID, agentSessionID, turnID, "upsert", now, false,
		))
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("iterate live turns for deleted workspace agent session: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close live turns for deleted workspace agent session: %w", err)
	}
	statements := []struct {
		name  string
		query string
		args  []any
	}{
		{
			name: "turns",
			query: `UPDATE workspace_agent_turns
SET phase = 'settled', outcome = COALESCE(outcome, 'interrupted'),
    settled_at_unix_ms = COALESCE(settled_at_unix_ms, ?),
    root_provider_turn_phase = CASE WHEN root_provider_turn_phase = 'running' THEN 'completed' ELSE root_provider_turn_phase END,
    root_provider_turn_outcome = CASE WHEN root_provider_turn_phase = 'running' AND root_provider_turn_outcome IS NULL THEN 'interrupted' ELSE root_provider_turn_outcome END,
    root_provider_turn_updated_at_unix_ms = CASE WHEN root_provider_turn_phase = 'running' THEN ? ELSE root_provider_turn_updated_at_unix_ms END,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND phase <> 'settled'`,
			args: []any{now, now, now, workspaceID, agentSessionID},
		},
		{
			name:  "pending interactions",
			query: `UPDATE workspace_agent_interactions SET status = 'superseded', updated_at_unix_ms = ? WHERE workspace_id = ? AND agent_session_id = ? AND status = 'pending'`,
			args:  []any{now, workspaceID, agentSessionID},
		},
		{
			name: "runtime operations",
			query: `UPDATE workspace_agent_runtime_operations
SET status = 'failed', result = 'failed', lease_owner = NULL,
    lease_expires_at_unix_ms = NULL, next_attempt_at_unix_ms = NULL,
    version = version + 1, last_error = 'session deleted',
    updated_at_unix_ms = ?, completed_at_unix_ms = NULL
WHERE workspace_id = ? AND agent_session_id = ? AND status IN ('prepared', 'leased')`,
			args: []any{now, workspaceID, agentSessionID},
		},
		{
			name:  "runtime operation events",
			query: `UPDATE workspace_agent_runtime_operation_events SET published_at_unix_ms = COALESCE(published_at_unix_ms, ?) WHERE workspace_id = ? AND agent_session_id = ?`,
			args:  []any{now, workspaceID, agentSessionID},
		},
		{
			name: "goal operations",
			query: `UPDATE workspace_agent_goal_control_operations
SET status = 'failed', last_error = 'session deleted', lease_owner = NULL,
    lease_expires_at_unix_ms = NULL, next_attempt_at_unix_ms = NULL,
    updated_at_unix_ms = ?, completed_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND status IN ('prepared', 'dispatched')`,
			args: []any{now, now, workspaceID, agentSessionID},
		},
		{
			name: "goal state",
			query: `UPDATE workspace_agent_session_goals
SET pending_operation_id = NULL, sync_status = 'failed',
    last_error = 'session deleted', updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ?
  AND (COALESCE(pending_operation_id, '') <> '' OR sync_status IN ('pending', 'applying'))`,
			args: []any{now, workspaceID, agentSessionID},
		},
		{
			name: "goal reconcile inbox",
			query: `UPDATE workspace_agent_goal_reconcile_inbox
SET status = 'failed', lease_owner = NULL, lease_expires_at_unix_ms = NULL,
    next_attempt_at_unix_ms = NULL, last_error = 'session deleted',
    updated_at_unix_ms = ?, completed_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND status IN ('prepared', 'leased')`,
			args: []any{now, now, workspaceID, agentSessionID},
		},
		{
			name: "goal generation fences",
			query: `UPDATE workspace_agent_goal_generation_fences
SET status = 'completed', lease_owner = NULL, lease_expires_at_unix_ms = NULL,
    next_attempt_at_unix_ms = NULL, last_error = 'session deleted',
    updated_at_unix_ms = ?, completed_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND status IN ('pending', 'processing')`,
			args: []any{now, now, workspaceID, agentSessionID},
		},
		{
			name: "effective history recovery fence",
			query: `UPDATE workspace_agent_session_history
SET recovery_state = 'ready', operation_id = '', updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ?
  AND (recovery_state <> 'ready' OR operation_id <> '')`,
			args: []any{now, workspaceID, agentSessionID},
		},
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement.query, statement.args...); err != nil {
			return nil, fmt.Errorf("settle deleted workspace agent session %s: %w", statement.name, err)
		}
	}
	return terminalMutations, nil
}
