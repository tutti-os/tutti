//go:build !windows

package agent

import (
	"context"
	"os/exec"
)

func newProviderCLICommand(ctx context.Context, executable string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, executable, args...)
}
