package workspace

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/httpx"
	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	builtinapps "github.com/tutti-os/tutti/services/tuttid/builtin-apps"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	appcliservice "github.com/tutti-os/tutti/services/tuttid/service/cli/appcli"
)

type AppCenterService struct {
	Store                  workspacedata.AppStore
	AppFactoryStore        workspacedata.AppFactoryStore
	WorkspaceRootResolver  WorkspaceRootResolver
	WorkspaceStore         workspacedata.CatalogStore
	PreferencesStore       workspacedata.PreferencesStore
	Runner                 *AppRunner
	AppCLIRegistry         *appcliservice.Registry
	StateDir               string
	Publisher              WorkspaceAppEventPublisher
	BuiltinCatalog         func() ([]builtinapps.App, error)
	ArtifactFetcher        AppArtifactFetcher
	RemoteCatalogRefresher func(context.Context, string) (builtinapps.CatalogSnapshot, error)

	mu                sync.Mutex
	stateRevisions    map[string]int64
	appProjectionKeys map[string]workspaceAppProjectionKey

	installMu             sync.Mutex
	installJobs           map[string]workspaceAppInstallJob
	activeInstallTrackers map[string]*installProgressTracker

	remoteBuiltinInstallLocks keyedOperationLocks

	uploadMu       sync.Mutex
	uploadSessions map[string]*workspaceAppUploadSession

	uploadJanitorOnce     sync.Once
	uploadJanitorStop     chan struct{}
	uploadJanitorInterval time.Duration
}

type workspaceAppInstallJobStatus string

const (
	workspaceAppInstallJobInstalling workspaceAppInstallJobStatus = "installing"
	workspaceAppInstallJobFailed     workspaceAppInstallJobStatus = "failed"
)

type workspaceAppInstallJob struct {
	WorkspaceID    string
	AppID          string
	Status         workspaceAppInstallJobStatus
	FailureReason  string
	RestartRunning bool
	Progress       *workspacebiz.AppInstallProgress
}

type WorkspaceRootResolver interface {
	ResolveWorkspaceRoot(context.Context, string) (workspacefiles.WorkspaceRoot, error)
}

type WorkspaceAppEventPublisher interface {
	PublishWorkspaceAppUpdated(context.Context, string, workspacebiz.WorkspaceApp) error
}

type AppArtifactFetcher interface {
	FetchAppArtifact(context.Context, string, string) error
}

type HTTPAppArtifactFetcher struct {
	Client *http.Client
}

func (f HTTPAppArtifactFetcher) FetchAppArtifact(ctx context.Context, artifactURL string, destinationPath string) error {
	client := f.Client
	if client == nil {
		client = httpx.Default()
	}
	return downloadAppArtifact(ctx, client, artifactURL, destinationPath)
}

func (s *AppCenterService) InitBuiltinPackages(ctx context.Context) error {
	if s.Store == nil {
		return errors.New("workspace app store is not configured")
	}

	builtins, err := s.builtinCatalog(ctx)
	if err != nil {
		return err
	}
	for _, builtin := range builtins {
		switch builtin.Distribution.Kind {
		case builtinapps.DistributionRemote:
			continue
		case builtinapps.DistributionEmbeddedArchive:
			if _, err := s.materializeEmbeddedArchiveBuiltinPackage(ctx, builtin); err != nil {
				return fmt.Errorf("initialize embedded builtin app archive %q: %w", builtin.Manifest.AppID, err)
			}
			continue
		}

		packageDir := s.packageCacheDir(builtin.Manifest.AppID, builtin.Manifest.Version)
		if err := builtinapps.CopyTo(builtin, packageDir); err != nil {
			return fmt.Errorf("initialize builtin app package %q: %w", builtin.Manifest.AppID, err)
		}
		manifest, manifestJSON, err := workspacebiz.ReadAppManifestFile(filepath.Join(packageDir, "tutti.app.json"))
		if err != nil {
			return fmt.Errorf("read initialized builtin app manifest %q: %w", builtin.Manifest.AppID, err)
		}
		if manifest.AppID != builtin.Manifest.AppID || manifest.Version != builtin.Manifest.Version {
			return fmt.Errorf("initialized builtin app manifest mismatch for %q", builtin.Manifest.AppID)
		}
		if err := s.Store.PutAppPackage(ctx, workspacebiz.AppPackage{
			AppID:        manifest.AppID,
			Version:      manifest.Version,
			PackageDir:   packageDir,
			Manifest:     manifest,
			ManifestJSON: manifestJSON,
			Source:       workspacebiz.AppPackageSourceBuiltin,
		}); err != nil {
			return err
		}
	}

	return nil
}

