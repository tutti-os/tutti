package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// ErrAgentTargetNotFound is returned when a target ID has no row.
var ErrAgentTargetNotFound = errors.New("agent target not found")

// Target is the stored representation of an agent target. Validation and
// canonicalization semantics belong to the host via Options.NormalizeTarget.
type Target struct {
	ID              string
	Provider        string
	LaunchRefJSON   string
	Name            string
	IconKey         string
	IconURL         string
	MaskIconURL     string
	HeroImageURL    string
	Enabled         bool
	Source          string
	SortOrder       int
	CreatedAtUnixMS int64
	UpdatedAtUnixMS int64
}

func (s *Store) normalizeTarget(target Target) (Target, error) {
	if s.opts.NormalizeTarget == nil {
		return target, nil
	}
	return s.opts.NormalizeTarget(target)
}

func (s *Store) isSkippableTargetRowError(err error) bool {
	return s.opts.IsSkippableTargetError != nil && s.opts.IsSkippableTargetError(err)
}

func (s *Store) ListAgentTargets(ctx context.Context) ([]Target, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}

	rows, err := s.db.QueryContext(ctx, `
SELECT id, provider, launch_ref_json, name, icon_key, icon_url, mask_icon_url, hero_image_url, enabled, source, sort_order, created_at_ms, updated_at_ms
FROM agent_targets
ORDER BY sort_order ASC, name ASC, id ASC
`)
	if err != nil {
		return nil, fmt.Errorf("list agent targets: %w", err)
	}
	defer rows.Close()

	var result []Target
	for rows.Next() {
		target, err := s.scanAgentTarget(rows)
		if err != nil {
			if s.isSkippableTargetRowError(err) {
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

func (s *Store) GetAgentTarget(ctx context.Context, id string) (Target, error) {
	if s == nil || s.db == nil {
		return Target{}, errors.New("workspace database is not initialized")
	}

	row := s.db.QueryRowContext(ctx, `
SELECT id, provider, launch_ref_json, name, icon_key, icon_url, mask_icon_url, hero_image_url, enabled, source, sort_order, created_at_ms, updated_at_ms
FROM agent_targets
WHERE id = ?
`, id)
	target, err := s.scanAgentTarget(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Target{}, ErrAgentTargetNotFound
		}
		return Target{}, err
	}
	return target, nil
}

func (s *Store) PutAgentTarget(ctx context.Context, target Target) (Target, error) {
	if s == nil || s.db == nil {
		return Target{}, errors.New("workspace database is not initialized")
	}
	normalized, err := s.normalizeTarget(target)
	if err != nil {
		return Target{}, err
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
  icon_url,
  mask_icon_url,
  hero_image_url,
  enabled,
  source,
  sort_order,
  created_at_ms,
  updated_at_ms
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  provider = excluded.provider,
  launch_ref_json = excluded.launch_ref_json,
  name = excluded.name,
  icon_key = excluded.icon_key,
  icon_url = excluded.icon_url,
  mask_icon_url = excluded.mask_icon_url,
  hero_image_url = excluded.hero_image_url,
  enabled = excluded.enabled,
  source = excluded.source,
  sort_order = excluded.sort_order,
  updated_at_ms = excluded.updated_at_ms
`, normalized.ID, normalized.Provider, normalized.LaunchRefJSON, normalized.Name, normalized.IconKey, normalized.IconURL, normalized.MaskIconURL, normalized.HeroImageURL, normalized.Enabled, normalized.Source, normalized.SortOrder, normalized.CreatedAtUnixMS, normalized.UpdatedAtUnixMS); err != nil {
		return Target{}, fmt.Errorf("put agent target: %w", err)
	}
	return s.GetAgentTarget(ctx, normalized.ID)
}

func (s *Store) DeleteAgentTarget(ctx context.Context, id string) error {
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

func (s *Store) scanAgentTarget(scanner rowScanner) (Target, error) {
	var target Target
	var iconKey sql.NullString
	var iconURL sql.NullString
	var maskIconURL sql.NullString
	var heroImageURL sql.NullString
	if err := scanner.Scan(
		&target.ID,
		&target.Provider,
		&target.LaunchRefJSON,
		&target.Name,
		&iconKey,
		&iconURL,
		&maskIconURL,
		&heroImageURL,
		&target.Enabled,
		&target.Source,
		&target.SortOrder,
		&target.CreatedAtUnixMS,
		&target.UpdatedAtUnixMS,
	); err != nil {
		return Target{}, fmt.Errorf("scan agent target: %w", err)
	}
	if iconKey.Valid {
		target.IconKey = iconKey.String
	}
	if iconURL.Valid {
		target.IconURL = iconURL.String
	}
	if maskIconURL.Valid {
		target.MaskIconURL = maskIconURL.String
	}
	if heroImageURL.Valid {
		target.HeroImageURL = heroImageURL.String
	}
	normalized, err := s.normalizeTarget(target)
	if err != nil {
		return Target{}, err
	}
	return normalized, nil
}
