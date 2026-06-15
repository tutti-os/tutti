package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	builtinapps "github.com/tutti-os/tutti/services/tuttid/builtin-apps"
)

func remoteBuiltinWorkspaceApp(builtin builtinapps.App) (workspacebiz.WorkspaceApp, error) {
	iconURL, err := remoteBuiltinIconURL(builtin)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	manifestJSON, err := normalizedManifestJSON(builtin.Manifest)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, fmt.Errorf("normalize remote builtin app manifest %q: %w", builtin.Manifest.AppID, err)
	}
	appPackage := workspacebiz.AppPackage{
		AppID:        builtin.Manifest.AppID,
		Version:      builtin.Manifest.Version,
		Manifest:     builtin.Manifest,
		ManifestJSON: manifestJSON,
		Source:       workspacebiz.AppPackageSourceBuiltin,
	}
	return workspacebiz.WorkspaceApp{
		Package: appPackage,
		IconURL: iconURL,
		Runtime: workspacebiz.AppRuntimeState{
			Status: workspacebiz.AppRuntimeStatusIdle,
		},
	}, nil
}

func (s *AppCenterService) artifactFetcher() AppArtifactFetcher {
	if s.ArtifactFetcher != nil {
		return s.ArtifactFetcher
	}
	return HTTPAppArtifactFetcher{}
}

func shouldUseRemoteBuiltin(appPackage workspacebiz.AppPackage, builtin builtinapps.App) bool {
	return appPackage.Source == workspacebiz.AppPackageSourceBuiltin &&
		builtin.Distribution.Kind == builtinapps.DistributionRemote &&
		strings.TrimSpace(appPackage.Version) != strings.TrimSpace(builtin.Manifest.Version)
}

func shouldMaterializeRemoteBuiltin(appPackage workspacebiz.AppPackage, builtin builtinapps.App) bool {
	if appPackage.Source != workspacebiz.AppPackageSourceBuiltin || builtin.Distribution.Kind != builtinapps.DistributionRemote {
		return false
	}
	if strings.TrimSpace(appPackage.Version) != strings.TrimSpace(builtin.Manifest.Version) {
		return true
	}
	return validateExtractedAppPackage(appPackage.PackageDir, appPackage.Manifest) != nil
}

