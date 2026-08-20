package managedruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const tuttiAppRuntimeRootEnv = "TUTTI_APP_RUNTIME_ROOT"
const tuttiAppRuntimeCacheRootEnv = "TUTTI_APP_RUNTIME_CACHE_ROOT"
const tuttiAppRuntimeCatalogEnv = "TUTTI_APP_RUNTIME_CATALOG"
const appRuntimeCatalogSchemaVersion = "tutti.app.runtimes.v2"
const appRuntimeBaselineProfile = "baseline"
const appRuntimeNodeStaticProfile = "connector-node-static"
const defaultTuttiAppRuntimeCatalogURL = "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-app-runtimes/catalog.json"

const NodeStaticProfile = appRuntimeNodeStaticProfile

const maxManagedAppRuntimeArtifactBytes int64 = 512 * 1024 * 1024
const maxManagedAppRuntimeExpandedBytes int64 = 2 * 1024 * 1024 * 1024
const managedAppRuntimeCatalogRequestAttempts = 3
const managedAppRuntimeCatalogRetryBaseDelay = 100 * time.Millisecond
const managedAppRuntimeCatalogErrorDrainBytes int64 = 32 * 1024

type Resolver interface {
	Resolve(context.Context) (ResolvedRuntime, error)
}

type ProfilePreloader interface {
	PreloadProfile(context.Context, string) error
}

type ProfileResolver interface {
	ResolveProfile(context.Context, string) (ResolvedRuntime, error)
}

type ResolvedRuntime struct {
	Root         string
	Python       string
	Node         string
	NPM          string
	BinDirs      []string
	EnvOverrides []string
}

type DefaultResolver struct {
	RuntimeRoot string
	Environ     func() []string
	HTTPClient  *http.Client
}

type DownloadProgress struct {
	DownloadedBytes int64
	TotalBytes      int64
}

type downloadProgressKey struct{}
type componentDownloadProgressKey struct{}

type appRuntimeCatalog struct {
	SchemaVersion string                            `json:"schemaVersion"`
	Runtimes      map[string]appRuntimeCatalogEntry `json:"runtimes"`
}

type appRuntimeCatalogEntry struct {
	Version     string                                `json:"version"`
	Components  map[string]appRuntimeCatalogComponent `json:"components"`
	Profiles    map[string][]string                   `json:"profiles"`
	ProfileABIs map[string]string                     `json:"profileAbis,omitempty"`
}

type appRuntimeCatalogComponent struct {
	Version           string `json:"version"`
	ArtifactURL       string `json:"artifactUrl"`
	ArtifactSHA256    string `json:"artifactSha256"`
	ArtifactSizeBytes int64  `json:"artifactSizeBytes,omitempty"`
}

type managedAppRuntimeRootLock struct {
	token chan struct{}
	users int
}

var managedAppRuntimeDownloadLocks = struct {
	sync.Mutex
	entries map[string]*managedAppRuntimeRootLock
}{entries: make(map[string]*managedAppRuntimeRootLock)}

func acquireManagedAppRuntimeDownloadLock(ctx context.Context, root string) (func(), error) {
	managedAppRuntimeDownloadLocks.Lock()
	lock := managedAppRuntimeDownloadLocks.entries[root]
	if lock == nil {
		lock = &managedAppRuntimeRootLock{token: make(chan struct{}, 1)}
		managedAppRuntimeDownloadLocks.entries[root] = lock
	}
	lock.users++
	managedAppRuntimeDownloadLocks.Unlock()

	releaseUser := func() {
		managedAppRuntimeDownloadLocks.Lock()
		lock.users--
		if lock.users == 0 && managedAppRuntimeDownloadLocks.entries[root] == lock {
			delete(managedAppRuntimeDownloadLocks.entries, root)
		}
		managedAppRuntimeDownloadLocks.Unlock()
	}
	select {
	case lock.token <- struct{}{}:
		var once sync.Once
		return func() {
			once.Do(func() {
				<-lock.token
				releaseUser()
			})
		}, nil
	case <-ctx.Done():
		releaseUser()
		return nil, ctx.Err()
	}
}

