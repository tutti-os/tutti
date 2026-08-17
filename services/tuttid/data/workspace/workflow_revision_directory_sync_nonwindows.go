//go:build !windows

package workspace

import (
	"fmt"
	"os"
)

func syncWorkflowRevisionDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open workspace workflow revision directory: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync workspace workflow revision directory: %w", err)
	}
	return nil
}
