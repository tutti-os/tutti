package managedruntime

import (
	"archive/zip"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

type temporaryNetworkError struct{}

func (temporaryNetworkError) Error() string   { return "temporary network error" }
func (temporaryNetworkError) Timeout() bool   { return false }
func (temporaryNetworkError) Temporary() bool { return true }

type observedResponseBody struct {
	reader *strings.Reader
	closed bool
}

func (body *observedResponseBody) Read(buffer []byte) (int, error) {
	return body.reader.Read(buffer)
}

func (body *observedResponseBody) Close() error {
	body.closed = true
	return nil
}

func TestDefaultResolverInjectsBaselineRuntime(t *testing.T) {
	root := t.TempDir()
	pythonBinDir := filepath.Join(root, "python", "bin")
	nodeBinDir := filepath.Join(root, "node", "bin")
	for _, dir := range []string{pythonBinDir, nodeBinDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir runtime bin dir: %v", err)
		}
	}
	writeExecutable(t, filepath.Join(pythonBinDir, pythonBinaryName()))
	writeExecutable(t, filepath.Join(nodeBinDir, nodeBinaryName()))
	writeExecutable(t, filepath.Join(nodeBinDir, npmBinaryName()))
	writeCorepackWrapper(t, filepath.Join(nodeBinDir, corepackBinaryName()))

	resolved, err := DefaultResolver{
		RuntimeRoot: root,
		Environ:     func() []string { return []string{"PATH=/usr/bin:/bin"} },
	}.Resolve(context.Background())
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	env := ProcessEnv(append([]string{"TUTTI_APP_ID=test"}, resolved.EnvOverrides...)...)
	pathEnv := EnvValue(env, "PATH")
	if !strings.HasPrefix(pathEnv, pythonBinDir+string(os.PathListSeparator)+nodeBinDir) {
		t.Fatalf("PATH = %q, want managed runtime bins first", pathEnv)
	}
	if EnvValue(env, "TUTTI_APP_PYTHON") != filepath.Join(pythonBinDir, pythonBinaryName()) {
		t.Fatalf("TUTTI_APP_PYTHON = %q", EnvValue(env, "TUTTI_APP_PYTHON"))
	}
	if EnvValue(env, "TUTTI_APP_NODE") != filepath.Join(nodeBinDir, nodeBinaryName()) {
		t.Fatalf("TUTTI_APP_NODE = %q", EnvValue(env, "TUTTI_APP_NODE"))
	}
	if !strings.Contains(pathEnv, "/usr/bin") {
		t.Fatalf("PATH = %q, want original path preserved", pathEnv)
	}
}

func TestDefaultResolverUsesExistingNodeProfileWithoutCatalog(t *testing.T) {
	root := t.TempDir()
	nodeBinDir := filepath.Join(root, "node", "bin")
	if err := os.MkdirAll(nodeBinDir, 0o755); err != nil {
		t.Fatalf("mkdir node bin dir: %v", err)
	}
	writeExecutable(t, filepath.Join(nodeBinDir, nodeBinaryName()))
	writeExecutable(t, filepath.Join(nodeBinDir, npmBinaryName()))
	writeCorepackWrapper(t, filepath.Join(nodeBinDir, corepackBinaryName()))

	resolved, err := DefaultResolver{
		RuntimeRoot: root,
		Environ: func() []string {
			return []string{
				tuttiAppRuntimeCatalogEnv + "=",
				"PATH=/usr/bin:/bin",
			}
		},
	}.ResolveProfile(context.Background(), appRuntimeNodeStaticProfile)
	if err != nil {
		t.Fatalf("ResolveProfile() error = %v", err)
	}
	if resolved.Node != filepath.Join(nodeBinDir, nodeBinaryName()) {
		t.Fatalf("resolved Node = %q, want existing managed node", resolved.Node)
	}
	if resolved.Python != "" {
		t.Fatalf("resolved Python = %q, want node-only profile", resolved.Python)
	}
}

