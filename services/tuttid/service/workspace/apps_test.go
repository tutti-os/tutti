package workspace

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	builtinapps "github.com/tutti-os/tutti/services/tuttid/builtin-apps"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

type appStoreStub struct {
	packages        map[string]workspacebiz.AppPackage
	packageVersions map[string]map[string]workspacebiz.AppPackage
	installations   map[string]workspacebiz.AppInstallation
}

type workspaceAppPublisherStub struct {
	published  []workspacebiz.WorkspaceApp
	workspaces []string
}

type appArtifactFetcherStub struct {
	calls []string
	err   error
}

type appRuntimeResolverStub struct {
	called chan struct{}
	once   sync.Once
	err    error
}

type preloadThenFailRuntimeResolver struct {
	called   chan struct{}
	once     sync.Once
	mu       sync.Mutex
	calls    int
	startErr error
}

type waitingAppRuntimeResolver struct {
	waitForFetch <-chan int
	called       chan struct{}
	once         sync.Once
	err          error
}

func (f *appArtifactFetcherStub) FetchAppArtifact(_ context.Context, artifactURL string, _ string) error {
	f.calls = append(f.calls, artifactURL)
	if f.err != nil {
		return f.err
	}
	return errors.New("unexpected artifact fetch")
}

type blockingArtifactFetcher struct {
	started   chan struct{}
	release   chan struct{}
	done      chan struct{}
	startOnce sync.Once
	doneOnce  sync.Once
}

func newBlockingArtifactFetcher() *blockingArtifactFetcher {
	return &blockingArtifactFetcher{
		started: make(chan struct{}),
		release: make(chan struct{}),
		done:    make(chan struct{}),
	}
}

func (f *blockingArtifactFetcher) FetchAppArtifact(ctx context.Context, _ string, destinationPath string) error {
	f.startOnce.Do(func() {
		close(f.started)
	})
	defer f.doneOnce.Do(func() {
		close(f.done)
	})
	select {
	case <-f.release:
	case <-ctx.Done():
		return ctx.Err()
	}
	return os.WriteFile(destinationPath, []byte("not a zip"), 0o644)
}

type copyingArtifactFetcher struct {
	sourcePath string
	done       chan struct{}
	doneOnce   sync.Once
}

type trackingArtifactFetcher struct {
	sourcePath string
	entered    chan int
	release    chan struct{}

	mu        sync.Mutex
	calls     int
	active    int
	maxActive int
}

func newCopyingArtifactFetcher(sourcePath string) *copyingArtifactFetcher {
	return &copyingArtifactFetcher{
		sourcePath: sourcePath,
		done:       make(chan struct{}),
	}
}

func (f *copyingArtifactFetcher) FetchAppArtifact(_ context.Context, _ string, destinationPath string) error {
	defer f.doneOnce.Do(func() {
		close(f.done)
	})
	data, err := os.ReadFile(f.sourcePath)
	if err != nil {
		return err
	}
	return os.WriteFile(destinationPath, data, 0o644)
}

func newTrackingArtifactFetcher(sourcePath string) *trackingArtifactFetcher {
	return &trackingArtifactFetcher{
		sourcePath: sourcePath,
		entered:    make(chan int, 2),
		release:    make(chan struct{}),
	}
}

func (f *trackingArtifactFetcher) FetchAppArtifact(ctx context.Context, _ string, destinationPath string) error {
	f.mu.Lock()
	f.calls += 1
	call := f.calls
	f.active += 1
	if f.active > f.maxActive {
		f.maxActive = f.active
	}
	f.mu.Unlock()

	f.entered <- call
	defer func() {
		f.mu.Lock()
		f.active -= 1
		f.mu.Unlock()
	}()
	select {
	case <-f.release:
	case <-ctx.Done():
		return ctx.Err()
	}

	data, err := os.ReadFile(f.sourcePath)
	if err != nil {
		return err
	}
	return os.WriteFile(destinationPath, data, 0o644)
}

func (f *trackingArtifactFetcher) MaxActive() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.maxActive
}

func (r *appRuntimeResolverStub) Resolve(context.Context) (ResolvedAppRuntime, error) {
	r.once.Do(func() {
		close(r.called)
	})
	if r.err != nil {
		return ResolvedAppRuntime{}, r.err
	}
	return ResolvedAppRuntime{}, nil
}

func (r *preloadThenFailRuntimeResolver) Resolve(context.Context) (ResolvedAppRuntime, error) {
	r.once.Do(func() {
		close(r.called)
	})
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls += 1
	if r.calls > 1 && r.startErr != nil {
		return ResolvedAppRuntime{}, r.startErr
	}
	return ResolvedAppRuntime{}, nil
}

func (r *waitingAppRuntimeResolver) Resolve(ctx context.Context) (ResolvedAppRuntime, error) {
	r.once.Do(func() {
		close(r.called)
	})
	select {
	case <-r.waitForFetch:
		return ResolvedAppRuntime{}, r.err
	case <-ctx.Done():
		return ResolvedAppRuntime{}, ctx.Err()
	}
}

func (s *workspaceAppPublisherStub) PublishWorkspaceAppUpdated(_ context.Context, workspaceID string, app workspacebiz.WorkspaceApp) error {
	s.workspaces = append(s.workspaces, workspaceID)
	s.published = append(s.published, app)
	return nil
}

func newAppStoreStub() *appStoreStub {
	return &appStoreStub{
		packages:        make(map[string]workspacebiz.AppPackage),
		packageVersions: make(map[string]map[string]workspacebiz.AppPackage),
		installations:   make(map[string]workspacebiz.AppInstallation),
	}
}

func (s *appStoreStub) PutAppPackage(_ context.Context, appPackage workspacebiz.AppPackage) error {
	if s.packageVersions[appPackage.AppID] == nil {
		s.packageVersions[appPackage.AppID] = make(map[string]workspacebiz.AppPackage)
	}
	s.packageVersions[appPackage.AppID][appPackage.Version] = appPackage
	s.packages[appPackage.AppID] = appPackage
	return nil
}

func (s *appStoreStub) PutAppPackageVersion(_ context.Context, appPackage workspacebiz.AppPackage) error {
	if s.packageVersions[appPackage.AppID] == nil {
		s.packageVersions[appPackage.AppID] = make(map[string]workspacebiz.AppPackage)
	}
	s.packageVersions[appPackage.AppID][appPackage.Version] = appPackage
	return nil
}

func (s *appStoreStub) DeleteAppPackage(_ context.Context, appID string) error {
	if _, ok := s.packages[appID]; !ok {
		return workspacedata.ErrWorkspaceAppNotFound
	}
	delete(s.packages, appID)
	delete(s.packageVersions, appID)
	for key, installation := range s.installations {
		if installation.AppID == appID {
			delete(s.installations, key)
		}
	}
	return nil
}

func (s *appStoreStub) GetAppPackage(_ context.Context, appID string) (workspacebiz.AppPackage, error) {
	appPackage, ok := s.packages[appID]
	if !ok {
		return workspacebiz.AppPackage{}, workspacedata.ErrWorkspaceAppNotFound
	}
	return appPackage, nil
}

func (s *appStoreStub) GetAppPackageVersion(_ context.Context, appID string, version string) (workspacebiz.AppPackage, error) {
	versionPackages, ok := s.packageVersions[appID]
	if !ok {
		return workspacebiz.AppPackage{}, workspacedata.ErrWorkspaceAppNotFound
	}
	appPackage, ok := versionPackages[version]
	if !ok {
		return workspacebiz.AppPackage{}, workspacedata.ErrWorkspaceAppNotFound
	}
	return appPackage, nil
}

func (s *appStoreStub) ListAppPackageVersions(_ context.Context, appID string) ([]workspacebiz.AppPackage, error) {
	versionPackages, ok := s.packageVersions[appID]
	if !ok {
		return nil, nil
	}
	result := make([]workspacebiz.AppPackage, 0, len(versionPackages))
	for _, appPackage := range versionPackages {
		result = append(result, appPackage)
	}
	return result, nil
}