func (s *AppCenterService) List(ctx context.Context, workspaceID string) ([]workspacebiz.WorkspaceApp, error) {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return nil, err
	}

	builtins, err := s.builtinCatalog(ctx)
	if err != nil {
		return nil, err
	}
	return s.listWithBuiltins(ctx, workspaceID, builtins)
}

func (s *AppCenterService) listWithBuiltins(ctx context.Context, workspaceID string, builtins []builtinapps.App) ([]workspacebiz.WorkspaceApp, error) {
	packages, err := s.Store.ListAppPackages(ctx)
	if err != nil {
		return nil, err
	}
	installations, err := s.Store.ListWorkspaceAppInstallations(ctx, workspaceID)
	if err != nil {
		return nil, err
	}

	installationsByAppID := make(map[string]workspacebiz.AppInstallation, len(installations))
	for _, installation := range installations {
		installationsByAppID[installation.AppID] = installation
	}
	packages = s.visibleAppPackagesForCatalog(packages, builtins, installationsByAppID)

	apps, err := s.resolveWorkspaceAppCatalog(packages, builtins, installationsByAppID, workspaceID)
	if err != nil {
		return nil, err
	}
	apps = s.withInstallJobProjections(apps, workspaceID)
	return apps, nil
}

func (s *AppCenterService) RefreshCatalog(ctx context.Context, workspaceID string) ([]workspacebiz.WorkspaceApp, error) {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return nil, err
	}
	if s.BuiltinCatalog == nil {
		if _, err := s.refreshBuiltinCatalogAndWait(ctx); err != nil {
			return nil, err
		}
	}
	return s.List(ctx, workspaceID)
}

func (s *AppCenterService) Install(ctx context.Context, workspaceID string, appID string) (workspacebiz.WorkspaceApp, error) {
	return s.InstallWithOptions(ctx, workspaceID, appID, InstallOptions{})
}

type InstallOptions struct {
	RestartRunning bool
}

type appInstallPackageResolver func(context.Context) (workspacebiz.AppPackage, error)

func (s *AppCenterService) InstallWithOptions(ctx context.Context, workspaceID string, appID string, options InstallOptions) (workspacebiz.WorkspaceApp, error) {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}

	app, err := s.workspaceAppProjectionForInstall(ctx, workspaceID, appID)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	runtimeProfileHint := s.installRuntimeProfileHint(ctx, appID, app)
	s.startInstallJob(workspaceID, appID, options, runtimeProfileHint, func(ctx context.Context) (workspacebiz.AppPackage, error) {
		return s.packageForInstall(ctx, appID)
	})
	return app, nil
}

func (s *AppCenterService) startInstallJob(workspaceID string, appID string, options InstallOptions, runtimeProfileHint string, resolvePackage appInstallPackageResolver) bool {
	if !s.beginInstallJob(workspaceID, appID, options) {
		return false
	}
	go s.runInstallJob(workspaceID, appID, runtimeProfileHint, resolvePackage)
	return true
}

func (s *AppCenterService) installRuntimeProfileHint(ctx context.Context, appID string, app workspacebiz.WorkspaceApp) string {
	remoteBuiltin, ok, err := s.remoteBuiltinForAppID(ctx, appID)
	if err == nil && ok && shouldUseRemoteBuiltin(app.Package, remoteBuiltin) {
		return appRuntimeProfileForManifest(remoteBuiltin.Manifest)
	}
	return appRuntimeProfileForPackage(app.Package)
}

