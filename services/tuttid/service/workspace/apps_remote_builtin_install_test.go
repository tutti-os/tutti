package workspace

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	builtinapps "github.com/tutti-os/tutti/services/tuttid/builtin-apps"
)

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
	fetcher := newCopyingArtifactFetcher(archivePath)
	service := AppCenterService{
		Store:           store,
		WorkspaceStore:  &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
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

	appPackage, err := service.packageForInstall(ctx, "large-builtin")
	if err != nil {
		t.Fatalf("packageForInstall() error = %v", err)
	}
	if appPackage.PackageDir == missingPackageDir {
		t.Fatalf("packageForInstall() reused missing package dir %q", missingPackageDir)
	}
	if err := validateExtractedAppPackage(NewPlatformAppShellAdapter(), appPackage.PackageDir, appPackage.Manifest); err != nil {
		t.Fatalf("repaired package validation error = %v", err)
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
	remoteManifest := mustReadManifestForTest(t, remoteSourceDir)

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
				Manifest: remoteManifest,
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
