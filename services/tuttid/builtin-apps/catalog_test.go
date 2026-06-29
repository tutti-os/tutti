package builtinapps

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestCatalogLoadsRemoteAppsFromFile(t *testing.T) {
	t.Setenv(remoteCatalogURLEnv, "")
	catalogPath := filepath.Join(t.TempDir(), "catalog.json")
	if err := os.WriteFile(catalogPath, []byte(`{
		"schemaVersion": "tutti.app.catalog.v1",
		"apps": [
			{
				"localizations": [
					{
						"locale": "zh-CN",
						"name": "远程设计",
						"description": "设计工作区",
						"tags": ["设计", "工作区"]
					}
				],
				"manifest": {
					"schemaVersion": "tutti.app.manifest.v1",
					"appId": "remote-design",
					"version": "0.1.0",
					"name": "Remote Design",
					"description": "Design workspace",
						"icon": {"type": "asset", "src": "icon.svg"},
						"runtime": {"bootstrap": "bootstrap.sh", "healthcheckPath": "/healthz"}
				},
				"distribution": {
					"kind": "remote",
					"artifactUrl": "https://cdn.example.test/apps/remote-design/remote-design.zip",
					"artifactSha256": "abc123",
					"iconUrl": "https://cdn.example.test/apps/remote-design/icon.svg"
				}
			}
		]
	}`), 0o644); err != nil {
		t.Fatalf("write catalog: %v", err)
	}
	t.Setenv(remoteCatalogFileEnv, catalogPath)

	apps, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	app := findCatalogAppForTest(apps, "remote-design")
	if app == nil {
		t.Fatalf("remote app missing from catalog: %#v", apps)
	}
	if app.Distribution.Kind != DistributionRemote || app.Distribution.IconURL == "" {
		t.Fatalf("remote app distribution = %#v", app.Distribution)
	}
	if len(app.Localizations) != 1 || app.Localizations[0].Locale != "zh-CN" || app.Localizations[0].Name != "远程设计" {
		t.Fatalf("remote app localizations = %#v", app.Localizations)
	}
}

func TestCatalogReturnsExplicitFileErrors(t *testing.T) {
	t.Setenv(remoteCatalogURLEnv, "")
	t.Setenv(remoteCatalogFileEnv, filepath.Join(t.TempDir(), "missing-catalog.json"))

	if _, err := Catalog(); err == nil {
		t.Fatal("Catalog() error = nil, want missing catalog file error")
	}
}

func TestCatalogLoadsRemoteAppsFromURL(t *testing.T) {
	t.Setenv(remoteCatalogFileEnv, "")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{
			"schemaVersion": "tutti.app.catalog.v1",
			"apps": [
				{
					"manifest": {
						"schemaVersion": "tutti.app.manifest.v1",
						"appId": "remote-tool",
						"version": "1.2.3",
						"name": "Remote Tool",
						"description": "Remote tool",
							"icon": {"type": "asset", "src": "icon.png"},
							"runtime": {"bootstrap": "bootstrap.sh", "healthcheckPath": "/"}
					},
					"distribution": {
						"kind": "remote",
						"artifactUrl": "https://cdn.example.test/apps/remote-tool/remote-tool.zip",
						"artifactSha256": "def456",
						"iconUrl": "https://cdn.example.test/apps/remote-tool/icon.png"
					}
				}
			]
		}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv(remoteCatalogURLEnv, server.URL+"/catalog.json")

	snapshot, err := Snapshot()
	if err != nil {
		t.Fatalf("Snapshot() error = %v", err)
	}
	if snapshot.RemoteCatalog.Status != RemoteCatalogLoadStatusLoading {
		t.Fatalf("remote catalog status = %q, want loading", snapshot.RemoteCatalog.Status)
	}
	if app := findCatalogAppForTest(snapshot.Apps, "remote-tool"); app != nil {
		t.Fatalf("remote app loaded synchronously: %#v", app)
	}

	snapshot = waitForCatalogStatusForTest(t, RemoteCatalogLoadStatusReady)
	if snapshot.RemoteCatalog.LastError != "" {
		t.Fatalf("remote catalog last error = %q, want empty", snapshot.RemoteCatalog.LastError)
	}
	if app := findCatalogAppForTest(snapshot.Apps, "remote-tool"); app == nil {
		t.Fatalf("remote app missing from catalog: %#v", snapshot.Apps)
	}
}

