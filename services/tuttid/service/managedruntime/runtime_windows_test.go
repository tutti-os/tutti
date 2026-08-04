//go:build windows

package managedruntime

import (
	"os"
	"path/filepath"
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