func (r DefaultResolver) Resolve(ctx context.Context) (ResolvedRuntime, error) {
	root := r.runtimeRoot()
	if err := r.ensureRuntime(ctx, root); err != nil {
		return ResolvedRuntime{}, err
	}
	components, err := r.baselineRuntimeComponents(ctx, root)
	if err != nil {
		return ResolvedRuntime{}, err
	}
	return r.resolvedRuntimeForComponents(root, components)
}

func (r DefaultResolver) PreloadProfile(ctx context.Context, profile string) error {
	return r.ensureRuntimeProfile(ctx, r.runtimeRoot(), profile)
}

func (r DefaultResolver) ResolveProfile(ctx context.Context, profile string) (ResolvedRuntime, error) {
	profile = strings.TrimSpace(profile)
	if profile == "" || profile == appRuntimeBaselineProfile {
		return r.Resolve(ctx)
	}
	root := r.runtimeRoot()
	if err := r.ensureRuntimeProfile(ctx, root, profile); err != nil {
		return ResolvedRuntime{}, err
	}
	if profile == appRuntimeNodeStaticProfile {
		return r.resolvedRuntimeForComponents(root, []string{"node"})
	}
	componentNames, err := r.runtimeProfileComponentNames(ctx, profile)
	if err != nil {
		return ResolvedRuntime{}, err
	}
	return r.resolvedRuntimeForComponents(root, componentNames)
}

func (r DefaultResolver) runtimeRoot() string {
	root := strings.TrimSpace(r.RuntimeRoot)
	if root == "" {
		root = strings.TrimSpace(envValue(r.environ(), tuttiAppRuntimeRootEnv))
	}
	if root == "" {
		root = DefaultRoot(r.environ())
	}
	return filepath.Clean(root)
}

func (r DefaultResolver) resolvedRuntime(root string) (ResolvedRuntime, error) {
	return r.resolvedRuntimeForComponents(root, []string{"python", "node"})
}

func (r DefaultResolver) resolvedRuntimeForComponents(root string, components []string) (ResolvedRuntime, error) {
	pythonBinDir := filepath.Join(root, "python", "bin")
	nodeBinDir := filepath.Join(root, "node", "bin")
	python := filepath.Join(pythonBinDir, pythonBinaryName())
	node := filepath.Join(nodeBinDir, nodeBinaryName())
	npm := filepath.Join(nodeBinDir, npmBinaryName())
	corepack := filepath.Join(nodeBinDir, corepackBinaryName())

	var (
		binDirs      []string
		envOverrides []string
		resolved     ResolvedRuntime
	)
	for _, component := range components {
		switch strings.TrimSpace(component) {
		case "python":
			if !isExecutableFile(python) {
				return ResolvedRuntime{}, fmt.Errorf("managed app runtime python executable is unavailable at %s", python)
			}
			resolved.Python = python
			binDirs = append(binDirs, pythonBinDir)
			envOverrides = append(envOverrides, "TUTTI_APP_PYTHON="+python)
		case "node":
			for name, path := range map[string]string{
				"node": node,
				"npm":  npm,
			} {
				if !isExecutableFile(path) {
					return ResolvedRuntime{}, fmt.Errorf("managed app runtime %s executable is unavailable at %s", name, path)
				}
			}
			if !isStandaloneCorepackWrapper(corepack) {
				return ResolvedRuntime{}, fmt.Errorf("managed app runtime corepack wrapper is unavailable or incompatible at %s", corepack)
			}
			resolved.Node = node
			resolved.NPM = npm
			binDirs = append(binDirs, nodeBinDir)
			envOverrides = append(envOverrides, "TUTTI_APP_NODE="+node, "TUTTI_APP_NPM="+npm)
		}
	}

	binDirs = mergeAppPathDirs(binDirs)
	resolved.Root = root
	resolved.BinDirs = binDirs
	resolved.EnvOverrides = append(
		[]string{tuttiAppRuntimeRootEnv + "=" + root},
		envOverrides...,
	)
	resolved.EnvOverrides = append(
		resolved.EnvOverrides,
		"PATH="+strings.Join(append(binDirs, filepath.SplitList(envValue(r.environ(), pathEnvKey(r.environ())))...), string(os.PathListSeparator)),
	)
	return resolved, nil
}