func (s *appStoreStub) ListAppPackages(context.Context) ([]workspacebiz.AppPackage, error) {
	result := make([]workspacebiz.AppPackage, 0, len(s.packages))
	for _, appPackage := range s.packages {
		result = append(result, appPackage)
	}
	return result, nil
}

func (s *appStoreStub) PutWorkspaceAppInstallation(_ context.Context, installation workspacebiz.AppInstallation) error {
	s.installations[installation.WorkspaceID+"\x00"+installation.AppID] = installation
	return nil
}

func (s *appStoreStub) SetActiveAppPackageVersion(_ context.Context, appID string, version string) error {
	appPackage, err := s.GetAppPackageVersion(context.Background(), appID, version)
	if err != nil {
		return workspacedata.ErrWorkspaceAppNotFound
	}
	s.packages[appID] = appPackage
	return nil
}

func (s *appStoreStub) DeleteWorkspaceAppInstallation(_ context.Context, workspaceID string, appID string) error {
	key := workspaceID + "\x00" + appID
	if _, ok := s.installations[key]; !ok {
		return workspacedata.ErrWorkspaceAppNotFound
	}
	delete(s.installations, key)
	return nil
}

func (s *appStoreStub) ListWorkspaceAppInstallations(_ context.Context, workspaceID string) ([]workspacebiz.AppInstallation, error) {
	var result []workspacebiz.AppInstallation
	for _, installation := range s.installations {
		if installation.WorkspaceID == workspaceID {
			result = append(result, installation)
		}
	}
	return result, nil
}

func (s *appStoreStub) ListWorkspaceAppInstallationsByApp(_ context.Context, appID string) ([]workspacebiz.AppInstallation, error) {
	var result []workspacebiz.AppInstallation
	for _, installation := range s.installations {
		if installation.AppID == appID {
			result = append(result, installation)
		}
	}
	return result, nil
}

