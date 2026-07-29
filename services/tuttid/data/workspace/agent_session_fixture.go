package workspace

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const agentSessionFixtureSchemaVersion = 1

// WaitAgentSessionGraphSettled keeps the capture window open until every
// already-accepted canonical operation in the selected graph is terminal.
func (s *SQLiteStore) WaitAgentSessionGraphSettled(
	ctx context.Context,
	workspaceID string,
	rootAgentSessionID string,
) error {
	if s == nil || s.readDB == nil {
		return errors.New("workspace database is not initialized")
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		var active int
		err := s.readDB.QueryRowContext(ctx, `
WITH graph(agent_session_id) AS (
  SELECT agent_session_id
  FROM workspace_agent_sessions
  WHERE workspace_id = ?
    AND deleted_at_unix_ms = 0
    AND (agent_session_id = ? OR root_agent_session_id = ?)
)
SELECT
  (SELECT COUNT(*)
   FROM workspace_agent_sessions
   WHERE workspace_id = ? AND agent_session_id IN (SELECT agent_session_id FROM graph) AND active_turn_id IS NOT NULL)
  +
  (SELECT COUNT(*)
   FROM workspace_agent_runtime_operations
   WHERE workspace_id = ? AND agent_session_id IN (SELECT agent_session_id FROM graph) AND status IN ('prepared','leased'))
  +
  (SELECT COUNT(*)
   FROM workspace_agent_goal_control_operations
   WHERE workspace_id = ? AND agent_session_id IN (SELECT agent_session_id FROM graph) AND status IN ('prepared','dispatched'))
  +
  (SELECT COUNT(*)
   FROM workspace_workflow_operations
   WHERE workspace_id = ?
     AND status IN ('pending','running')
     AND workflow_id IN (
       SELECT workflow_id FROM workspace_workflows
       WHERE workspace_id = ? AND source_session_id IN (SELECT agent_session_id FROM graph)
     ))
`, workspaceID, rootAgentSessionID, rootAgentSessionID,
			workspaceID, workspaceID, workspaceID, workspaceID, workspaceID,
		).Scan(&active)
		if err != nil {
			return fmt.Errorf("read Agent Session graph finalization state: %w", err)
		}
		if active == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("wait for Agent Session graph to settle: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

type agentSessionFixtureRecord struct {
	SchemaVersion int            `json:"schemaVersion"`
	Table         string         `json:"table"`
	Values        map[string]any `json:"values"`
}

// ResolveRootAgentSession returns the canonical root for either a root or
// child Session. It does not infer graph identity from provider state.
func (s *SQLiteStore) ResolveRootAgentSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (string, error) {
	if s == nil || s.readDB == nil {
		return "", errors.New("workspace database is not initialized")
	}
	var rootID string
	err := s.readDB.QueryRowContext(ctx, `
SELECT CASE
  WHEN TRIM(COALESCE(root_agent_session_id, '')) = '' THEN agent_session_id
  ELSE root_agent_session_id
END
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID)).Scan(&rootID)
	if err != nil {
		return "", fmt.Errorf("resolve Agent Session root: %w", err)
	}
	return strings.TrimSpace(rootID), nil
}

// ExportAgentSessionGraph writes a deterministic JSONL fixture containing only
// the selected canonical SessionGraph and rows owned by contributors linked to
// that graph. It never copies the SQLite database.
func (s *SQLiteStore) ExportAgentSessionGraph(
	ctx context.Context,
	workspaceID string,
	rootAgentSessionID string,
	destination string,
) error {
	if s == nil || s.readDB == nil {
		return errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	rootAgentSessionID = strings.TrimSpace(rootAgentSessionID)
	if workspaceID == "" || rootAgentSessionID == "" {
		return errors.New("workspace and root Agent Session ids are required")
	}
	sessionIDs, err := queryStringColumn(ctx, s.readDB, `
SELECT agent_session_id
FROM workspace_agent_sessions
WHERE workspace_id = ?
  AND deleted_at_unix_ms = 0
  AND (
    agent_session_id = ?
    OR root_agent_session_id = ?
  )
ORDER BY
  CASE WHEN agent_session_id = ? THEN 0 ELSE 1 END,
  created_at_unix_ms,
  agent_session_id
`, workspaceID, rootAgentSessionID, rootAgentSessionID, rootAgentSessionID)
	if err != nil {
		return fmt.Errorf("list Agent Session graph: %w", err)
	}
	if len(sessionIDs) == 0 || sessionIDs[0] != rootAgentSessionID {
		return sql.ErrNoRows
	}

	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	tempPath := destination + ".tmp"
	file, err := os.OpenFile(tempPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	writer := bufio.NewWriter(file)
	closeWithError := func(cause error) error {
		_ = file.Close()
		_ = os.Remove(tempPath)
		return cause
	}

	sessionTables := []string{
		"workspace_agent_sessions",
		"workspace_agent_turns",
		"workspace_agent_messages",
		"workspace_agent_interactions",
		"workspace_agent_submit_claims",
		"workspace_agent_runtime_operations",
		"workspace_agent_runtime_operation_events",
		"workspace_agent_session_goals",
		"workspace_agent_goal_control_operations",
		"workspace_agent_goal_provenance_ledger",
		"workspace_agent_goal_repair_incidents",
		"workspace_agent_goal_reconcile_inbox",
		"workspace_agent_turn_files",
		"tutti_mode_activations",
		"tutti_mode_turn_snapshots",
	}
	for _, table := range sessionTables {
		if err := exportFixtureTable(
			ctx,
			s.readDB,
			writer,
			table,
			workspaceID,
			"agent_session_id",
			sessionIDs,
		); err != nil {
			return closeWithError(err)
		}
	}

	activationIDs, err := fixtureLinkedIDs(
		ctx,
		s.readDB,
		"tutti_mode_activations",
		"activation_id",
		workspaceID,
		"agent_session_id",
		sessionIDs,
	)
	if err != nil {
		return closeWithError(err)
	}
	if err := exportFixtureTable(
		ctx,
		s.readDB,
		writer,
		"tutti_mode_activation_revisions",
		workspaceID,
		"activation_id",
		activationIDs,
	); err != nil {
		return closeWithError(err)
	}

	turnIDs, err := fixtureLinkedIDs(
		ctx,
		s.readDB,
		"workspace_agent_turns",
		"turn_id",
		workspaceID,
		"agent_session_id",
		sessionIDs,
	)
	if err != nil {
		return closeWithError(err)
	}
	if err := exportFixtureTable(
		ctx,
		s.readDB,
		writer,
		"workspace_workflow_turn_links",
		workspaceID,
		"turn_id",
		turnIDs,
	); err != nil {
		return closeWithError(err)
	}
	workflowIDs, err := fixtureLinkedIDs(
		ctx,
		s.readDB,
		"workspace_workflow_turn_links",
		"workflow_id",
		workspaceID,
		"turn_id",
		turnIDs,
	)
	if err != nil {
		return closeWithError(err)
	}
	for _, table := range []string{
		"workspace_workflows",
		"tutti_mode_plans",
		"workspace_workflow_plan_revisions",
		"workspace_workflow_checkpoints",
		"workspace_workflow_mutations",
		"workspace_workflow_operations",
	} {
		if err := exportFixtureTable(
			ctx,
			s.readDB,
			writer,
			table,
			workspaceID,
			"workflow_id",
			workflowIDs,
		); err != nil {
			return closeWithError(err)
		}
	}
	issueIDs, err := fixtureLinkedIDs(
		ctx,
		s.readDB,
		"workspace_workflow_operations",
		"issue_id",
		workspaceID,
		"workflow_id",
		workflowIDs,
	)
	if err != nil {
		return closeWithError(err)
	}
	issueIDs = nonEmptyStrings(issueIDs)
	for _, table := range []string{
		"workspace_issues",
		"workspace_issue_tasks",
		"workspace_issue_context_refs",
		"workspace_issue_runs",
		"workspace_issue_run_outputs",
	} {
		if err := exportFixtureTable(
			ctx,
			s.readDB,
			writer,
			table,
			workspaceID,
			"issue_id",
			issueIDs,
		); err != nil {
			return closeWithError(err)
		}
	}

	if err := writer.Flush(); err != nil {
		return closeWithError(err)
	}
	if err := file.Sync(); err != nil {
		return closeWithError(err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return os.Rename(tempPath, destination)
}

func exportFixtureTable(
	ctx context.Context,
	db *sql.DB,
	writer *bufio.Writer,
	table string,
	workspaceID string,
	identityColumn string,
	identities []string,
) error {
	columns, exists, err := sqliteTableColumns(ctx, db, table)
	if err != nil || !exists || len(identities) == 0 {
		return err
	}
	if !containsString(columns, "workspace_id") || !containsString(columns, identityColumn) {
		return fmt.Errorf("fixture table %s does not have required scope columns", table)
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(identities)), ",")
	query := fmt.Sprintf(
		"SELECT * FROM %s WHERE workspace_id = ? AND %s IN (%s) ORDER BY rowid",
		table,
		identityColumn,
		placeholders,
	)
	args := make([]any, 0, len(identities)+1)
	args = append(args, workspaceID)
	for _, identity := range identities {
		args = append(args, identity)
	}
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("query fixture table %s: %w", table, err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		values := make([]any, len(columns))
		destinations := make([]any, len(columns))
		for index := range values {
			destinations[index] = &values[index]
		}
		if err := rows.Scan(destinations...); err != nil {
			return err
		}
		recordValues := make(map[string]any, len(columns))
		for index, value := range values {
			if bytes, ok := value.([]byte); ok {
				value = string(bytes)
			}
			recordValues[columns[index]] = value
		}
		raw, err := json.Marshal(agentSessionFixtureRecord{
			SchemaVersion: agentSessionFixtureSchemaVersion,
			Table:         table,
			Values:        recordValues,
		})
		if err != nil {
			return err
		}
		if _, err := writer.Write(append(raw, '\n')); err != nil {
			return err
		}
	}
	return rows.Err()
}

func fixtureLinkedIDs(
	ctx context.Context,
	db *sql.DB,
	table string,
	resultColumn string,
	workspaceID string,
	identityColumn string,
	identities []string,
) ([]string, error) {
	columns, exists, err := sqliteTableColumns(ctx, db, table)
	if err != nil || !exists || len(identities) == 0 {
		return nil, err
	}
	if !containsString(columns, resultColumn) {
		return nil, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(identities)), ",")
	query := fmt.Sprintf(
		"SELECT DISTINCT %s FROM %s WHERE workspace_id = ? AND %s IN (%s) ORDER BY %s",
		resultColumn,
		table,
		identityColumn,
		placeholders,
		resultColumn,
	)
	args := []any{workspaceID}
	for _, identity := range identities {
		args = append(args, identity)
	}
	return queryStringColumn(ctx, db, query, args...)
}

func sqliteTableColumns(ctx context.Context, db *sql.DB, table string) ([]string, bool, error) {
	rows, err := db.QueryContext(ctx, "PRAGMA table_info("+table+")")
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = rows.Close() }()
	var columns []string
	for rows.Next() {
		var (
			cid        int
			name       string
			kind       string
			notNull    int
			defaultV   any
			primaryKey int
		)
		if err := rows.Scan(&cid, &name, &kind, &notNull, &defaultV, &primaryKey); err != nil {
			return nil, false, err
		}
		columns = append(columns, name)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return columns, len(columns) > 0, nil
}

func queryStringColumn(ctx context.Context, db *sql.DB, query string, args ...any) ([]string, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var values []string
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		values = append(values, strings.TrimSpace(value))
	}
	return values, rows.Err()
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func nonEmptyStrings(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			result = append(result, value)
		}
	}
	return result
}
