package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func (s *SQLiteStore) GetAgentProviderRuntimeSelection(
	ctx context.Context,
	provider string,
) (agentproviderbiz.RuntimeSelection, bool, error) {
	if s == nil || s.readDB == nil {
		return agentproviderbiz.RuntimeSelection{}, false, errors.New("workspace database is not initialized")
	}
	provider = agentproviderbiz.Normalize(provider)
	if provider == "" {
		return agentproviderbiz.RuntimeSelection{}, false, errors.New("agent provider is required")
	}
	var selection agentproviderbiz.RuntimeSelection
	var updatedAtUnixMS int64
	err := s.readDB.QueryRowContext(ctx, `
SELECT provider, launcher_path, updated_at_unix_ms
FROM agent_provider_runtime_selections
WHERE provider = ?
`, provider).Scan(&selection.Provider, &selection.LauncherPath, &updatedAtUnixMS)
	if errors.Is(err, sql.ErrNoRows) {
		return agentproviderbiz.RuntimeSelection{}, false, nil
	}
	if err != nil {
		return agentproviderbiz.RuntimeSelection{}, false, fmt.Errorf("get agent provider runtime selection: %w", err)
	}
	selection.UpdatedAt = time.UnixMilli(updatedAtUnixMS).UTC()
	return selection, true, nil
}

func (s *SQLiteStore) PutAgentProviderRuntimeSelection(
	ctx context.Context,
	selection agentproviderbiz.RuntimeSelection,
) (agentproviderbiz.RuntimeSelection, error) {
	if s == nil || s.writeDB == nil {
		return agentproviderbiz.RuntimeSelection{}, errors.New("workspace database is not initialized")
	}
	selection.Provider = agentproviderbiz.Normalize(selection.Provider)
	selection.LauncherPath = strings.TrimSpace(selection.LauncherPath)
	if selection.Provider == "" {
		return agentproviderbiz.RuntimeSelection{}, errors.New("agent provider is required")
	}
	if selection.LauncherPath == "" {
		return agentproviderbiz.RuntimeSelection{}, errors.New("agent provider runtime launcher path is required")
	}
	selection.UpdatedAt = time.Now().UTC()
	_, err := s.writeDB.ExecContext(ctx, `
INSERT INTO agent_provider_runtime_selections (provider, launcher_path, updated_at_unix_ms)
VALUES (?, ?, ?)
ON CONFLICT(provider) DO UPDATE SET
  launcher_path = excluded.launcher_path,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, selection.Provider, selection.LauncherPath, unixMs(selection.UpdatedAt))
	if err != nil {
		return agentproviderbiz.RuntimeSelection{}, fmt.Errorf("put agent provider runtime selection: %w", err)
	}
	return selection, nil
}

func (s *SQLiteStore) DeleteAgentProviderRuntimeSelection(ctx context.Context, provider string) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	provider = agentproviderbiz.Normalize(provider)
	if provider == "" {
		return errors.New("agent provider is required")
	}
	if _, err := s.writeDB.ExecContext(ctx, `
DELETE FROM agent_provider_runtime_selections WHERE provider = ?
`, provider); err != nil {
		return fmt.Errorf("delete agent provider runtime selection: %w", err)
	}
	return nil
}