func TestAppCenterServiceListPreloadsRuntimeForUninstalledApps(t *testing.T) {
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
	select {
	case <-resolver.called:
	case <-time.After(time.Second):
		t.Fatalf("List() did not preload runtime for uninstalled app")
	}
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
	select {
	case <-resolver.called:
		t.Fatalf("List() preloaded runtime when all apps are installed")
	default:
	}
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
	automationApp := findWorkspaceAppForTest(apps, "automation")
	if len(apps) != 1 || automationApp == nil {
		t.Fatalf("List() = %#v", apps)
	}
	if automationApp.Installation != nil || automationApp.Runtime.Status != workspacebiz.AppRuntimeStatusIdle {
		t.Fatalf("automation app = %#v", automationApp)
	}
	automation, err := store.GetAppPackage(context.Background(), "automation")
	if err != nil {
		t.Fatalf("GetAppPackage(automation) error = %v", err)
	}
	if automation.Manifest.Author == nil || automation.Manifest.Author.Name != "Tutti" || len(automation.Manifest.Tags) != 2 || !strings.Contains(automation.ManifestJSON, `"tags"`) {
		t.Fatalf("automation manifest = %#v, manifestJSON=%q", automation.Manifest, automation.ManifestJSON)
	}
	if iconURL := automation.IconDataURL(); iconURL == nil || !strings.HasPrefix(*iconURL, "data:image/png;base64,") {
		t.Fatalf("automation icon data URL = %v", iconURL)
	}
	if _, err := os.Stat(filepath.Join(automation.PackageDir, "icon.png")); err != nil {
		t.Fatalf("automation icon missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(automation.PackageDir, "tutti.cli.json")); err != nil {
		t.Fatalf("automation cli manifest missing: %v", err)
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
	if _, err := store.GetAppPackage(context.Background(), "automation"); err != nil {
		t.Fatalf("GetAppPackage(automation) error = %v", err)
	}
	state := service.CatalogLoadState()
	if state.Status != workspacebiz.AppCatalogLoadStatusLoading && state.Status != workspacebiz.AppCatalogLoadStatusFailed {
		t.Fatalf("CatalogLoadState() = %#v, want loading or failed", state)
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

	store := newAppStoreStub()
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       stateDir,
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return []builtinapps.App{{
				Manifest: mustReadManifestForTest(t, sourceDir),
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

func TestAppCenterServiceRemoteBuiltinInstallCachesUpdateWithoutActivating(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
	oldDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "large-builtin",
		Version:       "1.0.0",
		Name:          "Large Builtin",
		Description:   "Old large app",
		Icon: workspacebiz.AppManifestIcon{
			Type: "asset",
			Src:  "icon.png",
		},
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/",
		},
	})
	newDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
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
	if err := createAppPackageZip(newDir, archivePath); err != nil {
		t.Fatalf("createAppPackageZip() error = %v", err)
	}
	sha256Value, _, err := fileSHA256AndSize(archivePath)
	if err != nil {
		t.Fatalf("fileSHA256AndSize() error = %v", err)
	}
	fileServer := httptest.NewServer(http.FileServer(http.Dir(filepath.Dir(archivePath))))
	t.Cleanup(fileServer.Close)
	remoteBuiltin := builtinapps.App{
		Manifest: mustReadManifestForTest(t, newDir),
		Distribution: builtinapps.Distribution{
			Kind:           builtinapps.DistributionRemote,
			ArtifactURL:    fileServer.URL + "/" + filepath.Base(archivePath),
			ArtifactSHA256: sha256Value,
			IconURL:        fileServer.URL + "/icon.png",
		},
	}

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
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       stateDir,
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return []builtinapps.App{remoteBuiltin}, nil
		},
	}

	appPackage, err := service.packageForRemoteBuiltinInstall(ctx, remoteBuiltin)
	if err != nil {
		t.Fatalf("packageForRemoteBuiltinInstall() error = %v", err)
	}
	if appPackage.Version != "1.1.0" {
		t.Fatalf("packageForRemoteBuiltinInstall() version = %q, want 1.1.0", appPackage.Version)
	}
	stored, err := store.GetAppPackage(ctx, "large-builtin")
	if err != nil {
		t.Fatalf("GetAppPackage() error = %v", err)
	}
	if stored.Version != "1.0.0" || stored.PackageDir != oldDir {
		t.Fatalf("active package after cache = %#v, want old active package", stored)
	}
	cached, err := store.GetAppPackageVersion(ctx, "large-builtin", "1.1.0")
	if err != nil {
		t.Fatalf("GetAppPackageVersion(1.1.0) error = %v", err)
	}
	if cached.PackageDir == oldDir {
		t.Fatalf("cached package dir = %q, want new package dir", cached.PackageDir)
	}
	if actualIconURL := cached.IconDataURL(); actualIconURL == nil || !strings.HasPrefix(*actualIconURL, "data:image/png;base64,") {
		t.Fatalf("synced remote builtin icon url = %v", actualIconURL)
	}
}

func TestAppCenterServiceStartEnabledSkipsUninstalledRemoteBuiltinUpdate(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	oldDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "large-builtin",
		Version:       "1.0.0",
		Name:          "Large Builtin",
		Description:   "Old large app",
		Icon: workspacebiz.AppManifestIcon{
			Type: "asset",
			Src:  "icon.png",
		},
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
	fetcher := &appArtifactFetcherStub{}
	service := AppCenterService{
		Store:           store,
		WorkspaceStore:  &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:          &AppRunner{},
		StateDir:        t.TempDir(),
		ArtifactFetcher: fetcher,
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

	apps, err := service.StartEnabled(ctx, "ws-1")
	if err != nil {
		t.Fatalf("StartEnabled() error = %v", err)
	}
	if len(fetcher.calls) != 0 {
		t.Fatalf("artifact fetch calls = %#v, want none", fetcher.calls)
	}
	stored, err := store.GetAppPackage(ctx, "large-builtin")
	if err != nil {
		t.Fatalf("GetAppPackage() error = %v", err)
	}
	if stored.Version != "1.0.0" {
		t.Fatalf("stored package version = %q, want old cached version", stored.Version)
	}
	app := findWorkspaceAppForTest(apps, "large-builtin")
	if app == nil || app.Installation != nil || app.UpdateAvailable || app.Package.Version != "1.1.0" {
		t.Fatalf("remote builtin projection = %#v", app)
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

func TestAppCenterServiceStartEnabledDoesNotBlockOnRemoteBuiltinUpdate(t *testing.T) {
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
	fetcher := newBlockingArtifactFetcher()
	resolver := &preloadThenFailRuntimeResolver{called: make(chan struct{}), startErr: errors.New("skip runtime")}
	service := AppCenterService{
		Store:           store,
		WorkspaceStore:  &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:          &AppRunner{RuntimeResolver: resolver},
		StateDir:        t.TempDir(),
		ArtifactFetcher: fetcher,
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
		app := findWorkspaceAppForTest(result.apps, "large-builtin")
		if app == nil || app.Installation == nil || app.Package.Version != "1.0.0" {
			t.Fatalf("StartEnabled() app = %#v", app)
		}
	case <-fetcher.started:
		select {
		case result := <-resultCh:
			if result.err != nil {
				t.Fatalf("StartEnabled() error = %v", result.err)
			}
		case <-time.After(100 * time.Millisecond):
			close(fetcher.release)
			t.Fatal("StartEnabled() blocked on remote builtin artifact download")
		}
	case <-time.After(time.Second):
		close(fetcher.release)
		t.Fatal("StartEnabled() did not return")
	}

	select {
	case <-fetcher.started:
	case <-time.After(time.Second):
		close(fetcher.release)
		t.Fatal("background remote builtin sync did not start")
	}
	progress := waitForInstallJobProgressForTest(t, &service, "ws-1", "large-builtin")
	if progress.UserPhase != workspacebiz.AppInstallUserPhaseDownloading {
		close(fetcher.release)
		t.Fatalf("auto update install progress user phase = %q, want downloading", progress.UserPhase)
	}
	close(fetcher.release)
	select {
	case <-fetcher.done:
	case <-time.After(time.Second):
		t.Fatal("background remote builtin sync did not finish")
	}
}

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
				Manifest: mustReadManifestForTest(t, remoteDir),
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

	store := newAppStoreStub()
	missingPackageDir := filepath.Join(t.TempDir(), "missing-large-builtin")
	if err := store.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:      "large-builtin",
		Version:    "1.1.0",
		PackageDir: missingPackageDir,
		Manifest:   mustReadManifestForTest(t, remoteDir),
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
				Manifest: mustReadManifestForTest(t, remoteDir),
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
	if app == nil || app.Installation == nil || app.Package.PackageDir != missingPackageDir {
		t.Fatalf("StartEnabled() initial app = %#v", app)
	}
	active := waitForActiveAppPackageDirChangeForTest(t, store, "large-builtin", missingPackageDir)
	if err := validateExtractedAppPackage(active.PackageDir, active.Manifest); err != nil {
		t.Fatalf("repaired package validation error = %v", err)
	}
	waitForRunnerStatus(t, runner, "ws-1", "large-builtin", workspacebiz.AppRuntimeStatusFailed)
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
	if err := validateExtractedAppPackage(packageDir, mustReadManifestForTest(t, packageDir)); err != nil {
		t.Fatalf("copied package validation error = %v", err)
	}
}

func TestAppCenterServicePackageForInstallRepairsMissingRemoteBuiltinCache(t *testing.T) {
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

	store := newAppStoreStub()
	missingPackageDir := filepath.Join(t.TempDir(), "missing-large-builtin")
	if err := store.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:      "large-builtin",
		Version:    "1.1.0",
		PackageDir: missingPackageDir,
		Manifest:   mustReadManifestForTest(t, remoteDir),
		Source:     workspacebiz.AppPackageSourceBuiltin,
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	fetcher := newCopyingArtifactFetcher(archivePath)
	service := AppCenterService{
		Store:           store,
		WorkspaceStore:  &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		StateDir:        stateDir,
		ArtifactFetcher: fetcher,
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return []builtinapps.App{{
				Manifest: mustReadManifestForTest(t, remoteDir),
				Distribution: builtinapps.Distribution{
					Kind:           builtinapps.DistributionRemote,
					ArtifactURL:    "https://cdn.example.test/large-builtin.zip",
					ArtifactSHA256: artifactSHA256,
					IconURL:        "https://cdn.example.test/large-builtin.png",
				},
			}}, nil
		},
	}

	appPackage, err := service.packageForInstall(ctx, "large-builtin")
	if err != nil {
		t.Fatalf("packageForInstall() error = %v", err)
	}
	if appPackage.PackageDir == missingPackageDir {
		t.Fatalf("packageForInstall() reused missing package dir %q", missingPackageDir)
	}
	if err := validateExtractedAppPackage(appPackage.PackageDir, appPackage.Manifest); err != nil {
		t.Fatalf("repaired package validation error = %v", err)
	}
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
	resolver := &preloadThenFailRuntimeResolver{called: make(chan struct{}), startErr: errors.New("skip runtime")}
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

func TestAppCenterServiceListExposesInstalledRemoteBuiltinUpdate(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	oldDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "large-builtin",
		Version:       "1.0.0",
		Name:          "Large Builtin",
		Description:   "Old large app",
		Icon: workspacebiz.AppManifestIcon{
			Type: "asset",
			Src:  "icon.png",
		},
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/",
		},
	})
	remoteManifest := mustReadManifestForTest(t, oldDir)
	remoteManifest.Version = "1.1.0"
	iconURL := "https://cdn.example.test/large-builtin.png"

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
					IconURL:        iconURL,
				},
			}}, nil
		},
	}

	apps, err := service.List(ctx, "ws-1")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	app := findWorkspaceAppForTest(apps, "large-builtin")
	if app == nil {
		t.Fatalf("large-builtin missing: %#v", apps)
	}
	if app.Package.Version != "1.0.0" || !app.UpdateAvailable || app.AvailableVersion == nil || *app.AvailableVersion != "1.1.0" {
		t.Fatalf("installed remote builtin update projection = %#v", app)
	}
	if app.AvailableIconURL == nil || *app.AvailableIconURL != iconURL {
		t.Fatalf("available icon url = %v, want %q", app.AvailableIconURL, iconURL)
	}
}

