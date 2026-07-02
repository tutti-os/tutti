package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func (s *SQLiteStore) ListAgentTargets(ctx context.Context) ([]agenttargetbiz.Target, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}

	rows, err := s.db.QueryContext(ctx, `
SELECT id, provider, launch_ref_json, name, icon_key, enabled, source, sort_order, created_at_ms, updated_at_ms
FROM agent_targets
ORDER BY sort_order ASC, name ASC, id ASC
`)
	if err != nil {
		return nil, fmt.Errorf("list agent targets: %w", err)
	}
	defer rows.Close()

	var result []agenttargetbiz.Target
	for rows.Next() {
		target, err := scanAgentTarget(rows)
		if err != nil {
			if isSkippableAgentTargetRowError(err) {
				slog.Warn("skipping invalid agent target row", "error", err)
				continue
			}
			return nil, err
		}
		result = append(result, target)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate agent targets: %w", err)
	}
	return result, nil
}

func (s *SQLiteStore) GetAgentTarget(ctx context.Context, id string) (agenttargetbiz.Target, error) {
	if s == nil || s.db == nil {
		return agenttargetbiz.Target{}, errors.New("workspace database is not initialized")
	}

	row := s.db.QueryRowContext(ctx, `
SELECT id, provider, launch_ref_json, name, icon_key, enabled, source, sort_order, created_at_ms, updated_at_ms
FROM agent_targets
WHERE id = ?
`, id)
	target, err := scanAgentTarget(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return agenttargetbiz.Target{}, ErrAgentTargetNotFound
		}
		return agenttargetbiz.Target{}, err
	}
	return target, nil
}

func (s *SQLiteStore) PutAgentTarget(ctx context.Context, target agenttargetbiz.Target) (agenttargetbiz.Target, error) {
	if s == nil || s.db == nil {
		return agenttargetbiz.Target{}, errors.New("workspace database is not initialized")
	}
	normalized, err := agenttargetbiz.NormalizeTarget(target)
	if err != nil {
		return agenttargetbiz.Target{}, err
	}
	now := unixMs(time.Now().UTC())
	if normalized.CreatedAtUnixMS <= 0 {
		normalized.CreatedAtUnixMS = now
	}
	normalized.UpdatedAtUnixMS = now

	if _, err := s.db.ExecContext(ctx, `
INSERT INTO agent_targets (
  id,
  provider,
  launch_ref_json,
  name,
  icon_key,
  enabled,
  source,
  sort_order,
  created_at_ms,
  updated_at_ms
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  provider = excluded.provider,
  launch_ref_json = excluded.launch_ref_json,
  name = excluded.name,
  icon_key = excluded.icon_key,
  enabled = excluded.enabled,
  source = excluded.source,
  sort_order = excluded.sort_order,
  updated_at_ms = excluded.updated_at_ms
`, normalized.ID, normalized.Provider, normalized.LaunchRefJSON, normalized.Name, normalized.IconKey, normalized.Enabled, normalized.Source, normalized.SortOrder, normalized.CreatedAtUnixMS, normalized.UpdatedAtUnixMS); err != nil {
		return agenttargetbiz.Target{}, fmt.Errorf("put agent target: %w", err)
	}
	return s.GetAgentTarget(ctx, normalized.ID)
}

func (s *SQLiteStore) DeleteAgentTarget(ctx context.Context, id string) error {
	if s == nil || s.db == nil {
		return errors.New("workspace database is not initialized")
	}
	if _, err := s.db.ExecContext(ctx, `
DELETE FROM agent_targets
WHERE id = ?
`, id); err != nil {
		return fmt.Errorf("delete agent target: %w", err)
	}
	return nil
}

type agentTargetScanner interface {
	Scan(dest ...any) error
}

func scanAgentTarget(scanner agentTargetScanner) (agenttargetbiz.Target, error) {
	var target agenttargetbiz.Target
	var iconKey sql.NullString
	if err := scanner.Scan(
		&target.ID,
		&target.Provider,
		&target.LaunchRefJSON,
		&target.Name,
		&iconKey,
		&target.Enabled,
		&target.Source,
		&target.SortOrder,
		&target.CreatedAtUnixMS,
		&target.UpdatedAtUnixMS,
	); err != nil {
		return agenttargetbiz.Target{}, fmt.Errorf("scan agent target: %w", err)
	}
	if iconKey.Valid {
		target.IconKey = iconKey.String
	}
	normalized, err := agenttargetbiz.NormalizeTarget(target)
	if err != nil {
		return agenttargetbiz.Target{}, err
	}
	return normalized, nil
}

func isSkippableAgentTargetRowError(err error) bool {
	return errors.Is(err, agenttargetbiz.ErrInvalidTarget) ||
		errors.Is(err, agenttargetbiz.ErrInvalidLaunchRef)
}
