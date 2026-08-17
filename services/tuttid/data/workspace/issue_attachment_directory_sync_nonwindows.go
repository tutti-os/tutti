//go:build !windows

package workspace

import (
	"fmt"
	"os"
)

func syncIssueAttachmentDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open issue attachment directory: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync issue attachment directory: %w", err)
	}
	return nil
}
