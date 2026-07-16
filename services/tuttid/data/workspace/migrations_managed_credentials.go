package workspace

import (
	"context"
	"fmt"
	"time"
)

func (s *SQLiteStore) applyManagedCredentialsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationManagedCredentialsV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	_, err = s.writeDB.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS managed_model_provider_credentials (
  workspace_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  api_key_ciphertext TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  models_json TEXT NOT NULL DEFAULT '[]',
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, provider_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS managed_model_app_grants (
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  grant_ref TEXT NOT NULL,
  provider_ids_json TEXT NOT NULL DEFAULT '[]',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  created_at_unix_ms INTEGER NOT NULL,
  expires_at_unix_ms INTEGER NOT NULL,
  revoked_at_unix_ms INTEGER,
  PRIMARY KEY (workspace_id, app_id, grant_ref),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationManagedCredentialsV1, now)
	if err != nil {
		return fmt.Errorf("migrate managed credentials v1: %w", err)
	}
	return nil
}
