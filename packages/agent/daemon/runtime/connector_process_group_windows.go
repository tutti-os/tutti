//go:build windows

package agentruntime

import "os/exec"

func prepareConnectorProcessGroup(*exec.Cmd) {}

func terminateConnectorProcessGroup(command *exec.Cmd) error {
	return killConnectorProcessGroup(command)
}

func killConnectorProcessGroup(command *exec.Cmd) error {
	if command == nil || command.Process == nil {
		return nil
	}
	return command.Process.Kill()
}
