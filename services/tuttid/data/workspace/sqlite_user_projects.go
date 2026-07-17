package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
)

func (s *SQLiteStore) ListUserProjects(ctx context.Context) ([]userprojectbiz.Project, error) {
	if s == nil || s.writeDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}

	rows, err := s.readDB.QueryContext(ctx, `
SELECT id, path, label, created_at_unix_ms, updated_at_unix_ms, last_used_at_unix_ms, sort_order
FROM user_projects
ORDER BY sort_order ASC, id ASC
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
			&project.SortOrder,
		); err != nil {
			return nil, fmt.Errorf("scan user project: %w", err)
		}
		project.SectionKey = userprojectbiz.SectionKeyFromPath(project.Path)
		result = append(result, project)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate user projects: %w", err)
	}

	return result, nil
}

func (s *SQLiteStore) DeleteUserProject(ctx context.Context, id string) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin delete user project: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	_, err = tx.ExecContext(ctx, `
DELETE FROM user_projects
WHERE id = ?
`, id)
	if err != nil {
		return fmt.Errorf("delete user project: %w", err)
	}
	if err := compactUserProjectOrder(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete user project: %w", err)
	}
	return nil
}

// DeleteUserProjectByPath removes a user project by its unique path rather
// than by a recomputed id. The `path` column carries the table's UNIQUE
// constraint (see applyUserProjectsV1), so it is the durable lookup key for a
// caller-supplied path; deleting by an id that gets recomputed from the path
// on every call can silently miss the row if that derivation ever drifts from
// what was actually stored, leaving the "removed" project in place.
func (s *SQLiteStore) DeleteUserProjectByPath(ctx context.Context, path string) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin delete user project by path: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	_, err = tx.ExecContext(ctx, `
DELETE FROM user_projects
WHERE path = ?
`, path)
	if err != nil {
		return fmt.Errorf("delete user project by path: %w", err)
	}
	if err := compactUserProjectOrder(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete user project by path: %w", err)
	}
	return nil
}

func (s *SQLiteStore) PutUserProject(ctx context.Context, project userprojectbiz.Project) (userprojectbiz.Project, error) {
	if s == nil || s.writeDB == nil {
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
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return userprojectbiz.Project{}, fmt.Errorf("begin put user project: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var existingID string
	err = tx.QueryRowContext(ctx, `SELECT id FROM user_projects WHERE path = ?`, project.Path).Scan(&existingID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return userprojectbiz.Project{}, fmt.Errorf("find user project before put: %w", err)
	}
	if errors.Is(err, sql.ErrNoRows) {
		if _, err := tx.ExecContext(ctx, `UPDATE user_projects SET sort_order = sort_order + 1`); err != nil {
			return userprojectbiz.Project{}, fmt.Errorf("shift user projects before insert: %w", err)
		}
		project.SortOrder = 0
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO user_projects (
  id, path, label, created_at_unix_ms, updated_at_unix_ms, last_used_at_unix_ms, sort_order
)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(path) DO UPDATE SET
  label = excluded.label,
  updated_at_unix_ms = excluded.updated_at_unix_ms,
  last_used_at_unix_ms = excluded.last_used_at_unix_ms
`, project.ID, project.Path, project.Label, project.CreatedAtUnixMS, project.UpdatedAtUnixMS, project.LastUsedAtUnixMS, project.SortOrder)
	if err != nil {
		return userprojectbiz.Project{}, fmt.Errorf("put user project: %w", err)
	}

	row := tx.QueryRowContext(ctx, `
SELECT id, path, label, created_at_unix_ms, updated_at_unix_ms, last_used_at_unix_ms, sort_order
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
		&stored.SortOrder,
	); err != nil {
		return userprojectbiz.Project{}, fmt.Errorf("get user project after put: %w", err)
	}
	stored.SectionKey = userprojectbiz.SectionKeyFromPath(stored.Path)
	if err := tx.Commit(); err != nil {
		return userprojectbiz.Project{}, fmt.Errorf("commit put user project: %w", err)
	}
	return stored, nil
}

func (s *SQLiteStore) TouchUserProject(ctx context.Context, id string, atUnixMS int64) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	if atUnixMS <= 0 {
		atUnixMS = unixMs(time.Now().UTC())
	}
	_, err := s.writeDB.ExecContext(ctx, `
UPDATE user_projects
SET last_used_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE id = ?
`, atUnixMS, atUnixMS, id)
	if err != nil {
		return fmt.Errorf("touch user project: %w", err)
	}
	return nil
}

func (s *SQLiteStore) MoveUserProject(ctx context.Context, projectID string, beforeProjectID *string) ([]userprojectbiz.Project, error) {
	if s == nil || s.writeDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return nil, ErrUserProjectNotFound
	}
	var beforeID *string
	if beforeProjectID != nil {
		normalized := strings.TrimSpace(*beforeProjectID)
		if normalized == "" {
			return nil, ErrUserProjectNotFound
		}
		beforeID = &normalized
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin move user project: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	projects, err := listUserProjectsTx(ctx, tx)
	if err != nil {
		return nil, err
	}
	fromIndex := -1
	beforeIndex := -1
	for index, project := range projects {
		if project.ID == projectID {
			fromIndex = index
		}
		if beforeID != nil && project.ID == *beforeID {
			beforeIndex = index
		}
	}
	if fromIndex < 0 || (beforeID != nil && beforeIndex < 0) {
		return nil, ErrUserProjectNotFound
	}
	if beforeID == nil || *beforeID != projectID {
		moving := projects[fromIndex]
		projects = append(projects[:fromIndex], projects[fromIndex+1:]...)
		insertIndex := len(projects)
		if beforeID != nil {
			for index, project := range projects {
				if project.ID == *beforeID {
					insertIndex = index
					break
				}
			}
		}
		projects = append(projects, userprojectbiz.Project{})
		copy(projects[insertIndex+1:], projects[insertIndex:])
		projects[insertIndex] = moving
	}
	for index := range projects {
		projects[index].SortOrder = index
		if _, err := tx.ExecContext(ctx, `UPDATE user_projects SET sort_order = ? WHERE id = ?`, index, projects[index].ID); err != nil {
			return nil, fmt.Errorf("rewrite user project order: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit move user project: %w", err)
	}
	return projects, nil
}

func compactUserProjectOrder(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order ASC, id ASC) - 1 AS next_sort_order
  FROM user_projects
)
UPDATE user_projects
SET sort_order = (SELECT next_sort_order FROM ordered WHERE ordered.id = user_projects.id)
`)
	if err != nil {
		return fmt.Errorf("compact user project order: %w", err)
	}
	return nil
}

func listUserProjectsTx(ctx context.Context, tx *sql.Tx) ([]userprojectbiz.Project, error) {
	rows, err := tx.QueryContext(ctx, `
SELECT id, path, label, created_at_unix_ms, updated_at_unix_ms, last_used_at_unix_ms, sort_order
FROM user_projects
ORDER BY sort_order ASC, id ASC
`)
	if err != nil {
		return nil, fmt.Errorf("list user projects in transaction: %w", err)
	}
	defer rows.Close()
	projects := make([]userprojectbiz.Project, 0)
	for rows.Next() {
		var project userprojectbiz.Project
		if err := rows.Scan(&project.ID, &project.Path, &project.Label, &project.CreatedAtUnixMS, &project.UpdatedAtUnixMS, &project.LastUsedAtUnixMS, &project.SortOrder); err != nil {
			return nil, fmt.Errorf("scan user project in transaction: %w", err)
		}
		project.SectionKey = userprojectbiz.SectionKeyFromPath(project.Path)
		projects = append(projects, project)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate user projects in transaction: %w", err)
	}
	return projects, nil
}