func TestDefaultResolverRejectsMissingRuntime(t *testing.T) {
	_, err := DefaultResolver{
		Environ: func() []string {
			return []string{
				tuttiAppRuntimeCacheRootEnv + "=" + t.TempDir(),
				tuttiAppRuntimeCatalogEnv + "=",
			}
		},
	}.Resolve(context.Background())
	if err == nil {
		t.Fatal("Resolve() error = nil, want missing cached runtime error")
	}
}

func TestDefaultResolverUsesDaemonCacheRoot(t *testing.T) {
	cacheRoot := t.TempDir()
	root := DefaultRoot([]string{
		tuttiAppRuntimeCacheRootEnv + "=" + cacheRoot,
	})

	if root != filepath.Join(cacheRoot, appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH)) {
		t.Fatalf("DefaultRoot() = %q", root)
	}
}

func TestDefaultResolverUsesDefaultCatalogWhenUnset(t *testing.T) {
	source := DefaultResolver{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
	}.runtimeCatalogSource()

	if source != defaultTuttiAppRuntimeCatalogURL {
		t.Fatalf("runtimeCatalogSource() = %q, want %q", source, defaultTuttiAppRuntimeCatalogURL)
	}
}

func TestDefaultResolverAllowsEmptyCatalogOverride(t *testing.T) {
	source := DefaultResolver{
		Environ: func() []string {
			return []string{
				tuttiAppRuntimeCatalogEnv + "=",
				"PATH=/usr/bin:/bin",
			}
		},
	}.runtimeCatalogSource()

	if source != "" {
		t.Fatalf("runtimeCatalogSource() = %q, want empty override", source)
	}
}

func TestDefaultResolverRetriesTransientCatalogHTTPStatuses(t *testing.T) {
	for _, statusCode := range []int{http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusInternalServerError} {
		t.Run(http.StatusText(statusCode), func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				if requests.Add(1) == 1 {
					writer.WriteHeader(statusCode)
					return
				}
				_, _ = writer.Write([]byte("catalog"))
			}))
			defer server.Close()

			data, err := (DefaultResolver{HTTPClient: server.Client()}).readCatalog(context.Background(), server.URL)
			if err != nil {
				t.Fatalf("readCatalog() error = %v", err)
			}
			if string(data) != "catalog" {
				t.Fatalf("readCatalog() = %q, want catalog", data)
			}
			if got := requests.Load(); got != 2 {
				t.Fatalf("catalog requests = %d, want 2", got)
			}
		})
	}
}

func TestDefaultResolverRetriesOnlyTransientCatalogRequestErrors(t *testing.T) {
	transientErrors := []error{io.ErrUnexpectedEOF, syscall.ECONNRESET, syscall.ECONNREFUSED, temporaryNetworkError{}}
	for _, transientErr := range transientErrors {
		var requests atomic.Int32
		client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
			if requests.Add(1) == 1 {
				return nil, transientErr
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader("catalog")),
				Header:     make(http.Header),
			}, nil
		})}
		data, err := (DefaultResolver{HTTPClient: client}).readCatalog(context.Background(), "https://catalog.test")
		if err != nil || string(data) != "catalog" || requests.Load() != 2 {
			t.Fatalf("transient error %T: data=%q requests=%d error=%v", transientErr, data, requests.Load(), err)
		}
	}

	for _, permanentErr := range []error{
		errors.New("x509: certificate signed by unknown authority"),
		errors.New("redirect policy rejected"),
		errors.New("invalid proxy configuration"),
	} {
		var requests atomic.Int32
		client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
			requests.Add(1)
			return nil, permanentErr
		})}
		_, err := (DefaultResolver{HTTPClient: client}).readCatalog(context.Background(), "https://catalog.test")
		if err == nil || requests.Load() != 1 {
			t.Fatalf("permanent error %q: requests=%d error=%v", permanentErr, requests.Load(), err)
		}
	}
}

