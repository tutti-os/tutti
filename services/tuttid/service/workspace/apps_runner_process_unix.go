//go:build !windows

package workspace

import (
	"errors"
	"os/exec"
	"syscall"
)

func prepareAppProcessCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func releaseAppProcessCommand(_ *exec.Cmd) error {
	return nil
}

func interruptAppProcess(command *exec.Cmd) error {
	return signalAppProcessGroup(command, syscall.SIGINT)
}

func containAppProcess(_ *exec.Cmd) (appProcessContainment, error) {
	return nil, nil
}

func killAppProcess(process *appProcess) error {
	if process == nil {
		return nil
	}
	return signalAppProcessGroup(process.command, syscall.SIGKILL)
}

func signalAppProcessTree(command *exec.Cmd, force bool) error {
	if force {
		return signalAppProcessGroup(command, syscall.SIGKILL)
	}
	return signalAppProcessGroup(command, syscall.SIGINT)
}

func signalAppProcessGroup(command *exec.Cmd, signal syscall.Signal) error {
	if command == nil || command.Process == nil {
		return nil
	}
	if err := syscall.Kill(-command.Process.Pid, signal); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return command.Process.Signal(signal)
	}
	return nil
}
