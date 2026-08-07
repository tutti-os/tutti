//go:build !windows

package runtimeprep

import "os"

func replaceRuntimeAuthFile(source, destination string) error {
	return os.Rename(source, destination)
}
