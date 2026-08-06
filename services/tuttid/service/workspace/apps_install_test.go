package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	builtinapps "github.com/tutti-os/tutti/services/tuttid/builtin-apps"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

func TestAppCenterServiceInstallNodeStaticPackageSkipsBaselineRuntimePreload(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppStoreStub()
	manifest := workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "node-app",
		Version:       "1.0.0",
		Name:          "Node App",
		Description:   "Node-only app",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/",
			Profile:         workspaceAppNodeRuntimePreloadProfile,
		},
	}
	packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), manifest)
	if err := store.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:      manifest.AppID,
		Version:    manifest.Version,
		PackageDir: packageDir,
		Manifest:   manifest,
		Source:     workspacebiz.AppPackageSourceGenerated,
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	resolver := &appRuntimeResolverStub{called: make(chan struct{})}
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{RuntimeResolver: resolver},
		StateDir:       t.TempDir(),
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return nil, nil
		},
	}

	if _, err := service.Install(ctx, "ws-1", manifest.AppID); err != nil {
		t.Fatalf("Install() error = %v", err)
	}

	deadline := time.After(time.Second)
	for {
		resolver.mu.Lock()
		profile := resolver.profile
		resolveCalls := resolver.resolveCalls
		resolver.mu.Unlock()
		if profile == workspaceAppNodeRuntimePreloadProfile {
			if resolveCalls != 0 {
				t.Fatalf("baseline Resolve() calls = %d, want 0", resolveCalls)
			}
			return
		}
		select {
		case <-deadline:
			t.Fatal("node-static runtime preload did not run")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestAppCenterServiceInstallProjectionPreservesInstalledRemoteBuiltinUpdate(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
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
	remoteManifest := mustReadManifestForTest(t, oldDir)
	remoteManifest.Version = "1.1.0"
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
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       t.TempDir(),
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return []builtinapps.App{{
				Manifest: remoteManifest,
				Distribution: builtinapps.Distribution{
					Kind:           builtinapps.DistributionRemote,
					ArtifactURL:    "https://cdn.example.test/large-builtin.zip",
					ArtifactSHA256: "sha256",
					IconURL:        "https://cdn.example.test/large-builtin.png",
				},
			}}, nil
		},
	}

	app, err := service.workspaceAppProjectionForInstall(ctx, "ws-1", "large-builtin")
	if err != nil {
		t.Fatalf("workspaceAppProjectionForInstall() error = %v", err)
	}
	if app.Installation == nil || !app.Installation.Enabled {
		t.Fatalf("projection installation = %#v, want installed app", app.Installation)
	}
	if app.Package.Version != "1.0.0" || !app.UpdateAvailable || app.AvailableVersion == nil || *app.AvailableVersion != "1.1.0" {
		t.Fatalf("projection app = %#v, want installed old package with available update", app)
	}
}

func TestAppCenterServiceInstallPackagePrunesOldInactiveVersions(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	createVersion := func(version string, createdAt int64) workspacebiz.AppPackage {
		dir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
			SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
			AppID:         "large-builtin",
			Version:       version,
			Name:          "Large Builtin",
			Description:   "Large app",
			Runtime: workspacebiz.AppManifestRuntime{
				Bootstrap:       "bootstrap.sh",
				HealthcheckPath: "/",
			},
		})
		return workspacebiz.AppPackage{
			AppID:           "large-builtin",
			Version:         version,
			PackageDir:      dir,
			Manifest:        mustReadManifestForTest(t, dir),
			Source:          workspacebiz.AppPackageSourceBuiltin,
			CreatedAtUnixMs: createdAt,
		}
	}
	oldPackage := createVersion("1.0.0", 1000)
	previousPackage := createVersion("1.1.0", 2000)
	activePackage := createVersion("1.2.0", 3000)

	store := newAppStoreStub()
	if err := store.PutAppPackage(ctx, oldPackage); err != nil {
		t.Fatalf("PutAppPackage(old) error = %v", err)
	}
	if err := store.PutAppPackageVersion(ctx, previousPackage); err != nil {
		t.Fatalf("PutAppPackageVersion(previous) error = %v", err)
	}
	if err := store.SetActiveAppPackageVersion(ctx, "large-builtin", "1.1.0"); err != nil {
		t.Fatalf("SetActiveAppPackageVersion(previous) error = %v", err)
	}
	if err := store.PutAppPackageVersion(ctx, activePackage); err != nil {
		t.Fatalf("PutAppPackageVersion(active) error = %v", err)
	}
	runner := &AppRunner{RuntimeResolver: &appRuntimeResolverStub{called: make(chan struct{}), err: errors.New("skip runtime")}}
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         runner,
		StateDir:       t.TempDir(),
	}

	if _, err := service.installPackage(ctx, "ws-1", activePackage, InstallOptions{}); err != nil {
		t.Fatalf("installPackage() error = %v", err)
	}
	waitForRunnerStatus(t, runner, "ws-1", "large-builtin", workspacebiz.AppRuntimeStatusFailed)

	if _, err := store.GetAppPackageVersion(ctx, "large-builtin", "1.0.0"); !errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
		t.Fatalf("old package version error = %v, want ErrWorkspaceAppNotFound", err)
	}
	if _, err := os.Stat(oldPackage.PackageDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old package dir stat error = %v, want not exist", err)
	}
	if _, err := store.GetAppPackageVersion(ctx, "large-builtin", "1.1.0"); err != nil {
		t.Fatalf("previous package version error = %v", err)
	}
	if _, err := os.Stat(previousPackage.PackageDir); err != nil {
		t.Fatalf("previous package dir stat error = %v", err)
	}
	active, err := store.GetAppPackage(ctx, "large-builtin")
	if err != nil {
		t.Fatalf("GetAppPackage(active) error = %v", err)
	}
	if active.Version != "1.2.0" {
		t.Fatalf("active version = %q, want 1.2.0", active.Version)
	}
}

