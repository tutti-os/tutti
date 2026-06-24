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

func TestAppCenterServiceLoadLocalPackageResolvesSupportedDirectories(t *testing.T) {
	ctx := context.Background()

	tests := []struct {
		name      string
		sourceDir func(t *testing.T, manifest workspacebiz.AppManifest) (string, string)
	}{
		{
			name: "exact app dir",
			sourceDir: func(t *testing.T, manifest workspacebiz.AppManifest) (string, string) {
				t.Helper()
				packageDir := createWorkspaceAppPackageForTest(t, mustMkdirLocalAppTempDir(t), manifest)
				return packageDir, packageDir
			},
		},
		{
			name: "project root dev app dir",
			sourceDir: func(t *testing.T, manifest workspacebiz.AppManifest) (string, string) {
				t.Helper()
				projectRoot := mustMkdirLocalAppTempDir(t)
				packageDir := filepath.Join(projectRoot, ".tutti", "dev-app")
				if err := os.MkdirAll(packageDir, 0o755); err != nil {
					t.Fatalf("create dev app dir: %v", err)
				}
				createWorkspaceAppPackageForTest(t, packageDir, manifest)
				return projectRoot, packageDir
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			service := newLocalAppPackageTestService(t)
			manifest := localAppManifestForTest("local-dev-app", "Local Dev App")
			sourceDir, expectedPackageDir := tt.sourceDir(t, manifest)
			defer stopAndWaitLocalAppRunner(ctx, service.Runner)

			app, err := service.LoadLocalPackage(ctx, "ws-1", sourceDir, InstallOptions{RestartRunning: true})
			if err != nil {
				t.Fatalf("LoadLocalPackage() error = %v", err)
			}

			if app.Package.Source != workspacebiz.AppPackageSourceLocalDev {
				t.Fatalf("source = %q, want local-dev", app.Package.Source)
			}
			if app.Package.PackageDir != expectedPackageDir {
				t.Fatalf("packageDir = %q, want %q", app.Package.PackageDir, expectedPackageDir)
			}
			if app.Installation == nil || app.Installation.WorkspaceID != "ws-1" {
				t.Fatalf("installation = %#v", app.Installation)
			}
			stored, err := service.Store.GetAppPackage(ctx, manifest.AppID)
			if err != nil {
				t.Fatalf("GetAppPackage() error = %v", err)
			}
			if stored.PackageDir != expectedPackageDir || stored.Source != workspacebiz.AppPackageSourceLocalDev {
				t.Fatalf("stored package = %#v", stored)
			}
		})
	}
}

func TestAppCenterServiceLoadLocalPackageValidatesInputsAndConflicts(t *testing.T) {
	ctx := context.Background()

	t.Run("missing manifest", func(t *testing.T) {
		service := newLocalAppPackageTestService(t)
		if _, err := service.LoadLocalPackage(ctx, "ws-1", t.TempDir(), InstallOptions{}); !errors.Is(err, ErrLocalAppPackageInvalid) {
			t.Fatalf("LoadLocalPackage() error = %v, want ErrLocalAppPackageInvalid", err)
		}
	})

	t.Run("missing bootstrap", func(t *testing.T) {
		service := newLocalAppPackageTestService(t)
		packageDir := t.TempDir()
		writeLocalAppManifestForTest(t, packageDir, localAppManifestForTest("missing-bootstrap", "Missing Bootstrap"))
		if _, err := service.LoadLocalPackage(ctx, "ws-1", packageDir, InstallOptions{}); !errors.Is(err, ErrLocalAppPackageInvalid) {
			t.Fatalf("LoadLocalPackage() error = %v, want ErrLocalAppPackageInvalid", err)
		}
	})

	t.Run("bootstrap not executable", func(t *testing.T) {
		service := newLocalAppPackageTestService(t)
		packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), localAppManifestForTest("non-executable", "Non Executable"))
		if err := os.Chmod(filepath.Join(packageDir, "bootstrap.sh"), 0o644); err != nil {
			t.Fatalf("chmod bootstrap: %v", err)
		}
		if _, err := service.LoadLocalPackage(ctx, "ws-1", packageDir, InstallOptions{}); !errors.Is(err, ErrLocalAppPackageInvalid) {
			t.Fatalf("LoadLocalPackage() error = %v, want ErrLocalAppPackageInvalid", err)
		}
	})

	t.Run("non local-dev app id conflict", func(t *testing.T) {
		service := newLocalAppPackageTestService(t)
		manifest := localAppManifestForTest("conflict-app", "Conflict")
		if err := service.Store.PutAppPackage(ctx, workspacebiz.AppPackage{
			AppID:      manifest.AppID,
			Version:    manifest.Version,
			PackageDir: t.TempDir(),
			Manifest:   manifest,
			Source:     workspacebiz.AppPackageSourceGenerated,
		}); err != nil {
			t.Fatalf("PutAppPackage() error = %v", err)
		}
		packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), manifest)
		if _, err := service.LoadLocalPackage(ctx, "ws-1", packageDir, InstallOptions{}); !errors.Is(err, ErrAppPackageAlreadyExists) {
			t.Fatalf("LoadLocalPackage() error = %v, want ErrAppPackageAlreadyExists", err)
		}
	})

	t.Run("remote builtin app id conflict", func(t *testing.T) {
		service := newLocalAppPackageTestService(t)
		manifest := localAppManifestForTest("remote-builtin", "Remote Builtin")
		service.BuiltinCatalog = func() ([]builtinapps.App, error) {
			return []builtinapps.App{{
				Manifest: manifest,
				Distribution: builtinapps.Distribution{
					Kind: builtinapps.DistributionRemote,
				},
			}}, nil
		}
		packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), manifest)
		if _, err := service.LoadLocalPackage(ctx, "ws-1", packageDir, InstallOptions{}); !errors.Is(err, ErrAppPackageAlreadyExists) {
			t.Fatalf("LoadLocalPackage() error = %v, want ErrAppPackageAlreadyExists", err)
		}
	})
}