func TestCatalogRetriesRemoteURLFetch(t *testing.T) {
	disableRemoteCatalogRetrySleepForTest(t)
	t.Setenv(remoteCatalogFileEnv, "")
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) < remoteCatalogFetchAttempts {
			http.Error(writer, "unavailable", http.StatusServiceUnavailable)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{
			"schemaVersion": "tutti.app.catalog.v1",
			"apps": [
				{
					"manifest": {
						"schemaVersion": "tutti.app.manifest.v1",
						"appId": "retry-tool",
						"version": "1.2.3",
						"name": "Retry Tool",
						"description": "Retry tool",
							"icon": {"type": "asset", "src": "icon.png"},
							"runtime": {"bootstrap": "bootstrap.sh", "healthcheckPath": "/"}
					},
					"distribution": {
						"kind": "remote",
						"artifactUrl": "https://cdn.example.test/apps/retry-tool/retry-tool.zip",
						"artifactSha256": "def456",
						"iconUrl": "https://cdn.example.test/apps/retry-tool/icon.png"
					}
				}
			]
		}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv(remoteCatalogURLEnv, server.URL+"/catalog.json")

	snapshot, err := RefreshRemoteCatalog()
	if err != nil {
		t.Fatalf("RefreshRemoteCatalog() error = %v", err)
	}
	if snapshot.RemoteCatalog.Status != RemoteCatalogLoadStatusLoading {
		t.Fatalf("remote catalog status = %q, want loading", snapshot.RemoteCatalog.Status)
	}

	snapshot = waitForCatalogStatusForTest(t, RemoteCatalogLoadStatusReady)
	if got := requests.Load(); got != remoteCatalogFetchAttempts {
		t.Fatalf("remote catalog requests = %d, want %d", got, remoteCatalogFetchAttempts)
	}
	if app := findCatalogAppForTest(snapshot.Apps, "retry-tool"); app == nil {
		t.Fatalf("retry-loaded remote app missing from catalog: %#v", snapshot.Apps)
	}
}

func TestRefreshRemoteCatalogAndWaitReturnsReadyCatalog(t *testing.T) {
	t.Setenv(remoteCatalogFileEnv, "")
	releaseResponse := make(chan struct{})
	var releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() {
			close(releaseResponse)
		})
	}
	t.Cleanup(release)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		<-releaseResponse
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{
			"schemaVersion": "tutti.app.catalog.v1",
			"apps": [
				{
					"manifest": {
						"schemaVersion": "tutti.app.manifest.v1",
						"appId": "wait-tool",
						"version": "1.2.3",
						"name": "Wait Tool",
						"description": "Wait tool",
							"icon": {"type": "asset", "src": "icon.png"},
							"runtime": {"bootstrap": "bootstrap.sh", "healthcheckPath": "/"}
					},
					"distribution": {
						"kind": "remote",
						"artifactUrl": "https://cdn.example.test/apps/wait-tool/wait-tool.zip",
						"artifactSha256": "def456",
						"iconUrl": "https://cdn.example.test/apps/wait-tool/icon.png"
					}
				}
			]
		}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv(remoteCatalogURLEnv, server.URL+"/catalog.json")

	resultCh := make(chan struct {
		snapshot CatalogSnapshot
		err      error
	}, 1)
	go func() {
		snapshot, err := RefreshRemoteCatalogAndWait(context.Background())
		resultCh <- struct {
			snapshot CatalogSnapshot
			err      error
		}{snapshot: snapshot, err: err}
	}()

	select {
	case result := <-resultCh:
		t.Fatalf("RefreshRemoteCatalogAndWait() returned before response: %#v", result)
	case <-time.After(50 * time.Millisecond):
	}
	release()
	select {
	case result := <-resultCh:
		if result.err != nil {
			t.Fatalf("RefreshRemoteCatalogAndWait() error = %v", result.err)
		}
		if result.snapshot.RemoteCatalog.Status != RemoteCatalogLoadStatusReady {
			t.Fatalf("remote catalog status = %q, want ready", result.snapshot.RemoteCatalog.Status)
		}
		if app := findCatalogAppForTest(result.snapshot.Apps, "wait-tool"); app == nil {
			t.Fatalf("remote app missing from waited snapshot: %#v", result.snapshot.Apps)
		}
	case <-time.After(time.Second):
		t.Fatal("RefreshRemoteCatalogAndWait() did not return after response")
	}
}

func TestRefreshRemoteCatalogAndWaitReturnsFailedCatalog(t *testing.T) {
	disableRemoteCatalogRetrySleepForTest(t)
	t.Setenv(remoteCatalogFileEnv, "")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "unavailable", http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)
	t.Setenv(remoteCatalogURLEnv, server.URL+"/catalog.json")

	snapshot, err := RefreshRemoteCatalogAndWait(context.Background())
	if err != nil {
		t.Fatalf("RefreshRemoteCatalogAndWait() error = %v", err)
	}
	if snapshot.RemoteCatalog.Status != RemoteCatalogLoadStatusFailed {
		t.Fatalf("remote catalog status = %q, want failed", snapshot.RemoteCatalog.Status)
	}
	if snapshot.RemoteCatalog.LastError == "" {
		t.Fatal("remote catalog last error is empty, want failure details")
	}
}

