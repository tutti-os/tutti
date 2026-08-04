//go:build !windows

package runtimeprep

import "os"

func exposeCodexDirectory(source, target string) error {
	return os.Symlink(source, target)
}
