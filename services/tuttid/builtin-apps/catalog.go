package builtinapps

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

var files embed.FS

type App struct {
	Manifest     workspacebiz.AppManifest
	SourceDir    string
	Distribution Distribution
}

type DistributionKind string

const (
	DistributionEmbedded DistributionKind = "embedded"
	DistributionRemote   DistributionKind = "remote"
)

type Distribution struct {
	Kind           DistributionKind
	ArtifactURL    string
	ArtifactSHA256 string
	IconURL        string
}

const (
	remoteCatalogSchemaVersionV1 = "tutti.app.catalog.v1"
	remoteCatalogFileEnv         = "TUTTI_APP_CATALOG_FILE"
	remoteCatalogURLEnv          = "TUTTI_APP_CATALOG_URL"
	defaultRemoteCatalogURL      = "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-app-releases/catalog.json"
	remoteCatalogFetchTimeout    = 10 * time.Second
	remoteCatalogFetchAttempts   = 3
)

var sleepRemoteCatalogRetry = time.Sleep

type RemoteCatalogLoadStatus string

const (
	RemoteCatalogLoadStatusDisabled RemoteCatalogLoadStatus = "disabled"
	RemoteCatalogLoadStatusLoading  RemoteCatalogLoadStatus = "loading"
	RemoteCatalogLoadStatusReady    RemoteCatalogLoadStatus = "ready"
	RemoteCatalogLoadStatusFailed   RemoteCatalogLoadStatus = "failed"
)

type RemoteCatalogLoadState struct {
	Status          RemoteCatalogLoadStatus
	LastError       string
	UpdatedAtUnixMs int64
}

type CatalogSnapshot struct {
	Apps          []App
	RemoteCatalog RemoteCatalogLoadState
}

type remoteCatalogDocument struct {
	SchemaVersion string             `json:"schemaVersion"`
	Apps          []remoteCatalogApp `json:"apps"`
}

type remoteCatalogApp struct {
	Manifest     workspacebiz.AppManifest `json:"manifest"`
	Distribution remoteDistribution       `json:"distribution"`
}

type remoteDistribution struct {
	Kind           string `json:"kind"`
	ArtifactURL    string `json:"artifactUrl"`
	ArtifactSHA256 string `json:"artifactSha256"`
	IconURL        string `json:"iconUrl"`
}

func Catalog() ([]App, error) {
	snapshot, err := Snapshot()
	if err != nil {
		return nil, err
	}
	return snapshot.Apps, nil
}

func Snapshot() (CatalogSnapshot, error) {
	return snapshot(false)
}

func RefreshRemoteCatalog() (CatalogSnapshot, error) {
	return snapshot(true)
}

func snapshot(refreshRemote bool) (CatalogSnapshot, error) {
	apps := []App{}

	source := currentRemoteCatalogSource()
	remote, err := remoteCatalogSnapshot(source, refreshRemote)
	if err != nil {
		return CatalogSnapshot{}, err
	}
	if remote.state.Status == RemoteCatalogLoadStatusDisabled {
		return CatalogSnapshot{Apps: apps, RemoteCatalog: remote.state}, nil
	}

	mergedApps, err := mergeCatalogs(apps, remote.apps)
	if err != nil {
		if source.kind == remoteCatalogSourceFile {
			return CatalogSnapshot{}, err
		}
		failedState := failedRemoteCatalogLoadState(err)
		return CatalogSnapshot{Apps: apps, RemoteCatalog: failedState}, nil
	}
	return CatalogSnapshot{Apps: mergedApps, RemoteCatalog: remote.state}, nil
}

