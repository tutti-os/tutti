package workspace

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	builtinapps "github.com/tutti-os/tutti/services/tuttid/builtin-apps"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

func TestAppCenterServiceStartEnabledUpdatesRemoteBuiltinBeforeStartingIt(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
	oldDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "large-builtin",
		Version:       "1.0.0",
		Name:          "Large Builtin",
		Description:   "Old large app",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/",
		},
	})
	remoteDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "large-builtin",
		Version:       "1.1.0",
		Name:          "Large Builtin",
		Description:   "New large app",
		Icon: workspacebiz.AppManifestIcon{
			Type: "asset",
			Src:  "icon.png",
		},
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/",
		},
	})
	archivePath := filepath.Join(t.TempDir(), "large-builtin.zip")
	if err := createAppPackageZip(remoteDir, archivePath); err != nil {
		t.Fatalf("createAppPackageZip() error = %v", err)
	}
	artifactSHA256, _, err := fileSHA256AndSize(archivePath)
	if err != nil {
		t.Fatalf("fileSHA256AndSize() error = %v", err)
	}
	remoteManifest := mustReadManifestForTest(t, remoteDir)

	store := newAppStoreStub()
	if err := store.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:      "large-builtin",
		Version:    "1.0.0",
		PackageDir: oldDir,
		Manifest:   mustReadManifestForTest(t, oldDir),
		Source:     workspacebiz.AppPackageSourceBuiltin,
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	if err := store.PutWorkspaceAppInstallation(ctx, workspacebiz.AppInstallation{
		WorkspaceID: "ws-1",
		AppID:       "large-builtin",
		Enabled:     true,
	}); err != nil {
		t.Fatalf("PutWorkspaceAppInstallation() error = %v", err)
	}
	fetcher := newCopyingArtifactFetcher(archivePath)
	runner := &AppRunner{RuntimeResolver: &preloadThenFailRuntimeResolver{called: make(chan struct{}), startErr: errors.New("skip runtime")}}
	service := AppCenterService{
		Store:           store,
		WorkspaceStore:  &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:          runner,
		StateDir:        stateDir,
		ArtifactFetcher: fetcher,
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return []builtinapps.App{{
				Manifest: remoteManifest,
				Distribution: builtinapps.Distribution{
					Kind:           builtinapps.DistributionRemote,
					ArtifactURL:    "https://cdn.example.test/large-builtin.zip",
					ArtifactSHA256: artifactSHA256,
					IconURL:        "https://cdn.example.test/large-builtin.png",
				},
			}}, nil
		},
	}

	apps, err := service.StartEnabled(ctx, "ws-1")
	if err != nil {
		t.Fatalf("StartEnabled() error = %v", err)
	}
	app := findWorkspaceAppForTest(apps, "large-builtin")
	if app == nil || app.Installation == nil || app.Package.Version != "1.0.0" {
		t.Fatalf("StartEnabled() app = %#v", app)
	}
	select {
	case <-fetcher.done:
	case <-time.After(time.Second):
		t.Fatal("background remote builtin update did not finish")
	}
	active := waitForActiveAppPackageVersionForTest(t, store, "large-builtin", "1.1.0")
	if active.Version != "1.1.0" {
		t.Fatalf("active package version = %q, want 1.1.0", active.Version)
	}
	waitForRunnerStatus(t, runner, "ws-1", "large-builtin", workspacebiz.AppRuntimeStatusFailed)
}

