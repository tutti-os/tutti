//go:build !windows

package agent

import (
	"errors"
	"os/exec"
	"syscall"
)

func prepareCodexAppServerCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error {
		if command.Process == nil {
			return nil
		}
		if err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL); err != nil {
			if errors.Is(err, syscall.ESRCH) {
				return nil
			}
			return command.Process.Kill()
		}
		return nil
	}
}
