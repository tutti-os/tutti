package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

const localDevAppPackageSubdir = ".tutti/dev-app"

func (s *AppCenterService) LoadLocalPackage(ctx context.Context, workspaceID string, sourceDir string, options InstallOptions) (workspacebiz.WorkspaceApp, error) {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}

	packageDir, err := resolveLocalAppPackageDir(sourceDir)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	appPackage, err := readLocalAppPackage(packageDir)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	if err := s.putLocalDevPackage(ctx, workspaceID, appPackage); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	return s.installPackage(ctx, workspaceID, appPackage, options)
}

func (s *AppCenterService) ReloadLocalPackage(ctx context.Context, workspaceID string, appID string, options InstallOptions) (workspacebiz.WorkspaceApp, error) {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}

	appID = strings.TrimSpace(appID)
	if appID == "" {
		return workspacebiz.WorkspaceApp{}, errors.New("workspace app id is required")
	}
	existing, err := s.Store.GetAppPackage(ctx, appID)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	if existing.Source != workspacebiz.AppPackageSourceLocalDev {
		return workspacebiz.WorkspaceApp{}, fmt.Errorf("%w: app %q has source %q", ErrLocalAppPackageInvalid, appID, existing.Source)
	}
	appPackage, err := readLocalAppPackage(existing.PackageDir)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	if appPackage.AppID != appID {
		return workspacebiz.WorkspaceApp{}, fmt.Errorf("%w: app id changed from %q to %q", ErrLocalAppPackageInvalid, appID, appPackage.AppID)
	}
	if err := s.putLocalDevPackage(ctx, workspaceID, appPackage); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	installation, installed, err := s.workspaceAppInstallation(ctx, workspaceID, appPackage.AppID)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	if !installed {
		app := s.workspaceAppFromPackage(appPackage, workspacebiz.AppInstallation{}, false, workspaceID)
		return s.publishAppIfChanged(ctx, workspaceID, appPackage.AppID, app), nil
	}

	runtimeState, err := s.startPackage(ctx, workspaceID, appPackage, options.RestartRunning)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	app := workspacebiz.WorkspaceApp{
		Package:      appPackage,
		Installation: &installation,
		Runtime:      runtimeState,
	}
	app.CLI = s.appCLIState(workspaceID, app)
	return s.publishAppIfChanged(ctx, workspaceID, appPackage.AppID, app), nil
}

func (s *AppCenterService) putLocalDevPackage(ctx context.Context, workspaceID string, appPackage workspacebiz.AppPackage) error {
	existing, err := s.Store.GetAppPackage(ctx, appPackage.AppID)
	if err == nil && existing.Source != workspacebiz.AppPackageSourceLocalDev {
		return fmt.Errorf("%w: app %q already exists with source %q", ErrAppPackageAlreadyExists, appPackage.AppID, existing.Source)
	}
	if err != nil && !errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
		return err
	}
	if _, ok, err := s.remoteBuiltinForAppID(ctx, appPackage.AppID); err != nil {
		return err
	} else if ok {
		return fmt.Errorf("%w: app %q already exists with source %q", ErrAppPackageAlreadyExists, appPackage.AppID, workspacebiz.AppPackageSourceBuiltin)
	}
	appPackage.Source = workspacebiz.AppPackageSourceLocalDev
	appPackage.CreatedInWorkspaceID = strings.TrimSpace(workspaceID)
	return s.Store.PutAppPackage(ctx, appPackage)
}

func resolveLocalAppPackageDir(sourceDir string) (string, error) {
	sourceDir = strings.TrimSpace(sourceDir)
	if sourceDir == "" {
		return "", fmt.Errorf("%w: sourceDir is required", ErrLocalAppPackageInvalid)
	}
	absDir, err := filepath.Abs(sourceDir)
	if err != nil {
		return "", fmt.Errorf("%w: resolve sourceDir: %w", ErrLocalAppPackageInvalid, err)
	}
	absDir = filepath.Clean(absDir)
	info, err := os.Stat(absDir)
	if err != nil {
		return "", fmt.Errorf("%w: stat sourceDir: %w", ErrLocalAppPackageInvalid, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%w: sourceDir must be a directory", ErrLocalAppPackageInvalid)
	}
	if exists, err := appManifestFileExists(absDir); err != nil {
		if !os.IsNotExist(err) {
			return "", fmt.Errorf("%w: check sourceDir manifest: %w", ErrLocalAppPackageInvalid, err)
		}
	} else if exists {
		return absDir, nil
	}

	devAppDir := filepath.Join(absDir, filepath.FromSlash(localDevAppPackageSubdir))
	if exists, err := appManifestFileExists(devAppDir); err != nil {
		if !os.IsNotExist(err) {
			return "", fmt.Errorf("%w: check dev app manifest: %w", ErrLocalAppPackageInvalid, err)
		}
	} else if exists {
		return devAppDir, nil
	}

	return "", fmt.Errorf("%w: sourceDir must contain tutti.app.json or %s/tutti.app.json", ErrLocalAppPackageInvalid, localDevAppPackageSubdir)
}

func readLocalAppPackage(packageDir string) (workspacebiz.AppPackage, error) {
	packageDir = strings.TrimSpace(packageDir)
	if packageDir == "" {
		return workspacebiz.AppPackage{}, fmt.Errorf("%w: package directory is required", ErrLocalAppPackageInvalid)
	}
	manifest, manifestJSON, err := workspacebiz.ReadAppManifestFile(filepath.Join(packageDir, "tutti.app.json"))
	if err != nil {
		return workspacebiz.AppPackage{}, fmt.Errorf("%w: %w", ErrLocalAppPackageInvalid, err)
	}
	if err := validateLocalAppPackage(packageDir, manifest); err != nil {
		return workspacebiz.AppPackage{}, err
	}
	return workspacebiz.AppPackage{
		AppID:        manifest.AppID,
		Version:      manifest.Version,
		PackageDir:   filepath.Clean(packageDir),
		Manifest:     manifest,
		ManifestJSON: manifestJSON,
		Source:       workspacebiz.AppPackageSourceLocalDev,
	}, nil
}

func validateLocalAppPackage(packageDir string, manifest workspacebiz.AppManifest) error {
	bootstrapPath := filepath.Join(packageDir, filepath.FromSlash(strings.TrimSpace(manifest.Runtime.Bootstrap)))
	info, err := os.Stat(bootstrapPath)
	if err != nil {
		return fmt.Errorf("%w: bootstrap %q is required: %w", ErrLocalAppPackageInvalid, manifest.Runtime.Bootstrap, err)
	}
	if info.IsDir() {
		return fmt.Errorf("%w: bootstrap %q must be a file", ErrLocalAppPackageInvalid, manifest.Runtime.Bootstrap)
	}
	if info.Mode()&0o111 == 0 {
		return fmt.Errorf("%w: bootstrap %q must be executable", ErrLocalAppPackageInvalid, manifest.Runtime.Bootstrap)
	}
	return nil
}
