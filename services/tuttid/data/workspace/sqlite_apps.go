package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func (s *SQLiteStore) PutAppPackage(ctx context.Context, appPackage workspacebiz.AppPackage) error {
	return s.putAppPackage(ctx, appPackage, true)
}

func (s *SQLiteStore) PutAppPackageVersion(ctx context.Context, appPackage workspacebiz.AppPackage) error {
	return s.putAppPackage(ctx, appPackage, false)
}

func (s *SQLiteStore) putAppPackage(ctx context.Context, appPackage workspacebiz.AppPackage, activate bool) error {
	if s == nil || s.db == nil {
		return errors.New("workspace database is not initialized")
	}

	appID := strings.TrimSpace(appPackage.AppID)
	version := strings.TrimSpace(appPackage.Version)
	packageDir := strings.TrimSpace(appPackage.PackageDir)
	manifestJSON := strings.TrimSpace(appPackage.ManifestJSON)
	if manifestJSON == "" && appPackage.Manifest.AppID != "" {
		data, err := json.Marshal(appPackage.Manifest)
		if err != nil {
			return fmt.Errorf("serialize workspace app manifest: %w", err)
		}
		_, normalized, err := workspacebiz.ParseAppManifestJSON(data)
		if err != nil {
			return err
		}
		manifestJSON = normalized
	}
	if appID == "" || version == "" || packageDir == "" || manifestJSON == "" {
		return errors.New("workspace app package fields are required")
	}
	manifest, normalizedManifestJSON, err := workspacebiz.ParseAppManifestJSON([]byte(manifestJSON))
	if err != nil {
		return err
	}
	if manifest.AppID != appID || manifest.Version != version {
		return errors.New("workspace app package manifest does not match package identity")
	}

	now := unixMs(time.Now().UTC())
	source := strings.TrimSpace(string(appPackage.Source))
	if source == "" {
		source = string(workspacebiz.AppPackageSourceBuiltin)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace app package write: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	if _, err := tx.ExecContext(ctx, `
INSERT INTO app_packages (
  app_id, version, package_dir, manifest_json, source, factory_job_id, created_in_workspace_id, created_at_unix_ms, updated_at_unix_ms
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(app_id, version) DO UPDATE SET
  version = excluded.version,
  package_dir = excluded.package_dir,
  manifest_json = excluded.manifest_json,
  source = excluded.source,
  factory_job_id = excluded.factory_job_id,
  created_in_workspace_id = excluded.created_in_workspace_id,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, appID, version, packageDir, normalizedManifestJSON, source, strings.TrimSpace(appPackage.FactoryJobID), strings.TrimSpace(appPackage.CreatedInWorkspaceID), now, now); err != nil {
		return fmt.Errorf("put workspace app package: %w", err)
	}

	if activate {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO app_catalog_entries (
  app_id, active_version, source, created_in_workspace_id, created_at_unix_ms, updated_at_unix_ms
)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(app_id) DO UPDATE SET
  active_version = excluded.active_version,
  source = excluded.source,
  created_in_workspace_id = excluded.created_in_workspace_id,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, appID, version, source, strings.TrimSpace(appPackage.CreatedInWorkspaceID), now, now); err != nil {
			return fmt.Errorf("put workspace app catalog entry: %w", err)
		}
	} else {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO app_catalog_entries (
  app_id, active_version, source, created_in_workspace_id, created_at_unix_ms, updated_at_unix_ms
)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(app_id) DO NOTHING
`, appID, version, source, strings.TrimSpace(appPackage.CreatedInWorkspaceID), now, now); err != nil {
			return fmt.Errorf("put inactive workspace app catalog entry: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace app package write: %w", err)
	}
	return nil
}

func (s *SQLiteStore) GetAppPackage(ctx context.Context, appID string) (workspacebiz.AppPackage, error) {
	if s == nil || s.db == nil {
		return workspacebiz.AppPackage{}, errors.New("workspace database is not initialized")
	}

	appID = strings.TrimSpace(appID)
	if appID == "" {
		return workspacebiz.AppPackage{}, errors.New("workspace app id is required")
	}

	row := s.db.QueryRowContext(ctx, `
SELECT p.app_id, p.version, p.package_dir, p.manifest_json, p.source, p.factory_job_id, p.created_in_workspace_id, c.created_at_unix_ms
FROM app_catalog_entries c
JOIN app_packages p ON p.app_id = c.app_id AND p.version = c.active_version
WHERE c.app_id = ?
`, appID)

	appPackage, err := scanAppPackage(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workspacebiz.AppPackage{}, ErrWorkspaceAppNotFound
		}
		return workspacebiz.AppPackage{}, fmt.Errorf("get workspace app package: %w", err)
	}
	return appPackage, nil
}

