//go:build windows

package runtimeprep

import (
	"fmt"
	"os"
)

// Prefer a hard link after the ordinary symlink path. Hard links do not need
// the Windows symlink privilege and preserve shared-file updates when the
// source already exists. If the source is not present yet, the caller may
// treat the failed link as a cache miss and let the CLI create a private file.
func exposeCodexFile(source, target string, mode os.FileMode) error {
	if err := os.Symlink(source, target); err == nil {
		return nil
	} else {
		symlinkErr := err
		if err := os.Link(source, target); err == nil {
			return nil
		} else if copyErr := copyFile(source, target, mode); copyErr == nil {
			return nil
		} else {
			return fmt.Errorf("symlink failed: %v; hard-link/copy failed: %w", symlinkErr, copyErr)
		}
	}
}