func CopyTo(app App, destinationDir string) error {
	if app.Distribution.Kind != "" && app.Distribution.Kind != DistributionEmbedded {
		return fmt.Errorf("builtin app %q is not embedded", app.Manifest.AppID)
	}
	if app.SourceDir == "" {
		return errors.New("builtin app source dir is required")
	}
	if destinationDir == "" {
		return errors.New("builtin app destination dir is required")
	}

	if err := os.MkdirAll(destinationDir, 0o755); err != nil {
		return fmt.Errorf("create builtin app destination: %w", err)
	}

	return fs.WalkDir(files, app.SourceDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relativePath, err := filepath.Rel(app.SourceDir, path)
		if err != nil {
			return fmt.Errorf("resolve builtin app relative path: %w", err)
		}
		if relativePath == "." {
			return nil
		}

		targetPath := filepath.Join(destinationDir, relativePath)
		if entry.IsDir() {
			return os.MkdirAll(targetPath, 0o755)
		}

		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return fmt.Errorf("create builtin app file parent: %w", err)
		}

		sourceFile, err := files.Open(path)
		if err != nil {
			return fmt.Errorf("open builtin app source file: %w", err)
		}
		defer sourceFile.Close()

		targetFile, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, modeForBuiltinFile(relativePath))
		if err != nil {
			return fmt.Errorf("open builtin app target file: %w", err)
		}
		defer targetFile.Close()

		if _, err := io.Copy(targetFile, sourceFile); err != nil {
			return fmt.Errorf("copy builtin app file: %w", err)
		}
		return nil
	})
}

func modeForBuiltinFile(relativePath string) os.FileMode {
	if filepath.Base(relativePath) == "bootstrap.sh" {
		return 0o755
	}
	return 0o644
}

type remoteCatalogSourceKind string

const (
	remoteCatalogSourceNone remoteCatalogSourceKind = "none"
	remoteCatalogSourceFile remoteCatalogSourceKind = "file"
	remoteCatalogSourceURL  remoteCatalogSourceKind = "url"
)

type remoteCatalogSource struct {
	kind  remoteCatalogSourceKind
	value string
}

type remoteCatalogResult struct {
	apps  []App
	state RemoteCatalogLoadState
}

var defaultRemoteCatalogLoader asyncRemoteCatalogLoader

type asyncRemoteCatalogLoader struct {
	mu      sync.Mutex
	source  string
	loading bool
	apps    []App
	state   RemoteCatalogLoadState
}

func remoteCatalogSnapshot(source remoteCatalogSource, refresh bool) (remoteCatalogResult, error) {
	switch source.kind {
	case remoteCatalogSourceNone:
		return remoteCatalogResult{
			state: RemoteCatalogLoadState{Status: RemoteCatalogLoadStatusDisabled},
		}, nil
	case remoteCatalogSourceFile:
		apps, err := loadRemoteCatalogFromFile(source.value)
		if err != nil {
			return remoteCatalogResult{}, err
		}
		return remoteCatalogResult{
			apps:  apps,
			state: readyRemoteCatalogLoadState(),
		}, nil
	default:
		if refresh {
			return defaultRemoteCatalogLoader.refresh(source.value), nil
		}
		return defaultRemoteCatalogLoader.snapshot(source.value), nil
	}
}

func currentRemoteCatalogSource() remoteCatalogSource {
	filePath := strings.TrimSpace(os.Getenv(remoteCatalogFileEnv))
	if filePath != "" {
		return remoteCatalogSource{kind: remoteCatalogSourceFile, value: filePath}
	}

	catalogURL := remoteCatalogURL()
	if catalogURL == "" {
		return remoteCatalogSource{kind: remoteCatalogSourceNone}
	}
	return remoteCatalogSource{kind: remoteCatalogSourceURL, value: catalogURL}
}

func loadRemoteCatalogFromFile(filePath string) ([]App, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("read app catalog file: %w", err)
	}
	return parseRemoteCatalog(data)
}

func (l *asyncRemoteCatalogLoader) snapshot(catalogURL string) remoteCatalogResult {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.source != catalogURL {
		l.source = catalogURL
		l.loading = false
		l.apps = nil
		l.state = RemoteCatalogLoadState{Status: RemoteCatalogLoadStatusLoading}
	}

	if l.state.Status == "" {
		l.state = RemoteCatalogLoadState{Status: RemoteCatalogLoadStatusLoading}
	}
	if l.state.Status == RemoteCatalogLoadStatusLoading && !l.loading {
		l.loading = true
		go l.load(catalogURL)
	}

	return remoteCatalogResult{
		apps:  append([]App(nil), l.apps...),
		state: l.state,
	}
}