func (s *SQLiteStore) GetAppPackageVersion(ctx context.Context, appID string, version string) (workspacebiz.AppPackage, error) {
	if s == nil || s.db == nil {
		return workspacebiz.AppPackage{}, errors.New("workspace database is not initialized")
	}

	appID = strings.TrimSpace(appID)
	version = strings.TrimSpace(version)
	if appID == "" || version == "" {
		return workspacebiz.AppPackage{}, errors.New("workspace app id and version are required")
	}

	row := s.db.QueryRowContext(ctx, `
SELECT app_id, version, package_dir, manifest_json, source, factory_job_id, created_in_workspace_id, created_at_unix_ms
FROM app_packages
WHERE app_id = ? AND version = ?
`, appID, version)

	appPackage, err := scanAppPackage(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workspacebiz.AppPackage{}, ErrWorkspaceAppNotFound
		}
		return workspacebiz.AppPackage{}, fmt.Errorf("get workspace app package version: %w", err)
	}
	return appPackage, nil
}

func (s *SQLiteStore) ListAppPackages(ctx context.Context) ([]workspacebiz.AppPackage, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}

	rows, err := s.db.QueryContext(ctx, `
SELECT p.app_id, p.version, p.package_dir, p.manifest_json, p.source, p.factory_job_id, p.created_in_workspace_id, c.created_at_unix_ms
FROM app_catalog_entries c
JOIN app_packages p ON p.app_id = c.app_id AND p.version = c.active_version
ORDER BY p.app_id ASC
`)
	if err != nil {
		return nil, fmt.Errorf("list workspace app packages: %w", err)
	}
	defer rows.Close()

	var result []workspacebiz.AppPackage
	var invalidActivePackages []invalidAppPackageScan
	for rows.Next() {
		appPackage, err := scanAppPackage(rows)
		if err != nil {
			if strings.TrimSpace(appPackage.AppID) == "" || strings.TrimSpace(appPackage.Version) == "" {
				return nil, fmt.Errorf("scan workspace app package: %w", err)
			}
			invalidActivePackages = append(invalidActivePackages, invalidAppPackageScan{
				appPackage: appPackage,
				err:        err,
			})
			continue
		}
		result = append(result, appPackage)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace app packages: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close workspace app package rows: %w", err)
	}

	for _, invalidActivePackage := range invalidActivePackages {
		repairedPackage, repaired := s.repairInvalidActiveAppPackage(ctx, invalidActivePackage.appPackage, invalidActivePackage.err)
		if repaired {
			result = append(result, repairedPackage)
			continue
		}
		appPackage := invalidActivePackage.appPackage
		err := invalidActivePackage.err
		slog.Warn(
			"workspace app package skipped during list",
			"appId", appPackage.AppID,
			"version", appPackage.Version,
			"packageDir", appPackage.PackageDir,
			"error", err,
		)
	}
	sort.Slice(result, func(left int, right int) bool {
		leftName := strings.ToLower(result[left].DisplayName())
		rightName := strings.ToLower(result[right].DisplayName())
		if leftName == rightName {
			return result[left].AppID < result[right].AppID
		}
		return leftName < rightName
	})

	return result, nil
}

type invalidAppPackageScan struct {
	appPackage workspacebiz.AppPackage
	err        error
}