func TestAppCenterServiceSerializesSameRemoteBuiltinPackageInstall(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
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

	fetcher := newTrackingArtifactFetcher(archivePath)
	service := AppCenterService{
		Store:           newAppStoreStub(),
		WorkspaceStore:  &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:          &AppRunner{},
		StateDir:        stateDir,
		ArtifactFetcher: fetcher,
	}
	builtin := builtinapps.App{
		Manifest: mustReadManifestForTest(t, remoteDir),
		Distribution: builtinapps.Distribution{
			Kind:           builtinapps.DistributionRemote,
			ArtifactURL:    "https://cdn.example.test/large-builtin.zip",
			ArtifactSHA256: artifactSHA256,
			IconURL:        "https://cdn.example.test/large-builtin.png",
		},
	}

	resultCh := make(chan error, 2)
	go func() {
		_, err := service.downloadRemoteBuiltinPackage(ctx, builtin)
		resultCh <- err
	}()
	select {
	case <-fetcher.entered:
	case <-time.After(time.Second):
		close(fetcher.release)
		t.Fatal("first remote builtin install did not start")
	}

	go func() {
		_, err := service.downloadRemoteBuiltinPackage(ctx, builtin)
		resultCh <- err
	}()
	concurrentInstallStarted := false
	select {
	case <-fetcher.entered:
		concurrentInstallStarted = true
	case <-time.After(100 * time.Millisecond):
	}

	close(fetcher.release)
	for index := 0; index < 2; index += 1 {
		select {
		case err := <-resultCh:
			if err != nil {
				t.Fatalf("downloadRemoteBuiltinPackage() error = %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("remote builtin installs did not finish")
		}
	}
	if concurrentInstallStarted || fetcher.MaxActive() != 1 {
		t.Fatalf("remote builtin installs ran concurrently; max active = %d", fetcher.MaxActive())
	}

	packageDir := service.packageCacheDir("large-builtin", "1.1.0")
	if err := validateExtractedAppPackage(NewPlatformAppShellAdapter(), packageDir, mustReadManifestForTest(t, packageDir)); err != nil {
		t.Fatalf("copied package validation error = %v", err)
	}
}

func TestAppCenterServiceInstallReturnsWhileRemoteBuiltinDownloadRuns(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppStoreStub()
	if err := store.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:      "design-app",
		Version:    "0.1.0",
		PackageDir: filepath.Join(t.TempDir(), "design-app", "0.1.0"),
		Manifest: workspacebiz.AppManifest{
			SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
			AppID:         "design-app",
			Version:       "0.1.0",
			Name:          "Design App",
			Description:   "Old local design app",
			Runtime: workspacebiz.AppManifestRuntime{
				Bootstrap:       "bootstrap.sh",
				HealthcheckPath: "/",
			},
		},
		Source: workspacebiz.AppPackageSourceBuiltin,
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	fetcher := newBlockingArtifactFetcher()
	service := AppCenterService{
		Store:           store,
		WorkspaceStore:  &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		StateDir:        t.TempDir(),
		ArtifactFetcher: fetcher,
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return []builtinapps.App{{
				Manifest: workspacebiz.AppManifest{
					SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
					AppID:         "design-app",
					Version:       "0.1.0+abc123",
					Name:          "Design App",
					Description:   "Remote design app",
					Runtime: workspacebiz.AppManifestRuntime{
						Bootstrap:       "bootstrap.sh",
						HealthcheckPath: "/",
					},
				},
				Distribution: builtinapps.Distribution{
					Kind:           builtinapps.DistributionRemote,
					ArtifactURL:    "https://cdn.example.test/design-app.zip",
					ArtifactSHA256: "abc123",
					IconURL:        "https://cdn.example.test/design-app.png",
				},
			}}, nil
		},
	}

	resultCh := make(chan struct {
		app workspacebiz.WorkspaceApp
		err error
	}, 1)
	go func() {
		app, err := service.Install(ctx, "ws-1", "design-app")
		resultCh <- struct {
			app workspacebiz.WorkspaceApp
			err error
		}{app: app, err: err}
	}()

	select {
	case <-fetcher.started:
	case <-time.After(time.Second):
		t.Fatal("Install() did not start remote artifact fetch")
	}

	select {
	case result := <-resultCh:
		if result.err != nil {
			t.Fatalf("Install() error = %v", result.err)
		}
		if result.app.Package.Version != "0.1.0+abc123" || result.app.Installation != nil {
			t.Fatalf("Install() returned app = %#v", result.app)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Install() blocked on remote artifact download")
	}

	close(fetcher.release)
	select {
	case <-fetcher.done:
	case <-time.After(time.Second):
		t.Fatal("background remote builtin install job did not finish")
	}
}

func TestAppCenterServiceInstallCancelsPackageDownloadAfterRuntimePreloadFailure(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
	remoteDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "design-app",
		Version:       "0.1.0+abc123",
		Name:          "Design App",
		Description:   "Remote design app",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/",
		},
	})
	archivePath := filepath.Join(t.TempDir(), "design-app.zip")
	if err := createAppPackageZip(remoteDir, archivePath); err != nil {
		t.Fatalf("createAppPackageZip() error = %v", err)
	}
	artifactSHA256, _, err := fileSHA256AndSize(archivePath)
	if err != nil {
		t.Fatalf("fileSHA256AndSize() error = %v", err)
	}
	remoteManifest := mustReadManifestForTest(t, remoteDir)

	fetcher := newTrackingArtifactFetcher(archivePath)
	defer close(fetcher.release)
	runtimeErr := errors.New("runtime unavailable")
	resolver := &waitingAppRuntimeResolver{
		waitForFetch: fetcher.entered,
		called:       make(chan struct{}),
		err:          runtimeErr,
	}
	service := AppCenterService{
		Store:           newAppStoreStub(),
		WorkspaceStore:  &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:          &AppRunner{RuntimeResolver: resolver},
		StateDir:        stateDir,
		ArtifactFetcher: fetcher,
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return []builtinapps.App{{
				Manifest: remoteManifest,
				Distribution: builtinapps.Distribution{
					Kind:           builtinapps.DistributionRemote,
					ArtifactURL:    "https://cdn.example.test/design-app.zip",
					ArtifactSHA256: artifactSHA256,
					IconURL:        "https://cdn.example.test/design-app.png",
				},
			}}, nil
		},
	}

	if _, err := service.Install(ctx, "ws-1", "design-app"); err != nil {
		t.Fatalf("Install() error = %v", err)
	}
	select {
	case <-resolver.called:
	case <-time.After(time.Second):
		t.Fatal("runtime preload did not start")
	}

	deadline := time.After(time.Second)
	for {
		job, ok := service.installJob("ws-1", "design-app")
		if ok && job.Status == workspaceAppInstallJobFailed {
			if !strings.Contains(job.FailureReason, runtimeErr.Error()) {
				t.Fatalf("FailureReason = %q, want runtime preload error", job.FailureReason)
			}
			if job.FailurePhase != workspacebiz.AppFailurePhaseDownloading {
				t.Fatalf("FailurePhase = %q, want downloading", job.FailurePhase)
			}
			return
		}
		select {
		case <-deadline:
			t.Fatal("install job did not fail after runtime preload error; package download was not canceled")
		case <-time.After(10 * time.Millisecond):
		}
	}
}