func (s *AppCenterService) downloadRemoteBuiltinPackage(ctx context.Context, builtin builtinapps.App) (workspacebiz.AppPackage, error) {
	artifactURL := strings.TrimSpace(builtin.Distribution.ArtifactURL)
	artifactSHA256 := strings.TrimSpace(builtin.Distribution.ArtifactSHA256)
	if artifactURL == "" || artifactSHA256 == "" || strings.TrimSpace(builtin.Distribution.IconURL) == "" {
		return workspacebiz.AppPackage{}, fmt.Errorf("remote builtin app %q artifact url, sha256, and icon url are required", builtin.Manifest.AppID)
	}
	unlock := s.remoteBuiltinInstallLocks.Lock(builtin.Manifest.AppID + "@" + builtin.Manifest.Version)
	defer unlock()

	downloadParent := filepath.Join(s.stateDir(), "apps", "downloads")
	if err := os.MkdirAll(downloadParent, 0o755); err != nil {
		return workspacebiz.AppPackage{}, fmt.Errorf("create app download dir: %w", err)
	}
	archiveFile, err := os.CreateTemp(downloadParent, safeAppPathSegment(builtin.Manifest.AppID)+"-*.zip")
	if err != nil {
		return workspacebiz.AppPackage{}, fmt.Errorf("create app download file: %w", err)
	}
	archivePath := archiveFile.Name()
	if err := archiveFile.Close(); err != nil {
		return workspacebiz.AppPackage{}, fmt.Errorf("close app download file: %w", err)
	}
	defer func() {
		_ = os.Remove(archivePath)
	}()

	downloadStartedAt := time.Now()
	slog.Info(
		"remote builtin app package download started",
		"appId", builtin.Manifest.AppID,
		"version", builtin.Manifest.Version,
		"artifactUrl", artifactURL,
		"archivePath", archivePath,
	)
	if err := s.artifactFetcher().FetchAppArtifact(ctx, artifactURL, archivePath); err != nil {
		slog.Warn(
			"remote builtin app package download failed",
			"appId", builtin.Manifest.AppID,
			"version", builtin.Manifest.Version,
			"artifactUrl", artifactURL,
			"archivePath", archivePath,
			"duration", time.Since(downloadStartedAt),
			"error", err,
		)
		return workspacebiz.AppPackage{}, err
	}
	slog.Info(
		"remote builtin app package download completed",
		"appId", builtin.Manifest.AppID,
		"version", builtin.Manifest.Version,
		"artifactUrl", artifactURL,
		"archivePath", archivePath,
		"duration", time.Since(downloadStartedAt),
	)
	downloadedSHA256, _, err := fileSHA256AndSize(archivePath)
	if err != nil {
		return workspacebiz.AppPackage{}, err
	}
	if !strings.EqualFold(downloadedSHA256, artifactSHA256) {
		return workspacebiz.AppPackage{}, fmt.Errorf("remote builtin app %q artifact sha256 mismatch", builtin.Manifest.AppID)
	}

	stagingParent := filepath.Join(s.stateDir(), "apps")
	stagingDir, err := os.MkdirTemp(stagingParent, "remote-builtin-*")
	if err != nil {
		return workspacebiz.AppPackage{}, fmt.Errorf("create remote builtin staging dir: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(stagingDir)
	}()
	if err := extractAppPackageZip(archivePath, stagingDir); err != nil {
		return workspacebiz.AppPackage{}, err
	}
	packageRoot, err := resolveExtractedPackageRoot(stagingDir)
	if err != nil {
		return workspacebiz.AppPackage{}, err
	}
	manifest, manifestJSON, err := workspacebiz.ReadAppManifestFile(filepath.Join(packageRoot, "tutti.app.json"))
	if err != nil {
		return workspacebiz.AppPackage{}, err
	}
	if err := validateExtractedAppPackage(packageRoot, manifest); err != nil {
		return workspacebiz.AppPackage{}, err
	}
	if manifest.AppID != builtin.Manifest.AppID || manifest.Version != builtin.Manifest.Version {
		return workspacebiz.AppPackage{}, fmt.Errorf("remote builtin app manifest mismatch for %q", builtin.Manifest.AppID)
	}

	packageDir := s.packageCacheDir(manifest.AppID, manifest.Version)
	if err := os.RemoveAll(packageDir); err != nil {
		return workspacebiz.AppPackage{}, fmt.Errorf("replace remote builtin app package dir: %w", err)
	}
	if err := copyDirectory(packageRoot, packageDir); err != nil {
		return workspacebiz.AppPackage{}, fmt.Errorf("copy remote builtin app package: %w", err)
	}
	if err := validateExtractedAppPackage(packageDir, manifest); err != nil {
		return workspacebiz.AppPackage{}, fmt.Errorf("validate copied remote builtin app package: %w", err)
	}
	appPackage := workspacebiz.AppPackage{
		AppID:        manifest.AppID,
		Version:      manifest.Version,
		PackageDir:   packageDir,
		Manifest:     manifest,
		ManifestJSON: manifestJSON,
		Source:       workspacebiz.AppPackageSourceBuiltin,
	}
	if err := s.Store.PutAppPackage(ctx, appPackage); err != nil {
		return workspacebiz.AppPackage{}, err
	}
	return appPackage, nil
}

func (s *AppCenterService) builtinCatalog() ([]builtinapps.App, error) {
	if s.BuiltinCatalog != nil {
		return s.BuiltinCatalog()
	}
	return builtinapps.Catalog()
}

func (s *AppCenterService) CatalogLoadState() workspacebiz.AppCatalogLoadState {
	if s.BuiltinCatalog != nil {
		return workspacebiz.AppCatalogLoadState{
			Status: workspacebiz.AppCatalogLoadStatusReady,
		}
	}
	snapshot, err := builtinapps.Snapshot()
	if err != nil {
		lastError := err.Error()
		updatedAt := time.Now().UnixMilli()
		return workspacebiz.AppCatalogLoadState{
			Status:          workspacebiz.AppCatalogLoadStatusFailed,
			LastError:       &lastError,
			UpdatedAtUnixMs: &updatedAt,
		}
	}
	return appCatalogLoadStateFromBuiltin(snapshot.RemoteCatalog)
}

func appCatalogLoadStateFromBuiltin(state builtinapps.RemoteCatalogLoadState) workspacebiz.AppCatalogLoadState {
	result := workspacebiz.AppCatalogLoadState{
		Status: workspacebiz.AppCatalogLoadStatus(state.Status),
	}
	if result.Status == "" {
		result.Status = workspacebiz.AppCatalogLoadStatusDisabled
	}
	if strings.TrimSpace(state.LastError) != "" {
		lastError := state.LastError
		result.LastError = &lastError
	}
	if state.UpdatedAtUnixMs > 0 {
		updatedAt := state.UpdatedAtUnixMs
		result.UpdatedAtUnixMs = &updatedAt
	}
	return result
}

func remoteBuiltinIconURL(builtin builtinapps.App) (*string, error) {
	iconURL := strings.TrimSpace(builtin.Distribution.IconURL)
	if iconURL == "" {
		return nil, fmt.Errorf("remote builtin app %q icon url is required", builtin.Manifest.AppID)
	}
	return &iconURL, nil
}

func normalizedManifestJSON(manifest workspacebiz.AppManifest) (string, error) {
	data, err := json.Marshal(manifest)
	if err != nil {
		return "", fmt.Errorf("marshal app manifest json: %w", err)
	}
	_, manifestJSON, err := workspacebiz.ParseAppManifestJSON(data)
	if err != nil {
		return "", err
	}
	return manifestJSON, nil
}