func (s *SQLiteStore) repairInvalidActiveAppPackage(ctx context.Context, invalidPackage workspacebiz.AppPackage, scanErr error) (workspacebiz.AppPackage, bool) {
	appID := strings.TrimSpace(invalidPackage.AppID)
	activeVersion := strings.TrimSpace(invalidPackage.Version)
	if s == nil || s.db == nil || appID == "" || activeVersion == "" {
		return workspacebiz.AppPackage{}, false
	}

	rows, err := s.db.QueryContext(ctx, `
SELECT app_id, version, package_dir, manifest_json, source, factory_job_id, created_in_workspace_id, created_at_unix_ms
FROM app_packages
WHERE app_id = ? AND version <> ?
ORDER BY updated_at_unix_ms DESC, version DESC
`, appID, activeVersion)
	if err != nil {
		slog.Warn(
			"workspace app package repair lookup failed",
			"appId", appID,
			"version", activeVersion,
			"packageDir", invalidPackage.PackageDir,
			"error", err,
			"scanError", scanErr,
		)
		return workspacebiz.AppPackage{}, false
	}

	var repairPackage workspacebiz.AppPackage
	foundRepairPackage := false
	for rows.Next() {
		candidate, err := scanAppPackage(rows)
		if err != nil {
			slog.Warn(
				"workspace app package repair candidate skipped",
				"appId", appID,
				"version", candidate.Version,
				"packageDir", candidate.PackageDir,
				"error", err,
				"scanError", scanErr,
			)
			continue
		}
		repairPackage = candidate
		foundRepairPackage = true
		break
	}
	if err := rows.Err(); err != nil {
		slog.Warn(
			"workspace app package repair iteration failed",
			"appId", appID,
			"version", activeVersion,
			"packageDir", invalidPackage.PackageDir,
			"error", err,
			"scanError", scanErr,
		)
	}
	if err := rows.Close(); err != nil {
		slog.Warn(
			"workspace app package repair rows close failed",
			"appId", appID,
			"version", activeVersion,
			"packageDir", invalidPackage.PackageDir,
			"error", err,
			"scanError", scanErr,
		)
		return workspacebiz.AppPackage{}, false
	}
	if !foundRepairPackage {
		return workspacebiz.AppPackage{}, false
	}
	if err := s.SetActiveAppPackageVersion(ctx, repairPackage.AppID, repairPackage.Version); err != nil {
		slog.Warn(
			"workspace app package repair activation failed",
			"appId", appID,
			"version", activeVersion,
			"repairVersion", repairPackage.Version,
			"packageDir", invalidPackage.PackageDir,
			"repairPackageDir", repairPackage.PackageDir,
			"error", err,
			"scanError", scanErr,
		)
		return workspacebiz.AppPackage{}, false
	}
	slog.Warn(
		"workspace app package repaired active version during list",
		"appId", appID,
		"version", activeVersion,
		"repairVersion", repairPackage.Version,
		"packageDir", invalidPackage.PackageDir,
		"repairPackageDir", repairPackage.PackageDir,
		"error", scanErr,
	)
	return repairPackage, true
}

func (s *SQLiteStore) ListAppPackageVersions(ctx context.Context, appID string) ([]workspacebiz.AppPackage, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	appID = strings.TrimSpace(appID)
	if appID == "" {
		return nil, errors.New("workspace app id is required")
	}

	rows, err := s.db.QueryContext(ctx, `
SELECT app_id, version, package_dir, manifest_json, source, factory_job_id, created_in_workspace_id, created_at_unix_ms
FROM app_packages
WHERE app_id = ?
ORDER BY updated_at_unix_ms DESC, version DESC
`, appID)
	if err != nil {
		return nil, fmt.Errorf("list workspace app package versions: %w", err)
	}
	defer rows.Close()

	var result []workspacebiz.AppPackage
	for rows.Next() {
		appPackage, err := scanAppPackage(rows)
		if err != nil {
			return nil, fmt.Errorf("scan workspace app package version: %w", err)
		}
		result = append(result, appPackage)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace app package versions: %w", err)
	}
	return result, nil
}

