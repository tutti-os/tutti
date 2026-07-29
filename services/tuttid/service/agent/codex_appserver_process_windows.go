//go:build windows

package agent

import "os/exec"

func prepareCodexAppServerCommand(command *exec.Cmd) {
	command.Cancel = func() error {
		if command.Process == nil {
			return nil
		}
		return command.Process.Kill()
	}
}
