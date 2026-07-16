package workspace

import (
	"context"
	"fmt"
	"time"
)

func (s *SQLiteStore) applyWorkspaceWorkflowMutationsV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceWorkflowMutationsV2)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	_, err = s.writeDB.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS workspace_workflow_mutations (
  workspace_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('propose', 'revise')),
  workflow_scope_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
  workflow_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, source_session_id, mutation_kind, workflow_scope_id, request_id),
  FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES workspace_workflows(workspace_id, workflow_id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, workflow_id, revision_id)
    REFERENCES workspace_workflow_plan_revisions(workspace_id, workflow_id, revision_id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, workflow_id, checkpoint_id)
    REFERENCES workspace_workflow_checkpoints(workspace_id, workflow_id, checkpoint_id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_workspace_workflow_mutations_result
  ON workspace_workflow_mutations(workspace_id, workflow_id, revision_id);

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceWorkflowMutationsV2, unixMs(time.Now().UTC()))
	if err != nil {
		return fmt.Errorf("migrate workspace workflow mutations v2: %w", err)
	}
	return nil
}
