//go:build !windows

package artifact

import (
	"fmt"
	"os"
)

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync connector artifact directory: %w", err)
	}
	return nil
}