func (r DefaultResolver) ensureRuntime(ctx context.Context, root string) error {
	components, err := r.baselineRuntimeComponents(ctx, root)
	if err != nil {
		return err
	}
	if runtimeComponentsReady(root, components) {
		return nil
	}
	if err := r.ensureRuntimeProfile(ctx, root, appRuntimeBaselineProfile); err != nil {
		return err
	}
	if !runtimeComponentsReady(root, components) {
		return fmt.Errorf("managed app runtime artifact does not contain required baseline components: %s", strings.Join(components, ", "))
	}
	return nil
}

func (r DefaultResolver) baselineRuntimeComponents(ctx context.Context, root string) ([]string, error) {
	if RootReady(root) {
		return []string{"python", "node"}, nil
	}
	components, err := r.runtimeProfileComponentNames(ctx, appRuntimeBaselineProfile)
	if err == nil {
		return components, nil
	}
	// A fully materialized legacy runtime can still be resolved without a
	// catalog. Keep that offline behavior for existing Unix installations while
	// allowing platform catalogs (notably Windows) to define a node-only
	// baseline.
	return nil, err
}

func runtimeComponentsReady(root string, components []string) bool {
	if len(components) == 0 {
		return false
	}
	for _, component := range components {
		if !appRuntimeComponentReady(root, component) {
			return false
		}
	}
	return true
}

func (r DefaultResolver) ensureRuntimeProfile(ctx context.Context, root string, profile string) error {
	profile = strings.TrimSpace(profile)
	if profile == "" {
		return fmt.Errorf("managed app runtime profile is required")
	}
	release, err := acquireManagedAppRuntimeDownloadLock(ctx, root)
	if err != nil {
		return fmt.Errorf("wait for managed app runtime lock: %w", err)
	}
	defer release()

	if profile == appRuntimeBaselineProfile && RootReady(root) {
		return nil
	}
	if profile == appRuntimeNodeStaticProfile && NodeReady(root) {
		return nil
	}
	catalogSource := r.runtimeCatalogSource()
	if catalogSource == "" {
		return fmt.Errorf("managed app runtime is unavailable at %s and %s is not configured", root, tuttiAppRuntimeCatalogEnv)
	}
	platformArch := appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH)
	catalog, err := r.loadCatalog(ctx, catalogSource)
	if err != nil {
		return err
	}
	entry, ok := catalog.Runtimes[platformArch]
	if !ok {
		return fmt.Errorf("managed app runtime catalog does not contain platform %q", platformArch)
	}
	componentNames, err := appRuntimeProfileComponentNames(entry, profile)
	if err != nil {
		return err
	}
	missing := make([]string, 0, len(componentNames))
	for _, name := range componentNames {
		if !appRuntimeComponentReady(root, name) {
			missing = append(missing, name)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	return r.downloadRuntime(ctx, root, entry, missing)
}

func (r DefaultResolver) runtimeProfileComponentNames(ctx context.Context, profile string) ([]string, error) {
	catalogSource := r.runtimeCatalogSource()
	if catalogSource == "" {
		return nil, fmt.Errorf("managed app runtime catalog is unavailable and %s is not configured", tuttiAppRuntimeCatalogEnv)
	}
	platformArch := appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH)
	catalog, err := r.loadCatalog(ctx, catalogSource)
	if err != nil {
		return nil, err
	}
	entry, ok := catalog.Runtimes[platformArch]
	if !ok {
		return nil, fmt.Errorf("managed app runtime catalog does not contain platform %q", platformArch)
	}
	return appRuntimeProfileComponentNames(entry, profile)
}

func RootReady(root string) bool {
	if strings.TrimSpace(root) == "" {
		return false
	}
	runtime, err := DefaultResolver{RuntimeRoot: root}.resolvedRuntime(root)
	return err == nil &&
		runtime.Python != "" &&
		runtime.Node != "" &&
		runtime.NPM != ""
}