func TestAppCenterServiceCachedRemoteBuiltinUpdateDoesNotReplaceActiveInstall(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	oldDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "large-builtin",
		Version:       "1.0.0",
		Name:          "Large Builtin v1",
		Description:   "Old large app",
		Icon: workspacebiz.AppManifestIcon{
			Type: "asset",
			Src:  "icon.png",
		},
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/",
		},
	})
	newDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "large-builtin",
		Version:       "1.1.0",
		Name:          "Large Builtin v2",
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
	if err := createAppPackageZip(newDir, archivePath); err != nil {
		t.Fatalf("createAppPackageZip() error = %v", err)
	}
	archiveSHA256, _, err := fileSHA256AndSize(archivePath)
	if err != nil {
		t.Fatalf("fileSHA256AndSize() error = %v", err)
	}
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
		ArtifactFetcher: newCopyingArtifactFetcher(
			archivePath,
		),
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return []builtinapps.App{{
				Manifest: mustReadManifestForTest(t, newDir),
				Distribution: builtinapps.Distribution{
					Kind:           builtinapps.DistributionRemote,
					ArtifactURL:    "https://cdn.example.test/large-builtin.zip",
					ArtifactSHA256: archiveSHA256,
					IconURL:        "https://cdn.example.test/large-builtin.png",
				},
			}}, nil
		},
	}

	builtins, err := service.BuiltinCatalog()
	if err != nil {
		t.Fatalf("BuiltinCatalog() error = %v", err)
	}
	if _, err := service.packageForRemoteBuiltinInstall(ctx, builtins[0]); err != nil {
		t.Fatalf("packageForRemoteBuiltinInstall() error = %v", err)
	}
	active, err := store.GetAppPackage(ctx, "large-builtin")
	if err != nil {
		t.Fatalf("GetAppPackage() error = %v", err)
	}
	if active.Version != "1.0.0" {
		t.Fatalf("active package version = %q, want 1.0.0", active.Version)
	}
	if _, err := store.GetAppPackageVersion(ctx, "large-builtin", "1.1.0"); err != nil {
		t.Fatalf("cached update package missing: %v", err)
	}
	if _, err := service.packageForRemoteBuiltinInstall(ctx, builtins[0]); err != nil {
		t.Fatalf("packageForRemoteBuiltinInstall(cached) error = %v", err)
	}
	active, err = store.GetAppPackage(ctx, "large-builtin")
	if err != nil {
		t.Fatalf("GetAppPackage() after cached resolve error = %v", err)
	}
	if active.Version != "1.0.0" {
		t.Fatalf("active package after cached resolve = %q, want 1.0.0", active.Version)
	}

	apps, err := service.List(ctx, "ws-1")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	app := findWorkspaceAppForTest(apps, "large-builtin")
	if app == nil {
		t.Fatalf("large-builtin missing: %#v", apps)
	}
	if app.Package.Version != "1.0.0" || app.Package.DisplayName() != "Large Builtin v1" {
		t.Fatalf("projected active package = version %q name %q, want v1", app.Package.Version, app.Package.DisplayName())
	}
	if !app.UpdateAvailable || app.AvailableVersion == nil || *app.AvailableVersion != "1.1.0" {
		t.Fatalf("projected update fields = updateAvailable %v availableVersion %v, want v2 update", app.UpdateAvailable, app.AvailableVersion)
	}
}

func TestAppCenterServiceListsRemoteBuiltinWhenOlderLocalPackageExists(t *testing.T) {
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

	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       t.TempDir(),
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return []builtinapps.App{{
				Manifest: workspacebiz.AppManifest{
					SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
					AppID:         "design-app",
					Version:       "0.1.0+abc123",
					Name:          "Design App",
					Description:   "Remote design app",
					Icon: workspacebiz.AppManifestIcon{
						Type: "asset",
						Src:  "icon.png",
					},
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

	apps, err := service.List(ctx, "ws-1")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	app := findWorkspaceAppForTest(apps, "design-app")
	if app == nil {
		t.Fatalf("design app missing: %#v", apps)
	}
	if app.Package.Version != "0.1.0+abc123" || app.Package.PackageDir != "" || app.Package.Description() != "Remote design app" {
		t.Fatalf("design app projection = %#v", app.Package)
	}
	if actualIconURL := app.ResolvedIconURL(); actualIconURL == nil || *actualIconURL != "https://cdn.example.test/design-app.png" {
		t.Fatalf("design app icon url = %v", actualIconURL)
	}
}

func TestAppCenterServiceKeepsUserPackageWhenRemoteBuiltinSharesAppID(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	packageDir := filepath.Join(t.TempDir(), "design-app", "0.1.0")
	store := newAppStoreStub()
	if err := store.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:      "design-app",
		Version:    "0.1.0",
		PackageDir: packageDir,
		Manifest: workspacebiz.AppManifest{
			SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
			AppID:         "design-app",
			Version:       "0.1.0",
			Name:          "Design App",
			Description:   "Imported design app",
			Runtime: workspacebiz.AppManifestRuntime{
				Bootstrap:       "bootstrap.sh",
				HealthcheckPath: "/",
			},
		},
		Source: workspacebiz.AppPackageSourceImported,
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}

	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       t.TempDir(),
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

	apps, err := service.List(ctx, "ws-1")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	app := findWorkspaceAppForTest(apps, "design-app")
	if app == nil {
		t.Fatalf("design app missing: %#v", apps)
	}
	if app.Package.Version != "0.1.0" || app.Package.PackageDir != packageDir || app.Package.Source != workspacebiz.AppPackageSourceImported {
		t.Fatalf("user package projection = %#v", app.Package)
	}
	if app.Package.Description() != "Imported design app" {
		t.Fatalf("user package description = %q", app.Package.Description())
	}
}

func TestAppCenterServiceKeepsInstalledLocalBuiltinRuntimeWhenRemoteBuiltinVersionDiffers(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	packageDir := filepath.Join(t.TempDir(), "design-app", "0.1.0")
	store := newAppStoreStub()
	if err := store.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:      "design-app",
		Version:    "0.1.0",
		PackageDir: packageDir,
		Manifest: workspacebiz.AppManifest{
			SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
			AppID:         "design-app",
			Version:       "0.1.0",
			Name:          "Design App",
			Description:   "Installed design app",
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
		AppID:       "design-app",
		Enabled:     true,
	}); err != nil {
		t.Fatalf("PutWorkspaceAppInstallation() error = %v", err)
	}
	runner := &AppRunner{}
	runner.setState(appRuntimeKey("ws-1", "design-app"), workspacebiz.AppRuntimeState{
		Status: workspacebiz.AppRuntimeStatusRunning,
	})

	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         runner,
		StateDir:       t.TempDir(),
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

	apps, err := service.List(ctx, "ws-1")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	app := findWorkspaceAppForTest(apps, "design-app")
	if app == nil {
		t.Fatalf("design app missing: %#v", apps)
	}
	if app.Package.Version != "0.1.0" || app.Package.PackageDir != packageDir || app.Installation == nil {
		t.Fatalf("installed package projection = %#v", app)
	}
	if app.Runtime.Status != workspacebiz.AppRuntimeStatusRunning {
		t.Fatalf("installed package runtime status = %q", app.Runtime.Status)
	}
}

func TestAppCenterServiceResolvesRemoteBuiltinForInstallWhenOlderLocalPackageExists(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
	remoteSourceDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "design-app",
		Version:       "0.1.0+abc123",
		Name:          "Design App",
		Description:   "Remote design app",
		Icon: workspacebiz.AppManifestIcon{
			Type: "asset",
			Src:  "icon.png",
		},
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/",
		},
	})
	archivePath := filepath.Join(t.TempDir(), "design-app.zip")
	if err := createAppPackageZip(remoteSourceDir, archivePath); err != nil {
		t.Fatalf("createAppPackageZip() error = %v", err)
	}
	sha256Value, _, err := fileSHA256AndSize(archivePath)
	if err != nil {
		t.Fatalf("fileSHA256AndSize() error = %v", err)
	}
	fileServer := httptest.NewServer(http.FileServer(http.Dir(filepath.Dir(archivePath))))
	t.Cleanup(fileServer.Close)

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

	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		StateDir:       stateDir,
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return []builtinapps.App{{
				Manifest: mustReadManifestForTest(t, remoteSourceDir),
				Distribution: builtinapps.Distribution{
					Kind:           builtinapps.DistributionRemote,
					ArtifactURL:    fileServer.URL + "/" + filepath.Base(archivePath),
					ArtifactSHA256: sha256Value,
					IconURL:        "https://cdn.example.test/design-app.png",
				},
			}}, nil
		},
	}

	appPackage, err := service.packageForInstall(ctx, "design-app")
	if err != nil {
		t.Fatalf("packageForInstall() error = %v", err)
	}
	if appPackage.Version != "0.1.0+abc123" {
		t.Fatalf("install package version = %q, want remote version", appPackage.Version)
	}
	activePackage, err := store.GetAppPackage(ctx, "design-app")
	if err != nil {
		t.Fatalf("GetAppPackage() error = %v", err)
	}
	if activePackage.Version != "0.1.0" {
		t.Fatalf("active package = %#v, want old active package", activePackage)
	}
	cachedPackage, err := store.GetAppPackageVersion(ctx, "design-app", "0.1.0+abc123")
	if err != nil {
		t.Fatalf("GetAppPackageVersion(remote) error = %v", err)
	}
	if cachedPackage.PackageDir == "" {
		t.Fatalf("cached package = %#v", cachedPackage)
	}
}

