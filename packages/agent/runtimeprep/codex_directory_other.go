//go:build !windows

package runtimeprep

import (
	"os"
	"path/filepath"
)

func exposeCodexDirectory(source, target string) error {
	return os.Symlink(source, target)
}

func exposeCodexSharedDirectory(source, target string) error {
	return exposeSharedRuntimeDirectory(source, target)
}

func exposeSharedRuntimeDirectory(source, target string) error {
	return os.Symlink(source, target)
}

func sameSharedRuntimePath(left, right string) bool {
	return filepath.Clean(left) == filepath.Clean(right)
}