func TestAppCenterServiceStartEnabledRepairsMissingRemoteBuiltinCacheBeforeStarting(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
	remoteDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "large-builtin",
		Version:       "1.1.0",
		Name:          "Large Builtin",
		Description:   "Remote app",
		Icon: workspacebiz.AppManifestIcon{
			Type: "asset",
			Src:  "icon.png",
		},
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/",
		},
	})
	archivePath := filepath.Join(t.TempDir(), "large-builtin.zip")
	if err := createAppPackageZip(remoteDir, archivePath); err != nil {
		t.Fatalf("createAppPackageZip() error = %v", err)
	}
	artifactSHA256, _, err := fileSHA256AndSize(archivePath)
	if err != nil {
		t.Fatalf("fileSHA256AndSize() error = %v", err)
	}
	remoteManifest := mustReadManifestForTest(t, remoteDir)

	store := newAppStoreStub()
	missingPackageDir := filepath.Join(t.TempDir(), "missing-large-builtin")
	if err := store.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:      "large-builtin",
		Version:    "1.1.0",
		PackageDir: missingPackageDir,
		Manifest:   remoteManifest,
		Source:     workspacebiz.AppPackageSourceBuiltin,
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	if err := store.PutWorkspaceAppInstallation(ctx, workspacebiz.AppInstallation{
		WorkspaceID: "ws-1",
		AppID:       "large-builtin",
		Enabled:     true,
	}); err != nil {
		t.Fatalf("PutWorkspaceAppInstallation() error = %v", err)
	}
	fetcher := newCopyingArtifactFetcher(archivePath)
	runner := &AppRunner{RuntimeResolver: &preloadThenFailRuntimeResolver{called: make(chan struct{}), startErr: errors.New("skip runtime")}}
	service := AppCenterService{
		Store:           store,
		WorkspaceStore:  &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:          runner,
		StateDir:        stateDir,
		ArtifactFetcher: fetcher,
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return []builtinapps.App{{
				Manifest: remoteManifest,
				Distribution: builtinapps.Distribution{
					Kind:           builtinapps.DistributionRemote,
					ArtifactURL:    "https://cdn.example.test/large-builtin.zip",
					ArtifactSHA256: artifactSHA256,
					IconURL:        "https://cdn.example.test/large-builtin.png",
				},
			}}, nil
		},
	}

	apps, err := service.StartEnabled(ctx, "ws-1")
	if err != nil {
		t.Fatalf("StartEnabled() error = %v", err)
	}
	app := findWorkspaceAppForTest(apps, "large-builtin")
	if app == nil || app.Installation == nil {
		t.Fatalf("StartEnabled() initial app = %#v", app)
	}
	active := waitForActiveAppPackageDirChangeForTest(t, store, "large-builtin", missingPackageDir)
	if err := validateExtractedAppPackage(NewPlatformAppShellAdapter(), active.PackageDir, active.Manifest); err != nil {
		t.Fatalf("repaired package validation error = %v", err)
	}
	waitForRunnerStatus(t, runner, "ws-1", "large-builtin", workspacebiz.AppRuntimeStatusFailed)
}

func TestAppCenterServiceStartEnabledReturnsErrorForMissingNonRemotePackage(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppStoreStub()
	if err := store.PutWorkspaceAppInstallation(ctx, workspacebiz.AppInstallation{
		WorkspaceID: "ws-1",
		AppID:       "missing-local",
		Enabled:     true,
	}); err != nil {
		t.Fatalf("PutWorkspaceAppInstallation() error = %v", err)
	}
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       t.TempDir(),
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return nil, nil
		},
	}

	if _, err := service.StartEnabled(ctx, "ws-1"); !errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
		t.Fatalf("StartEnabled() error = %v, want ErrWorkspaceAppNotFound", err)
	}
}

func TestAppCenterServiceStartEnabledDoesNotBlockOtherAppsWhenRemoteBuiltinPackageIsMissing(t *testing.T) {
	ctx := context.Background()
	localDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "local-app",
		Version:       "1.0.0",
		Name:          "Local App",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/",
		},
	})
	store := newAppStoreStub()
	if err := store.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:      "local-app",
		Version:    "1.0.0",
		PackageDir: localDir,
		Manifest:   mustReadManifestForTest(t, localDir),
		Source:     workspacebiz.AppPackageSourceGenerated,
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	for _, appID := range []string{"missing-builtin", "local-app"} {
		if err := store.PutWorkspaceAppInstallation(ctx, workspacebiz.AppInstallation{
			WorkspaceID: "ws-1",
			AppID:       appID,
			Enabled:     true,
		}); err != nil {
			t.Fatalf("PutWorkspaceAppInstallation() error = %v", err)
		}
	}
	fetcher := newBlockingArtifactFetcher()
	resolver := &appRuntimeResolverStub{called: make(chan struct{}), err: errors.New("skip runtime")}
	runner := &AppRunner{RuntimeResolver: resolver}
	service := AppCenterService{
		Store:           store,
		WorkspaceStore:  &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:          runner,
		StateDir:        t.TempDir(),
		ArtifactFetcher: fetcher,
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return []builtinapps.App{{
				Manifest: workspacebiz.AppManifest{
					SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
					AppID:         "missing-builtin",
					Version:       "1.0.0",
					Name:          "Missing Builtin",
					Runtime: workspacebiz.AppManifestRuntime{
						Bootstrap:       "bootstrap.sh",
						HealthcheckPath: "/",
					},
				},
				Distribution: builtinapps.Distribution{
					Kind:           builtinapps.DistributionRemote,
					ArtifactURL:    "https://cdn.example.test/missing-builtin.zip",
					ArtifactSHA256: "sha256",
					IconURL:        "https://cdn.example.test/missing-builtin.png",
				},
			}}, nil
		},
	}

	resultCh := make(chan struct {
		apps []workspacebiz.WorkspaceApp
		err  error
	}, 1)
	go func() {
		apps, err := service.StartEnabled(ctx, "ws-1")
		resultCh <- struct {
			apps []workspacebiz.WorkspaceApp
			err  error
		}{apps: apps, err: err}
	}()

	select {
	case result := <-resultCh:
		if result.err != nil {
			t.Fatalf("StartEnabled() error = %v", result.err)
		}
		localApp := findWorkspaceAppForTest(result.apps, "local-app")
		if localApp == nil || localApp.Installation == nil || localApp.Package.Version != "1.0.0" {
			t.Fatalf("local app after StartEnabled() = %#v", localApp)
		}
	case <-time.After(time.Second):
		close(fetcher.release)
		t.Fatal("StartEnabled() blocked on missing remote builtin package")
	}

	select {
	case <-fetcher.started:
	case <-time.After(time.Second):
		close(fetcher.release)
		t.Fatal("missing remote builtin install job did not start")
	}
	close(fetcher.release)
	select {
	case <-fetcher.done:
	case <-time.After(time.Second):
		t.Fatal("missing remote builtin install job did not finish")
	}
	waitForRunnerStatus(t, runner, "ws-1", "local-app", workspacebiz.AppRuntimeStatusFailed)
}

