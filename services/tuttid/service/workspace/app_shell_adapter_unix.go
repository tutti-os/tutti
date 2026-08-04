//go:build !windows

package workspace

import (
	"context"
	"fmt"
	"os"
	"os/exec"
)

func (platformAppShellAdapter) ValidateScript(scriptPath string) error {
	info, err := os.Stat(scriptPath)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return fmt.Errorf("must be a file")
	}
	if info.Mode()&0o111 == 0 {
		return fmt.Errorf("must be executable")
	}
	return nil
}

func (platformAppShellAdapter) Command(ctx context.Context, scriptPath string) (*exec.Cmd, []string, error) {
	return exec.CommandContext(ctx, scriptPath), nil, nil
}
