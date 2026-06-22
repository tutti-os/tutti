package managedruntime

import (
	"archive/zip"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

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
        "node-static": ["node"]
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
	if err := resolver.PreloadProfile(context.Background(), "node-static"); err != nil {
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

	nodeRuntime, err := resolver.ResolveProfile(context.Background(), "node-static")
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

func createManagedRuntimeComponentArchiveForTest(t *testing.T, componentName string) string {
	t.Helper()

	sourceDir := t.TempDir()
	switch componentName {
	case "python":
		writeExecutable(t, filepath.Join(sourceDir, "python", "bin", pythonBinaryName()))
	case "node":
		writeExecutable(t, filepath.Join(sourceDir, "node", "bin", nodeBinaryName()))
		writeExecutable(t, filepath.Join(sourceDir, "node", "bin", npmBinaryName()))
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
