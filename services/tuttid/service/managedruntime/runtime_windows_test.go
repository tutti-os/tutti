//go:build windows

package managedruntime

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNodeReadyAcceptsOfficialWindowsCorepackLayout(t *testing.T) {
	root := t.TempDir()
	nodeBinDir := filepath.Join(root, "node", "bin")
	if err := os.MkdirAll(nodeBinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"node.exe", "npm.cmd"} {
		if err := os.WriteFile(filepath.Join(nodeBinDir, name), []byte("fixture"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	corepack := `@IF EXIST "%~dp0\node.exe" ("%~dp0\node.exe" "%~dp0\node_modules\corepack\dist\corepack.js" %*)`
	if err := os.WriteFile(filepath.Join(nodeBinDir, "corepack.cmd"), []byte(corepack), 0o755); err != nil {
		t.Fatal(err)
	}
	if !NodeReady(root) {
		t.Fatal("NodeReady() rejected the official Windows Node corepack.cmd layout")
	}
}

func TestDefaultResolverUsesWindowsCatalogBaselineWithoutPython(t *testing.T) {
	root := t.TempDir()
	nodeBinDir := filepath.Join(root, "node", "bin")
	if err := os.MkdirAll(nodeBinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"node.exe", "npm.cmd"} {
		if err := os.WriteFile(filepath.Join(nodeBinDir, name), []byte("fixture"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(nodeBinDir, "corepack.cmd"), []byte(`@IF EXIST "%~dp0\node.exe" ("%~dp0\node.exe" "%~dp0\node_modules\corepack\dist\corepack.js" %*)`), 0o644); err != nil {
		t.Fatal(err)
	}

	catalogPath := filepath.Join(t.TempDir(), "runtime-catalog.json")
	catalog := `{
  "schemaVersion": "tutti.app.runtimes.v2",
  "runtimes": {
    "windows-amd64": {
      "version": "test",
      "components": {
        "node": {
          "version": "test-node",
          "artifactUrl": "https://example.test/node.zip",
          "artifactSha256": "` + strings.Repeat("0", 64) + `"
        }
      },
      "profiles": {
        "baseline": ["node"],
        "node-static": ["node"]
      }
    }
  }
}`
	if err := os.WriteFile(catalogPath, []byte(catalog), 0o644); err != nil {
		t.Fatal(err)
	}

	resolved, err := (DefaultResolver{
		RuntimeRoot: root,
		Environ: func() []string {
			return []string{
				tuttiAppRuntimeCatalogEnv + "=" + catalogPath,
				"PATH=C:\\Windows\\System32",
			}
		},
	}).Resolve(context.Background())
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if resolved.Python != "" {
		t.Fatalf("resolved Python = %q, want empty for the Windows node-only baseline", resolved.Python)
	}
	if resolved.Node != filepath.Join(nodeBinDir, "node.exe") || resolved.NPM != filepath.Join(nodeBinDir, "npm.cmd") {
		t.Fatalf("resolved runtime = %#v", resolved)
	}
}