func TestAppCenterServiceLoadLocalPackageUpdatesExistingLocalDev(t *testing.T) {
	ctx := context.Background()
	service := newLocalAppPackageTestService(t)
	manifest := localAppManifestForTest("local-dev-app", "Local Dev App")
	firstDir := createWorkspaceAppPackageForTest(t, mustMkdirLocalAppTempDir(t), manifest)
	secondManifest := localAppManifestForTest("local-dev-app", "Renamed Local Dev App")
	secondDir := createWorkspaceAppPackageForTest(t, mustMkdirLocalAppTempDir(t), secondManifest)
	defer stopAndWaitLocalAppRunner(ctx, service.Runner)

	if _, err := service.LoadLocalPackage(ctx, "ws-1", firstDir, InstallOptions{}); err != nil {
		t.Fatalf("first LoadLocalPackage() error = %v", err)
	}
	app, err := service.LoadLocalPackage(ctx, "ws-1", secondDir, InstallOptions{RestartRunning: true})
	if err != nil {
		t.Fatalf("second LoadLocalPackage() error = %v", err)
	}

	if app.Package.PackageDir != secondDir {
		t.Fatalf("packageDir = %q, want %q", app.Package.PackageDir, secondDir)
	}
	if app.Package.DisplayName() != "Renamed Local Dev App" {
		t.Fatalf("displayName = %q", app.Package.DisplayName())
	}
}

func TestAppCenterServiceReloadLocalPackageDoesNotInstallUninstalledApp(t *testing.T) {
	ctx := context.Background()
	service := newLocalAppPackageTestService(t)
	manifest := localAppManifestForTest("local-dev-app", "Local Dev App")
	packageDir := createWorkspaceAppPackageForTest(t, mustMkdirLocalAppTempDir(t), manifest)
	defer stopAndWaitLocalAppRunner(ctx, service.Runner)

	if _, err := service.LoadLocalPackage(ctx, "ws-1", packageDir, InstallOptions{}); err != nil {
		t.Fatalf("LoadLocalPackage() error = %v", err)
	}
	if _, err := service.Uninstall(ctx, "ws-1", manifest.AppID); err != nil {
		t.Fatalf("Uninstall() error = %v", err)
	}
	stopAndWaitLocalAppRunner(ctx, service.Runner)

	updatedManifest := localAppManifestForTest("local-dev-app", "Reloaded Local Dev App")
	writeLocalAppManifestForTest(t, packageDir, updatedManifest)
	app, err := service.ReloadLocalPackage(ctx, "ws-1", manifest.AppID, InstallOptions{RestartRunning: true})
	if err != nil {
		t.Fatalf("ReloadLocalPackage() error = %v", err)
	}

	if app.Installation != nil {
		t.Fatalf("installation = %#v, want nil", app.Installation)
	}
	if app.Package.DisplayName() != "Reloaded Local Dev App" {
		t.Fatalf("displayName = %q", app.Package.DisplayName())
	}
	installations, err := service.Store.ListWorkspaceAppInstallations(ctx, "ws-1")
	if err != nil {
		t.Fatalf("ListWorkspaceAppInstallations() error = %v", err)
	}
	if len(installations) != 0 {
		t.Fatalf("installations = %#v, want none", installations)
	}
	service.Runner.mu.Lock()
	startCount := len(service.Runner.starts)
	processCount := len(service.Runner.processes)
	service.Runner.mu.Unlock()
	if startCount != 0 || processCount != 0 {
		t.Fatalf("runner starts/processes = %d/%d, want 0/0", startCount, processCount)
	}
}