func TestDefaultResolverBoundsCatalogRetries(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		writer.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	_, err := (DefaultResolver{HTTPClient: server.Client()}).readCatalog(context.Background(), server.URL)
	if err == nil || !strings.Contains(err.Error(), "unexpected status 503") {
		t.Fatalf("readCatalog() error = %v, want 503", err)
	}
	if got := requests.Load(); got != managedAppRuntimeCatalogRequestAttempts {
		t.Fatalf("catalog requests = %d, want bounded attempts %d", got, managedAppRuntimeCatalogRequestAttempts)
	}
}

func TestDefaultResolverDrainsCatalogErrorResponseBeforeRetry(t *testing.T) {
	body := &observedResponseBody{reader: strings.NewReader(strings.Repeat("x", 1024))}
	var requests atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		if requests.Add(1) == 1 {
			return &http.Response{StatusCode: http.StatusServiceUnavailable, Body: body, Header: make(http.Header)}, nil
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader("catalog")),
			Header:     make(http.Header),
		}, nil
	})}

	_, err := (DefaultResolver{HTTPClient: client}).readCatalog(context.Background(), "https://catalog.test")
	if err != nil {
		t.Fatalf("readCatalog() error = %v", err)
	}
	if !body.closed || body.reader.Len() != 0 {
		t.Fatalf("error response body closed=%v remaining=%d, want drained and closed", body.closed, body.reader.Len())
	}
}

func TestDefaultResolverDoesNotRetryPermanentCatalogFailures(t *testing.T) {
	t.Run("http 4xx", func(t *testing.T) {
		var requests atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			requests.Add(1)
			writer.WriteHeader(http.StatusNotFound)
		}))
		defer server.Close()

		_, err := (DefaultResolver{HTTPClient: server.Client()}).readCatalog(context.Background(), server.URL)
		if err == nil || !strings.Contains(err.Error(), "unexpected status 404") {
			t.Fatalf("readCatalog() error = %v, want 404", err)
		}
		if got := requests.Load(); got != 1 {
			t.Fatalf("catalog requests = %d, want 1", got)
		}
	})

	t.Run("schema", func(t *testing.T) {
		var requests atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			requests.Add(1)
			_, _ = writer.Write([]byte(`{"schemaVersion":"unsupported","runtimes":{}}`))
		}))
		defer server.Close()

		_, err := (DefaultResolver{HTTPClient: server.Client()}).loadCatalog(context.Background(), server.URL)
		if err == nil || !strings.Contains(err.Error(), "unsupported managed app runtime catalog schema") {
			t.Fatalf("loadCatalog() error = %v, want schema error", err)
		}
		if got := requests.Load(); got != 1 {
			t.Fatalf("catalog requests = %d, want 1", got)
		}
	})
}

func TestDefaultResolverRetriesTruncatedCatalogResponse(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			writer.Header().Set("Content-Length", "100")
			_, _ = writer.Write([]byte("{"))
			return
		}
		_, _ = writer.Write([]byte("catalog"))
	}))
	defer server.Close()

	data, err := (DefaultResolver{HTTPClient: server.Client()}).readCatalog(context.Background(), server.URL)
	if err != nil {
		t.Fatalf("readCatalog() error = %v", err)
	}
	if string(data) != "catalog" || requests.Load() != 2 {
		t.Fatalf("readCatalog() = %q after %d requests, want catalog after 2", data, requests.Load())
	}
}

func TestDefaultResolverCatalogRetryRespectsContextCancellation(t *testing.T) {
	var requests atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		cancel()
		writer.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	defer cancel()

	_, err := (DefaultResolver{HTTPClient: server.Client()}).readCatalog(ctx, server.URL)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("readCatalog() error = %v, want context.Canceled", err)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("catalog requests = %d, want 1", got)
	}
}