func TestCatalogReturnsEmbeddedCatalogWhenRemoteURLFails(t *testing.T) {
	disableRemoteCatalogRetrySleepForTest(t)
	t.Setenv(remoteCatalogFileEnv, "")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "unavailable", http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)
	t.Setenv(remoteCatalogURLEnv, server.URL+"/catalog.json")

	apps, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	if app := findCatalogAppForTest(apps, "tutti-onboarding"); app == nil {
		t.Fatalf("Catalog() apps = %#v, want embedded onboarding", apps)
	}

	snapshot := waitForCatalogStatusForTest(t, RemoteCatalogLoadStatusFailed)
	if snapshot.RemoteCatalog.LastError == "" {
		t.Fatal("remote catalog last error is empty, want failure details")
	}
	if app := findCatalogAppForTest(snapshot.Apps, "tutti-onboarding"); app == nil {
		t.Fatalf("failed snapshot apps = %#v, want embedded onboarding", snapshot.Apps)
	}
}

func TestEmbeddedOnboardingArchiveMatchesCatalog(t *testing.T) {
	app := findCatalogAppForTest(embeddedCatalog(), "tutti-onboarding")
	if app == nil {
		t.Fatal("embedded catalog missing tutti-onboarding")
	}
	if app.Distribution.Kind != DistributionEmbeddedArchive {
		t.Fatalf("onboarding distribution kind = %q, want embedded-archive", app.Distribution.Kind)
	}

	manifestData, err := os.ReadFile(filepath.Join("tutti-onboarding", "tutti-package", "tutti.app.json"))
	if err != nil {
		t.Fatalf("read source manifest: %v", err)
	}
	sourceManifest, _, err := workspacebiz.ParseAppManifestJSON(manifestData)
	if err != nil {
		t.Fatalf("parse source manifest: %v", err)
	}
	assertCatalogManifestMatchesSource(t, app.Manifest, sourceManifest)

	archiveData, err := files.ReadFile(app.Distribution.EmbeddedArtifactPath)
	if err != nil {
		t.Fatalf("read embedded archive %q: %v", app.Distribution.EmbeddedArtifactPath, err)
	}
	archive, err := zip.NewReader(bytes.NewReader(archiveData), int64(len(archiveData)))
	if err != nil {
		t.Fatalf("open embedded archive: %v", err)
	}
	requireZipEntryForTest(t, archive, "tutti.app.json")
	requireZipEntryForTest(t, archive, "tutti.cli.json")
	requireZipEntryForTest(t, archive, "tutti-guide.md")
	requireZipEntryForTest(t, archive, "bootstrap.sh")
	requireZipEntryForTest(t, archive, "dist/index.html")
	requireZipEntryForTest(t, archive, "bin/darwin-arm64/tutti-onboarding-server")
	requireZipEntryForTest(t, archive, "bin/darwin-amd64/tutti-onboarding-server")

	archiveManifestData := readZipEntryForTest(t, archive, "tutti.app.json")
	archiveManifest, _, err := workspacebiz.ParseAppManifestJSON(archiveManifestData)
	if err != nil {
		t.Fatalf("parse archive manifest: %v", err)
	}
	assertCatalogManifestMatchesSource(t, app.Manifest, archiveManifest)
}

func TestRemoteCatalogURLDefaultsToPublishedCatalog(t *testing.T) {
	previousValue, hadPreviousValue := os.LookupEnv(remoteCatalogURLEnv)
	t.Cleanup(func() {
		if hadPreviousValue {
			_ = os.Setenv(remoteCatalogURLEnv, previousValue)
			return
		}
		_ = os.Unsetenv(remoteCatalogURLEnv)
	})
	_ = os.Unsetenv(remoteCatalogURLEnv)

	if got := remoteCatalogURL(); got != defaultRemoteCatalogURL {
		t.Fatalf("remoteCatalogURL() = %q, want %q", got, defaultRemoteCatalogURL)
	}

	_ = os.Setenv(remoteCatalogURLEnv, "")
	if got := remoteCatalogURL(); got != "" {
		t.Fatalf("remoteCatalogURL() with empty override = %q, want empty", got)
	}

	override := "https://cdn.example.test/catalog.json"
	_ = os.Setenv(remoteCatalogURLEnv, override)
	if got := remoteCatalogURL(); got != override {
		t.Fatalf("remoteCatalogURL() with override = %q, want %q", got, override)
	}
}

