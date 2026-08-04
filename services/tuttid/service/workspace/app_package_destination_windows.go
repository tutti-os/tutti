//go:build windows

package workspace

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

// Windows keeps executable files open while an app process is running. A
// daemon restart can therefore be unable to remove the previous version's
// package directory even though the package is otherwise valid. Materialize
// the replacement beside the locked directory and point the store at the new
// path; the old process can finish using its immutable package in place.
func replaceWorkspaceAppPackageDir(packageDir string) (string, error) {
	if err := os.RemoveAll(packageDir); err == nil {
		return packageDir, nil
	} else {
		parent := filepath.Dir(packageDir)
		if mkdirErr := os.MkdirAll(parent, 0o755); mkdirErr != nil {
			return "", fmt.Errorf("replace app package dir: %w; create replacement parent: %v", err, mkdirErr)
		}
		replacementDir, mkdirErr := os.MkdirTemp(parent, filepath.Base(packageDir)+"-windows-refresh-")
		if mkdirErr != nil {
			return "", fmt.Errorf("replace app package dir: %w; create side-by-side replacement: %v", err, mkdirErr)
		}
		slog.Warn(
			"workspace app package directory is locked; using side-by-side replacement",
			"event", "workspace.app.package.replace_deferred",
			"packageDir", packageDir,
			"replacementDir", replacementDir,
			"error", err,
		)
		return replacementDir, nil
	}
}