func TestAppCenterServiceLaunchStartsIdleInstalledApp(t *testing.T) {
	ctx := context.Background()
	service, runner := newLaunchTestAppCenterService(t)
	defer func() {
		_, _ = runner.Stop(context.Background(), "ws-1", "local-app")
	}()

	app, err := service.Launch(ctx, "ws-1", "local-app")
	if err != nil {
		t.Fatalf("Launch() error = %v", err)
	}
	if app.Runtime.Status != workspacebiz.AppRuntimeStatusPreparing {
		t.Fatalf("Launch() status = %q, want preparing", app.Runtime.Status)
	}
	waitForRunnerStatus(t, runner, "ws-1", "local-app", workspacebiz.AppRuntimeStatusFailed)
}

func TestAppCenterServiceLaunchReturnsActiveRuntimeWithoutRestart(t *testing.T) {
	for _, status := range []workspacebiz.AppRuntimeStatus{
		workspacebiz.AppRuntimeStatusPreparing,
		workspacebiz.AppRuntimeStatusStarting,
		workspacebiz.AppRuntimeStatusRunning,
	} {
		t.Run(string(status), func(t *testing.T) {
			ctx := context.Background()
			service, runner := newLaunchTestAppCenterService(t)
			state := workspacebiz.AppRuntimeState{
				Status:    status,
				LaunchURL: stringPtr("http://127.0.0.1:43210"),
				Port:      intPtr(43210),
			}
			runner.setState(appRuntimeKey("ws-1", "local-app"), state)

			app, err := service.Launch(ctx, "ws-1", "local-app")
			if err != nil {
				t.Fatalf("Launch() error = %v", err)
			}
			if app.Runtime.Status != status {
				t.Fatalf("Launch() status = %q, want %q", app.Runtime.Status, status)
			}
			if app.Runtime.Port == nil || *app.Runtime.Port != 43210 {
				t.Fatalf("Launch() port = %v, want 43210", app.Runtime.Port)
			}
		})
	}
}

func TestAppCenterServiceLaunchMarksRunningOldPackagePendingRestart(t *testing.T) {
	ctx := context.Background()
	service, runner := newLaunchTestAppCenterService(t)
	runner.setState(appRuntimeKey("ws-1", "local-app"), workspacebiz.AppRuntimeState{
		Status:     workspacebiz.AppRuntimeStatusRunning,
		LaunchURL:  stringPtr("http://127.0.0.1:43210"),
		Port:       intPtr(43210),
		PackageDir: filepath.Join(t.TempDir(), "local-app", "0.0.9"),
	})

	app, err := service.Launch(ctx, "ws-1", "local-app")
	if err != nil {
		t.Fatalf("Launch() error = %v", err)
	}
	if app.Runtime.Status != workspacebiz.AppRuntimeStatusInstalledPendingRestart {
		t.Fatalf("Launch() status = %q, want %q", app.Runtime.Status, workspacebiz.AppRuntimeStatusInstalledPendingRestart)
	}
	if app.Runtime.Port == nil || *app.Runtime.Port != 43210 {
		t.Fatalf("Launch() port = %v, want 43210", app.Runtime.Port)
	}
	if app.Runtime.LaunchURL == nil || *app.Runtime.LaunchURL != "http://127.0.0.1:43210" {
		t.Fatalf("Launch() launch URL = %v, want old running URL", app.Runtime.LaunchURL)
	}
}