func (s *AppCenterService) installPackage(ctx context.Context, workspaceID string, appPackage workspacebiz.AppPackage, options InstallOptions) (workspacebiz.WorkspaceApp, error) {
	installation := workspacebiz.AppInstallation{
		WorkspaceID: workspaceID,
		AppID:       appPackage.AppID,
		Enabled:     true,
	}
	if err := s.Store.PutWorkspaceAppInstallation(ctx, installation); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	runtimeState, err := s.startPackage(ctx, workspaceID, appPackage, options.RestartRunning)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	if err := s.Store.SetActiveAppPackageVersion(ctx, appPackage.AppID, appPackage.Version); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	runtimeState = runtimeStateForActivePackage(runtimeState, appPackage)
	if err := s.pruneInactiveAppPackageVersions(ctx, appPackage); err != nil {
		slog.Warn(
			"workspace app inactive package version prune failed",
			"workspaceId", workspaceID,
			"appId", appPackage.AppID,
			"activeVersion", appPackage.Version,
			"error", err,
		)
	}

	app := workspacebiz.WorkspaceApp{
		Package:      appPackage,
		Installation: &installation,
		Runtime:      runtimeState,
	}
	app.CLI = s.appCLIState(workspaceID, app)
	return s.publishAppIfChanged(ctx, workspaceID, appPackage.AppID, app), nil
}

func (s *AppCenterService) runInstallJob(workspaceID string, appID string, runtimeProfileHint string, resolvePackage appInstallPackageResolver) {
	startedAt := time.Now()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	options := s.installJobOptions(workspaceID, appID)
	plan := s.buildInstallProgressPlan(ctx, appID)
	tracker := s.newInstallProgressTracker(workspaceID, appID, plan)
	s.registerActiveInstallTracker(workspaceID, appID, tracker)
	defer func() {
		s.unregisterActiveInstallTracker(workspaceID, appID)
		tracker.clear()
	}()

	var appPackage workspacebiz.AppPackage
	type installJobResult struct {
		appPackage workspacebiz.AppPackage
		err        error
		kind       string
	}
	results := make(chan installJobResult, 2)
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		pkg, err := resolvePackage(tracker.packageProgressContext(ctx))
		results <- installJobResult{
			appPackage: pkg,
			err:        err,
			kind:       "package",
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		var err error
		if appRuntimeProfileIsStandalone(runtimeProfileHint) {
			err = nil
		} else if strings.TrimSpace(runtimeProfileHint) == workspaceAppNodeRuntimePreloadProfile {
			err = s.runner().PreloadRuntimeForProfile(tracker.runtimeProgressContext(ctx), workspaceAppNodeRuntimePreloadProfile)
		} else {
			err = s.runner().PreloadRuntime(tracker.runtimeProgressContext(ctx))
		}
		results <- installJobResult{
			err:  err,
			kind: "runtime",
		}
	}()

	for completed := 0; completed < 2; completed += 1 {
		result := <-results
		if result.kind == "package" {
			appPackage = result.appPackage
		}
		if result.err != nil {
			cancel()
			wg.Wait()
			s.handleInstallJobFailure(context.Background(), workspaceID, appID, appPackage, result.err, startedAt)
			return
		}
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		s.handleInstallJobFailure(ctx, workspaceID, appID, appPackage, err, startedAt)
		return
	}

	tracker.beginInstalling()
	if _, err := s.installPackage(ctx, workspaceID, appPackage, options); err != nil {
		s.handleInstallJobFailure(ctx, workspaceID, appID, appPackage, err, startedAt)
		return
	}
	tracker.finishInstalling()
	tracker.finishStarting()

	s.finishInstallJob(workspaceID, appID)
	slog.Info("workspace_app_install_job_succeeded", "workspaceId", workspaceID, "appId", appID, "packageSource", appPackage.Source, "version", appPackage.Version, "packageDir", appPackage.PackageDir, "durationMs", time.Since(startedAt).Milliseconds())
}

