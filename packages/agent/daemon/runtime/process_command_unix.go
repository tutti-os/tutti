//go:build !windows

package agentruntime

import (
	"context"
	"os/exec"
	"syscall"
)

func newManagedProcessCommand(ctx context.Context, executable string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, executable, args...)
}

func terminateManagedProcess(command *exec.Cmd) error {
	return command.Process.Signal(syscall.SIGTERM)
}

func killManagedProcessTree(command *exec.Cmd) error {
	return command.Process.Kill()
}