func TestAppCenterServiceDeleteLocalDevPackageKeepsSourceDirectory(t *testing.T) {
	ctx := context.Background()
	service := newLocalAppPackageTestService(t)
	manifest := localAppManifestForTest("local-dev-app", "Local Dev App")
	packageDir := createWorkspaceAppPackageForTest(t, mustMkdirLocalAppTempDir(t), manifest)
	defer stopAndWaitLocalAppRunner(ctx, service.Runner)

	if _, err := service.LoadLocalPackage(ctx, "ws-1", packageDir, InstallOptions{}); err != nil {
		t.Fatalf("LoadLocalPackage() error = %v", err)
	}
	if err := service.DeletePackage(ctx, "ws-1", manifest.AppID); err != nil {
		t.Fatalf("DeletePackage() error = %v", err)
	}
	if info, err := os.Stat(packageDir); err != nil || !info.IsDir() {
		t.Fatalf("source directory stat = %#v, %v", info, err)
	}
	if _, err := service.Store.GetAppPackage(ctx, manifest.AppID); !errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
		t.Fatalf("GetAppPackage() error = %v, want ErrWorkspaceAppNotFound", err)
	}
}

func TestAppCenterServiceLocalDevPackageRejectsExportAndIconReplacement(t *testing.T) {
	ctx := context.Background()
	service := newLocalAppPackageTestService(t)
	manifest := localAppManifestForTest("local-dev-app", "Local Dev App")
	packageDir := createWorkspaceAppPackageForTest(t, mustMkdirLocalAppTempDir(t), manifest)
	defer stopAndWaitLocalAppRunner(ctx, service.Runner)

	if _, err := service.LoadLocalPackage(ctx, "ws-1", packageDir, InstallOptions{}); err != nil {
		t.Fatalf("LoadLocalPackage() error = %v", err)
	}

	if _, err := service.ExportPackage(ctx, manifest.AppID, "", filepath.Join(t.TempDir(), "local-dev.zip")); err == nil || !strings.Contains(err.Error(), "only generated or imported workspace apps can be exported") {
		t.Fatalf("ExportPackage() error = %v, want local-dev export rejection", err)
	}
	if _, err := service.ReplaceIcon(ctx, "ws-1", manifest.AppID, "/tmp/icon.png"); !errors.Is(err, ErrAppPackageIconReplaceForbidden) {
		t.Fatalf("ReplaceIcon() error = %v, want ErrAppPackageIconReplaceForbidden", err)
	}
}

func newLocalAppPackageTestService(t *testing.T) *AppCenterService {
	t.Helper()
	stateDir := mustMkdirLocalAppTempDir(t)
	runner := &AppRunner{
		HealthcheckTimeout: 10 * time.Millisecond,
		RuntimeResolver: &appRuntimeResolverStub{
			called: make(chan struct{}),
			err:    errors.New("skip runtime"),
		},
	}
	t.Cleanup(func() {
		stopAndWaitLocalAppRunner(context.Background(), runner)
	})
	return &AppCenterService{
		Store:          newAppStoreStub(),
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
		Runner:         runner,
		StateDir:       stateDir,
		BuiltinCatalog: func() ([]builtinapps.App, error) { return nil, nil },
	}
}

func stopAndWaitLocalAppRunner(ctx context.Context, runner *AppRunner) {
	if runner == nil {
		return
	}
	deadline := time.Now().Add(time.Second)
	for {
		runner.mu.Lock()
		startCount := len(runner.starts)
		runner.mu.Unlock()
		if startCount == 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	runner.StopAll(ctx)
	deadline = time.Now().Add(time.Second)
	for {
		runner.mu.Lock()
		startCount := len(runner.starts)
		processCount := len(runner.processes)
		runner.mu.Unlock()
		if startCount == 0 && processCount == 0 {
			return
		}
		if time.Now().After(deadline) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func mustMkdirLocalAppTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "tutti-local-app-*")
	if err != nil {
		t.Fatalf("create temp dir: %v", err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(dir)
	})
	return dir
}

func localAppManifestForTest(appID string, name string) workspacebiz.AppManifest {
	return workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         appID,
		Version:       "0.1.0",
		Name:          name,
		Description:   "Local development app",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/",
		},
	}
}

func writeLocalAppManifestForTest(t *testing.T, packageDir string, manifest workspacebiz.AppManifest) {
	t.Helper()
	data := []byte(`{
  "schemaVersion": "` + manifest.SchemaVersion + `",
  "appId": "` + manifest.AppID + `",
  "version": "` + manifest.Version + `",
  "name": "` + manifest.Name + `",
  "description": "` + manifest.Description + `",
  "runtime": {
    "bootstrap": "` + manifest.Runtime.Bootstrap + `",
    "healthcheckPath": "` + manifest.Runtime.HealthcheckPath + `"
  }
}
`)
	if err := os.WriteFile(filepath.Join(packageDir, "tutti.app.json"), data, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
}