func TestManagedAppRuntimeDownloadLockWaitRespectsContextCancellation(t *testing.T) {
	root := t.TempDir()
	release, err := acquireManagedAppRuntimeDownloadLock(context.Background(), root)
	if err != nil {
		t.Fatalf("acquire first lock: %v", err)
	}
	defer release()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result := make(chan error, 1)
	go func() {
		_, err := acquireManagedAppRuntimeDownloadLock(ctx, root)
		result <- err
	}()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("waiting lock error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("waiting lock did not return after context cancellation")
	}
}

func TestDefaultResolverConcurrentProfilePreloadsRecoverFromTransientCatalogEOF(t *testing.T) {
	cacheRoot := t.TempDir()
	nodeArtifactPath := createManagedRuntimeComponentArchiveForTest(t, "node")
	nodeSHA256, _, err := fileSHA256AndSize(nodeArtifactPath)
	if err != nil {
		t.Fatalf("fileSHA256AndSize() error = %v", err)
	}
	catalogJSON := `{
  "schemaVersion": "tutti.app.runtimes.v2",
  "runtimes": {
    "` + appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH) + `": {
      "version": "test",
      "components": {
        "node": {
          "version": "test-node",
          "artifactUrl": "` + filepath.ToSlash(nodeArtifactPath) + `",
          "artifactSha256": "` + nodeSHA256 + `"
        }
      },
      "profiles": {
        "baseline": ["node"],
        "connector-node-static": ["node"]
      }
    }
  }
}`
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			writer.Header().Set("Content-Length", "100")
			_, _ = writer.Write([]byte("{"))
			return
		}
		_, _ = writer.Write([]byte(catalogJSON))
	}))
	defer server.Close()

	resolver := DefaultResolver{
		RuntimeRoot: filepath.Join(cacheRoot, "shared-runtime"),
		Environ: func() []string {
			return []string{tuttiAppRuntimeCatalogEnv + "=" + server.URL}
		},
		HTTPClient: server.Client(),
	}
	var waitGroup sync.WaitGroup
	errorsByCaller := make(chan error, 2)
	for range 2 {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			errorsByCaller <- resolver.PreloadProfile(context.Background(), appRuntimeNodeStaticProfile)
		}()
	}
	waitGroup.Wait()
	close(errorsByCaller)
	for err := range errorsByCaller {
		if err != nil {
			t.Fatalf("PreloadProfile() error = %v", err)
		}
	}
	if got := requests.Load(); got != 2 {
		t.Fatalf("catalog requests = %d, want one failed and one successful request", got)
	}
	if !NodeReady(resolver.RuntimeRoot) {
		t.Fatal("shared managed runtime is not ready after concurrent preloads")
	}
}

func TestDefaultResolverDownloadsRuntimeFromCatalog(t *testing.T) {
	cacheRoot := t.TempDir()
	pythonArtifactPath := createManagedRuntimeComponentArchiveForTest(t, "python")
	pythonSHA256, _, err := fileSHA256AndSize(pythonArtifactPath)
	if err != nil {
		t.Fatalf("fileSHA256AndSize() error = %v", err)
	}
	nodeArtifactPath := createManagedRuntimeComponentArchiveForTest(t, "node")
	nodeSHA256, _, err := fileSHA256AndSize(nodeArtifactPath)
	if err != nil {
		t.Fatalf("fileSHA256AndSize() error = %v", err)
	}
	catalogPath := filepath.Join(t.TempDir(), "runtimes.json")
	catalogJSON := `{
  "schemaVersion": "tutti.app.runtimes.v2",
  "runtimes": {
    "` + appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH) + `": {
      "version": "test",
      "components": {
        "python": {
          "version": "test-python",
          "artifactUrl": "` + filepath.ToSlash(pythonArtifactPath) + `",
          "artifactSha256": "` + pythonSHA256 + `"
        },
        "node": {
          "version": "test-node",
          "artifactUrl": "` + filepath.ToSlash(nodeArtifactPath) + `",
          "artifactSha256": "` + nodeSHA256 + `"
        }
      },
      "profiles": {
        "baseline": ["python", "node"]
      }
    }
  }
}`
	if err := os.WriteFile(catalogPath, []byte(catalogJSON), 0o644); err != nil {
		t.Fatalf("write catalog: %v", err)
	}

	resolved, err := DefaultResolver{
		Environ: func() []string {
			return []string{
				tuttiAppRuntimeCacheRootEnv + "=" + cacheRoot,
				tuttiAppRuntimeCatalogEnv + "=" + catalogPath,
				"PATH=/usr/bin:/bin",
			}
		},
	}.Resolve(context.Background())
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}

	wantRoot := filepath.Join(cacheRoot, appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH))
	if resolved.Root != wantRoot {
		t.Fatalf("Root = %q, want %q", resolved.Root, wantRoot)
	}
	for _, path := range []string{resolved.Python, resolved.Node, resolved.NPM} {
		if !strings.HasPrefix(path, wantRoot) {
			t.Fatalf("resolved executable %q is outside runtime root %q", path, wantRoot)
		}
		if !isExecutableFile(path) {
			t.Fatalf("resolved executable %q is not executable", path)
		}
	}
}

