//go:build !windows

package workspace

import (
	"fmt"
	"os"
)

func replaceWorkspaceAppPackageDir(packageDir string) (string, error) {
	if err := os.RemoveAll(packageDir); err != nil {
		return "", fmt.Errorf("replace app package dir: %w", err)
	}
	return packageDir, nil
}
