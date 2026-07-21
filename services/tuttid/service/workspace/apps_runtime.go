package workspace

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	builtinapps "github.com/tutti-os/tutti/services/tuttid/builtin-apps"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

var ErrInvalidWorkspaceAppRuntimeState = errors.New("invalid workspace app runtime state")

func (s *AppCenterService) Launch(ctx context.Context, workspaceID string, appID string) (workspacebiz.WorkspaceApp, error) {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}

	appPackage, installation, err := s.installedPackage(ctx, workspaceID, appID)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}

	runtimeState := s.runner().State(workspaceID, appPackage.AppID)
	switch runtimeState.Status {
	case workspacebiz.AppRuntimeStatusIdle:
		runtimeState, err = s.startPackage(ctx, workspaceID, appPackage, false)
		if err != nil {
			return workspacebiz.WorkspaceApp{}, err
		}
	case workspacebiz.AppRuntimeStatusPreparing, workspacebiz.AppRuntimeStatusStarting, workspacebiz.AppRuntimeStatusRunning:
	case workspacebiz.AppRuntimeStatusFailed:
		return workspacebiz.WorkspaceApp{}, fmt.Errorf("%w: failed workspace apps must be retried before launch", ErrInvalidWorkspaceAppRuntimeState)
	case workspacebiz.AppRuntimeStatusStopping:
		return workspacebiz.WorkspaceApp{}, fmt.Errorf("%w: workspace app is stopping", ErrInvalidWorkspaceAppRuntimeState)
	default:
		return workspacebiz.WorkspaceApp{}, fmt.Errorf("%w: unsupported status %q", ErrInvalidWorkspaceAppRuntimeState, runtimeState.Status)
	}

	return s.publishInstalledAppRuntime(ctx, workspaceID, appPackage, installation, runtimeState), nil
}

func (s *AppCenterService) Retry(ctx context.Context, workspaceID string, appID string) (workspacebiz.WorkspaceApp, error) {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}

	appPackage, installation, err := s.installedPackage(ctx, workspaceID, appID)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	if runtimeState := s.runner().State(workspaceID, appPackage.AppID); runtimeState.Status != workspacebiz.AppRuntimeStatusFailed {
		return workspacebiz.WorkspaceApp{}, fmt.Errorf("%w: workspace app retry requires failed runtime status", ErrInvalidWorkspaceAppRuntimeState)
	}
	runtimeState, err := s.startPackage(ctx, workspaceID, appPackage, true)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}

	return s.publishInstalledAppRuntime(ctx, workspaceID, appPackage, installation, runtimeState), nil
}

