package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

var (
	ErrDeletedSessionNotFound      = errors.New("deleted workspace agent session not found")
	ErrDeletedSessionNotRestorable = errors.New("deleted workspace agent session is not restorable")
)

const (
	defaultDeletedSessionPageLimit = 50
	maximumDeletedSessionPageLimit = 100
)

func (s *Store) ListDeletedSessions(ctx context.Context, input ListDeletedSessionsInput) (DeletedSessionPage, error) {
	if s == nil || s.db == nil {
		return DeletedSessionPage{}, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if workspaceID == "" {
		return DeletedSessionPage{}, nil
	}
	limit := input.Limit
	if limit <= 0 {
		limit = defaultDeletedSessionPageLimit
	}
	if limit > maximumDeletedSessionPageLimit {
		limit = maximumDeletedSessionPageLimit
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return DeletedSessionPage{}, fmt.Errorf("begin list deleted workspace agent sessions: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	predicates := []string{
		"s.workspace_id = ?",
		"s.deleted_at_unix_ms > 0",
		`NOT EXISTS (
  SELECT 1 FROM workspace_agent_sessions parent
  WHERE parent.workspace_id = s.workspace_id
    AND parent.agent_session_id = s.parent_agent_session_id
    AND parent.deleted_at_unix_ms > 0
)`,
	}
	args := []any{workspaceID}
	if input.RailSectionKey != nil {
		railSectionKey := strings.TrimSpace(*input.RailSectionKey)
		if railSectionKey == "" {
			return DeletedSessionPage{}, errors.New("rail section key is required")
		}
		predicates = append(predicates, "s.rail_section_key = ?")
		args = append(args, railSectionKey)
	}
	for _, token := range strings.Fields(strings.ToLower(input.SearchQuery)) {
		predicates = append(predicates, "LOWER(s.title) LIKE ? ESCAPE '\\'")
		args = append(args, "%"+escapeSessionSearchLikeToken(token)+"%")
	}
	where := strings.Join(predicates, " AND ")

	var totalCount int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspace_agent_sessions s WHERE `+where, args...).Scan(&totalCount); err != nil {
		return DeletedSessionPage{}, fmt.Errorf("count deleted workspace agent sessions: %w", err)
	}
	var workspaceTotalCount int
	if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*) FROM workspace_agent_sessions s
WHERE s.workspace_id = ? AND s.deleted_at_unix_ms > 0
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_sessions parent
    WHERE parent.workspace_id = s.workspace_id
      AND parent.agent_session_id = s.parent_agent_session_id
      AND parent.deleted_at_unix_ms > 0
  )
`, workspaceID).Scan(&workspaceTotalCount); err != nil {
		return DeletedSessionPage{}, fmt.Errorf("count all deleted workspace agent sessions: %w", err)
	}
	railSections, err := listDeletedSessionRailSectionsTx(ctx, tx, workspaceID)
	if err != nil {
		return DeletedSessionPage{}, err
	}

	pagePredicates := append([]string(nil), predicates...)
	pageArgs := append([]any(nil), args...)
	cursorID := strings.TrimSpace(input.CursorAgentSessionID)
	if cursorID != "" {
		pagePredicates = append(pagePredicates, "(s.updated_at_unix_ms < ? OR (s.updated_at_unix_ms = ? AND s.agent_session_id > ?))")
		pageArgs = append(pageArgs, input.CursorUpdatedAtUnixMS, input.CursorUpdatedAtUnixMS, cursorID)
	}
	pageArgs = append(pageArgs, limit+1)
	rows, err := tx.QueryContext(ctx, `
SELECT s.agent_session_id, s.title, s.rail_section_key, s.rail_project_path,
	   s.updated_at_unix_ms, s.deleted_at_unix_ms, s.recoverable_delete_version,
	   s.recoverable_delete_tree_size
FROM workspace_agent_sessions s
WHERE `+strings.Join(pagePredicates, " AND ")+`
ORDER BY s.updated_at_unix_ms DESC, s.agent_session_id ASC
LIMIT ?
`, pageArgs...)
	if err != nil {
		return DeletedSessionPage{}, fmt.Errorf("list deleted workspace agent sessions: %w", err)
	}
	defer rows.Close()

	type deletedRow struct {
		summary  DeletedSessionSummary
		version  int64
		treeSize int
	}
	pageRows := make([]deletedRow, 0, limit+1)
	for rows.Next() {
		var row deletedRow
		if err := rows.Scan(
			&row.summary.AgentSessionID,
			&row.summary.Title,
			&row.summary.RailSectionKey,
			&row.summary.ProjectPath,
			&row.summary.UpdatedAtUnixMS,
			&row.summary.DeletedAtUnixMS,
			&row.version,
			&row.treeSize,
		); err != nil {
			return DeletedSessionPage{}, fmt.Errorf("scan deleted workspace agent session: %w", err)
		}
		row.summary.RailSectionKey = strings.TrimSpace(row.summary.RailSectionKey)
		if row.summary.RailSectionKey == "" {
			return DeletedSessionPage{}, fmt.Errorf("deleted workspace agent session %q has no rail section key", row.summary.AgentSessionID)
		}
		pageRows = append(pageRows, row)
	}
	if err := rows.Err(); err != nil {
		return DeletedSessionPage{}, fmt.Errorf("iterate deleted workspace agent sessions: %w", err)
	}

	hasMore := len(pageRows) > limit
	if hasMore {
		pageRows = pageRows[:limit]
	}
	summaries := make([]DeletedSessionSummary, 0, len(pageRows))
	for _, row := range pageRows {
		reason, _, err := deletedSessionRestorabilityTx(
			ctx, tx, workspaceID, row.summary.AgentSessionID, row.summary.DeletedAtUnixMS, row.version, row.treeSize,
		)
		if err != nil {
			return DeletedSessionPage{}, err
		}
		row.summary.Restorable = reason == ""
		row.summary.UnavailableReason = reason
		summaries = append(summaries, row.summary)
	}
	nextCursor := ""
	if hasMore && len(summaries) > 0 {
		last := summaries[len(summaries)-1]
		nextCursor = strconv.FormatInt(last.UpdatedAtUnixMS, 10) + "|" + strings.TrimSpace(last.AgentSessionID)
	}
	return DeletedSessionPage{
		WorkspaceID: workspaceID, Sessions: summaries, RailSections: railSections,
		TotalCount: totalCount, WorkspaceTotalCount: workspaceTotalCount,
		HasMore: hasMore, NextCursor: nextCursor,
	}, nil
}

func listDeletedSessionRailSectionsTx(ctx context.Context, tx *sql.Tx, workspaceID string) ([]DeletedSessionRailSection, error) {
	rows, err := tx.QueryContext(ctx, `
SELECT s.rail_section_key, MIN(NULLIF(s.rail_project_path, ''))
FROM workspace_agent_sessions s
WHERE s.workspace_id = ? AND s.deleted_at_unix_ms > 0
  AND TRIM(s.rail_section_key) <> ''
  AND s.rail_section_key <> ?
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_sessions parent
    WHERE parent.workspace_id = s.workspace_id
      AND parent.agent_session_id = s.parent_agent_session_id
      AND parent.deleted_at_unix_ms > 0
  )
GROUP BY s.rail_section_key
ORDER BY s.rail_section_key ASC
`, workspaceID, RailSectionKeyConversations)
	if err != nil {
		return nil, fmt.Errorf("list deleted workspace agent session rail sections: %w", err)
	}
	defer rows.Close()
	sections := make([]DeletedSessionRailSection, 0)
	for rows.Next() {
		var section DeletedSessionRailSection
		var projectPath sql.NullString
		if err := rows.Scan(&section.RailSectionKey, &projectPath); err != nil {
			return nil, fmt.Errorf("scan deleted workspace agent session rail section: %w", err)
		}
		section.RailSectionKey = strings.TrimSpace(section.RailSectionKey)
		section.ProjectPath = strings.TrimSpace(projectPath.String)
		sections = append(sections, section)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate deleted workspace agent session rail sections: %w", err)
	}
	return sections, nil
}

// deletedSessionRestorabilityTx returns the presentation reason and the full
// anchor-first reachable component. A version-one topmost tombstone is
// restorable only when every descendant belongs to the same deletion
// generation and the stored component size proves that no member is missing.
func deletedSessionRestorabilityTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	componentSessionID string,
	deletedAtUnixMS int64,
	version int64,
	expectedTreeSize int,
) (string, []string, error) {
	if version != recoverableDeleteVersionCurrent || expectedTreeSize <= 0 {
		return DeletedSessionUnavailableLegacyData, nil, nil
	}
	rows, err := tx.QueryContext(ctx, `
WITH RECURSIVE reachable(agent_session_id, depth) AS (
  SELECT anchor.agent_session_id, 0
  FROM workspace_agent_sessions anchor
  WHERE anchor.workspace_id = ? AND anchor.agent_session_id = ?
    AND anchor.deleted_at_unix_ms > 0
    AND NOT EXISTS (
      SELECT 1 FROM workspace_agent_sessions parent
      WHERE parent.workspace_id = anchor.workspace_id
        AND parent.agent_session_id = anchor.parent_agent_session_id
        AND parent.deleted_at_unix_ms > 0
    )
  UNION
  SELECT child.agent_session_id, parent.depth + 1
  FROM workspace_agent_sessions child
  JOIN reachable parent ON child.parent_agent_session_id = parent.agent_session_id
  WHERE child.workspace_id = ? AND child.session_kind = 'child'
)
SELECT r.agent_session_id, r.depth,
       s.deleted_at_unix_ms, s.recoverable_delete_version,
	   s.recoverable_delete_tree_size
FROM reachable r
JOIN workspace_agent_sessions s
  ON s.workspace_id = ? AND s.agent_session_id = r.agent_session_id
ORDER BY r.depth ASC, r.agent_session_id ASC
`, workspaceID, componentSessionID, workspaceID, workspaceID)
	if err != nil {
		return "", nil, fmt.Errorf("resolve deleted workspace agent session tree: %w", err)
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		var depth, memberDeletedAt, memberVersion int64
		var memberTreeSize int
		if err := rows.Scan(&id, &depth, &memberDeletedAt, &memberVersion, &memberTreeSize); err != nil {
			return "", nil, fmt.Errorf("scan deleted workspace agent session tree: %w", err)
		}
		if memberDeletedAt != deletedAtUnixMS || memberDeletedAt <= 0 ||
			memberVersion != recoverableDeleteVersionCurrent || memberTreeSize != expectedTreeSize {
			return DeletedSessionUnavailableIncompleteTree, nil, nil
		}
		ids = append(ids, strings.TrimSpace(id))
	}
	if err := rows.Err(); err != nil {
		return "", nil, fmt.Errorf("iterate deleted workspace agent session tree: %w", err)
	}
	if len(ids) == 0 {
		return DeletedSessionUnavailableIncompleteTree, nil, nil
	}
	if len(ids) != expectedTreeSize {
		return DeletedSessionUnavailableIncompleteTree, nil, nil
	}
	return "", ids, nil
}