func TestDefaultResolverPreloadsRuntimeProfileComponents(t *testing.T) {
	cacheRoot := t.TempDir()
	pythonArtifactPath := createManagedRuntimeComponentArchiveForTest(t, "python")
	pythonSHA256, _, err := fileSHA256AndSize(pythonArtifactPath)
	if err != nil {
		t.Fatalf("fileSHA256AndSize() error = %v", err)
	}
	nodeArtifactPath := createManagedRuntimeComponentArchiveForTest(t, "node")
	nodeSHA256, _, err := fileSHA256AndSize(nodeArtifactPath)
	if err != nil {
		t.Fatalf("fileSHA256AndSize() error = %v", err)
	}
	catalogPath := filepath.Join(t.TempDir(), "runtimes.json")
	catalogJSON := `{
  "schemaVersion": "tutti.app.runtimes.v2",
  "runtimes": {
    "` + appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH) + `": {
      "version": "test",
      "components": {
        "python": {
          "version": "test-python",
          "artifactUrl": "` + filepath.ToSlash(pythonArtifactPath) + `",
          "artifactSha256": "` + pythonSHA256 + `"
        },
        "node": {
          "version": "test-node",
          "artifactUrl": "` + filepath.ToSlash(nodeArtifactPath) + `",
          "artifactSha256": "` + nodeSHA256 + `"
        }
      },
      "profiles": {
        "baseline": ["python", "node"],
        "connector-node-static": ["node"]
      }
    }
  }
}`
	if err := os.WriteFile(catalogPath, []byte(catalogJSON), 0o644); err != nil {
		t.Fatalf("write catalog: %v", err)
	}

	resolver := DefaultResolver{
		Environ: func() []string {
			return []string{
				tuttiAppRuntimeCacheRootEnv + "=" + cacheRoot,
				tuttiAppRuntimeCatalogEnv + "=" + catalogPath,
				"PATH=/usr/bin:/bin",
			}
		},
	}
	if err := resolver.PreloadProfile(context.Background(), "connector-node-static"); err != nil {
		t.Fatalf("PreloadProfile() error = %v", err)
	}

	root := filepath.Join(cacheRoot, appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH))
	if !isExecutableFile(filepath.Join(root, "node", "bin", nodeBinaryName())) {
		t.Fatal("node profile preload did not install node")
	}
	if !isExecutableFile(filepath.Join(root, "node", "bin", npmBinaryName())) {
		t.Fatal("node profile preload did not install npm")
	}
	if isExecutableFile(filepath.Join(root, "python", "bin", pythonBinaryName())) {
		t.Fatal("node profile preload installed python")
	}

	nodeRuntime, err := resolver.ResolveProfile(context.Background(), "connector-node-static")
	if err != nil {
		t.Fatalf("ResolveProfile(node-static) error = %v", err)
	}
	if nodeRuntime.Python != "" {
		t.Fatalf("ResolveProfile(node-static) Python = %q, want empty", nodeRuntime.Python)
	}
	if !isExecutableFile(nodeRuntime.Node) || !isExecutableFile(nodeRuntime.NPM) {
		t.Fatalf("ResolveProfile(node-static) did not resolve node runtime: %#v", nodeRuntime)
	}
	if isExecutableFile(filepath.Join(root, "python", "bin", pythonBinaryName())) {
		t.Fatal("node profile resolve installed python")
	}

	resolved, err := resolver.Resolve(context.Background())
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if !isExecutableFile(resolved.Python) || !isExecutableFile(resolved.Node) || !isExecutableFile(resolved.NPM) {
		t.Fatalf("Resolve() did not complete baseline runtime: %#v", resolved)
	}
}