// NodeReady reports whether root contains a compatible managed Node component.
func NodeReady(root string) bool {
	return appRuntimeComponentReady(root, "node")
}

func appRuntimeComponentReady(root string, name string) bool {
	if strings.TrimSpace(root) == "" {
		return false
	}
	switch strings.TrimSpace(name) {
	case "python":
		return isExecutableFile(filepath.Join(root, "python", "bin", pythonBinaryName()))
	case "node":
		nodeBinDir := filepath.Join(root, "node", "bin")
		return isExecutableFile(filepath.Join(nodeBinDir, nodeBinaryName())) &&
			isExecutableFile(filepath.Join(nodeBinDir, npmBinaryName())) &&
			isStandaloneCorepackWrapper(filepath.Join(nodeBinDir, corepackBinaryName()))
	default:
		info, err := os.Stat(filepath.Join(root, name))
		return err == nil && info.IsDir()
	}
}

func (r DefaultResolver) loadCatalog(ctx context.Context, source string) (appRuntimeCatalog, error) {
	data, err := r.readCatalog(ctx, source)
	if err != nil {
		return appRuntimeCatalog{}, err
	}
	var catalog appRuntimeCatalog
	if err := json.Unmarshal(data, &catalog); err != nil {
		return appRuntimeCatalog{}, fmt.Errorf("parse managed app runtime catalog: %w", err)
	}
	if !isSupportedAppRuntimeCatalogSchemaVersion(strings.TrimSpace(catalog.SchemaVersion)) {
		return appRuntimeCatalog{}, fmt.Errorf("unsupported managed app runtime catalog schema version %q", catalog.SchemaVersion)
	}
	if len(catalog.Runtimes) == 0 {
		return appRuntimeCatalog{}, fmt.Errorf("managed app runtime catalog has no runtimes")
	}
	for platform, entry := range catalog.Runtimes {
		if err := validateManagedAppRuntimeCatalogEntry(platform, entry); err != nil {
			return appRuntimeCatalog{}, err
		}
	}
	return catalog, nil
}

func isSupportedAppRuntimeCatalogSchemaVersion(schemaVersion string) bool {
	return schemaVersion == appRuntimeCatalogSchemaVersion
}

func (r DefaultResolver) runtimeCatalogSource() string {
	for _, item := range r.environ() {
		key, value, ok := strings.Cut(item, "=")
		if ok && key == tuttiAppRuntimeCatalogEnv {
			return strings.TrimSpace(value)
		}
	}
	return defaultTuttiAppRuntimeCatalogURL
}

func (r DefaultResolver) readCatalog(ctx context.Context, source string) ([]byte, error) {
	if strings.HasPrefix(source, "http://") || strings.HasPrefix(source, "https://") {
		var lastErr error
		for attempt := 1; attempt <= managedAppRuntimeCatalogRequestAttempts; attempt++ {
			data, retry, err := r.readRemoteCatalogOnce(ctx, source)
			if err == nil {
				return data, nil
			}
			lastErr = err
			if !retry || attempt == managedAppRuntimeCatalogRequestAttempts {
				return nil, err
			}
			if err := waitForManagedAppRuntimeCatalogRetry(ctx, attempt); err != nil {
				return nil, fmt.Errorf("download managed app runtime catalog: %w", err)
			}
		}
		return nil, lastErr
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return nil, fmt.Errorf("read managed app runtime catalog: %w", err)
	}
	return data, nil
}