func (s *AppCenterService) handleInstallJobFailure(ctx context.Context, workspaceID string, appID string, appPackage workspacebiz.AppPackage, err error, startedAt time.Time) {
	slog.Warn("workspace_app_install_job_failed", "workspaceId", workspaceID, "appId", appID, "packageSource", appPackage.Source, "version", appPackage.Version, "packageDir", appPackage.PackageDir, "failureReason", err.Error(), "durationMs", time.Since(startedAt).Milliseconds(), "error", err)
	s.failInstallJob(workspaceID, appID, err)
	if failedApp, projectionErr := s.failedInstallAppProjection(ctx, workspaceID, appID, err); projectionErr == nil {
		_ = s.publishAppIfChanged(ctx, workspaceID, appID, failedApp)
	} else {
		slog.Warn("workspace app install failure projection failed", "workspaceId", workspaceID, "appId", appID, "error", projectionErr)
	}
}

func (s *AppCenterService) packageForInstall(ctx context.Context, appID string) (workspacebiz.AppPackage, error) {
	appPackage, err := s.Store.GetAppPackage(ctx, appID)
	if err != nil {
		if !errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
			return workspacebiz.AppPackage{}, err
		}
		return s.materializeRemoteBuiltinPackage(ctx, appID)
	}
	remoteBuiltin, ok, err := s.remoteBuiltinForAppID(ctx, appID)
	if err != nil {
		return appPackage, nil
	}
	if ok && shouldMaterializeRemoteBuiltin(appPackage, remoteBuiltin) {
		return s.downloadRemoteBuiltinPackage(ctx, remoteBuiltin)
	}
	return appPackage, nil
}

func (s *AppCenterService) Add(ctx context.Context, workspaceID string, appID string) (workspacebiz.WorkspaceApp, error) {
	return s.Install(ctx, workspaceID, appID)
}

func (s *AppCenterService) Uninstall(ctx context.Context, workspaceID string, appID string) (workspacebiz.WorkspaceApp, error) {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}

	appPackage, _, err := s.installedPackage(ctx, workspaceID, appID)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	if _, err := s.runner().Stop(ctx, workspaceID, appPackage.AppID); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	s.deactivateAppCLI(workspaceID, appPackage.AppID)
	if err := s.removeWorkspaceAppStateRoot(workspaceID, appPackage.AppID); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	deletePackage, err := s.shouldDeleteRemoteBuiltinPackageAfterUninstall(ctx, workspaceID, appPackage)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	if deletePackage {
		if err := s.deleteRemoteBuiltinPackageFilesAndRecord(ctx, appPackage); err != nil {
			return workspacebiz.WorkspaceApp{}, err
		}
	} else {
		if err := s.Store.DeleteWorkspaceAppInstallation(ctx, workspaceID, appPackage.AppID); err != nil {
			return workspacebiz.WorkspaceApp{}, err
		}
	}

	app := workspacebiz.WorkspaceApp{
		Package: appPackage,
		Runtime: workspacebiz.AppRuntimeState{
			Status: workspacebiz.AppRuntimeStatusIdle,
		},
	}
	app.CLI = s.appCLIState(workspaceID, app)
	return s.publishAppIfChanged(ctx, workspaceID, appPackage.AppID, app), nil
}

func (s *AppCenterService) Remove(ctx context.Context, workspaceID string, appID string) (workspacebiz.WorkspaceApp, error) {
	return s.Uninstall(ctx, workspaceID, appID)
}

func (s *AppCenterService) Rollback(ctx context.Context, workspaceID string, appID string, version string) (workspacebiz.WorkspaceApp, error) {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	if strings.TrimSpace(appID) == "" || strings.TrimSpace(version) == "" {
		return workspacebiz.WorkspaceApp{}, errors.New("workspace app id and version are required")
	}
	if err := s.Store.SetActiveAppPackageVersion(ctx, appID, version); err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}

	appPackage, err := s.Store.GetAppPackage(ctx, appID)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}

	var installationPtr *workspacebiz.AppInstallation
	installations, err := s.Store.ListWorkspaceAppInstallations(ctx, workspaceID)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	for _, installation := range installations {
		if installation.AppID == appPackage.AppID {
			installationCopy := installation
			installationPtr = &installationCopy
			break
		}
	}

	runtimeState := workspacebiz.AppRuntimeState{Status: workspacebiz.AppRuntimeStatusIdle}
	if installationPtr != nil {
		_, _ = s.runner().Stop(ctx, workspaceID, appPackage.AppID)
		started, err := s.startPackage(ctx, workspaceID, appPackage, true)
		if err != nil {
			return workspacebiz.WorkspaceApp{}, err
		}
		runtimeState = started
	}

	app := workspacebiz.WorkspaceApp{
		Package:      appPackage,
		Installation: installationPtr,
		Runtime:      runtimeState,
	}
	app.CLI = s.appCLIState(workspaceID, app)
	return s.publishAppIfChanged(ctx, workspaceID, appPackage.AppID, app), nil
}