func TestAppCenterServiceLaunchRejectsFailedAndStoppingApps(t *testing.T) {
	for _, status := range []workspacebiz.AppRuntimeStatus{
		workspacebiz.AppRuntimeStatusFailed,
		workspacebiz.AppRuntimeStatusStopping,
	} {
		t.Run(string(status), func(t *testing.T) {
			service, runner := newLaunchTestAppCenterService(t)
			runner.setState(appRuntimeKey("ws-1", "local-app"), workspacebiz.AppRuntimeState{Status: status})

			if _, err := service.Launch(context.Background(), "ws-1", "local-app"); !errors.Is(err, ErrInvalidWorkspaceAppRuntimeState) {
				t.Fatalf("Launch() error = %v, want ErrInvalidWorkspaceAppRuntimeState", err)
			}
		})
	}
}

func TestAppCenterServiceRetryRestartsFailedApp(t *testing.T) {
	ctx := context.Background()
	service, runner := newLaunchTestAppCenterService(t)
	defer func() {
		_, _ = runner.Stop(context.Background(), "ws-1", "local-app")
	}()
	runner.setState(appRuntimeKey("ws-1", "local-app"), workspacebiz.AppRuntimeState{
		Status:        workspacebiz.AppRuntimeStatusFailed,
		FailureReason: stringPtr("healthcheck"),
		LastError:     stringPtr("app healthcheck timed out"),
	})

	app, err := service.Retry(ctx, "ws-1", "local-app")
	if err != nil {
		t.Fatalf("Retry() error = %v", err)
	}
	if app.Runtime.Status != workspacebiz.AppRuntimeStatusPreparing {
		t.Fatalf("Retry() status = %q, want preparing", app.Runtime.Status)
	}
	waitForRunnerStatus(t, runner, "ws-1", "local-app", workspacebiz.AppRuntimeStatusFailed)
}

func TestAppCenterServiceRetryRejectsNonFailedApps(t *testing.T) {
	for _, status := range []workspacebiz.AppRuntimeStatus{
		workspacebiz.AppRuntimeStatusIdle,
		workspacebiz.AppRuntimeStatusPreparing,
		workspacebiz.AppRuntimeStatusStarting,
		workspacebiz.AppRuntimeStatusRunning,
		workspacebiz.AppRuntimeStatusStopping,
	} {
		t.Run(string(status), func(t *testing.T) {
			service, runner := newLaunchTestAppCenterService(t)
			runner.setState(appRuntimeKey("ws-1", "local-app"), workspacebiz.AppRuntimeState{Status: status})

			if _, err := service.Retry(context.Background(), "ws-1", "local-app"); !errors.Is(err, ErrInvalidWorkspaceAppRuntimeState) {
				t.Fatalf("Retry() error = %v, want ErrInvalidWorkspaceAppRuntimeState", err)
			}
		})
	}
}

func TestAppCenterServiceStartEnabledSkipsFailedAndStoppingApps(t *testing.T) {
	for _, status := range []workspacebiz.AppRuntimeStatus{
		workspacebiz.AppRuntimeStatusFailed,
		workspacebiz.AppRuntimeStatusStopping,
	} {
		t.Run(string(status), func(t *testing.T) {
			service, runner := newLaunchTestAppCenterService(t)
			runner.setState(appRuntimeKey("ws-1", "local-app"), workspacebiz.AppRuntimeState{Status: status})

			apps, err := service.StartEnabled(context.Background(), "ws-1")
			if err != nil {
				t.Fatalf("StartEnabled() error = %v", err)
			}
			app := findWorkspaceAppForTest(apps, "local-app")
			if app == nil {
				t.Fatal("StartEnabled() did not return local-app")
				return
			}
			if app.Runtime.Status != status {
				t.Fatalf("StartEnabled() status = %q, want %q", app.Runtime.Status, status)
			}
		})
	}
}