func (r DefaultResolver) readRemoteCatalogOnce(ctx context.Context, source string) ([]byte, bool, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return nil, false, fmt.Errorf("create managed app runtime catalog request: %w", err)
	}
	response, err := r.httpClient().Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, false, fmt.Errorf("download managed app runtime catalog: %w", ctx.Err())
		}
		return nil, isTransientManagedAppRuntimeCatalogError(err), fmt.Errorf("download managed app runtime catalog: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, managedAppRuntimeCatalogErrorDrainBytes))
		_ = response.Body.Close()
		retry := response.StatusCode == http.StatusRequestTimeout ||
			response.StatusCode == http.StatusTooManyRequests ||
			response.StatusCode >= http.StatusInternalServerError
		return nil, retry, fmt.Errorf("download managed app runtime catalog: unexpected status %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024+1))
	_ = response.Body.Close()
	if err != nil {
		if ctx.Err() != nil {
			return nil, false, fmt.Errorf("read managed app runtime catalog: %w", ctx.Err())
		}
		return nil, true, fmt.Errorf("read managed app runtime catalog: %w", err)
	}
	if len(data) > 2*1024*1024 {
		return nil, false, fmt.Errorf("managed app runtime catalog exceeds maximum size")
	}
	return data, false, nil
}

func isTransientManagedAppRuntimeCatalogError(err error) bool {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.ECONNABORTED) || errors.Is(err, syscall.ETIMEDOUT) {
		return true
	}
	var timeoutError interface{ Timeout() bool }
	if errors.As(err, &timeoutError) && timeoutError.Timeout() {
		return true
	}
	var temporaryError interface{ Temporary() bool }
	return errors.As(err, &temporaryError) && temporaryError.Temporary()
}