func (s *AppCenterService) StartEnabled(ctx context.Context, workspaceID string) ([]workspacebiz.WorkspaceApp, error) {
	startedAt := time.Now()
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return nil, err
	}
	installations, err := s.Store.ListWorkspaceAppInstallations(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	enabledAppIDs := make(map[string]struct{}, len(installations))
	for _, installation := range installations {
		if installation.Enabled {
			enabledAppIDs[installation.AppID] = struct{}{}
		}
	}
	var builtins []builtinapps.App
	slog.Info("workspace app start enabled started", "workspaceId", workspaceID, "enabledAppCount", len(enabledAppIDs))
	if len(enabledAppIDs) > 0 {
		refreshStartedAt := time.Now()
		var err error
		builtins, err = s.refreshBuiltinCatalogForStartEnabled(ctx, workspaceID)
		if err != nil {
			slog.Warn(
				"workspace app start enabled remote catalog refresh failed; continuing with cached builtin catalog",
				"workspaceId", workspaceID,
				"error", err,
			)
			builtins, err = s.builtinCatalog(ctx)
			if err != nil {
				return nil, err
			}
		}
		slog.Info("workspace app start enabled remote catalog refresh completed", "workspaceId", workspaceID, "enabledAppCount", len(enabledAppIDs), "durationMs", time.Since(refreshStartedAt).Milliseconds())
	} else {
		slog.Info("workspace app start enabled remote catalog refresh skipped", "workspaceId", workspaceID, "enabledAppCount", len(enabledAppIDs), "reason", "no-enabled-apps")
	}
	remoteBuiltins := remoteBuiltinByAppID(builtins)

	for _, installation := range installations {
		if !installation.Enabled {
			continue
		}
		appPackage, err := s.Store.GetAppPackage(ctx, installation.AppID)
		if err != nil {
			if !errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
				return nil, err
			}
			remoteBuiltin, ok := remoteBuiltins[installation.AppID]
			if !ok {
				return nil, err
			}
			s.startRemoteBuiltinInstallJob(workspaceID, remoteBuiltin)
			slog.Warn("workspace app start enabled deferred app; package unavailable locally", "workspaceId", workspaceID, "appId", installation.AppID)
			continue
		}
		if remoteBuiltin, ok := remoteBuiltins[installation.AppID]; ok && shouldMaterializeRemoteBuiltin(appPackage, remoteBuiltin) {
			s.startRemoteBuiltinInstallJob(workspaceID, remoteBuiltin)
			slog.Info(
				"workspace app start enabled deferred app; remote builtin update available",
				"workspaceId", workspaceID,
				"appId", installation.AppID,
				"currentVersion", appPackage.Version,
				"availableVersion", remoteBuiltin.Manifest.Version,
			)
			continue
		}
		runtimeState := s.runner().State(workspaceID, appPackage.AppID)
		switch runtimeState.Status {
		case workspacebiz.AppRuntimeStatusIdle:
		case workspacebiz.AppRuntimeStatusPreparing, workspacebiz.AppRuntimeStatusStarting, workspacebiz.AppRuntimeStatusRunning:
			continue
		case workspacebiz.AppRuntimeStatusFailed, workspacebiz.AppRuntimeStatusStopping:
			slog.Info(
				"workspace app start enabled skipped app in non-launchable runtime state",
				"workspaceId", workspaceID,
				"appId", appPackage.AppID,
				"runtimeStatus", runtimeState.Status,
			)
			continue
		default:
			slog.Warn(
				"workspace app start enabled skipped app in unknown runtime state",
				"workspaceId", workspaceID,
				"appId", appPackage.AppID,
				"runtimeStatus", runtimeState.Status,
			)
			continue
		}
		if _, err := s.startPackage(ctx, workspaceID, appPackage, false); err != nil {
			return nil, err
		}
	}
	slog.Info("workspace app start enabled completed", "workspaceId", workspaceID, "enabledAppCount", len(enabledAppIDs), "duration", time.Since(startedAt), "durationMs", time.Since(startedAt).Milliseconds())

	if len(enabledAppIDs) > 0 {
		return s.listWithBuiltins(ctx, workspaceID, builtins)
	}
	return s.List(ctx, workspaceID)
}

func (s *AppCenterService) refreshBuiltinCatalogForStartEnabled(ctx context.Context, workspaceID string) ([]builtinapps.App, error) {
	if s.BuiltinCatalog != nil {
		return s.BuiltinCatalog()
	}
	snapshot, err := s.refreshBuiltinCatalogAndWait(ctx)
	if err != nil {
		return nil, err
	}
	if snapshot.RemoteCatalog.Status == builtinapps.RemoteCatalogLoadStatusFailed {
		slog.Warn(
			"workspace app start enabled remote catalog refresh failed",
			"workspaceId", workspaceID,
			"error", snapshot.RemoteCatalog.LastError,
		)
	}
	return snapshot.Apps, nil
}

func (s *AppCenterService) StopAll(ctx context.Context, workspaceID string) ([]workspacebiz.WorkspaceApp, error) {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return nil, err
	}

	s.deactivateWorkspaceAppCLI(ctx, workspaceID)
	s.runner().StopWorkspace(ctx, workspaceID)
	return s.List(ctx, workspaceID)
}

func (s *AppCenterService) publishInstalledAppRuntime(ctx context.Context, workspaceID string, appPackage workspacebiz.AppPackage, installation workspacebiz.AppInstallation, runtimeState workspacebiz.AppRuntimeState) workspacebiz.WorkspaceApp {
	app := workspacebiz.WorkspaceApp{
		Package:      appPackage,
		Installation: &installation,
		Runtime:      runtimeStateForActivePackage(runtimeState, appPackage),
	}
	app.CLI = s.appCLIState(workspaceID, app)
	return s.publishAppIfChanged(ctx, workspaceID, appPackage.AppID, app)
}