func (s *AppCenterService) workspaceSummary(ctx context.Context, workspaceID string) (workspacebiz.Summary, error) {
	if s.Store == nil {
		return workspacebiz.Summary{}, errors.New("workspace app store is not configured")
	}
	if s.WorkspaceStore == nil {
		return workspacebiz.Summary{}, errors.New("workspace catalog store is not configured")
	}

	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return workspacebiz.Summary{}, errors.New("workspace id is required")
	}

	return s.WorkspaceStore.Get(ctx, workspaceID)
}

func (s *AppCenterService) workspaceRoot(ctx context.Context, workspaceID string) (workspacefiles.WorkspaceRoot, error) {
	if s.WorkspaceRootResolver == nil {
		return workspacefiles.WorkspaceRoot{}, nil
	}
	return s.WorkspaceRootResolver.ResolveWorkspaceRoot(ctx, workspaceID)
}

func (s *AppCenterService) runner() *AppRunner {
	if s.Runner == nil {
		s.Runner = &AppRunner{}
	}
	if s.Runner.OnStateChanged == nil {
		s.Runner.OnStateChanged = s.handleRunnerStateChanged
	}
	return s.Runner
}

func (s *AppCenterService) handleRunnerStateChanged(workspaceID string, appID string, state workspacebiz.AppRuntimeState) {
	if s.Store == nil {
		return
	}
	s.syncInstallProgressFromRuntimeStatus(workspaceID, appID, state.Status)
	ctx := context.Background()
	appPackage, err := s.Store.GetAppPackage(ctx, appID)
	if err != nil {
		slog.Warn("workspace app runtime state changed for unknown package", "workspaceId", workspaceID, "appId", appID, "error", err)
		return
	}

	var installationPtr *workspacebiz.AppInstallation
	installations, err := s.Store.ListWorkspaceAppInstallations(ctx, workspaceID)
	if err != nil {
		slog.Warn("workspace app runtime state installation lookup failed", "workspaceId", workspaceID, "appId", appID, "error", err)
		return
	}
	for _, installation := range installations {
		if installation.AppID == appPackage.AppID {
			installationCopy := installation
			installationPtr = &installationCopy
			break
		}
	}

	app := workspacebiz.WorkspaceApp{
		Package:      appPackage,
		Installation: installationPtr,
		Runtime:      runtimeStateForActivePackage(state, appPackage),
	}
	if state.Status == workspacebiz.AppRuntimeStatusRunning && state.LaunchURL != nil && installationPtr != nil && installationPtr.Enabled {
		app.CLI = s.activateAppCLI(ctx, workspaceID, appPackage, *state.LaunchURL)
	} else {
		app.CLI = s.appCLIState(workspaceID, app)
	}
	_ = s.publishAppIfChanged(ctx, workspaceID, appPackage.AppID, app)
}

func (s *AppCenterService) publishAppIfChanged(ctx context.Context, workspaceID string, appID string, app workspacebiz.WorkspaceApp) workspacebiz.WorkspaceApp {
	app = s.withActiveInstallJobProgress(app, workspaceID, appID)
	app, changed := s.withChangedRevision(app, workspaceID, appID)
	if !changed {
		return app
	}
	if s.Publisher == nil {
		return app
	}
	if err := s.Publisher.PublishWorkspaceAppUpdated(ctx, workspaceID, app); err != nil {
		slog.Warn("workspace app updated event publish failed", "workspaceId", workspaceID, "appId", appID, "stateRevision", app.StateRevision, "error", err)
	}
	return app
}