func waitForManagedAppRuntimeCatalogRetry(ctx context.Context, attempt int) error {
	timer := time.NewTimer(time.Duration(attempt) * managedAppRuntimeCatalogRetryBaseDelay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (r DefaultResolver) downloadRuntime(ctx context.Context, root string, entry appRuntimeCatalogEntry, componentNames []string) error {
	parent := filepath.Dir(root)
	downloadsDir := filepath.Join(parent, "downloads")
	if err := os.MkdirAll(downloadsDir, 0o755); err != nil {
		return fmt.Errorf("create managed app runtime download dir: %w", err)
	}

	downloads, err := r.downloadRuntimeComponents(ctx, downloadsDir, entry.Components, componentNames)
	defer func() {
		for _, download := range downloads {
			_ = os.Remove(download.archivePath)
		}
	}()
	if err != nil {
		return err
	}
	stagingDir, err := os.MkdirTemp(parent, filepath.Base(root)+".tmp-")
	if err != nil {
		return fmt.Errorf("create managed app runtime staging dir: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(stagingDir)
	}()
	for _, download := range downloads {
		if err := extractZipWithLimits(download.archivePath, stagingDir, maxManagedAppRuntimeArtifactBytes, maxManagedAppRuntimeExpandedBytes); err != nil {
			return fmt.Errorf("extract managed app runtime component %q: %w", download.name, err)
		}
	}
	for _, name := range componentNames {
		if !appRuntimeComponentReady(stagingDir, name) {
			return fmt.Errorf("managed app runtime artifact does not contain %q component", name)
		}
	}
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fmt.Errorf("create managed app runtime parent: %w", err)
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return fmt.Errorf("create managed app runtime root: %w", err)
	}
	for _, name := range componentNames {
		source := filepath.Join(stagingDir, name)
		target := filepath.Join(root, name)
		if err := os.RemoveAll(target); err != nil {
			return fmt.Errorf("replace managed app runtime component %q: %w", name, err)
		}
		if err := os.Rename(source, target); err != nil {
			return fmt.Errorf("install managed app runtime component %q: %w", name, err)
		}
	}
	return nil
}

type managedAppRuntimeComponentDownload struct {
	name        string
	archivePath string
}

func (r DefaultResolver) downloadRuntimeComponents(
	ctx context.Context,
	downloadsDir string,
	components map[string]appRuntimeCatalogComponent,
	componentNames []string,
) ([]managedAppRuntimeComponentDownload, error) {
	type result struct {
		download managedAppRuntimeComponentDownload
		err      error
	}
	downloadCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	results := make(chan result, len(componentNames))
	var waitGroup sync.WaitGroup
	for _, componentName := range componentNames {
		name := componentName
		component := components[name]
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			componentReport := componentDownloadProgressFromContext(downloadCtx)
			componentCtx := downloadCtx
			if componentReport != nil {
				componentCtx = ContextWithDownloadProgress(downloadCtx, func(progress DownloadProgress) {
					componentReport(name, progress)
				})
			}
			download, err := r.downloadRuntimeComponent(componentCtx, downloadsDir, name, component)
			if err != nil {
				cancel()
			}
			results <- result{download: download, err: err}
		}()
	}
	waitGroup.Wait()
	close(results)

	downloadsByName := make(map[string]managedAppRuntimeComponentDownload, len(componentNames))
	var resultErr error
	for item := range results {
		if item.err != nil {
			resultErr = errors.Join(resultErr, item.err)
			continue
		}
		downloadsByName[item.download.name] = item.download
	}
	if resultErr != nil {
		for _, download := range downloadsByName {
			_ = os.Remove(download.archivePath)
		}
		return nil, resultErr
	}

	downloads := make([]managedAppRuntimeComponentDownload, 0, len(componentNames))
	for _, name := range componentNames {
		download, ok := downloadsByName[name]
		if !ok {
			return nil, fmt.Errorf("managed app runtime component %q was not downloaded", name)
		}
		downloads = append(downloads, download)
	}
	return downloads, nil
}

func (r DefaultResolver) downloadRuntimeComponent(
	ctx context.Context,
	downloadsDir string,
	componentName string,
	component appRuntimeCatalogComponent,
) (managedAppRuntimeComponentDownload, error) {
	archiveFile, err := os.CreateTemp(downloadsDir, "runtime-"+safeAppRuntimeComponentName(componentName)+"-*.zip")
	if err != nil {
		return managedAppRuntimeComponentDownload{}, fmt.Errorf("create managed app runtime component download file: %w", err)
	}
	archivePath := archiveFile.Name()
	if err := archiveFile.Close(); err != nil {
		_ = os.Remove(archivePath)
		return managedAppRuntimeComponentDownload{}, fmt.Errorf("close managed app runtime component download file: %w", err)
	}
	if err := r.fetchArtifact(ctx, strings.TrimSpace(component.ArtifactURL), archivePath); err != nil {
		_ = os.Remove(archivePath)
		return managedAppRuntimeComponentDownload{}, err
	}
	downloadedSHA256, _, err := fileSHA256AndSize(archivePath)
	if err != nil {
		_ = os.Remove(archivePath)
		return managedAppRuntimeComponentDownload{}, err
	}
	if !strings.EqualFold(downloadedSHA256, strings.TrimSpace(component.ArtifactSHA256)) {
		_ = os.Remove(archivePath)
		return managedAppRuntimeComponentDownload{}, fmt.Errorf("managed app runtime component %q sha256 mismatch", componentName)
	}
	return managedAppRuntimeComponentDownload{name: componentName, archivePath: archivePath}, nil
}

func (r DefaultResolver) fetchArtifact(ctx context.Context, artifactURL string, destinationPath string) error {
	if strings.HasPrefix(artifactURL, "http://") || strings.HasPrefix(artifactURL, "https://") {
		return downloadArtifact(ctx, r.httpClient(), artifactURL, destinationPath)
	}
	source, err := os.Open(artifactURL)
	if err != nil {
		return fmt.Errorf("open managed app runtime artifact: %w", err)
	}
	defer func() {
		_ = source.Close()
	}()
	if err := os.MkdirAll(filepath.Dir(destinationPath), 0o755); err != nil {
		return fmt.Errorf("create managed app runtime artifact destination parent: %w", err)
	}
	target, err := os.OpenFile(destinationPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("create managed app runtime artifact destination: %w", err)
	}
	_, copyErr := io.Copy(target, io.LimitReader(source, maxManagedAppRuntimeArtifactBytes+1))
	info, statErr := target.Stat()
	var sizeErr error
	if statErr == nil && info != nil && info.Size() > maxManagedAppRuntimeArtifactBytes {
		sizeErr = fmt.Errorf("managed app runtime artifact exceeds maximum size %d", maxManagedAppRuntimeArtifactBytes)
	}
	return errors.Join(
		copyErr,
		statErr,
		target.Close(),
		sizeErr,
	)
}

func (r DefaultResolver) httpClient() *http.Client {
	if r.HTTPClient != nil {
		return r.HTTPClient
	}
	return httpx.Default()
}

func ContextWithDownloadProgress(ctx context.Context, report func(DownloadProgress)) context.Context {
	if report == nil {
		return ctx
	}
	return context.WithValue(ctx, downloadProgressKey{}, report)
}

func ContextWithComponentDownloadProgress(ctx context.Context, report func(string, DownloadProgress)) context.Context {
	if report == nil {
		return ctx
	}
	return context.WithValue(ctx, componentDownloadProgressKey{}, report)
}

func componentDownloadProgressFromContext(ctx context.Context) func(string, DownloadProgress) {
	if ctx == nil {
		return nil
	}
	report, _ := ctx.Value(componentDownloadProgressKey{}).(func(string, DownloadProgress))
	return report
}

func downloadProgressFromContext(ctx context.Context) func(DownloadProgress) {
	if ctx == nil {
		return nil
	}
	report, _ := ctx.Value(downloadProgressKey{}).(func(DownloadProgress))
	return report
}

func DefaultRoot(env []string) string {
	cacheRoot := strings.TrimSpace(envValue(env, tuttiAppRuntimeCacheRootEnv))
	if cacheRoot == "" {
		cacheRoot = filepath.Join(tuttitypes.DefaultStateDir(), "app-runtimes")
	}
	return filepath.Join(cacheRoot, appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH))
}

