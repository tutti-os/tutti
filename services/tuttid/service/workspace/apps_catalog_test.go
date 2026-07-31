package workspace

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	builtinapps "github.com/tutti-os/tutti/services/tuttid/builtin-apps"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

func TestAppCenterServiceListDoesNotPreloadRuntimeForUninstalledApps(t *testing.T) {
	t.Parallel()

	store := newAppStoreStub()
	appPackage := workspacebiz.AppPackage{
		AppID:   "local-app",
		Version: "1.0.0",
		Manifest: workspacebiz.AppManifest{
			SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
			AppID:         "local-app",
			Version:       "1.0.0",
			Name:          "Local App",
			Runtime: workspacebiz.AppManifestRuntime{
				Bootstrap:       "bootstrap.sh",
				HealthcheckPath: "/",
			},
		},
		Source: workspacebiz.AppPackageSourceGenerated,
	}
	if err := store.PutAppPackage(context.Background(), appPackage); err != nil {
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

	apps, err := service.List(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(apps) != 1 || apps[0].Installation != nil {
		t.Fatalf("List() apps = %#v", apps)
	}
	assertRuntimeResolverNotCalled(t, resolver)
}

func TestAppCenterServiceRefreshCatalogDoesNotPreloadRuntimeForUninstalledApps(t *testing.T) {
	t.Parallel()

	store := newAppStoreStub()
	appPackage := workspacebiz.AppPackage{
		AppID:   "local-app",
		Version: "1.0.0",
		Manifest: workspacebiz.AppManifest{
			SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
			AppID:         "local-app",
			Version:       "1.0.0",
			Name:          "Local App",
			Runtime: workspacebiz.AppManifestRuntime{
				Bootstrap:       "bootstrap.sh",
				HealthcheckPath: "/",
			},
		},
		Source: workspacebiz.AppPackageSourceGenerated,
	}
	if err := store.PutAppPackage(context.Background(), appPackage); err != nil {
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

	apps, err := service.RefreshCatalog(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("RefreshCatalog() error = %v", err)
	}
	if len(apps) != 1 || apps[0].Installation != nil {
		t.Fatalf("RefreshCatalog() apps = %#v", apps)
	}
	assertRuntimeResolverNotCalled(t, resolver)
}

func TestAppCenterServiceListSkipsRuntimePreloadForUninstalledStandaloneApp(t *testing.T) {
	t.Parallel()

	store := newAppStoreStub()
	appPackage := workspacebiz.AppPackage{
		AppID:   "standalone-app",
		Version: "1.0.0",
		Manifest: workspacebiz.AppManifest{
			SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
			AppID:         "standalone-app",
			Version:       "1.0.0",
			Name:          "Standalone App",
			Runtime: workspacebiz.AppManifestRuntime{
				Bootstrap:       "bootstrap.sh",
				HealthcheckPath: "/",
				Profile:         workspaceAppStandaloneRuntimeProfile,
			},
		},
		Source: workspacebiz.AppPackageSourceGenerated,
	}
	if err := store.PutAppPackage(context.Background(), appPackage); err != nil {
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

	apps, err := service.List(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(apps) != 1 || apps[0].Installation != nil {
		t.Fatalf("List() apps = %#v", apps)
	}
	assertRuntimeResolverNotCalled(t, resolver)
}

func TestAppCenterServiceListSkipsRuntimePreloadWhenAllAppsInstalled(t *testing.T) {
	t.Parallel()

	store := newAppStoreStub()
	appPackage := workspacebiz.AppPackage{
		AppID:   "installed-app",
		Version: "1.0.0",
		Manifest: workspacebiz.AppManifest{
			SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
			AppID:         "installed-app",
			Version:       "1.0.0",
			Name:          "Installed App",
			Runtime: workspacebiz.AppManifestRuntime{
				Bootstrap:       "bootstrap.sh",
				HealthcheckPath: "/",
			},
		},
		Source: workspacebiz.AppPackageSourceGenerated,
	}
	if err := store.PutAppPackage(context.Background(), appPackage); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	if err := store.PutWorkspaceAppInstallation(context.Background(), workspacebiz.AppInstallation{
		WorkspaceID: "ws-1",
		AppID:       appPackage.AppID,
		Enabled:     true,
	}); err != nil {
		t.Fatalf("PutWorkspaceAppInstallation() error = %v", err)
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

	apps, err := service.List(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(apps) != 1 || apps[0].Installation == nil {
		t.Fatalf("List() apps = %#v", apps)
	}
	assertRuntimeResolverNotCalled(t, resolver)
}

func TestAppCenterServiceInitializesBuiltinCatalogAndInstallState(t *testing.T) {
	t.Setenv("TUTTI_APP_CATALOG_URL", "")

	store := newAppStoreStub()
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{HealthcheckTimeout: 3 * time.Second},
		StateDir:       t.TempDir(),
	}

	if err := service.InitBuiltinPackages(context.Background()); err != nil {
		t.Fatalf("InitBuiltinPackages() error = %v", err)
	}

	apps, err := service.List(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	onboarding := findWorkspaceAppForTest(apps, "tutti-onboarding")
	if onboarding == nil {
		t.Fatalf("List() = %#v, want embedded onboarding", apps)
		return
	}
	if onboarding.Package.Manifest.Runtime.Profile != workspaceAppStandaloneRuntimeProfile {
		t.Fatalf("onboarding runtime profile = %q, want standalone", onboarding.Package.Manifest.Runtime.Profile)
	}
	if onboarding.Package.Manifest.CLI == nil || onboarding.Package.Manifest.CLI.Manifest != "tutti.cli.json" {
		t.Fatalf("onboarding cli manifest = %#v, want tutti.cli.json", onboarding.Package.Manifest.CLI)
	}
	if _, err := os.Stat(filepath.Join(onboarding.Package.PackageDir, "bin", "darwin-arm64", "tutti-onboarding-server")); err != nil {
		t.Fatalf("onboarding embedded server missing: %v", err)
	}
}

func TestAppCenterServiceInitializesBuiltinPackagesWhenRemoteCatalogFails(t *testing.T) {
	t.Setenv("TUTTI_APP_CATALOG_FILE", "")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "unavailable", http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)
	t.Setenv("TUTTI_APP_CATALOG_URL", server.URL+"/catalog.json")

	store := newAppStoreStub()
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{HealthcheckTimeout: 3 * time.Second},
		StateDir:       t.TempDir(),
	}

	if err := service.InitBuiltinPackages(context.Background()); err != nil {
		t.Fatalf("InitBuiltinPackages() error = %v", err)
	}
	if packages, err := store.ListAppPackages(context.Background()); err != nil {
		t.Fatalf("ListAppPackages() error = %v", err)
	} else if len(packages) != 1 || packages[0].AppID != "tutti-onboarding" {
		t.Fatalf("ListAppPackages() = %#v, want embedded onboarding package", packages)
	}
	state := service.CatalogLoadState()
	if state.Status != workspacebiz.AppCatalogLoadStatusLoading && state.Status != workspacebiz.AppCatalogLoadStatusFailed {
		t.Fatalf("CatalogLoadState() = %#v, want loading or failed", state)
	}
}

func TestAppCenterServiceAppCatalogRemoteURLFollowsPreferenceChannel(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := AppCenterService{}
	if got := service.appCatalogRemoteURL(ctx); got != builtinapps.ProductionRemoteCatalogURL {
		t.Fatalf("appCatalogRemoteURL() = %q, want production URL", got)
	}

	service.PreferencesStore = appCenterPreferencesStoreStub{
		preferences: preferencesbiz.DesktopPreferences{
			AppCatalogChannel: "staging",
		},
	}
	if got := service.appCatalogRemoteURL(ctx); got != builtinapps.StagingRemoteCatalogURL {
		t.Fatalf("appCatalogRemoteURL() = %q, want staging URL", got)
	}

	service.PreferencesStore = appCenterPreferencesStoreStub{err: errors.New("preferences unavailable")}
	if got := service.appCatalogRemoteURL(ctx); got != builtinapps.ProductionRemoteCatalogURL {
		t.Fatalf("appCatalogRemoteURL() with preference error = %q, want production URL", got)
	}
}

func TestAppCenterServiceListsRemoteBuiltinBeforeDownloadAndMaterializesOnDemand(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
	sourceDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "large-builtin",
		Version:       "1.0.0",
		Name:          "Large Builtin",
		Description:   "Large app",
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
	if err := createAppPackageZip(sourceDir, archivePath); err != nil {
		t.Fatalf("createAppPackageZip() error = %v", err)
	}
	sha256Value, _, err := fileSHA256AndSize(archivePath)
	if err != nil {
		t.Fatalf("fileSHA256AndSize() error = %v", err)
	}
	iconURL := "https://cdn.example.test/large-builtin.png"
	fileServer := httptest.NewServer(http.FileServer(http.Dir(filepath.Dir(archivePath))))
	t.Cleanup(fileServer.Close)
	sourceManifest := mustReadManifestForTest(t, sourceDir)

	store := newAppStoreStub()
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       stateDir,
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return []builtinapps.App{{
				Manifest: sourceManifest,
				Localizations: []workspacebiz.AppManifestLocalization{
					{
						Locale:      "zh-CN",
						Name:        "大型内置应用",
						Description: "大型应用",
						Tags:        []string{"内置", "工作区"},
					},
				},
				Distribution: builtinapps.Distribution{
					Kind:           builtinapps.DistributionRemote,
					ArtifactURL:    fileServer.URL + "/" + filepath.Base(archivePath),
					ArtifactSHA256: sha256Value,
					IconURL:        iconURL,
				},
			}}, nil
		},
	}

	apps, err := service.List(ctx, "ws-1")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	remoteApp := findWorkspaceAppForTest(apps, "large-builtin")
	if remoteApp == nil || remoteApp.Package.PackageDir != "" || remoteApp.Installation != nil {
		t.Fatalf("remote builtin projection = %#v", remoteApp)
	}
	if actualIconURL := remoteApp.ResolvedIconURL(); actualIconURL == nil || *actualIconURL != iconURL {
		t.Fatalf("remote builtin icon url = %v, want %q", actualIconURL, iconURL)
	}
	localizations := remoteApp.Package.Localizations()
	if len(localizations) != 1 || localizations[0].Locale != "zh-CN" || localizations[0].Name != "大型内置应用" {
		t.Fatalf("remote builtin localizations = %#v", localizations)
	}
	if _, err := store.GetAppPackage(ctx, "large-builtin"); !errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
		t.Fatalf("GetAppPackage() before materialize error = %v", err)
	}

	appPackage, err := service.materializeRemoteBuiltinPackage(ctx, "large-builtin")
	if err != nil {
		t.Fatalf("materializeRemoteBuiltinPackage() error = %v", err)
	}
	if appPackage.PackageDir == "" || appPackage.Source != workspacebiz.AppPackageSourceBuiltin {
		t.Fatalf("materialized package = %#v", appPackage)
	}
	if actualIconURL := appPackage.IconDataURL(); actualIconURL == nil || !strings.HasPrefix(*actualIconURL, "data:image/png;base64,") {
		t.Fatalf("materialized remote builtin package icon = %v", actualIconURL)
	}
	if _, err := os.Stat(filepath.Join(appPackage.PackageDir, "tutti.app.json")); err != nil {
		t.Fatalf("materialized manifest missing: %v", err)
	}
	apps, err = service.List(ctx, "ws-1")
	if err != nil {
		t.Fatalf("List() after materialize error = %v", err)
	}
	remoteApp = findWorkspaceAppForTest(apps, "large-builtin")
	if remoteApp == nil {
		t.Fatalf("remote builtin missing after materialize: %#v", apps)
		return
	}
	if actualIconURL := remoteApp.ResolvedIconURL(); actualIconURL == nil || *actualIconURL != iconURL {
		t.Fatalf("listed materialized remote builtin icon url = %v, want %q", actualIconURL, iconURL)
	}
}

func TestAppCenterServiceListHidesUninstalledBuiltinMissingFromReadyCatalog(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppStoreStub()
	if err := store.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:   "retired-builtin",
		Version: "1.0.0",
		Manifest: workspacebiz.AppManifest{
			SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
			AppID:         "retired-builtin",
			Version:       "1.0.0",
			Name:          "Retired Builtin",
			Runtime: workspacebiz.AppManifestRuntime{
				Bootstrap:       "bootstrap.sh",
				HealthcheckPath: "/",
			},
		},
		Source: workspacebiz.AppPackageSourceBuiltin,
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
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

	apps, err := service.List(ctx, "ws-1")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if app := findWorkspaceAppForTest(apps, "retired-builtin"); app != nil {
		t.Fatalf("retired builtin should be hidden, got %#v", app)
	}
	if _, err := store.GetAppPackage(ctx, "retired-builtin"); err != nil {
		t.Fatalf("stale builtin package should remain cached, GetAppPackage() error = %v", err)
	}
}

func TestAppCenterServiceListKeepsInstalledBuiltinMissingFromReadyCatalog(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppStoreStub()
	if err := store.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:   "retired-builtin",
		Version: "1.0.0",
		Manifest: workspacebiz.AppManifest{
			SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
			AppID:         "retired-builtin",
			Version:       "1.0.0",
			Name:          "Retired Builtin",
			Runtime: workspacebiz.AppManifestRuntime{
				Bootstrap:       "bootstrap.sh",
				HealthcheckPath: "/",
			},
		},
		Source: workspacebiz.AppPackageSourceBuiltin,
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	if err := store.PutWorkspaceAppInstallation(ctx, workspacebiz.AppInstallation{
		WorkspaceID: "ws-1",
		AppID:       "retired-builtin",
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

	apps, err := service.List(ctx, "ws-1")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	app := findWorkspaceAppForTest(apps, "retired-builtin")
	if app == nil || app.Installation == nil {
		t.Fatalf("installed retired builtin should remain visible, got %#v", app)
	}
}

func TestAppCenterServiceListKeepsCachedBuiltinWhenCatalogNotReady(t *testing.T) {
	t.Setenv("TUTTI_APP_CATALOG_FILE", "")
	t.Setenv("TUTTI_APP_CATALOG_URL", "")

	ctx := context.Background()
	store := newAppStoreStub()
	if err := store.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:   "cached-builtin",
		Version: "1.0.0",
		Manifest: workspacebiz.AppManifest{
			SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
			AppID:         "cached-builtin",
			Version:       "1.0.0",
			Name:          "Cached Builtin",
			Runtime: workspacebiz.AppManifestRuntime{
				Bootstrap:       "bootstrap.sh",
				HealthcheckPath: "/",
			},
		},
		Source: workspacebiz.AppPackageSourceBuiltin,
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       t.TempDir(),
	}

	apps, err := service.List(ctx, "ws-1")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if app := findWorkspaceAppForTest(apps, "cached-builtin"); app == nil {
		t.Fatalf("cached builtin should remain visible while catalog is not ready: %#v", apps)
	}
}

func TestWorkspaceAppFromPackageMarksRunningOldPackagePendingRestart(t *testing.T) {
	packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		AppID:         "local-app",
		Name:          "Local App",
		Version:       "1.1.0",
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/",
		},
	})
	runner := &AppRunner{}
	runner.setState(appRuntimeKey("ws-1", "local-app"), workspacebiz.AppRuntimeState{
		Status:     workspacebiz.AppRuntimeStatusRunning,
		LaunchURL:  stringPointer("http://127.0.0.1:3000"),
		PackageDir: filepath.Join(t.TempDir(), "local-app", "1.0.0"),
	})
	service := AppCenterService{
		Runner: runner,
	}

	app := service.workspaceAppFromPackage(workspacebiz.AppPackage{
		AppID:      "local-app",
		Manifest:   workspacebiz.AppManifest{AppID: "local-app", Version: "1.1.0"},
		PackageDir: packageDir,
		Version:    "1.1.0",
	}, workspacebiz.AppInstallation{
		AppID:       "local-app",
		Enabled:     true,
		WorkspaceID: "ws-1",
	}, true, "ws-1")

	if app.Runtime.Status != workspacebiz.AppRuntimeStatusInstalledPendingRestart {
		t.Fatalf("runtime status = %q, want %q", app.Runtime.Status, workspacebiz.AppRuntimeStatusInstalledPendingRestart)
	}
	if app.Runtime.LaunchURL == nil || *app.Runtime.LaunchURL != "http://127.0.0.1:3000" {
		t.Fatalf("runtime launch URL = %v, want old running launch URL", app.Runtime.LaunchURL)
	}
}