func (s *AppCenterService) withChangedRevision(app workspacebiz.WorkspaceApp, workspaceID string, appID string) (workspacebiz.WorkspaceApp, bool) {
	key := appRuntimeKey(workspaceID, appID)
	projection := projectionKeyFromWorkspaceApp(app)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureRevisionStateLocked()
	if previous, ok := s.appProjectionKeys[key]; ok && previous == projection {
		app.StateRevision = s.stateRevisions[key]
		return app, false
	}
	s.stateRevisions[key] += 1
	s.appProjectionKeys[key] = projection
	app.StateRevision = s.stateRevisions[key]
	return app, true
}

func (s *AppCenterService) withCurrentRevision(app workspacebiz.WorkspaceApp, workspaceID string, appID string) workspacebiz.WorkspaceApp {
	key := appRuntimeKey(workspaceID, appID)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureRevisionStateLocked()
	app.StateRevision = s.stateRevisions[key]
	return app
}

func (s *AppCenterService) materializeRemoteBuiltinPackage(ctx context.Context, appID string) (workspacebiz.AppPackage, error) {
	builtins, err := s.builtinCatalog(ctx)
	if err != nil {
		return workspacebiz.AppPackage{}, err
	}
	for _, builtin := range builtins {
		if builtin.Manifest.AppID != appID || builtin.Distribution.Kind != builtinapps.DistributionRemote {
			continue
		}
		return s.downloadRemoteBuiltinPackage(ctx, builtin)
	}
	return workspacebiz.AppPackage{}, workspacedata.ErrWorkspaceAppNotFound
}

func (s *AppCenterService) remoteBuiltinForAppID(ctx context.Context, appID string) (builtinapps.App, bool, error) {
	builtins, err := s.builtinCatalog(ctx)
	if err != nil {
		return builtinapps.App{}, false, err
	}
	for _, builtin := range builtins {
		if builtin.Manifest.AppID == appID && builtin.Distribution.Kind == builtinapps.DistributionRemote {
			return builtin, true, nil
		}
	}
	return builtinapps.App{}, false, nil
}

func (s *AppCenterService) remoteBuiltinWorkspaceApp(builtin builtinapps.App, workspaceID string) (workspacebiz.WorkspaceApp, error) {
	app, err := remoteBuiltinWorkspaceApp(builtin)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	return s.withCurrentRevision(app, workspaceID, app.Package.AppID), nil
}

func (s *AppCenterService) workspaceAppProjectionForInstall(ctx context.Context, workspaceID string, appID string) (workspacebiz.WorkspaceApp, error) {
	appPackage, packageErr := s.Store.GetAppPackage(ctx, appID)
	remoteBuiltin, hasRemoteBuiltin, remoteErr := s.remoteBuiltinForAppID(ctx, appID)
	if packageErr != nil {
		if !errors.Is(packageErr, workspacedata.ErrWorkspaceAppNotFound) {
			return workspacebiz.WorkspaceApp{}, packageErr
		}
		if remoteErr != nil {
			return workspacebiz.WorkspaceApp{}, remoteErr
		}
		if hasRemoteBuiltin {
			return s.remoteBuiltinWorkspaceApp(remoteBuiltin, workspaceID)
		}
		return workspacebiz.WorkspaceApp{}, workspacedata.ErrWorkspaceAppNotFound
	}
	installation, installed, err := s.workspaceAppInstallation(ctx, workspaceID, appID)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	if remoteErr == nil && hasRemoteBuiltin && shouldUseRemoteBuiltin(appPackage, remoteBuiltin) {
		if installed {
			return workspaceAppWithRemoteBuiltinUpdate(
				s.workspaceAppFromPackage(appPackage, installation, installed, workspaceID),
				remoteBuiltin,
			)
		}
		return s.remoteBuiltinWorkspaceApp(remoteBuiltin, workspaceID)
	}
	return s.workspaceAppFromPackage(appPackage, installation, installed, workspaceID), nil
}

func (s *AppCenterService) workspaceAppInstallation(ctx context.Context, workspaceID string, appID string) (workspacebiz.AppInstallation, bool, error) {
	installations, err := s.Store.ListWorkspaceAppInstallations(ctx, workspaceID)
	if err != nil {
		return workspacebiz.AppInstallation{}, false, err
	}
	for _, installation := range installations {
		if installation.AppID == appID {
			return installation, true, nil
		}
	}
	return workspacebiz.AppInstallation{}, false, nil
}