func (r DefaultResolver) DefaultRoot() string {
	return DefaultRoot(r.environ())
}

func appRuntimePlatformArch(platform string, arch string) string {
	return platform + "-" + arch
}

func ProcessEnv(overrides ...string) []string {
	env := os.Environ()
	for _, override := range overrides {
		key, _, ok := strings.Cut(override, "=")
		if !ok {
			env = append(env, override)
			continue
		}
		next := make([]string, 0, len(env)+1)
		for _, item := range env {
			itemKey, _, ok := strings.Cut(item, "=")
			if ok && strings.EqualFold(itemKey, key) {
				continue
			}
			next = append(next, item)
		}
		env = append(next, override)
	}
	// Inject the macOS system proxy so processes spawned with this env (agent
	// installs, workspace apps) reach the upstream API through the same proxy as
	// Resolver.Env()-spawned agents. Without it, an install from a restricted
	// region connects directly and gets `403 Request not allowed`.
	return runtimecmd.InjectSystemProxyEnv(env)
}

func EnvValue(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		candidateKey, value, ok := strings.Cut(env[i], "=")
		if ok && strings.EqualFold(candidateKey, key) {
			return value
		}
	}
	return ""
}

func (r DefaultResolver) environ() []string {
	if r.Environ != nil {
		return r.Environ()
	}
	return os.Environ()
}

func pythonBinaryName() string {
	if runtime.GOOS == "windows" {
		return "python.exe"
	}
	return "python3"
}

func nodeBinaryName() string {
	if runtime.GOOS == "windows" {
		return "node.exe"
	}
	return "node"
}

func npmBinaryName() string {
	if runtime.GOOS == "windows" {
		return "npm.cmd"
	}
	return "npm"
}

func corepackBinaryName() string {
	if runtime.GOOS == "windows" {
		return "corepack.cmd"
	}
	return "corepack"
}

func isStandaloneCorepackWrapper(path string) bool {
	if !isExecutableFile(path) {
		return false
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	normalized := strings.ReplaceAll(string(content), `\`, "/")
	if strings.Contains(normalized, "lib/node_modules/corepack/dist/corepack.js") {
		return true
	}
	return runtime.GOOS == "windows" && strings.Contains(
		normalized,
		"node_modules/corepack/dist/corepack.js",
	)
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return info.Mode().Perm()&0o111 != 0
}

func pathEnvKey(env []string) string {
	for i := len(env) - 1; i >= 0; i-- {
		key, _, ok := strings.Cut(env[i], "=")
		if ok && strings.EqualFold(key, "PATH") {
			return key
		}
	}
	return "PATH"
}
