//go:build windows

package agentruntime

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

func newManagedProcessCommand(ctx context.Context, executable string, args ...string) *exec.Cmd {
	extension := strings.ToLower(filepath.Ext(executable))
	var command *exec.Cmd
	if extension == ".cmd" || extension == ".bat" {
		// Batch files need cmd.exe's CALL command. Pass the executable and each
		// argument as separate exec.Cmd arguments so Go performs the Windows
		// quoting once; composing the whole command into the /C argument causes
		// cmd.exe to retain a literal quote around paths containing spaces.
		command = exec.CommandContext(ctx, windowsCommandInterpreter(), append([]string{"/D", "/C", "call", executable}, args...)...)
	} else if extension == ".ps1" {
		command = exec.CommandContext(ctx, "powershell.exe", append([]string{
			"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", executable,
		}, args...)...)
	} else {
		command = exec.CommandContext(ctx, executable, args...)
	}
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	return command
}

func windowsCommandInterpreter() string {
	if value := strings.TrimSpace(os.Getenv("ComSpec")); value != "" {
		return value
	}
	return "cmd.exe"
}

func terminateManagedProcess(command *exec.Cmd) error {
	if command == nil || command.Process == nil {
		return nil
	}
	err := exec.Command("taskkill.exe", "/PID", strconv.Itoa(command.Process.Pid), "/T").Run()
	if err == nil {
		return nil
	}
	if killErr := command.Process.Kill(); killErr != nil {
		return errors.Join(err, killErr)
	}
	return nil
}

func killManagedProcessTree(command *exec.Cmd) error {
	if command == nil || command.Process == nil {
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
