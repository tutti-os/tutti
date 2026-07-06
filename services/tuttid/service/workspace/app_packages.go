package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

var ErrAppPackageAlreadyExists = errors.New("workspace app package already exists")
var ErrAppPackageDeleteForbidden = errors.New("workspace app package cannot be deleted")
var ErrLocalAppPackageInvalid = errors.New("local workspace app package is invalid")

const retainedInactiveAppPackageVersions = 1

type AppPackageArchiveResult struct {
	AppID              string
	Version            string
	Path               string
	ArtifactSHA256     string
	ArtifactSizeBytes  int64
	ImportedOrExported workspacebiz.AppPackage
}

func (s *AppCenterService) ExportPackage(ctx context.Context, appID string, version string, destinationPath string) (AppPackageArchiveResult, error) {
	appID = strings.TrimSpace(appID)
	version = strings.TrimSpace(version)
	destinationPath = strings.TrimSpace(destinationPath)
	if appID == "" || destinationPath == "" {
		return AppPackageArchiveResult{}, errors.New("workspace app id and destination path are required")
	}

	var appPackage workspacebiz.AppPackage
	var err error
	if version != "" {
		appPackage, err = s.Store.GetAppPackageVersion(ctx, appID, version)
	} else {
		appPackage, err = s.Store.GetAppPackage(ctx, appID)
	}
	if err != nil {
		return AppPackageArchiveResult{}, err
	}
	if appPackage.Source != workspacebiz.AppPackageSourceGenerated && appPackage.Source != workspacebiz.AppPackageSourceImported {
		return AppPackageArchiveResult{}, errors.New("only generated or imported workspace apps can be exported")
	}
	if strings.TrimSpace(appPackage.PackageDir) == "" {
		return AppPackageArchiveResult{}, errors.New("workspace app package directory is missing")
	}
	if err := createAppPackageZip(appPackage.PackageDir, destinationPath); err != nil {
		return AppPackageArchiveResult{}, err
	}
	sha256Value, sizeBytes, err := fileSHA256AndSize(destinationPath)
	if err != nil {
		return AppPackageArchiveResult{}, err
	}
	return AppPackageArchiveResult{
		AppID:              appPackage.AppID,
		Version:            appPackage.Version,
		Path:               destinationPath,
		ArtifactSHA256:     sha256Value,
		ArtifactSizeBytes:  sizeBytes,
		ImportedOrExported: appPackage,
	}, nil
}

func (s *AppCenterService) ImportPackage(ctx context.Context, archivePath string) (workspacebiz.WorkspaceApp, error) {
	archivePath = strings.TrimSpace(archivePath)
	if archivePath == "" {
		return workspacebiz.WorkspaceApp{}, errors.New("workspace app archive path is required")
	}
	stagingParent := filepath.Join(s.stateDir(), "apps")
	if err := os.MkdirAll(stagingParent, 0o755); err != nil {
		return workspacebiz.WorkspaceApp{}, fmt.Errorf("create app import staging parent: %w", err)
	}
	stagingDir, err := os.MkdirTemp(stagingParent, "import-*")
	if err != nil {
		return workspacebiz.WorkspaceApp{}, fmt.Errorf("create app import staging dir: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(stagingDir)
	}()
	if err := extractAppPackageZip(archivePath, stagingDir); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	packageRoot, err := resolveExtractedPackageRoot(stagingDir)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	manifest, manifestJSON, err := workspacebiz.ReadAppManifestFile(filepath.Join(packageRoot, "tutti.app.json"))
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	if err := validateExtractedAppPackage(packageRoot, manifest); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	if _, err := s.Store.GetAppPackageVersion(ctx, manifest.AppID, manifest.Version); err == nil {
		return workspacebiz.WorkspaceApp{}, fmt.Errorf("%w: app %q version %q", ErrAppPackageAlreadyExists, manifest.AppID, manifest.Version)
	} else if !errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
		return workspacebiz.WorkspaceApp{}, err
	}
	packageDir := s.packageCacheDir(manifest.AppID, manifest.Version)
	if err := os.RemoveAll(packageDir); err != nil {
		return workspacebiz.WorkspaceApp{}, fmt.Errorf("replace imported app package dir: %w", err)
	}
	if err := copyDirectory(packageRoot, packageDir); err != nil {
		return workspacebiz.WorkspaceApp{}, fmt.Errorf("copy imported app package: %w", err)
	}
	appPackage := workspacebiz.AppPackage{
		AppID:        manifest.AppID,
		Version:      manifest.Version,
		PackageDir:   packageDir,
		Manifest:     manifest,
		ManifestJSON: manifestJSON,
		Source:       workspacebiz.AppPackageSourceImported,
	}
	if err := s.Store.PutAppPackage(ctx, appPackage); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	return workspacebiz.WorkspaceApp{
		Package: appPackage,
		Runtime: workspacebiz.AppRuntimeState{
			Status: workspacebiz.AppRuntimeStatusIdle,
		},
	}, nil
}

