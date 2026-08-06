//go:build !windows

package agentruntime

import (
	"errors"
	"os/exec"
	"syscall"
)

func prepareConnectorProcessGroup(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateConnectorProcessGroup(command *exec.Cmd) error {
	return signalConnectorProcessGroup(command, syscall.SIGTERM)
}

func killConnectorProcessGroup(command *exec.Cmd) error {
	return signalConnectorProcessGroup(command, syscall.SIGKILL)
}

func signalConnectorProcessGroup(command *exec.Cmd, signal syscall.Signal) error {
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