func TestAppCenterServiceFallsBackToLocalInstallPackageWhenRemoteCatalogFails(t *testing.T) {
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
			Description:   "Cached design app",
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
		Store:    store,
		StateDir: t.TempDir(),
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return nil, errors.New("catalog unavailable")
		},
	}

	appPackage, err := service.packageForInstall(ctx, "design-app")
	if err != nil {
		t.Fatalf("packageForInstall() error = %v", err)
	}
	if appPackage.Version != "0.1.0" {
		t.Fatalf("install package version = %q, want cached version", appPackage.Version)
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
	defer close(fetcher.release)
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
				Manifest: mustReadManifestForTest(t, remoteDir),
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
			return
		}
		select {
		case <-deadline:
			t.Fatal("install job did not fail after runtime preload error; package download was not canceled")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestAppCenterServiceImportsAndExportsUserPackageArchives(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
	sourceDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "imported-app",
		Version:       "0.2.0",
		Name:          "Imported App",
		Description:   "Imported app",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/",
		},
	})
	archivePath := filepath.Join(t.TempDir(), "imported-app.zip")
	if err := createAppPackageZip(sourceDir, archivePath); err != nil {
		t.Fatalf("createAppPackageZip() error = %v", err)
	}
	store := newAppStoreStub()
	service := AppCenterService{
		Store:    store,
		StateDir: stateDir,
	}

	imported, err := service.ImportPackage(ctx, archivePath)
	if err != nil {
		t.Fatalf("ImportPackage() error = %v", err)
	}
	if imported.Package.Source != workspacebiz.AppPackageSourceImported || imported.Package.PackageDir == "" {
		t.Fatalf("imported app = %#v", imported)
	}
	if _, err := service.ImportPackage(ctx, archivePath); !errors.Is(err, ErrAppPackageAlreadyExists) {
		t.Fatalf("ImportPackage() duplicate error = %v, want ErrAppPackageAlreadyExists", err)
	}
	exportPath := filepath.Join(t.TempDir(), "exported.zip")
	exported, err := service.ExportPackage(ctx, "imported-app", "", exportPath)
	if err != nil {
		t.Fatalf("ExportPackage() error = %v", err)
	}
	if exported.Path != exportPath || exported.ArtifactSHA256 == "" || exported.ArtifactSizeBytes <= 0 {
		t.Fatalf("ExportPackage() = %#v", exported)
	}
	if _, err := os.Stat(exportPath); err != nil {
		t.Fatalf("export archive missing: %v", err)
	}
}

func TestAppCenterServiceRemovePublishesUninstalledAppUpdate(t *testing.T) {
	t.Parallel()

	store := newAppStoreStub()
	appPackage := workspacebiz.AppPackage{
		AppID:   "sample-app",
		Version: "0.1.0",
		Manifest: workspacebiz.AppManifest{
			AppID:       "sample-app",
			Name:        "Sample App",
			Description: "Sample app",
		},
	}
	if err := store.PutAppPackage(context.Background(), appPackage); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	if err := store.PutWorkspaceAppInstallation(context.Background(), workspacebiz.AppInstallation{
		WorkspaceID: "ws-1",
		AppID:       "sample-app",
		Enabled:     true,
	}); err != nil {
		t.Fatalf("PutWorkspaceAppInstallation() error = %v", err)
	}
	publisher := &workspaceAppPublisherStub{}
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		Publisher:      publisher,
		StateDir:       t.TempDir(),
	}

	removed, err := service.Remove(context.Background(), "ws-1", "sample-app")
	if err != nil {
		t.Fatalf("Remove() error = %v", err)
	}
	if removed.Installation != nil || removed.Runtime.Status != workspacebiz.AppRuntimeStatusIdle {
		t.Fatalf("Remove() = %#v", removed)
	}
	if removed.StateRevision != 1 {
		t.Fatalf("removed state revision = %d, want 1", removed.StateRevision)
	}
	if len(publisher.published) != 1 {
		t.Fatalf("published updates = %d, want 1", len(publisher.published))
	}
	published := publisher.published[0]
	if publisher.workspaces[0] != "ws-1" || published.Installation != nil || published.StateRevision != 1 || published.Runtime.Status != workspacebiz.AppRuntimeStatusIdle {
		t.Fatalf("published update = workspace %q app %#v", publisher.workspaces[0], published)
	}
}

func TestAppCenterServiceRemoveDeletesWorkspaceAppState(t *testing.T) {
	t.Parallel()

	store := newAppStoreStub()
	appPackage := workspacebiz.AppPackage{
		AppID:   "sample-app",
		Version: "0.1.0",
		Manifest: workspacebiz.AppManifest{
			AppID:       "sample-app",
			Name:        "Sample App",
			Description: "Sample app",
		},
	}
	if err := store.PutAppPackage(context.Background(), appPackage); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	if err := store.PutWorkspaceAppInstallation(context.Background(), workspacebiz.AppInstallation{
		WorkspaceID: "ws-1",
		AppID:       "sample-app",
		Enabled:     true,
	}); err != nil {
		t.Fatalf("PutWorkspaceAppInstallation() error = %v", err)
	}
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       t.TempDir(),
	}
	stateRoot := service.workspaceAppStateRoot("ws-1", "sample-app")
	if err := os.MkdirAll(filepath.Join(stateRoot, "data"), 0o755); err != nil {
		t.Fatalf("create app data dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stateRoot, "data", "app.sqlite"), []byte("sqlite data"), 0o644); err != nil {
		t.Fatalf("write app data: %v", err)
	}

	if _, err := service.Remove(context.Background(), "ws-1", "sample-app"); err != nil {
		t.Fatalf("Remove() error = %v", err)
	}
	if _, err := os.Stat(stateRoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("removed app state root stat error = %v, want not exist", err)
	}
}

func TestAppCenterServiceRemoveDeletesUnusedRemoteBuiltinPackage(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppStoreStub()
	packageDir := filepath.Join(t.TempDir(), "packages", "remote-builtin", "1.0.0")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("create package dir: %v", err)
	}
	appPackage := workspacebiz.AppPackage{
		AppID:      "remote-builtin",
		Version:    "1.0.0",
		PackageDir: packageDir,
		Source:     workspacebiz.AppPackageSourceBuiltin,
		Manifest: workspacebiz.AppManifest{
			AppID:       "remote-builtin",
			Version:     "1.0.0",
			Name:        "Remote Builtin",
			Description: "Remote builtin",
		},
	}
	if err := store.PutAppPackage(ctx, appPackage); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	if err := store.PutWorkspaceAppInstallation(ctx, workspacebiz.AppInstallation{
		WorkspaceID: "ws-1",
		AppID:       "remote-builtin",
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
			return []builtinapps.App{
				{
					Manifest: appPackage.Manifest,
					Distribution: builtinapps.Distribution{
						Kind: builtinapps.DistributionRemote,
					},
				},
			}, nil
		},
	}

	if _, err := service.Remove(ctx, "ws-1", "remote-builtin"); err != nil {
		t.Fatalf("Remove() error = %v", err)
	}
	if _, err := store.GetAppPackage(ctx, "remote-builtin"); !errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
		t.Fatalf("GetAppPackage() after remove error = %v, want ErrWorkspaceAppNotFound", err)
	}
	if _, err := os.Stat(packageDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("removed package dir stat error = %v, want not exist", err)
	}
	installations, err := store.ListWorkspaceAppInstallationsByApp(ctx, "remote-builtin")
	if err != nil {
		t.Fatalf("ListWorkspaceAppInstallationsByApp() error = %v", err)
	}
	if len(installations) != 0 {
		t.Fatalf("installations after remove = %#v, want empty", installations)
	}
}

