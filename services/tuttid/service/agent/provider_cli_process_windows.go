//go:build windows

package agent

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

func newProviderCLICommand(ctx context.Context, executable string, args ...string) *exec.Cmd {
	extension := strings.ToLower(filepath.Ext(executable))
	var command *exec.Cmd
	switch extension {
	case ".cmd", ".bat":
		command = exec.CommandContext(ctx, "cmd.exe", append([]string{"/D", "/S", "/C", "call", executable}, args...)...)
	case ".ps1":
		command = exec.CommandContext(ctx, "powershell.exe", append([]string{
			"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", executable,
		}, args...)...)
	default:
		command = exec.CommandContext(ctx, executable, args...)
	}
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	command.WaitDelay = 500 * time.Millisecond
	command.Cancel = func() error {
		if command.Process == nil {
			return nil
		}
		err := exec.Command("taskkill.exe", "/PID", strconv.Itoa(command.Process.Pid), "/T", "/F").Run()
		if err == nil {
			return nil
		}
		if killErr := command.Process.Kill(); killErr != nil {
			return errors.Join(err, killErr)
		}
		return nil
	}
	return command
}