func (s *SQLiteStore) ListAppPackageFileRecords(ctx context.Context, appID string) ([]workspacebiz.AppPackageFileRecord, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	appID = strings.TrimSpace(appID)
	if appID == "" {
		return nil, errors.New("workspace app id is required")
	}

	rows, err := s.db.QueryContext(ctx, `
SELECT app_id, version, package_dir, source
FROM app_packages
WHERE app_id = ?
ORDER BY updated_at_unix_ms DESC, version DESC
`, appID)
	if err != nil {
		return nil, fmt.Errorf("list workspace app package file records: %w", err)
	}
	defer rows.Close()

	var result []workspacebiz.AppPackageFileRecord
	for rows.Next() {
		var record workspacebiz.AppPackageFileRecord
		var source string
		if err := rows.Scan(&record.AppID, &record.Version, &record.PackageDir, &source); err != nil {
			return nil, fmt.Errorf("scan workspace app package file record: %w", err)
		}
		source = strings.TrimSpace(source)
		if source == "" {
			source = string(workspacebiz.AppPackageSourceBuiltin)
		}
		record.Source = workspacebiz.AppPackageSource(source)
		result = append(result, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace app package file records: %w", err)
	}
	return result, nil
}

func (s *SQLiteStore) SetActiveAppPackageVersion(ctx context.Context, appID string, version string) error {
	if s == nil || s.db == nil {
		return errors.New("workspace database is not initialized")
	}
	appID = strings.TrimSpace(appID)
	version = strings.TrimSpace(version)
	if appID == "" || version == "" {
		return errors.New("workspace app id and version are required")
	}

	appPackage, err := s.GetAppPackageVersion(ctx, appID, version)
	if err != nil {
		return err
	}
	now := unixMs(time.Now().UTC())
	result, err := s.db.ExecContext(ctx, `
UPDATE app_catalog_entries
SET active_version = ?, source = ?, created_in_workspace_id = ?, updated_at_unix_ms = ?
WHERE app_id = ?
`, version, string(appPackage.Source), appPackage.CreatedInWorkspaceID, now, appID)
	if err != nil {
		return fmt.Errorf("set active workspace app package version: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("set active workspace app package version rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrWorkspaceAppNotFound
	}
	return nil
}

func (s *SQLiteStore) DeleteAppPackage(ctx context.Context, appID string) error {
	if s == nil || s.db == nil {
		return errors.New("workspace database is not initialized")
	}

	appID = strings.TrimSpace(appID)
	if appID == "" {
		return errors.New("workspace app id is required")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace app package delete: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	result, err := tx.ExecContext(ctx, `
DELETE FROM app_catalog_entries
WHERE app_id = ?
`, appID)
	if err != nil {
		return fmt.Errorf("delete workspace app catalog entry: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete workspace app catalog entry rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrWorkspaceAppNotFound
	}

	if _, err := tx.ExecContext(ctx, `
DELETE FROM app_packages
WHERE app_id = ?
`, appID); err != nil {
		return fmt.Errorf("delete workspace app packages: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace app package delete: %w", err)
	}
	return nil
}

func (s *SQLiteStore) DeleteAppPackageVersion(ctx context.Context, appID string, version string) error {
	if s == nil || s.db == nil {
		return errors.New("workspace database is not initialized")
	}

	appID = strings.TrimSpace(appID)
	version = strings.TrimSpace(version)
	if appID == "" || version == "" {
		return errors.New("workspace app id and version are required")
	}

	result, err := s.db.ExecContext(ctx, `
DELETE FROM app_packages
WHERE app_id = ? AND version = ?
  AND NOT EXISTS (
    SELECT 1
    FROM app_catalog_entries
    WHERE app_catalog_entries.app_id = app_packages.app_id
      AND app_catalog_entries.active_version = app_packages.version
  )
`, appID, version)
	if err != nil {
		return fmt.Errorf("delete workspace app package version: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete workspace app package version rows affected: %w", err)
	}
	if rowsAffected == 0 {
		if _, err := s.GetAppPackageVersion(ctx, appID, version); err == nil {
			return errors.New("active workspace app package version cannot be deleted")
		} else if !errors.Is(err, ErrWorkspaceAppNotFound) {
			return err
		}
		return ErrWorkspaceAppNotFound
	}
	return nil
}

func (s *SQLiteStore) PutWorkspaceAppInstallation(ctx context.Context, installation workspacebiz.AppInstallation) error {
	if s == nil || s.db == nil {
		return errors.New("workspace database is not initialized")
	}

	workspaceID := strings.TrimSpace(installation.WorkspaceID)
	appID := strings.TrimSpace(installation.AppID)
	if workspaceID == "" || appID == "" {
		return errors.New("workspace id and app id are required")
	}

	now := unixMs(time.Now().UTC())
	_, err := s.db.ExecContext(ctx, `
INSERT INTO workspace_app_installations (
  workspace_id, app_id, enabled, created_at_unix_ms, updated_at_unix_ms
)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, app_id) DO UPDATE SET
  enabled = excluded.enabled,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, workspaceID, appID, boolToSQLiteInt(installation.Enabled), now, now)
	if err != nil {
		return fmt.Errorf("put workspace app installation: %w", err)
	}

	return nil
}

func (s *SQLiteStore) DeleteWorkspaceAppInstallation(ctx context.Context, workspaceID string, appID string) error {
	if s == nil || s.db == nil {
		return errors.New("workspace database is not initialized")
	}

	workspaceID = strings.TrimSpace(workspaceID)
	appID = strings.TrimSpace(appID)
	if workspaceID == "" || appID == "" {
		return errors.New("workspace id and app id are required")
	}

	result, err := s.db.ExecContext(ctx, `
DELETE FROM workspace_app_installations
WHERE workspace_id = ? AND app_id = ?
`, workspaceID, appID)
	if err != nil {
		return fmt.Errorf("delete workspace app installation: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete workspace app installation rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrWorkspaceAppNotFound
	}

	return nil
}

func (s *SQLiteStore) ListWorkspaceAppInstallations(ctx context.Context, workspaceID string) ([]workspacebiz.AppInstallation, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}

	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil, errors.New("workspace id is required")
	}

	rows, err := s.db.QueryContext(ctx, `
SELECT workspace_id, app_id, enabled
FROM workspace_app_installations
WHERE workspace_id = ?
ORDER BY app_id ASC
`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list workspace app installations: %w", err)
	}
	defer rows.Close()

	var result []workspacebiz.AppInstallation
	for rows.Next() {
		var installation workspacebiz.AppInstallation
		var enabled int
		if err := rows.Scan(&installation.WorkspaceID, &installation.AppID, &enabled); err != nil {
			return nil, fmt.Errorf("scan workspace app installation: %w", err)
		}
		installation.Enabled = enabled != 0
		result = append(result, installation)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace app installations: %w", err)
	}

	return result, nil
}

func (s *SQLiteStore) ListWorkspaceAppInstallationsByApp(ctx context.Context, appID string) ([]workspacebiz.AppInstallation, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}

	appID = strings.TrimSpace(appID)
	if appID == "" {
		return nil, errors.New("workspace app id is required")
	}

	rows, err := s.db.QueryContext(ctx, `
SELECT workspace_id, app_id, enabled
FROM workspace_app_installations
WHERE app_id = ?
ORDER BY workspace_id ASC
`, appID)
	if err != nil {
		return nil, fmt.Errorf("list workspace app installations by app: %w", err)
	}
	defer rows.Close()

	var result []workspacebiz.AppInstallation
	for rows.Next() {
		var installation workspacebiz.AppInstallation
		var enabled int
		if err := rows.Scan(&installation.WorkspaceID, &installation.AppID, &enabled); err != nil {
			return nil, fmt.Errorf("scan workspace app installation by app: %w", err)
		}
		installation.Enabled = enabled != 0
		result = append(result, installation)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace app installations by app: %w", err)
	}
	return result, nil
}

type appPackageScanner interface {
	Scan(dest ...any) error
}

func scanAppPackage(scanner appPackageScanner) (workspacebiz.AppPackage, error) {
	var appPackage workspacebiz.AppPackage
	var manifestJSON string
	var source string
	if err := scanner.Scan(
		&appPackage.AppID,
		&appPackage.Version,
		&appPackage.PackageDir,
		&manifestJSON,
		&source,
		&appPackage.FactoryJobID,
		&appPackage.CreatedInWorkspaceID,
		&appPackage.CreatedAtUnixMs,
	); err != nil {
		return workspacebiz.AppPackage{}, err
	}
	manifest, normalizedManifestJSON, err := workspacebiz.ParseAppManifestJSON([]byte(manifestJSON))
	if err != nil {
		return appPackage, err
	}
	appPackage.Manifest = manifest
	appPackage.ManifestJSON = normalizedManifestJSON
	appPackage.Source = workspacebiz.AppPackageSource(strings.TrimSpace(source))
	return appPackage, nil
}

func boolToSQLiteInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