func TestAppCenterServiceRemoveKeepsRemoteBuiltinPackageUsedByAnotherWorkspace(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppStoreStub()
	packageDir := filepath.Join(t.TempDir(), "packages", "remote-builtin", "1.0.0")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("create package dir: %v", err)
	}
	appPackage := workspacebiz.AppPackage{
		AppID:      "remote-builtin",
		Version:    "1.0.0",
		PackageDir: packageDir,
		Source:     workspacebiz.AppPackageSourceBuiltin,
		Manifest: workspacebiz.AppManifest{
			AppID:       "remote-builtin",
			Version:     "1.0.0",
			Name:        "Remote Builtin",
			Description: "Remote builtin",
		},
	}
	if err := store.PutAppPackage(ctx, appPackage); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	for _, workspaceID := range []string{"ws-1", "ws-2"} {
		if err := store.PutWorkspaceAppInstallation(ctx, workspacebiz.AppInstallation{
			WorkspaceID: workspaceID,
			AppID:       "remote-builtin",
			Enabled:     true,
		}); err != nil {
			t.Fatalf("PutWorkspaceAppInstallation(%s) error = %v", workspaceID, err)
		}
	}
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       t.TempDir(),
		BuiltinCatalog: func() ([]builtinapps.App, error) {
			return []builtinapps.App{
				{
					Manifest: appPackage.Manifest,
					Distribution: builtinapps.Distribution{
						Kind: builtinapps.DistributionRemote,
					},
				},
			}, nil
		},
	}

	if _, err := service.Remove(ctx, "ws-1", "remote-builtin"); err != nil {
		t.Fatalf("Remove() error = %v", err)
	}
	if _, err := store.GetAppPackage(ctx, "remote-builtin"); err != nil {
		t.Fatalf("GetAppPackage() after remove error = %v", err)
	}
	if _, err := os.Stat(packageDir); err != nil {
		t.Fatalf("package dir after remove stat error = %v", err)
	}
	installations, err := store.ListWorkspaceAppInstallationsByApp(ctx, "remote-builtin")
	if err != nil {
		t.Fatalf("ListWorkspaceAppInstallationsByApp() error = %v", err)
	}
	if len(installations) != 1 || installations[0].WorkspaceID != "ws-2" {
		t.Fatalf("installations after remove = %#v, want ws-2 only", installations)
	}
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
			}
			if app.Runtime.Status != status {
				t.Fatalf("StartEnabled() status = %q, want %q", app.Runtime.Status, status)
			}
		})
	}
}

func TestAppCenterServiceDeletePackageRemovesLocalApp(t *testing.T) {
	t.Parallel()

	store := newAppStoreStub()
	packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "local-app",
		Version:       "0.1.0",
		Name:          "Local App",
		Description:   "Local app",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/ready",
		},
	})
	appPackage := workspacebiz.AppPackage{
		AppID:      "local-app",
		Version:    "0.1.0",
		PackageDir: packageDir,
		Manifest:   mustReadManifestForTest(t, packageDir),
		Source:     workspacebiz.AppPackageSourceGenerated,
	}
	if err := store.PutAppPackage(context.Background(), appPackage); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	if err := store.PutWorkspaceAppInstallation(context.Background(), workspacebiz.AppInstallation{
		WorkspaceID: "ws-1",
		AppID:       "local-app",
		Enabled:     true,
	}); err != nil {
		t.Fatalf("PutWorkspaceAppInstallation() error = %v", err)
	}
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       t.TempDir(),
	}

	if err := service.DeletePackage(context.Background(), "ws-1", "local-app"); err != nil {
		t.Fatalf("DeletePackage() error = %v", err)
	}
	if _, err := os.Stat(packageDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted package dir stat error = %v, want not exist", err)
	}
	if _, err := store.GetAppPackage(context.Background(), "local-app"); !errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
		t.Fatalf("GetAppPackage() after delete error = %v, want ErrWorkspaceAppNotFound", err)
	}
	if installations, err := store.ListWorkspaceAppInstallations(context.Background(), "ws-1"); err != nil || len(installations) != 0 {
		t.Fatalf("installations after delete = %#v error = %v, want empty", installations, err)
	}
}

func TestAppCenterServiceDeletePackageRemovesFactoryJobFiles(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
	store := newAppStoreStub()
	factoryStore := newAppFactoryStoreStub()
	packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "local-app",
		Version:       "0.1.0",
		Name:          "Local App",
		Description:   "Local app",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/ready",
		},
	})
	appPackage := workspacebiz.AppPackage{
		AppID:                "local-app",
		Version:              "0.1.0",
		PackageDir:           packageDir,
		Manifest:             mustReadManifestForTest(t, packageDir),
		Source:               workspacebiz.AppPackageSourceGenerated,
		FactoryJobID:         "job-1",
		CreatedInWorkspaceID: "ws-1",
	}
	if err := store.PutAppPackage(ctx, appPackage); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	jobRoot := filepath.Join(stateDir, "apps", "factory", "jobs", "job-1")
	if err := os.MkdirAll(filepath.Join(jobRoot, "draft"), 0o755); err != nil {
		t.Fatalf("create factory job draft: %v", err)
	}
	if err := factoryStore.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		WorkspaceID: "ws-1",
		JobID:       "job-1",
		Status:      workspacebiz.AppFactoryJobStatusPublished,
		DraftDir:    filepath.Join(jobRoot, "draft"),
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	service := AppCenterService{
		Store:           store,
		AppFactoryStore: factoryStore,
		WorkspaceStore:  &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:          &AppRunner{},
		StateDir:        stateDir,
	}

	if err := service.DeletePackage(ctx, "ws-1", "local-app"); err != nil {
		t.Fatalf("DeletePackage() error = %v", err)
	}
	if _, err := os.Stat(jobRoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("factory job root stat error = %v, want not exist", err)
	}
	if _, err := factoryStore.GetAppFactoryJob(ctx, "ws-1", "job-1"); err != nil {
		t.Fatalf("factory job record error = %v, want retained", err)
	}
}

func TestAppCenterServiceDeletePackagePrunesEmptyPackageCacheParent(t *testing.T) {
	t.Parallel()

	store := newAppStoreStub()
	stateDir := t.TempDir()
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       stateDir,
	}
	appID := "local-app"
	for _, version := range []string{"0.1.0", "0.2.0"} {
		packageDir := service.packageCacheDir(appID, version)
		if err := os.MkdirAll(packageDir, 0o755); err != nil {
			t.Fatalf("create package dir: %v", err)
		}
		createWorkspaceAppPackageForTest(t, packageDir, workspacebiz.AppManifest{
			SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
			AppID:         appID,
			Version:       version,
			Name:          "Local App",
			Description:   "Local app",
			Runtime: workspacebiz.AppManifestRuntime{
				Bootstrap:       "bootstrap.sh",
				HealthcheckPath: "/ready",
			},
		})
		if err := store.PutAppPackage(context.Background(), workspacebiz.AppPackage{
			AppID:      appID,
			Version:    version,
			PackageDir: packageDir,
			Manifest:   mustReadManifestForTest(t, packageDir),
			Source:     workspacebiz.AppPackageSourceGenerated,
		}); err != nil {
			t.Fatalf("PutAppPackage(%s) error = %v", version, err)
		}
	}
	appPackageParent := filepath.Join(service.packageCacheRoot(), appID)

	if err := service.DeletePackage(context.Background(), "ws-1", appID); err != nil {
		t.Fatalf("DeletePackage() error = %v", err)
	}
	if _, err := os.Stat(appPackageParent); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted app package parent stat error = %v, want not exist", err)
	}
	if _, err := os.Stat(service.packageCacheRoot()); err != nil {
		t.Fatalf("package cache root stat error = %v, want exists", err)
	}
}