func TestDefaultResolverReplacesNodeComponentWithBrokenCorepackWrapper(t *testing.T) {
	cacheRoot := t.TempDir()
	root := filepath.Join(cacheRoot, appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH))
	nodeBinDir := filepath.Join(root, "node", "bin")
	writeExecutable(t, filepath.Join(nodeBinDir, nodeBinaryName()))
	writeExecutable(t, filepath.Join(nodeBinDir, npmBinaryName()))
	writeExecutable(t, filepath.Join(nodeBinDir, corepackBinaryName()))

	nodeArtifactPath := createManagedRuntimeComponentArchiveForTest(t, "node")
	nodeSHA256, _, err := fileSHA256AndSize(nodeArtifactPath)
	if err != nil {
		t.Fatalf("fileSHA256AndSize() error = %v", err)
	}
	catalogPath := filepath.Join(t.TempDir(), "runtimes.json")
	catalogJSON := `{
  "schemaVersion": "tutti.app.runtimes.v2",
  "runtimes": {
    "` + appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH) + `": {
      "version": "test",
      "components": {
        "node": {
          "version": "test-node",
          "artifactUrl": "` + filepath.ToSlash(nodeArtifactPath) + `",
          "artifactSha256": "` + nodeSHA256 + `"
        }
      },
      "profiles": {
        "baseline": ["node"],
        "connector-node-static": ["node"]
      }
    }
  }
}`
	if err := os.WriteFile(catalogPath, []byte(catalogJSON), 0o644); err != nil {
		t.Fatalf("write catalog: %v", err)
	}

	resolved, err := DefaultResolver{
		Environ: func() []string {
			return []string{
				tuttiAppRuntimeCacheRootEnv + "=" + cacheRoot,
				tuttiAppRuntimeCatalogEnv + "=" + catalogPath,
				"PATH=/usr/bin:/bin",
			}
		},
	}.ResolveProfile(context.Background(), appRuntimeNodeStaticProfile)
	if err != nil {
		t.Fatalf("ResolveProfile() error = %v", err)
	}
	if !isStandaloneCorepackWrapper(filepath.Join(nodeBinDir, corepackBinaryName())) {
		t.Fatal("ResolveProfile() did not replace the broken corepack wrapper")
	}
	if resolved.Node != filepath.Join(nodeBinDir, nodeBinaryName()) {
		t.Fatalf("resolved Node = %q, want managed node component", resolved.Node)
	}
}

