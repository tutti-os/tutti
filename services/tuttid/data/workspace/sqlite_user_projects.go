package workspace

import (
	"context"
	"errors"
	"fmt"
	"time"

	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
)

func (s *SQLiteStore) ListUserProjects(ctx context.Context) ([]userprojectbiz.Project, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}

	rows, err := s.db.QueryContext(ctx, `
SELECT id, path, label, created_at_unix_ms, updated_at_unix_ms, last_used_at_unix_ms
FROM user_projects
ORDER BY last_used_at_unix_ms DESC, updated_at_unix_ms DESC, label ASC, id ASC
`)
	if err != nil {
		return nil, fmt.Errorf("list user projects: %w", err)
	}
	defer rows.Close()

	var result []userprojectbiz.Project
	for rows.Next() {
		var project userprojectbiz.Project
		if err := rows.Scan(
			&project.ID,
			&project.Path,
			&project.Label,
			&project.CreatedAtUnixMS,
			&project.UpdatedAtUnixMS,
			&project.LastUsedAtUnixMS,
		); err != nil {
			return nil, fmt.Errorf("scan user project: %w", err)
		}
		result = append(result, project)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate user projects: %w", err)
	}

	return result, nil
}

func (s *SQLiteStore) DeleteUserProject(ctx context.Context, id string) error {
	if s == nil || s.db == nil {
		return errors.New("workspace database is not initialized")
	}
	_, err := s.db.ExecContext(ctx, `
DELETE FROM user_projects
WHERE id = ?
`, id)
	if err != nil {
		return fmt.Errorf("delete user project: %w", err)
	}
	return nil
}

func (s *SQLiteStore) PutUserProject(ctx context.Context, project userprojectbiz.Project) (userprojectbiz.Project, error) {
	if s == nil || s.db == nil {
		return userprojectbiz.Project{}, errors.New("workspace database is not initialized")
	}

	now := unixMs(time.Now().UTC())
	if project.CreatedAtUnixMS <= 0 {
		project.CreatedAtUnixMS = now
	}
	if project.LastUsedAtUnixMS <= 0 {
		project.LastUsedAtUnixMS = now
	}
	project.UpdatedAtUnixMS = project.LastUsedAtUnixMS
	_, err := s.db.ExecContext(ctx, `
INSERT INTO user_projects (
  id, path, label, created_at_unix_ms, updated_at_unix_ms, last_used_at_unix_ms
)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(path) DO UPDATE SET
  label = excluded.label,
  updated_at_unix_ms = excluded.updated_at_unix_ms,
  last_used_at_unix_ms = excluded.last_used_at_unix_ms
`, project.ID, project.Path, project.Label, project.CreatedAtUnixMS, project.UpdatedAtUnixMS, project.LastUsedAtUnixMS)
	if err != nil {
		return userprojectbiz.Project{}, fmt.Errorf("put user project: %w", err)
	}

	row := s.db.QueryRowContext(ctx, `
SELECT id, path, label, created_at_unix_ms, updated_at_unix_ms, last_used_at_unix_ms
FROM user_projects
WHERE path = ?
`, project.Path)
	var stored userprojectbiz.Project
	if err := row.Scan(
		&stored.ID,
		&stored.Path,
		&stored.Label,
		&stored.CreatedAtUnixMS,
		&stored.UpdatedAtUnixMS,
		&stored.LastUsedAtUnixMS,
	); err != nil {
		return userprojectbiz.Project{}, fmt.Errorf("get user project after put: %w", err)
	}
	return stored, nil
}

func (s *SQLiteStore) TouchUserProject(ctx context.Context, id string, atUnixMS int64) error {
	if s == nil || s.db == nil {
		return errors.New("workspace database is not initialized")
	}
	if atUnixMS <= 0 {
		atUnixMS = unixMs(time.Now().UTC())
	}
	_, err := s.db.ExecContext(ctx, `
UPDATE user_projects
SET last_used_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE id = ?
`, atUnixMS, atUnixMS, id)
	if err != nil {
		return fmt.Errorf("touch user project: %w", err)
	}
	return nil
}