func TestAppCenterServiceDeletePackageKeepsNonEmptyPackageCacheParent(t *testing.T) {
	t.Parallel()

	store := newAppStoreStub()
	stateDir := t.TempDir()
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       stateDir,
	}
	appID := "local-app"
	packageDir := service.packageCacheDir(appID, "0.1.0")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("create package dir: %v", err)
	}
	createWorkspaceAppPackageForTest(t, packageDir, workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         appID,
		Version:       "0.1.0",
		Name:          "Local App",
		Description:   "Local app",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/ready",
		},
	})
	if err := store.PutAppPackage(context.Background(), workspacebiz.AppPackage{
		AppID:      appID,
		Version:    "0.1.0",
		PackageDir: packageDir,
		Manifest:   mustReadManifestForTest(t, packageDir),
		Source:     workspacebiz.AppPackageSourceGenerated,
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	appPackageParent := filepath.Join(service.packageCacheRoot(), appID)
	keptDir := filepath.Join(appPackageParent, "manual-cache")
	if err := os.MkdirAll(keptDir, 0o755); err != nil {
		t.Fatalf("create kept package dir: %v", err)
	}

	if err := service.DeletePackage(context.Background(), "ws-1", appID); err != nil {
		t.Fatalf("DeletePackage() error = %v", err)
	}
	if _, err := os.Stat(packageDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted package dir stat error = %v, want not exist", err)
	}
	if _, err := os.Stat(keptDir); err != nil {
		t.Fatalf("kept package dir stat error = %v, want exists", err)
	}
	if _, err := os.Stat(appPackageParent); err != nil {
		t.Fatalf("non-empty app package parent stat error = %v, want exists", err)
	}
}

func TestAppCenterServiceDeletePackageRemovesWorkspaceAppState(t *testing.T) {
	t.Parallel()

	store := newAppStoreStub()
	packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "local-app",
		Version:       "0.1.0",
		Name:          "Local App",
		Description:   "Local app",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/ready",
		},
	})
	appPackage := workspacebiz.AppPackage{
		AppID:      "local-app",
		Version:    "0.1.0",
		PackageDir: packageDir,
		Manifest:   mustReadManifestForTest(t, packageDir),
		Source:     workspacebiz.AppPackageSourceGenerated,
	}
	if err := store.PutAppPackage(context.Background(), appPackage); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	for _, workspaceID := range []string{"ws-1", "ws-2"} {
		if err := store.PutWorkspaceAppInstallation(context.Background(), workspacebiz.AppInstallation{
			WorkspaceID: workspaceID,
			AppID:       "local-app",
			Enabled:     true,
		}); err != nil {
			t.Fatalf("PutWorkspaceAppInstallation() error = %v", err)
		}
	}
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       t.TempDir(),
	}
	stateRoots := []string{
		service.workspaceAppStateRoot("ws-1", "local-app"),
		service.workspaceAppStateRoot("ws-2", "local-app"),
	}
	for _, stateRoot := range stateRoots {
		if err := os.MkdirAll(filepath.Join(stateRoot, "data"), 0o755); err != nil {
			t.Fatalf("create app data dir: %v", err)
		}
		if err := os.WriteFile(filepath.Join(stateRoot, "data", "app.sqlite"), []byte("sqlite data"), 0o644); err != nil {
			t.Fatalf("write app data: %v", err)
		}
	}

	if err := service.DeletePackage(context.Background(), "ws-1", "local-app"); err != nil {
		t.Fatalf("DeletePackage() error = %v", err)
	}
	for _, stateRoot := range stateRoots {
		if _, err := os.Stat(stateRoot); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("deleted app state root stat error = %v, want not exist", err)
		}
	}
}

func TestAppCenterServiceReplaceIconUpdatesGeneratedPackage(t *testing.T) {
	t.Parallel()

	store := newAppStoreStub()
	packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "local-app",
		Version:       "0.1.0",
		Name:          "Local App",
		Description:   "Local app",
		Icon: workspacebiz.AppManifestIcon{
			Type: "asset",
			Src:  "icon.png",
		},
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/ready",
		},
	})
	appPackage := workspacebiz.AppPackage{
		AppID:      "local-app",
		Version:    "0.1.0",
		PackageDir: packageDir,
		Manifest:   mustReadManifestForTest(t, packageDir),
		Source:     workspacebiz.AppPackageSourceGenerated,
	}
	if err := store.PutAppPackage(context.Background(), appPackage); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	if err := store.PutWorkspaceAppInstallation(context.Background(), workspacebiz.AppInstallation{
		WorkspaceID: "ws-1",
		AppID:       "local-app",
		Enabled:     true,
	}); err != nil {
		t.Fatalf("PutWorkspaceAppInstallation() error = %v", err)
	}
	sourceIconPath := filepath.Join(t.TempDir(), "replacement.png")
	if err := os.WriteFile(sourceIconPath, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, 0o644); err != nil {
		t.Fatalf("write source icon: %v", err)
	}
	publisher := &workspaceAppPublisherStub{}
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		Publisher:      publisher,
		StateDir:       t.TempDir(),
	}

	app, err := service.ReplaceIcon(context.Background(), "ws-1", "local-app", sourceIconPath)
	if err != nil {
		t.Fatalf("ReplaceIcon() error = %v", err)
	}
	if app.Package.Manifest.Icon.Src != "icon.png" {
		t.Fatalf("replaced icon src = %q", app.Package.Manifest.Icon.Src)
	}
	replacedIconData, err := os.ReadFile(filepath.Join(packageDir, "icon.png"))
	if err != nil {
		t.Fatalf("read replaced icon: %v", err)
	}
	if string(replacedIconData) != string([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		t.Fatalf("replaced icon data = %v", replacedIconData)
	}
	manifest := mustReadManifestForTest(t, packageDir)
	if manifest.Icon.Src != "icon.png" {
		t.Fatalf("manifest icon src = %q", manifest.Icon.Src)
	}
	stored, err := store.GetAppPackage(context.Background(), "local-app")
	if err != nil {
		t.Fatalf("GetAppPackage() error = %v", err)
	}
	if stored.Manifest.Icon.Src != "icon.png" {
		t.Fatalf("stored icon src = %q", stored.Manifest.Icon.Src)
	}
	if len(publisher.published) != 1 || publisher.published[0].Package.Manifest.Icon.Src != "icon.png" {
		t.Fatalf("published updates = %#v", publisher.published)
	}
}

func TestAppCenterServiceReplaceIconUsesCustomPathWhenExistingIconExtensionDiffers(t *testing.T) {
	t.Parallel()

	store := newAppStoreStub()
	packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "local-app",
		Version:       "0.1.0",
		Name:          "Local App",
		Description:   "Local app",
		Icon: workspacebiz.AppManifestIcon{
			Type: "asset",
			Src:  "icon.webp",
		},
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/ready",
		},
	})
	appPackage := workspacebiz.AppPackage{
		AppID:      "local-app",
		Version:    "0.1.0",
		PackageDir: packageDir,
		Manifest:   mustReadManifestForTest(t, packageDir),
		Source:     workspacebiz.AppPackageSourceGenerated,
	}
	if err := store.PutAppPackage(context.Background(), appPackage); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	sourceIconPath := filepath.Join(t.TempDir(), "replacement.png")
	if err := os.WriteFile(sourceIconPath, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, 0o644); err != nil {
		t.Fatalf("write source icon: %v", err)
	}
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       t.TempDir(),
	}

	app, err := service.ReplaceIcon(context.Background(), "ws-1", "local-app", sourceIconPath)
	if err != nil {
		t.Fatalf("ReplaceIcon() error = %v", err)
	}
	if app.Package.Manifest.Icon.Src != "assets/icon-custom.png" {
		t.Fatalf("replaced icon src = %q", app.Package.Manifest.Icon.Src)
	}
	if _, err := os.Stat(filepath.Join(packageDir, "assets", "icon-custom.png")); err != nil {
		t.Fatalf("custom icon stat error = %v", err)
	}
}