func TestDefaultResolverRejectsRuntimeShaMismatch(t *testing.T) {
	cacheRoot := t.TempDir()
	pythonArtifactPath := createManagedRuntimeComponentArchiveForTest(t, "python")
	nodeArtifactPath := createManagedRuntimeComponentArchiveForTest(t, "node")
	nodeSHA256, _, err := fileSHA256AndSize(nodeArtifactPath)
	if err != nil {
		t.Fatalf("fileSHA256AndSize() error = %v", err)
	}
	catalogPath := filepath.Join(t.TempDir(), "runtimes.json")
	catalogJSON := `{
  "schemaVersion": "tutti.app.runtimes.v2",
  "runtimes": {
    "` + appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH) + `": {
      "version": "test",
      "components": {
        "python": {
          "version": "test-python",
          "artifactUrl": "` + filepath.ToSlash(pythonArtifactPath) + `",
          "artifactSha256": "` + strings.Repeat("0", 64) + `"
        },
        "node": {
          "version": "test-node",
          "artifactUrl": "` + filepath.ToSlash(nodeArtifactPath) + `",
          "artifactSha256": "` + nodeSHA256 + `"
        }
      },
      "profiles": {
        "baseline": ["python", "node"]
      }
    }
  }
}`
	if err := os.WriteFile(catalogPath, []byte(catalogJSON), 0o644); err != nil {
		t.Fatalf("write catalog: %v", err)
	}

	_, err = DefaultResolver{
		Environ: func() []string {
			return []string{
				tuttiAppRuntimeCacheRootEnv + "=" + cacheRoot,
				tuttiAppRuntimeCatalogEnv + "=" + catalogPath,
			}
		},
	}.Resolve(context.Background())
	if err == nil || !strings.Contains(err.Error(), "sha256 mismatch") {
		t.Fatalf("Resolve() error = %v, want sha256 mismatch", err)
	}
}

func writeExecutable(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("create executable parent %s: %v", path, err)
	}
	body := "#!/bin/sh\nexit 0\n"
	mode := os.FileMode(0o755)
	if runtime.GOOS == "windows" {
		body = "@echo off\r\nexit /b 0\r\n"
		mode = 0o644
	}
	if err := os.WriteFile(path, []byte(body), mode); err != nil {
		t.Fatalf("write executable %s: %v", path, err)
	}
}

func writeCorepackWrapper(t *testing.T, path string) {
	t.Helper()
	body := `#!/bin/sh
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "${script_dir}/node" "${script_dir}/../lib/node_modules/corepack/dist/corepack.js" "$@"
`
	mode := os.FileMode(0o755)
	if runtime.GOOS == "windows" {
		body = `@echo off
"%~dp0node.exe" "%~dp0..\lib\node_modules\corepack\dist\corepack.js" %*
`
		mode = 0o644
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("create corepack wrapper parent %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(body), mode); err != nil {
		t.Fatalf("write corepack wrapper %s: %v", path, err)
	}
}

func createManagedRuntimeComponentArchiveForTest(t *testing.T, componentName string) string {
	t.Helper()

	sourceDir := t.TempDir()
	switch componentName {
	case "python":
		writeExecutable(t, filepath.Join(sourceDir, "python", "bin", pythonBinaryName()))
	case "node":
		writeExecutable(t, filepath.Join(sourceDir, "node", "bin", nodeBinaryName()))
		writeExecutable(t, filepath.Join(sourceDir, "node", "bin", npmBinaryName()))
		writeCorepackWrapper(t, filepath.Join(sourceDir, "node", "bin", corepackBinaryName()))
	default:
		t.Fatalf("unsupported runtime component %q", componentName)
	}

	archivePath := filepath.Join(t.TempDir(), "runtime.zip")
	target, err := os.Create(archivePath)
	if err != nil {
		t.Fatalf("create runtime archive: %v", err)
	}
	writer := zip.NewWriter(target)
	walkErr := filepath.WalkDir(sourceDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relativePath, err := filepath.Rel(sourceDir, path)
		if err != nil {
			return err
		}
		if relativePath == "." {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(relativePath)
		if entry.IsDir() {
			header.Name += "/"
		}
		archiveEntry, err := writer.CreateHeader(header)
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		_, err = archiveEntry.Write(data)
		return err
	})
	if err := writer.Close(); err != nil && walkErr == nil {
		walkErr = err
	}
	if err := target.Close(); err != nil && walkErr == nil {
		walkErr = err
	}
	if walkErr != nil {
		t.Fatalf("write runtime archive: %v", walkErr)
	}
	return archivePath
}