func (s *AppCenterService) DeletePackage(ctx context.Context, workspaceID string, appID string) error {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return err
	}

	appPackage, err := s.Store.GetAppPackage(ctx, appID)
	if err != nil {
		return err
	}
	if appPackage.Source != workspacebiz.AppPackageSourceGenerated && appPackage.Source != workspacebiz.AppPackageSourceImported && appPackage.Source != workspacebiz.AppPackageSourceLocalDev {
		return fmt.Errorf("%w: app %q has source %q", ErrAppPackageDeleteForbidden, appPackage.AppID, appPackage.Source)
	}

	versions, err := s.Store.ListAppPackageVersions(ctx, appPackage.AppID)
	if err != nil {
		return err
	}
	if appPackage.Source == workspacebiz.AppPackageSourceLocalDev {
		return s.deleteLocalDevPackage(ctx, workspaceID, appPackage, versions)
	}
	packageDirs := make(map[string]struct{}, len(versions)+1)
	if dir := strings.TrimSpace(appPackage.PackageDir); dir != "" && appPackage.Source != workspacebiz.AppPackageSourceLocalDev {
		packageDirs[dir] = struct{}{}
	}
	for _, versionPackage := range versions {
		if versionPackage.Source != workspacebiz.AppPackageSourceGenerated && versionPackage.Source != workspacebiz.AppPackageSourceImported && versionPackage.Source != workspacebiz.AppPackageSourceLocalDev {
			return fmt.Errorf("%w: app %q version %q has source %q", ErrAppPackageDeleteForbidden, versionPackage.AppID, versionPackage.Version, versionPackage.Source)
		}
		if dir := strings.TrimSpace(versionPackage.PackageDir); dir != "" && versionPackage.Source != workspacebiz.AppPackageSourceLocalDev {
			packageDirs[dir] = struct{}{}
		}
	}

	s.runner().StopApp(ctx, appPackage.AppID)
	s.deactivateAppCLIForApp(appPackage.AppID)
	if err := s.removeAllWorkspaceAppStateRoots(appPackage.AppID); err != nil {
		return err
	}
	if err := s.removeFactoryJobFilesForPackage(ctx, workspaceID, appPackage); err != nil {
		return err
	}
	for packageDir := range packageDirs {
		if err := os.RemoveAll(packageDir); err != nil {
			return fmt.Errorf("delete workspace app package dir: %w", err)
		}
		if err := s.pruneEmptyPackageCacheParents(packageDir); err != nil {
			return err
		}
	}
	return s.Store.DeleteAppPackage(ctx, appPackage.AppID)
}

func (s *AppCenterService) deleteLocalDevPackage(ctx context.Context, workspaceID string, appPackage workspacebiz.AppPackage, versions []workspacebiz.AppPackage) error {
	restorePackage, restore := localDevRestorePackage(versions, appPackage.Version)

	s.runner().StopApp(ctx, appPackage.AppID)
	s.deactivateAppCLIForApp(appPackage.AppID)
	if err := s.removeAllWorkspaceAppStateRoots(appPackage.AppID); err != nil {
		return err
	}

	if restore {
		if err := s.Store.DeleteWorkspaceAppInstallation(ctx, workspaceID, appPackage.AppID); err != nil && !errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
			return err
		}
		if err := s.Store.SetActiveAppPackageVersion(ctx, restorePackage.AppID, restorePackage.Version); err != nil {
			return err
		}
		return s.Store.DeleteAppPackageVersion(ctx, appPackage.AppID, appPackage.Version)
	}

	return s.Store.DeleteAppPackage(ctx, appPackage.AppID)
}

func localDevRestorePackage(versions []workspacebiz.AppPackage, activeVersion string) (workspacebiz.AppPackage, bool) {
	activeVersion = strings.TrimSpace(activeVersion)
	for _, versionPackage := range versions {
		if versionPackage.Source != workspacebiz.AppPackageSourceBuiltin {
			continue
		}
		if strings.TrimSpace(versionPackage.Version) == activeVersion {
			continue
		}
		return versionPackage, true
	}
	return workspacebiz.AppPackage{}, false
}

func (s *AppCenterService) shouldDeleteRemoteBuiltinPackageAfterUninstall(ctx context.Context, workspaceID string, appPackage workspacebiz.AppPackage) (bool, error) {
	if appPackage.Source != workspacebiz.AppPackageSourceBuiltin {
		return false, nil
	}
	_, ok, err := s.remoteBuiltinForAppID(ctx, appPackage.AppID)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, nil
	}

	installations, err := s.Store.ListWorkspaceAppInstallationsByApp(ctx, appPackage.AppID)
	if err != nil {
		return false, err
	}
	if len(installations) != 1 {
		return false, nil
	}
	installation := installations[0]
	return installation.WorkspaceID == workspaceID && installation.AppID == appPackage.AppID, nil
}