func (s *Store) RestoreDeletedSession(ctx context.Context, input RestoreDeletedSessionInput) (RestoreDeletedSessionResult, error) {
	if s == nil || s.db == nil {
		return RestoreDeletedSessionResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	componentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || componentSessionID == "" {
		return RestoreDeletedSessionResult{}, ErrDeletedSessionNotFound
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RestoreDeletedSessionResult{}, fmt.Errorf("begin restore deleted workspace agent session: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var deletedAtUnixMS, version int64
	var expectedTreeSize int
	if err := tx.QueryRowContext(ctx, `
SELECT deleted_at_unix_ms, recoverable_delete_version, recoverable_delete_tree_size
FROM workspace_agent_sessions anchor
WHERE anchor.workspace_id = ? AND anchor.agent_session_id = ?
  AND anchor.deleted_at_unix_ms > 0
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_sessions parent
    WHERE parent.workspace_id = anchor.workspace_id
      AND parent.agent_session_id = anchor.parent_agent_session_id
      AND parent.deleted_at_unix_ms > 0
  )
`, workspaceID, componentSessionID).Scan(&deletedAtUnixMS, &version, &expectedTreeSize); errors.Is(err, sql.ErrNoRows) || deletedAtUnixMS <= 0 {
		return RestoreDeletedSessionResult{}, ErrDeletedSessionNotFound
	} else if err != nil {
		return RestoreDeletedSessionResult{}, fmt.Errorf("read deleted workspace agent session: %w", err)
	}
	reason, sessionIDs, err := deletedSessionRestorabilityTx(ctx, tx, workspaceID, componentSessionID, deletedAtUnixMS, version, expectedTreeSize)
	if err != nil {
		return RestoreDeletedSessionResult{}, err
	}
	if reason != "" {
		return RestoreDeletedSessionResult{}, fmt.Errorf("%w: %s", ErrDeletedSessionNotRestorable, reason)
	}
	mutations := make([]TransactionMutation, 0, len(sessionIDs))
	for _, sessionID := range sessionIDs {
		result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET deleted_at_unix_ms = 0,
    recoverable_delete_version = 0,
	 recoverable_delete_tree_size = 0,
    active_turn_id = NULL
WHERE workspace_id = ? AND agent_session_id = ?
  AND deleted_at_unix_ms = ? AND recoverable_delete_version = ?
`, workspaceID, sessionID, deletedAtUnixMS, recoverableDeleteVersionCurrent)
		if err != nil {
			return RestoreDeletedSessionResult{}, fmt.Errorf("restore workspace agent session tree member: %w", err)
		}
		changed, err := rowsWereAffected(result, "restore workspace agent session tree member")
		if err != nil {
			return RestoreDeletedSessionResult{}, err
		}
		if !changed {
			return RestoreDeletedSessionResult{}, fmt.Errorf("%w: %s", ErrDeletedSessionNotRestorable, DeletedSessionUnavailableIncompleteTree)
		}
		mutations = append(mutations, transactionMutation(workspaceID, sessionID, MutationEntitySession, sessionID, "restore", deletedAtUnixMS))
	}
	delta, err := s.commitTransaction(ctx, tx, workspaceID, mutations)
	if err != nil {
		return RestoreDeletedSessionResult{}, fmt.Errorf("commit restore deleted workspace agent session: %w", err)
	}
	sort.Strings(sessionIDs)
	return RestoreDeletedSessionResult{
		TransactionID: delta.TransactionID, CommitDelta: delta,
		Restored: true, RestoredSessionIDs: sessionIDs,
	}, nil
}

func (s *Store) PurgeDeletedSessionTrees(ctx context.Context, input PurgeDeletedSessionTreesInput) (PurgeDeletedSessionTreesResult, error) {
	if s == nil || s.db == nil {
		return PurgeDeletedSessionTreesResult{}, errors.New("workspace database is not initialized")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PurgeDeletedSessionTreesResult{}, fmt.Errorf("begin purge deleted workspace agent session trees: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	result, err := s.PurgeDeletedSessionTreesTx(ctx, tx, input)
	if err != nil {
		return PurgeDeletedSessionTreesResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return PurgeDeletedSessionTreesResult{}, fmt.Errorf("commit purge deleted workspace agent session trees: %w", err)
	}
	return result, nil
}

// PurgeDeletedSessionTreesTx permanently removes the selected topmost deleted
// components using tx. The caller owns commit and rollback. This seam lets a
// workspace store remove product-side state in the same transaction as the
// canonical agent rows. RootSessionIDs is retained as a compatibility field;
// its values identify component anchors and may name root or child Sessions.
func (s *Store) PurgeDeletedSessionTreesTx(
	ctx context.Context,
	tx *sql.Tx,
	input PurgeDeletedSessionTreesInput,
) (PurgeDeletedSessionTreesResult, error) {
	if s == nil || tx == nil {
		return PurgeDeletedSessionTreesResult{}, errors.New("workspace database transaction is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if workspaceID == "" {
		return PurgeDeletedSessionTreesResult{}, ErrDeletedSessionNotFound
	}

	rootIDs := normalizedSessionIDs(input.RootSessionIDs)
	if len(rootIDs) == 0 {
		rows, err := tx.QueryContext(ctx, `
SELECT anchor.agent_session_id
FROM workspace_agent_sessions anchor
WHERE anchor.workspace_id = ? AND anchor.deleted_at_unix_ms > 0
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_sessions parent
    WHERE parent.workspace_id = anchor.workspace_id
      AND parent.agent_session_id = anchor.parent_agent_session_id
      AND parent.deleted_at_unix_ms > 0
  )
ORDER BY anchor.agent_session_id ASC
`, workspaceID)
		if err != nil {
			return PurgeDeletedSessionTreesResult{}, fmt.Errorf("list deleted workspace agent session roots for purge: %w", err)
		}
		for rows.Next() {
			var rootID string
			if err := rows.Scan(&rootID); err != nil {
				rows.Close()
				return PurgeDeletedSessionTreesResult{}, fmt.Errorf("scan deleted workspace agent session root for purge: %w", err)
			}
			rootIDs = append(rootIDs, strings.TrimSpace(rootID))
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return PurgeDeletedSessionTreesResult{}, fmt.Errorf("iterate deleted workspace agent session roots for purge: %w", err)
		}
		if err := rows.Close(); err != nil {
			return PurgeDeletedSessionTreesResult{}, fmt.Errorf("close deleted workspace agent session roots for purge: %w", err)
		}
	}
	result := PurgeDeletedSessionTreesResult{
		PurgedRootSessionIDs: make([]string, 0, len(rootIDs)),
		PurgedSessionIDs:     make([]string, 0),
	}
	for _, rootID := range rootIDs {
		candidates, found, err := deletedTreePurgeCandidatesTx(ctx, tx, workspaceID, rootID)
		if err != nil {
			return PurgeDeletedSessionTreesResult{}, err
		}
		if !found {
			continue
		}
		for _, candidate := range candidates {
			removedMessages, removed, err := purgeDeletedSessionTx(ctx, tx, candidate)
			if err != nil {
				return PurgeDeletedSessionTreesResult{}, err
			}
			if !removed {
				return PurgeDeletedSessionTreesResult{}, fmt.Errorf("%w: %s", ErrDeletedSessionNotRestorable, DeletedSessionUnavailableIncompleteTree)
			}
			result.PurgedSessionIDs = append(result.PurgedSessionIDs, candidate.AgentSessionID)
			result.RemovedSessions++
			result.RemovedMessages += removedMessages
			result.PayloadBytes += candidate.PayloadBytes
		}
		result.PurgedRootSessionIDs = append(result.PurgedRootSessionIDs, rootID)
	}
	sort.Strings(result.PurgedRootSessionIDs)
	sort.Strings(result.PurgedSessionIDs)
	return result, nil
}

func deletedTreePurgeCandidatesTx(ctx context.Context, tx *sql.Tx, workspaceID, componentID string) ([]PurgedSession, bool, error) {
	var componentDeletedAt int64
	err := tx.QueryRowContext(ctx, `
SELECT anchor.deleted_at_unix_ms
FROM workspace_agent_sessions anchor
WHERE anchor.workspace_id = ? AND anchor.agent_session_id = ?
  AND anchor.deleted_at_unix_ms > 0
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_sessions parent
    WHERE parent.workspace_id = anchor.workspace_id
      AND parent.agent_session_id = anchor.parent_agent_session_id
      AND parent.deleted_at_unix_ms > 0
  )
`, workspaceID, componentID).Scan(&componentDeletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("read deleted workspace agent session component for purge: %w", err)
	}

	rows, err := tx.QueryContext(ctx, `
WITH RECURSIVE tree(agent_session_id, depth) AS (
  SELECT anchor.agent_session_id, 0
  FROM workspace_agent_sessions anchor
  WHERE anchor.workspace_id = ? AND anchor.agent_session_id = ?
  UNION
  SELECT child.agent_session_id, parent.depth + 1
  FROM workspace_agent_sessions child
  JOIN tree parent ON child.parent_agent_session_id = parent.agent_session_id
  WHERE child.workspace_id = ? AND child.session_kind = 'child'
)
SELECT s.agent_session_id, s.deleted_at_unix_ms, tree.depth,
       COALESCE((
         SELECT SUM(length(CAST(m.payload_json AS BLOB)) + length(CAST(m.semantics_json AS BLOB)))
         FROM workspace_agent_messages m
         WHERE m.workspace_id = s.workspace_id AND m.agent_session_id = s.agent_session_id
       ), 0)
FROM tree
JOIN workspace_agent_sessions s
  ON s.workspace_id = ? AND s.agent_session_id = tree.agent_session_id
ORDER BY tree.depth DESC, s.agent_session_id ASC
`, workspaceID, componentID, workspaceID, workspaceID)
	if err != nil {
		return nil, false, fmt.Errorf("resolve deleted workspace agent session tree for purge: %w", err)
	}
	defer rows.Close()
	candidates := make([]PurgedSession, 0)
	for rows.Next() {
		var candidate PurgedSession
		var depth int64
		candidate.WorkspaceID = workspaceID
		if err := rows.Scan(
			&candidate.AgentSessionID, &candidate.DeletedAtUnixMS,
			&depth, &candidate.PayloadBytes,
		); err != nil {
			return nil, false, fmt.Errorf("scan deleted workspace agent session tree for purge: %w", err)
		}
		if candidate.DeletedAtUnixMS <= 0 {
			return nil, false, fmt.Errorf("%w: %s", ErrDeletedSessionNotRestorable, DeletedSessionUnavailableIncompleteTree)
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("iterate deleted workspace agent session tree for purge: %w", err)
	}
	if len(candidates) == 0 {
		return nil, false, nil
	}
	return candidates, true, nil
}

func (s *Store) ListRecoverableDeletedSessionResources(ctx context.Context) ([]DeletedSessionResource, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT workspace_id, agent_session_id, cwd
FROM workspace_agent_sessions
WHERE deleted_at_unix_ms > 0 AND recoverable_delete_version = ?
ORDER BY workspace_id ASC, agent_session_id ASC
`, recoverableDeleteVersionCurrent)
	if err != nil {
		return nil, fmt.Errorf("list recoverable deleted workspace agent session resources: %w", err)
	}
	defer rows.Close()
	resources := make([]DeletedSessionResource, 0)
	for rows.Next() {
		var resource DeletedSessionResource
		if err := rows.Scan(&resource.WorkspaceID, &resource.AgentSessionID, &resource.Cwd); err != nil {
			return nil, fmt.Errorf("scan recoverable deleted workspace agent session resource: %w", err)
		}
		resources = append(resources, resource)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate recoverable deleted workspace agent session resources: %w", err)
	}
	return resources, nil
}
