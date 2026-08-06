//go:build windows

package workspace

import (
	"errors"
	"os/exec"
	"strconv"
	"syscall"

	"golang.org/x/sys/windows"
)

func prepareAppProcessCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
}

func interruptAppProcess(command *exec.Cmd) error {
	return signalWindowsAppProcessTree(command, false)
}

func killAppProcess(command *exec.Cmd) error {
	return signalWindowsAppProcessTree(command, true)
}

func signalWindowsAppProcessTree(command *exec.Cmd, force bool) error {
	if command == nil || command.Process == nil {
		return nil
	}
	args := []string{"/PID", strconv.Itoa(command.Process.Pid), "/T"}
	if force {
		args = append(args, "/F")
	}
	err := exec.Command("taskkill.exe", args...).Run()
	if err == nil {
		return nil
	}
	if killErr := command.Process.Kill(); killErr != nil {
		return errors.Join(err, killErr)
	}
	return nil
}
