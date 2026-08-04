//go:build windows

package workspace

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const managedPosixShellEnv = "TUTTI_MANAGED_POSIX_SHELL"

func (platformAppShellAdapter) ValidateScript(scriptPath string) error {
	info, err := os.Stat(scriptPath)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return fmt.Errorf("must be a file")
	}
	return nil
}

func (platformAppShellAdapter) Command(ctx context.Context, scriptPath string) (*exec.Cmd, []string, error) {
	shellPath := strings.TrimSpace(os.Getenv(managedPosixShellEnv))
	if shellPath == "" {
		return nil, nil, fmt.Errorf("managed POSIX shell is unavailable on Windows: %s is not configured", managedPosixShellEnv)
	}
	if !filepath.IsAbs(shellPath) {
		return nil, nil, fmt.Errorf("managed POSIX shell must be an absolute path: %s", shellPath)
	}
	info, err := os.Stat(shellPath)
	if err != nil {
		return nil, nil, fmt.Errorf("stat managed POSIX shell: %w", err)
	}
	if info.IsDir() {
		return nil, nil, fmt.Errorf("managed POSIX shell must be a file: %s", shellPath)
	}
	return exec.CommandContext(ctx, shellPath, "--noprofile", "--norc", scriptPath), []string{filepath.Dir(shellPath)}, nil
}