func (s *AppCenterService) deleteRemoteBuiltinPackageFilesAndRecord(ctx context.Context, appPackage workspacebiz.AppPackage) error {
	records, err := s.Store.ListAppPackageFileRecords(ctx, appPackage.AppID)
	if err != nil {
		return err
	}
	packageDirs := make(map[string]struct{}, len(records)+1)
	if dir := strings.TrimSpace(appPackage.PackageDir); dir != "" {
		packageDirs[dir] = struct{}{}
	}
	for _, record := range records {
		if record.Source == workspacebiz.AppPackageSourceLocalDev {
			continue
		}
		if dir := strings.TrimSpace(record.PackageDir); dir != "" {
			packageDirs[dir] = struct{}{}
		}
	}
	for packageDir := range packageDirs {
		if err := os.RemoveAll(packageDir); err != nil {
			return fmt.Errorf("delete remote builtin workspace app package dir: %w", err)
		}
		if err := s.pruneEmptyPackageCacheParents(packageDir); err != nil {
			return err
		}
	}
	return s.Store.DeleteAppPackage(ctx, appPackage.AppID)
}

func (s *AppCenterService) pruneInactiveAppPackageVersions(ctx context.Context, activePackage workspacebiz.AppPackage) error {
	versions, err := s.Store.ListAppPackageVersions(ctx, activePackage.AppID)
	if err != nil {
		return err
	}
	inactive := make([]workspacebiz.AppPackage, 0, len(versions))
	for _, versionPackage := range versions {
		if versionPackage.Version == activePackage.Version {
			continue
		}
		inactive = append(inactive, versionPackage)
	}
	sort.SliceStable(inactive, func(i int, j int) bool {
		left := inactive[i]
		right := inactive[j]
		if left.CreatedAtUnixMs != right.CreatedAtUnixMs {
			return left.CreatedAtUnixMs > right.CreatedAtUnixMs
		}
		return left.Version > right.Version
	})
	for index, versionPackage := range inactive {
		if index < retainedInactiveAppPackageVersions {
			continue
		}
		if err := s.Store.DeleteAppPackageVersion(ctx, versionPackage.AppID, versionPackage.Version); err != nil {
			return err
		}
		if dir := strings.TrimSpace(versionPackage.PackageDir); dir != "" && versionPackage.Source != workspacebiz.AppPackageSourceLocalDev {
			if err := os.RemoveAll(dir); err != nil {
				return fmt.Errorf("delete inactive workspace app package dir: %w", err)
			}
			if err := s.pruneEmptyPackageCacheParents(dir); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *AppCenterService) removeFactoryJobFilesForPackage(ctx context.Context, workspaceID string, appPackage workspacebiz.AppPackage) error {
	if s.AppFactoryStore == nil || strings.TrimSpace(appPackage.FactoryJobID) == "" {
		return nil
	}
	jobWorkspaceID := strings.TrimSpace(appPackage.CreatedInWorkspaceID)
	if jobWorkspaceID == "" {
		jobWorkspaceID = strings.TrimSpace(workspaceID)
	}
	job, err := s.AppFactoryStore.GetAppFactoryJob(ctx, jobWorkspaceID, appPackage.FactoryJobID)
	if err != nil {
		if errors.Is(err, workspacedata.ErrWorkspaceAppFactoryJobNotFound) {
			return nil
		}
		return err
	}
	jobRoot := appFactoryJobRoot(s.stateDir(), job)
	if jobRoot == "" {
		return nil
	}
	if err := os.RemoveAll(jobRoot); err != nil {
		return fmt.Errorf("remove app factory job files: %w", err)
	}
	return nil
}

func (s *AppCenterService) pruneEmptyPackageCacheParents(packageDir string) error {
	packageDir = strings.TrimSpace(packageDir)
	if packageDir == "" {
		return nil
	}

	root := filepath.Clean(s.packageCacheRoot())
	current := filepath.Dir(filepath.Clean(packageDir))
	rel, err := filepath.Rel(root, current)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return nil
	}

	for current != root {
		entries, err := os.ReadDir(current)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				current = filepath.Dir(current)
				continue
			}
			return fmt.Errorf("inspect workspace app package parent dir: %w", err)
		}
		if len(entries) > 0 {
			return nil
		}
		if err := os.Remove(current); err != nil && !errors.Is(err, os.ErrNotExist) {
			entries, readErr := os.ReadDir(current)
			if readErr == nil && len(entries) > 0 {
				return nil
			}
			return fmt.Errorf("remove empty workspace app package parent dir: %w", err)
		}
		current = filepath.Dir(current)
	}

	return nil
}