func TestAppCenterServiceReplaceIconRejectsBuiltinApp(t *testing.T) {
	t.Parallel()

	store := newAppStoreStub()
	if err := store.PutAppPackage(context.Background(), workspacebiz.AppPackage{
		AppID:   "builtin-app",
		Version: "0.1.0",
		Manifest: workspacebiz.AppManifest{
			AppID: "builtin-app",
			Name:  "Builtin App",
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

	if _, err := service.ReplaceIcon(context.Background(), "ws-1", "builtin-app", "/tmp/icon.png"); !errors.Is(err, ErrAppPackageIconReplaceForbidden) {
		t.Fatalf("ReplaceIcon() error = %v, want ErrAppPackageIconReplaceForbidden", err)
	}
}

func TestAppCenterServiceReplaceIconRejectsInvalidIcon(t *testing.T) {
	t.Parallel()

	store := newAppStoreStub()
	packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "local-app",
		Version:       "0.1.0",
		Name:          "Local App",
		Description:   "Local app",
		Icon: workspacebiz.AppManifestIcon{
			Type: "asset",
			Src:  "icon.png",
		},
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/ready",
		},
	})
	if err := store.PutAppPackage(context.Background(), workspacebiz.AppPackage{
		AppID:      "local-app",
		Version:    "0.1.0",
		PackageDir: packageDir,
		Manifest:   mustReadManifestForTest(t, packageDir),
		Source:     workspacebiz.AppPackageSourceGenerated,
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	sourceIconPath := filepath.Join(t.TempDir(), "replacement.png")
	if err := os.WriteFile(sourceIconPath, []byte("not png data"), 0o644); err != nil {
		t.Fatalf("write source icon: %v", err)
	}
	service := AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         &AppRunner{},
		StateDir:       t.TempDir(),
	}

	if _, err := service.ReplaceIcon(context.Background(), "ws-1", "local-app", sourceIconPath); !errors.Is(err, ErrAppPackageIconInvalid) {
		t.Fatalf("ReplaceIcon() error = %v, want ErrAppPackageIconInvalid", err)
	}
}

func TestAppCenterServiceDeletePackageRejectsBuiltinApp(t *testing.T) {
	t.Parallel()

	store := newAppStoreStub()
	if err := store.PutAppPackage(context.Background(), workspacebiz.AppPackage{
		AppID:   "builtin-app",
		Version: "0.1.0",
		Manifest: workspacebiz.AppManifest{
			AppID: "builtin-app",
			Name:  "Builtin App",
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

	if err := service.DeletePackage(context.Background(), "ws-1", "builtin-app"); !errors.Is(err, ErrAppPackageDeleteForbidden) {
		t.Fatalf("DeletePackage() error = %v, want ErrAppPackageDeleteForbidden", err)
	}
}

func createWorkspaceAppPackageForTest(t *testing.T, packageDir string, manifest workspacebiz.AppManifest) string {
	t.Helper()
	data := []byte(`{
  "schemaVersion": "` + manifest.SchemaVersion + `",
  "appId": "` + manifest.AppID + `",
  "version": "` + manifest.Version + `",
  "name": "` + manifest.Name + `",
  "description": "` + manifest.Description + `",
  "icon": {
    "type": "` + manifest.Icon.Type + `",
    "src": "` + manifest.Icon.Src + `"
  },
  "runtime": {
    "bootstrap": "` + manifest.Runtime.Bootstrap + `",
    "healthcheckPath": "` + manifest.Runtime.HealthcheckPath + `"
  }
}
`)
	if err := os.WriteFile(filepath.Join(packageDir, "tutti.app.json"), data, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "bootstrap.sh"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write bootstrap: %v", err)
	}
	if strings.TrimSpace(manifest.Icon.Src) != "" {
		if err := os.WriteFile(filepath.Join(packageDir, manifest.Icon.Src), []byte{0x89, 0x50, 0x4e, 0x47}, 0o644); err != nil {
			t.Fatalf("write icon: %v", err)
		}
	}
	if err := os.WriteFile(filepath.Join(packageDir, "AGENTS.md"), []byte("Test app package.\n"), 0o644); err != nil {
		t.Fatalf("write AGENTS.md: %v", err)
	}
	return packageDir
}

func mustReadManifestForTest(t *testing.T, packageDir string) workspacebiz.AppManifest {
	t.Helper()
	manifest, _, err := workspacebiz.ReadAppManifestFile(filepath.Join(packageDir, "tutti.app.json"))
	if err != nil {
		t.Fatalf("ReadAppManifestFile() error = %v", err)
	}
	return manifest
}

func findWorkspaceAppForTest(apps []workspacebiz.WorkspaceApp, appID string) *workspacebiz.WorkspaceApp {
	for index := range apps {
		if apps[index].Package.AppID == appID {
			return &apps[index]
		}
	}
	return nil
}

func newLaunchTestAppCenterService(t *testing.T) (AppCenterService, *AppRunner) {
	t.Helper()

	ctx := context.Background()
	packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "local-app",
		Version:       "0.1.0",
		Name:          "Local App",
		Description:   "Local app",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/ready",
		},
	})
	appPackage := workspacebiz.AppPackage{
		AppID:      "local-app",
		Version:    "0.1.0",
		PackageDir: packageDir,
		Manifest:   mustReadManifestForTest(t, packageDir),
		Source:     workspacebiz.AppPackageSourceImported,
	}
	store := newAppStoreStub()
	if err := store.PutAppPackage(ctx, appPackage); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	if err := store.PutWorkspaceAppInstallation(ctx, workspacebiz.AppInstallation{
		WorkspaceID: "ws-1",
		AppID:       "local-app",
		Enabled:     true,
	}); err != nil {
		t.Fatalf("PutWorkspaceAppInstallation() error = %v", err)
	}
	runner := &AppRunner{
		RuntimeResolver: &appRuntimeResolverStub{
			called: make(chan struct{}),
			err:    errors.New("skip runtime"),
		},
	}
	return AppCenterService{
		Store:          store,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         runner,
		StateDir:       t.TempDir(),
	}, runner
}

func intPtr(value int) *int {
	return &value
}

func waitForActiveAppPackageVersionForTest(t *testing.T, store *appStoreStub, appID string, version string) workspacebiz.AppPackage {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		appPackage, err := store.GetAppPackage(context.Background(), appID)
		if err == nil && appPackage.Version == version {
			return appPackage
		}
		if time.Now().After(deadline) {
			t.Fatalf("GetAppPackage(%s) version = %q, error = %v, want %s", appID, appPackage.Version, err, version)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitForActiveAppPackageDirChangeForTest(t *testing.T, store *appStoreStub, appID string, previousPackageDir string) workspacebiz.AppPackage {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		appPackage, err := store.GetAppPackage(context.Background(), appID)
		if err == nil && appPackage.PackageDir != previousPackageDir {
			return appPackage
		}
		if time.Now().After(deadline) {
			t.Fatalf("GetAppPackage(%s) packageDir = %q, error = %v, want different from %q", appID, appPackage.PackageDir, err, previousPackageDir)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitForInstallJobProgressForTest(t *testing.T, service *AppCenterService, workspaceID string, appID string) workspacebiz.AppInstallProgress {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		job, ok := service.installJob(workspaceID, appID)
		if ok && job.Progress != nil {
			return *job.Progress
		}
		if time.Now().After(deadline) {
			t.Fatalf("install job progress for %s/%s was not published", workspaceID, appID)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