func (l *asyncRemoteCatalogLoader) refresh(catalogURL string) remoteCatalogResult {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.source != catalogURL {
		l.source = catalogURL
		l.loading = false
		l.apps = nil
	}
	l.state = RemoteCatalogLoadState{Status: RemoteCatalogLoadStatusLoading}
	if !l.loading {
		l.loading = true
		go l.load(catalogURL)
	}

	return remoteCatalogResult{
		apps:  append([]App(nil), l.apps...),
		state: l.state,
	}
}

func (l *asyncRemoteCatalogLoader) load(catalogURL string) {
	slog.Info("remote app catalog fetch started", "url", catalogURL)
	apps, err := fetchRemoteCatalogWithRetries(catalogURL)

	l.mu.Lock()
	defer l.mu.Unlock()
	if l.source != catalogURL {
		return
	}
	l.loading = false
	if err != nil {
		slog.Warn("remote app catalog fetch failed", "url", catalogURL, "error", err)
		l.state = failedRemoteCatalogLoadState(err)
		return
	}
	slog.Info("remote app catalog fetch completed", "url", catalogURL, "appCount", len(apps))
	l.apps = apps
	l.state = readyRemoteCatalogLoadState()
}

func fetchRemoteCatalogWithRetries(catalogURL string) ([]App, error) {
	var lastErr error
	for attempt := 1; attempt <= remoteCatalogFetchAttempts; attempt++ {
		apps, err := fetchRemoteCatalog(catalogURL)
		if err == nil {
			return apps, nil
		}
		lastErr = err
		if attempt >= remoteCatalogFetchAttempts || !isRetryableRemoteCatalogError(err) {
			break
		}
		sleepRemoteCatalogRetry(remoteCatalogRetryDelay(attempt))
	}
	return nil, lastErr
}

func remoteCatalogRetryDelay(attempt int) time.Duration {
	if attempt <= 1 {
		return 300 * time.Millisecond
	}
	return 900 * time.Millisecond
}

func fetchRemoteCatalog(catalogURL string) ([]App, error) {
	ctx, cancel := context.WithTimeout(context.Background(), remoteCatalogFetchTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, catalogURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create app catalog request: %w", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("fetch app catalog: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("fetch app catalog: %w", remoteCatalogHTTPStatusError{statusCode: response.StatusCode})
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
	if err != nil {
		return nil, fmt.Errorf("read app catalog response: %w", err)
	}
	return parseRemoteCatalog(data)
}

type remoteCatalogHTTPStatusError struct {
	statusCode int
}

func (e remoteCatalogHTTPStatusError) Error() string {
	return fmt.Sprintf("unexpected status %d", e.statusCode)
}

func isRetryableRemoteCatalogError(err error) bool {
	var statusErr remoteCatalogHTTPStatusError
	if errors.As(err, &statusErr) {
		return statusErr.statusCode >= 500
	}
	message := err.Error()
	return strings.HasPrefix(message, "fetch app catalog:") || strings.HasPrefix(message, "read app catalog response:")
}

func readyRemoteCatalogLoadState() RemoteCatalogLoadState {
	return RemoteCatalogLoadState{
		Status:          RemoteCatalogLoadStatusReady,
		UpdatedAtUnixMs: time.Now().UnixMilli(),
	}
}

func failedRemoteCatalogLoadState(err error) RemoteCatalogLoadState {
	return RemoteCatalogLoadState{
		Status:          RemoteCatalogLoadStatusFailed,
		LastError:       err.Error(),
		UpdatedAtUnixMs: time.Now().UnixMilli(),
	}
}

func remoteCatalogURL() string {
	if value, ok := os.LookupEnv(remoteCatalogURLEnv); ok {
		return strings.TrimSpace(value)
	}
	return defaultRemoteCatalogURL
}

func parseRemoteCatalog(data []byte) ([]App, error) {
	var document remoteCatalogDocument
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, fmt.Errorf("parse app catalog json: %w", err)
	}
	if !isSupportedRemoteCatalogSchemaVersion(strings.TrimSpace(document.SchemaVersion)) {
		return nil, fmt.Errorf("unsupported app catalog schema version %q", document.SchemaVersion)
	}

	apps := make([]App, 0, len(document.Apps))
	seenAppIDs := make(map[string]struct{}, len(document.Apps))
	for _, entry := range document.Apps {
		if err := workspacebiz.ValidateAppManifest(entry.Manifest); err != nil {
			return nil, fmt.Errorf("validate app catalog manifest: %w", err)
		}
		appID := strings.TrimSpace(entry.Manifest.AppID)
		if _, ok := seenAppIDs[appID]; ok {
			return nil, fmt.Errorf("duplicate app catalog appId %q", appID)
		}
		seenAppIDs[appID] = struct{}{}

		distribution, err := parseRemoteDistribution(appID, entry.Manifest, entry.Distribution)
		if err != nil {
			return nil, err
		}
		apps = append(apps, App{
			Manifest:     entry.Manifest,
			Distribution: distribution,
		})
	}
	return apps, nil
}