func (s *AppCenterService) startRemoteBuiltinInstallJob(workspaceID string, builtin builtinapps.App) bool {
	appID := strings.TrimSpace(builtin.Manifest.AppID)
	return s.startInstallJob(workspaceID, appID, InstallOptions{}, appRuntimeProfileForManifest(builtin.Manifest), func(ctx context.Context) (workspacebiz.AppPackage, error) {
		return s.packageForRemoteBuiltinInstall(ctx, builtin)
	})
}

func (s *AppCenterService) packageForRemoteBuiltinInstall(ctx context.Context, builtin builtinapps.App) (workspacebiz.AppPackage, error) {
	appID := strings.TrimSpace(builtin.Manifest.AppID)
	version := strings.TrimSpace(builtin.Manifest.Version)
	if appID == "" || version == "" {
		return workspacebiz.AppPackage{}, errors.New("remote builtin app id and version are required")
	}
	existing, err := s.Store.GetAppPackageVersion(ctx, appID, version)
	if err == nil && existing.Source == workspacebiz.AppPackageSourceBuiltin {
		if shouldMaterializeRemoteBuiltin(existing, builtin) {
			return s.downloadRemoteBuiltinPackage(ctx, builtin)
		}
		return existing, nil
	}
	if err != nil && !errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
		return workspacebiz.AppPackage{}, err
	}
	return s.downloadRemoteBuiltinPackage(ctx, builtin)
}

func remoteBuiltinByAppID(builtins []builtinapps.App) map[string]builtinapps.App {
	apps := make(map[string]builtinapps.App, len(builtins))
	for _, builtin := range builtins {
		if builtin.Distribution.Kind != builtinapps.DistributionRemote {
			continue
		}
		appID := strings.TrimSpace(builtin.Manifest.AppID)
		if appID == "" {
			continue
		}
		apps[appID] = builtin
	}
	return apps
}

func (s *AppCenterService) installedPackage(ctx context.Context, workspaceID string, appID string) (workspacebiz.AppPackage, workspacebiz.AppInstallation, error) {
	appPackage, err := s.Store.GetAppPackage(ctx, appID)
	if err != nil {
		return workspacebiz.AppPackage{}, workspacebiz.AppInstallation{}, err
	}

	installations, err := s.Store.ListWorkspaceAppInstallations(ctx, workspaceID)
	if err != nil {
		return workspacebiz.AppPackage{}, workspacebiz.AppInstallation{}, err
	}
	for _, installation := range installations {
		if installation.AppID == appPackage.AppID {
			return appPackage, installation, nil
		}
	}
	return workspacebiz.AppPackage{}, workspacebiz.AppInstallation{}, workspacedata.ErrWorkspaceAppNotFound
}

func (s *AppCenterService) startPackage(ctx context.Context, workspaceID string, appPackage workspacebiz.AppPackage, restart bool) (workspacebiz.AppRuntimeState, error) {
	workspace, err := s.workspaceSummary(ctx, workspaceID)
	if err != nil {
		return workspacebiz.AppRuntimeState{}, err
	}
	root := s.workspaceAppStateRoot(workspaceID, appPackage.AppID)
	return s.runner().Start(ctx, AppStartInput{
		WorkspaceID:     workspaceID,
		WorkspaceName:   workspace.Name,
		AppID:           appPackage.AppID,
		PackageDir:      appPackage.PackageDir,
		Bootstrap:       appPackage.Manifest.Runtime.Bootstrap,
		HealthcheckPath: appPackage.Manifest.Runtime.HealthcheckPath,
		RuntimeProfile:  appRuntimeProfileForPackage(appPackage),
		RuntimeDir:      filepath.Join(root, "runtime"),
		DataDir:         filepath.Join(root, "data"),
		DatabaseDir:     filepath.Join(root, "database"),
		LogDir:          filepath.Join(root, "logs"),
		Restart:         restart,
	})
}
