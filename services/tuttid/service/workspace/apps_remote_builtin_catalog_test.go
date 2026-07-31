package workspace

import (
	"context"
	"path/filepath"
	"testing"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	builtinapps "github.com/tutti-os/tutti/services/tuttid/builtin-apps"
)

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
		return
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
	newManifest := mustReadManifestForTest(t, newDir)
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
				Manifest: newManifest,
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
		return
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
		return
	}
	if app.Package.Version != "0.1.0+abc123" || app.Package.PackageDir != "" || app.Package.Description() != "Remote design app" {
		t.Fatalf("design app projection = %#v", app.Package)
	}
	if actualIconURL := app.ResolvedIconURL(); actualIconURL == nil || *actualIconURL != "https://cdn.example.test/design-app.png" {
		t.Fatalf("design app icon url = %v", actualIconURL)
	}
}

func TestShouldUseRemoteBuiltinNeverDowngradesInstalledPackage(t *testing.T) {
	appPackage := workspacebiz.AppPackage{
		AppID:   "design-app",
		Version: "2.0.0",
		Source:  workspacebiz.AppPackageSourceBuiltin,
	}
	builtin := builtinapps.App{
		Manifest: workspacebiz.AppManifest{AppID: "design-app", Version: "1.0.0"},
		Distribution: builtinapps.Distribution{
			Kind: builtinapps.DistributionRemote,
		},
	}

	if shouldUseRemoteBuiltin(appPackage, builtin) {
		t.Fatal("older remote builtin must not replace installed package")
	}
	builtin.Manifest.Version = "3.0.0"
	if !shouldUseRemoteBuiltin(appPackage, builtin) {
		t.Fatal("newer remote builtin should replace installed package")
	}
	appPackage.Version = "legacy-a"
	builtin.Manifest.Version = "legacy-b"
	if !shouldUseRemoteBuiltin(appPackage, builtin) {
		t.Fatal("changed non-semver remote builtin should replace installed package")
	}
	builtin.Manifest.Version = "legacy-a"
	if shouldUseRemoteBuiltin(appPackage, builtin) {
		t.Fatal("equal non-semver remote builtin must not replace installed package")
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
		return
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
		return
	}
	if app.Package.Version != "0.1.0" || app.Package.PackageDir != packageDir || app.Installation == nil {
		t.Fatalf("installed package projection = %#v", app)
	}
	if app.Runtime.Status != workspacebiz.AppRuntimeStatusRunning {
		t.Fatalf("installed package runtime status = %q", app.Runtime.Status)
	}
}