func isSupportedRemoteCatalogSchemaVersion(schemaVersion string) bool {
	return schemaVersion == remoteCatalogSchemaVersionV1
}

func parseRemoteDistribution(appID string, manifest workspacebiz.AppManifest, distribution remoteDistribution) (Distribution, error) {
	if strings.TrimSpace(distribution.Kind) != string(DistributionRemote) {
		return Distribution{}, fmt.Errorf("app catalog app %q distribution.kind must be %q", appID, DistributionRemote)
	}
	artifactURL := strings.TrimSpace(distribution.ArtifactURL)
	artifactSHA256 := strings.TrimSpace(distribution.ArtifactSHA256)
	iconURL := strings.TrimSpace(distribution.IconURL)
	if artifactURL == "" || artifactSHA256 == "" || iconURL == "" {
		return Distribution{}, fmt.Errorf("app catalog app %q artifactUrl, artifactSha256, and iconUrl are required", appID)
	}
	if strings.TrimSpace(manifest.Icon.Type) == "" || strings.TrimSpace(manifest.Icon.Src) == "" {
		return Distribution{}, fmt.Errorf("app catalog app %q manifest icon is required", appID)
	}
	return Distribution{
		Kind:           DistributionRemote,
		ArtifactURL:    artifactURL,
		ArtifactSHA256: artifactSHA256,
		IconURL:        iconURL,
	}, nil
}

func mergeCatalogs(embeddedApps []App, remoteApps []App) ([]App, error) {
	apps := make([]App, 0, len(embeddedApps)+len(remoteApps))
	seenAppIDs := make(map[string]struct{}, len(embeddedApps)+len(remoteApps))
	embeddedAppIDs := make(map[string]struct{}, len(embeddedApps))
	for _, app := range embeddedApps {
		appID := strings.TrimSpace(app.Manifest.AppID)
		if appID == "" {
			return nil, errors.New("builtin app manifest appId is required")
		}
		if _, ok := seenAppIDs[appID]; ok {
			return nil, fmt.Errorf("duplicate builtin app appId %q", appID)
		}
		seenAppIDs[appID] = struct{}{}
		embeddedAppIDs[appID] = struct{}{}
		apps = append(apps, app)
	}
	for _, app := range remoteApps {
		appID := strings.TrimSpace(app.Manifest.AppID)
		if appID == "" {
			return nil, errors.New("remote builtin app manifest appId is required")
		}
		if _, ok := embeddedAppIDs[appID]; ok {
			continue
		}
		if _, ok := seenAppIDs[appID]; ok {
			return nil, fmt.Errorf("duplicate remote builtin app appId %q", appID)
		}
		seenAppIDs[appID] = struct{}{}
		apps = append(apps, app)
	}
	return apps, nil
}
