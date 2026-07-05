package workspace

import (
	"context"
	"fmt"
	"time"
)

func (s *SQLiteStore) applyWorkspaceAppsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAppsV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	_, err = s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS app_packages (
  app_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  package_dir TEXT NOT NULL,
  manifest_json TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_app_installations (
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, app_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (app_id) REFERENCES app_packages(app_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workspace_app_installations_workspace
  ON workspace_app_installations(workspace_id, app_id ASC);

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceAppsV1, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database apps v1: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyWorkspaceAppsV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAppsV2)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	hasManifestJSON, err := s.hasColumn(ctx, "app_packages", "manifest_json")
	if err != nil {
		return err
	}

	now := unixMs(time.Now().UTC())
	if !hasManifestJSON {
		if _, err := s.db.ExecContext(ctx, `
ALTER TABLE app_packages ADD COLUMN manifest_json TEXT NOT NULL DEFAULT '';
`); err != nil {
			return fmt.Errorf("migrate workspace database apps v2: %w", err)
		}
	}

	_, err = s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceAppsV2, now)
	if err != nil {
		return fmt.Errorf("record workspace database apps v2 migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyWorkspaceAppsV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAppsV3)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	if _, err := s.db.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		return fmt.Errorf("disable sqlite foreign keys for workspace apps v3 migration: %w", err)
	}
	defer func() {
		_, _ = s.db.ExecContext(context.Background(), `PRAGMA foreign_keys = ON`)
	}()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace apps v3 migration: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	_, err = tx.ExecContext(ctx, `
DROP INDEX IF EXISTS idx_workspace_app_installations_workspace;

CREATE TABLE app_packages_v3 (
  app_id TEXT NOT NULL,
  version TEXT NOT NULL,
  package_dir TEXT NOT NULL,
  manifest_json TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'builtin',
  factory_job_id TEXT NOT NULL DEFAULT '',
  created_in_workspace_id TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (app_id, version)
);

INSERT INTO app_packages_v3 (
  app_id, version, package_dir, manifest_json, source, created_at_unix_ms, updated_at_unix_ms
)
SELECT app_id, version, package_dir, manifest_json, 'builtin', created_at_unix_ms, updated_at_unix_ms
FROM app_packages;

CREATE TABLE app_catalog_entries (
  app_id TEXT PRIMARY KEY,
  active_version TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'builtin',
  created_in_workspace_id TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL
);

INSERT INTO app_catalog_entries (
  app_id, active_version, source, created_at_unix_ms, updated_at_unix_ms
)
SELECT app_id, version, 'builtin', created_at_unix_ms, updated_at_unix_ms
FROM app_packages;

CREATE TABLE workspace_app_installations_v3 (
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, app_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (app_id) REFERENCES app_catalog_entries(app_id) ON DELETE CASCADE
);

INSERT INTO workspace_app_installations_v3 (
  workspace_id, app_id, enabled, created_at_unix_ms, updated_at_unix_ms
)
SELECT workspace_id, app_id, enabled, created_at_unix_ms, updated_at_unix_ms
FROM workspace_app_installations;

DROP TABLE workspace_app_installations;
DROP TABLE app_packages;
ALTER TABLE app_packages_v3 RENAME TO app_packages;
ALTER TABLE workspace_app_installations_v3 RENAME TO workspace_app_installations;

CREATE INDEX IF NOT EXISTS idx_workspace_app_installations_workspace
  ON workspace_app_installations(workspace_id, app_id ASC);
CREATE INDEX IF NOT EXISTS idx_app_packages_app_updated
  ON app_packages(app_id, updated_at_unix_ms DESC);

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceAppsV3, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database apps v3: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace apps v3 migration: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `PRAGMA foreign_keys = ON`); err != nil {
		return fmt.Errorf("re-enable sqlite foreign keys for workspace apps v3 migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyAppFactoryJobsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAppFactoryJobsV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	_, err = s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS app_factory_jobs (
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  app_id TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  agent_target_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  agent_session_id TEXT NOT NULL DEFAULT '',
  draft_dir TEXT NOT NULL DEFAULT '',
  runtime_dir TEXT NOT NULL DEFAULT '',
  data_dir TEXT NOT NULL DEFAULT '',
  log_dir TEXT NOT NULL DEFAULT '',
  package_dir TEXT NOT NULL DEFAULT '',
  validation_result_json TEXT NOT NULL DEFAULT '',
  failure_reason TEXT NOT NULL DEFAULT '',
  published_version TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, job_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_app_factory_jobs_workspace_updated
  ON app_factory_jobs(workspace_id, updated_at_unix_ms DESC, job_id ASC);

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationAppFactoryJobsV1, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database app factory jobs v1: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyAppFactoryJobsV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAppFactoryJobsV2)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	_, err = s.db.ExecContext(ctx, `
ALTER TABLE app_factory_jobs
  ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT '';
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationAppFactoryJobsV2, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database app factory jobs v2: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyAppFactoryJobsV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAppFactoryJobsV3)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	hasAgentTargetID, err := s.hasColumn(ctx, "app_factory_jobs", "agent_target_id")
	if err != nil {
		return err
	}
	if !hasAgentTargetID {
		if _, err := s.db.ExecContext(ctx, `
ALTER TABLE app_factory_jobs ADD COLUMN agent_target_id TEXT NOT NULL DEFAULT '';
`); err != nil {
			return fmt.Errorf("migrate workspace app factory jobs agent target id: %w", err)
		}
	}

	now := unixMs(time.Now().UTC())
	_, err = s.db.ExecContext(ctx, `
UPDATE app_factory_jobs
SET agent_target_id = CASE provider
  WHEN 'codex' THEN 'local:codex'
  WHEN 'claude-code' THEN 'local:claude-code'
  ELSE agent_target_id
END
WHERE agent_target_id = '';
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationAppFactoryJobsV3, now)
	if err != nil {
		return fmt.Errorf("record workspace app factory jobs v3 migration: %w", err)
	}
	return nil
}