func (s *AppCenterService) resolveWorkspaceAppCatalog(packages []workspacebiz.AppPackage, builtins []builtinapps.App, installationsByAppID map[string]workspacebiz.AppInstallation, workspaceID string) ([]workspacebiz.WorkspaceApp, error) {
	packagesByAppID := make(map[string]workspacebiz.AppPackage, len(packages))
	for _, appPackage := range packages {
		packagesByAppID[appPackage.AppID] = appPackage
	}

	apps := make([]workspacebiz.WorkspaceApp, 0, len(packages)+len(builtins))
	emittedAppIDs := make(map[string]struct{}, len(packages)+len(builtins))
	for _, builtin := range builtins {
		if builtin.Distribution.Kind != builtinapps.DistributionRemote {
			continue
		}
		appID := builtin.Manifest.AppID
		installation, installed := installationsByAppID[appID]
		if appPackage, ok := packagesByAppID[appID]; ok && !shouldDisplayRemoteBuiltinCatalog(appPackage, builtin, installed) {
			app, err := workspaceAppWithRemoteBuiltinUpdate(
				s.workspaceAppFromPackage(appPackage, installation, installed, workspaceID),
				builtin,
			)
			if err != nil {
				return nil, err
			}
			apps = append(apps, app)
		} else {
			app, err := s.remoteBuiltinWorkspaceApp(builtin, workspaceID)
			if err != nil {
				return nil, err
			}
			apps = append(apps, app)
		}
		emittedAppIDs[appID] = struct{}{}
	}

	for _, appPackage := range packages {
		if _, ok := emittedAppIDs[appPackage.AppID]; ok {
			continue
		}
		installation, installed := installationsByAppID[appPackage.AppID]
		apps = append(apps, s.workspaceAppFromPackage(appPackage, installation, installed, workspaceID))
	}
	return apps, nil
}

func (s *AppCenterService) workspaceAppFromPackage(appPackage workspacebiz.AppPackage, installation workspacebiz.AppInstallation, installed bool, workspaceID string) workspacebiz.WorkspaceApp {
	app := workspacebiz.WorkspaceApp{
		Package: appPackage,
		Runtime: workspacebiz.AppRuntimeState{
			Status: workspacebiz.AppRuntimeStatusIdle,
		},
	}
	if installed {
		installationCopy := installation
		app.Installation = &installationCopy
		app.Runtime = s.runner().State(workspaceID, appPackage.AppID)
		app.Runtime = runtimeStateForActivePackage(app.Runtime, appPackage)
	}
	app.CLI = s.appCLIState(workspaceID, app)
	return s.withCurrentRevision(app, workspaceID, appPackage.AppID)
}

func runtimeStateForActivePackage(state workspacebiz.AppRuntimeState, appPackage workspacebiz.AppPackage) workspacebiz.AppRuntimeState {
	if state.Status != workspacebiz.AppRuntimeStatusRunning {
		return state
	}
	if strings.TrimSpace(state.PackageDir) == "" || strings.TrimSpace(appPackage.PackageDir) == "" {
		return state
	}
	if filepath.Clean(state.PackageDir) == filepath.Clean(appPackage.PackageDir) {
		return state
	}
	state.Status = workspacebiz.AppRuntimeStatusInstalledPendingRestart
	return state
}

func shouldDisplayRemoteBuiltinCatalog(appPackage workspacebiz.AppPackage, builtin builtinapps.App, installed bool) bool {
	return !installed && shouldUseRemoteBuiltin(appPackage, builtin)
}

func workspaceAppWithRemoteBuiltinUpdate(app workspacebiz.WorkspaceApp, builtin builtinapps.App) (workspacebiz.WorkspaceApp, error) {
	catalogIconURL, err := remoteBuiltinIconURL(builtin)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	if app.Installation == nil {
		app.IconURL = catalogIconURL
	}
	if !shouldUseRemoteBuiltin(app.Package, builtin) {
		return app, nil
	}
	availableVersion := builtin.Manifest.Version
	app.AvailableVersion = &availableVersion
	app.AvailableIconURL = catalogIconURL
	app.UpdateAvailable = true
	return app, nil
}