func TestMergeCatalogsKeepsEmbeddedAppBeforeRemoteAppWithSameID(t *testing.T) {
	embedded := embeddedCatalog()
	if len(embedded) == 0 {
		t.Fatal("embedded catalog is empty")
	}
	remoteManifest := embedded[0].Manifest
	remoteManifest.Version = "9.9.9"

	apps, err := mergeCatalogs(embedded, []App{
		{
			Manifest: remoteManifest,
			Distribution: Distribution{
				Kind:           DistributionRemote,
				ArtifactURL:    "https://cdn.example.test/tutti-onboarding.zip",
				ArtifactSHA256: "abc123",
				IconURL:        "https://cdn.example.test/tutti-onboarding.webp",
			},
		},
	})
	if err != nil {
		t.Fatalf("mergeCatalogs() error = %v", err)
	}
	app := findCatalogAppForTest(apps, "tutti-onboarding")
	if app == nil {
		t.Fatalf("merged apps = %#v, want embedded onboarding", apps)
	}
	if app.Manifest.Version != "0.1.0" || app.Distribution.Kind != DistributionEmbeddedArchive {
		t.Fatalf("merged onboarding = %#v, want embedded version", app)
	}
}

func TestCatalogLoadsRemoteAutomationWhenProvidedByCatalog(t *testing.T) {
	t.Setenv(remoteCatalogURLEnv, "")
	catalogPath := filepath.Join(t.TempDir(), "catalog.json")
	manifest := remoteCatalogManifestForTest("automation")
	document := remoteCatalogDocument{
		SchemaVersion: remoteCatalogSchemaVersionV1,
		Apps: []remoteCatalogApp{{
			Manifest: manifest,
			Distribution: remoteDistribution{
				Kind:           string(DistributionRemote),
				ArtifactURL:    "https://cdn.example.test/automation.zip",
				ArtifactSHA256: "abc123",
				IconURL:        "https://cdn.example.test/automation.png",
			},
		}},
	}
	data, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal catalog: %v", err)
	}
	if err := os.WriteFile(catalogPath, data, 0o644); err != nil {
		t.Fatalf("write catalog: %v", err)
	}
	t.Setenv(remoteCatalogFileEnv, catalogPath)

	apps, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	var matchingApps []App
	for _, app := range apps {
		if app.Manifest.AppID == "automation" {
			matchingApps = append(matchingApps, app)
		}
	}
	if len(matchingApps) != 1 {
		t.Fatalf("automation entries = %#v, want exactly one remote entry", matchingApps)
	}
	if matchingApps[0].Distribution.Kind != DistributionRemote {
		t.Fatalf("automation distribution = %#v, want remote", matchingApps[0].Distribution)
	}
}

func TestParseRemoteCatalogRequiresIconURLAndManifestIcon(t *testing.T) {
	manifest := remoteCatalogManifestForTest("remote-tool")
	document := remoteCatalogDocument{
		SchemaVersion: remoteCatalogSchemaVersionV1,
		Apps: []remoteCatalogApp{{
			Manifest: manifest,
			Distribution: remoteDistribution{
				Kind:           string(DistributionRemote),
				ArtifactURL:    "https://cdn.example.test/remote-tool.zip",
				ArtifactSHA256: "abc123",
			},
		}},
	}
	data, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal catalog: %v", err)
	}
	if _, err := parseRemoteCatalog(data); err == nil {
		t.Fatal("parseRemoteCatalog() error = nil, want missing iconUrl error")
	}

	manifest.Icon = workspacebiz.AppManifestIcon{}
	document.Apps[0].Manifest = manifest
	document.Apps[0].Distribution.IconURL = "https://cdn.example.test/icon.png"
	data, err = json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal catalog: %v", err)
	}
	if _, err := parseRemoteCatalog(data); err == nil {
		t.Fatal("parseRemoteCatalog() error = nil, want missing manifest icon error")
	}
}

func assertCatalogManifestMatchesSource(t *testing.T, catalog workspacebiz.AppManifest, source workspacebiz.AppManifest) {
	t.Helper()
	if catalog.SchemaVersion != source.SchemaVersion {
		t.Fatalf("schemaVersion = %q, want %q", catalog.SchemaVersion, source.SchemaVersion)
	}
	if catalog.AppID != source.AppID {
		t.Fatalf("appId = %q, want %q", catalog.AppID, source.AppID)
	}
	if catalog.Version != source.Version {
		t.Fatalf("version = %q, want %q", catalog.Version, source.Version)
	}
	if catalog.Name != source.Name {
		t.Fatalf("name = %q, want %q", catalog.Name, source.Name)
	}
	if catalog.Description != source.Description {
		t.Fatalf("description = %q, want %q", catalog.Description, source.Description)
	}
	if !reflect.DeepEqual(catalog.Icon, source.Icon) {
		t.Fatalf("icon = %#v, want %#v", catalog.Icon, source.Icon)
	}
	if !reflect.DeepEqual(catalog.Runtime, source.Runtime) {
		t.Fatalf("runtime = %#v, want %#v", catalog.Runtime, source.Runtime)
	}
	if !reflect.DeepEqual(catalog.CLI, source.CLI) {
		t.Fatalf("cli = %#v, want %#v", catalog.CLI, source.CLI)
	}
	if !reflect.DeepEqual(catalog.Window, source.Window) {
		t.Fatalf("window = %#v, want %#v", catalog.Window, source.Window)
	}
	if !reflect.DeepEqual(catalog.Launch, source.Launch) {
		t.Fatalf("launch = %#v, want %#v", catalog.Launch, source.Launch)
	}
	if !reflect.DeepEqual(catalog.LocalizationInfo, source.LocalizationInfo) {
		t.Fatalf("localizationInfo = %#v, want %#v", catalog.LocalizationInfo, source.LocalizationInfo)
	}
	if !reflect.DeepEqual(catalog.Author, source.Author) {
		t.Fatalf("author = %#v, want %#v", catalog.Author, source.Author)
	}
	if !reflect.DeepEqual(catalog.Authors, source.Authors) {
		t.Fatalf("authors = %#v, want %#v", catalog.Authors, source.Authors)
	}
	if !reflect.DeepEqual(catalog.Source, source.Source) {
		t.Fatalf("source = %#v, want %#v", catalog.Source, source.Source)
	}
	if !reflect.DeepEqual(catalog.Tags, source.Tags) {
		t.Fatalf("tags = %#v, want %#v", catalog.Tags, source.Tags)
	}
}

func requireZipEntryForTest(t *testing.T, archive *zip.Reader, name string) {
	t.Helper()
	for _, file := range archive.File {
		if file.Name == name {
			return
		}
	}
	t.Fatalf("zip missing %q", name)
}

func readZipEntryForTest(t *testing.T, archive *zip.Reader, name string) []byte {
	t.Helper()
	for _, file := range archive.File {
		if file.Name != name {
			continue
		}
		reader, err := file.Open()
		if err != nil {
			t.Fatalf("open zip entry %q: %v", name, err)
		}
		defer reader.Close()
		data, err := io.ReadAll(reader)
		if err != nil {
			t.Fatalf("read zip entry %q: %v", name, err)
		}
		return data
	}
	t.Fatalf("zip missing %q", name)
	return nil
}

func remoteCatalogManifestForTest(appID string) workspacebiz.AppManifest {
	return workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         appID,
		Version:       "0.1.0",
		Name:          "Remote App",
		Description:   "Remote app",
		Icon: workspacebiz.AppManifestIcon{
			Type: "asset",
			Src:  "icon.png",
		},
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/",
		},
		Authors: []workspacebiz.AppManifestAuthor{
			{
				Name:      "Tutti Developer",
				URL:       "https://github.com/tutti-os",
				AvatarURL: "https://github.com/tutti-os.png",
			},
		},
		Source: &workspacebiz.AppManifestSource{
			Type: "github",
			URL:  "https://github.com/tutti-os/remote-app",
		},
	}
}

func findCatalogAppForTest(apps []App, appID string) *App {
	for index := range apps {
		if apps[index].Manifest.AppID == appID {
			return &apps[index]
		}
	}
	return nil
}

func waitForCatalogStatusForTest(t *testing.T, status RemoteCatalogLoadStatus) CatalogSnapshot {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		snapshot, err := Snapshot()
		if err != nil {
			t.Fatalf("Snapshot() error = %v", err)
		}
		if snapshot.RemoteCatalog.Status == status {
			return snapshot
		}
		if time.Now().After(deadline) {
			t.Fatalf("remote catalog status = %q, want %q", snapshot.RemoteCatalog.Status, status)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func disableRemoteCatalogRetrySleepForTest(t *testing.T) {
	t.Helper()
	previous := sleepRemoteCatalogRetry
	sleepRemoteCatalogRetry = func(time.Duration) {}
	t.Cleanup(func() {
		sleepRemoteCatalogRetry = previous
	})
}
