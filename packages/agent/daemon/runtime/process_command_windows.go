//go:build windows

package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func newManagedProcessCommand(ctx context.Context, executable string, args ...string) *exec.Cmd {
	extension := strings.ToLower(filepath.Ext(executable))
	var command *exec.Cmd
	switch extension {
	case ".cmd", ".bat":
		// Batch files need cmd.exe's CALL command. Pass the executable and each
		// argument as separate exec.Cmd arguments so Go performs the Windows
		// quoting once; composing the whole command into the /C argument causes
		// cmd.exe to retain a literal quote around paths containing spaces.
		command = exec.CommandContext(ctx, windowsCommandInterpreter(), append([]string{"/D", "/C", "call", executable}, args...)...)
	case ".ps1":
		command = exec.CommandContext(ctx, "powershell.exe", append([]string{
			"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", executable,
		}, args...)...)
	default:
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

type windowsManagedProcessGroup struct {
	mu     sync.Mutex
	handle windows.Handle
}

func attachManagedProcessGroup(command *exec.Cmd) (managedProcessGroup, error) {
	if command == nil || command.Process == nil {
		return nil, errors.New("managed process is unavailable")
	}
	handle, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("create process job: %w", err)
	}
	group := &windowsManagedProcessGroup{handle: handle}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		handle,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)),
		uint32(unsafe.Sizeof(limits)),
	); err != nil {
		_ = group.close()
		return nil, fmt.Errorf("configure process job: %w", err)
	}
	processHandle, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(command.Process.Pid),
	)
	if err != nil {
		_ = group.close()
		return nil, fmt.Errorf("open managed process handle: %w", err)
	}
	defer func() { _ = windows.CloseHandle(processHandle) }()
	if err := windows.AssignProcessToJobObject(handle, processHandle); err != nil {
		_ = group.close()
		return nil, fmt.Errorf("assign process to job: %w", err)
	}
	return group, nil
}

func (group *windowsManagedProcessGroup) terminate() error {
	if group == nil {
		return nil
	}
	group.mu.Lock()
	defer group.mu.Unlock()
	if group.handle == 0 {
		return nil
	}
	return windows.TerminateJobObject(group.handle, 1)
}

func (group *windowsManagedProcessGroup) kill() error {
	return group.terminate()
}

func (group *windowsManagedProcessGroup) close() error {
	if group == nil {
		return nil
	}
	group.mu.Lock()
	defer group.mu.Unlock()
	if group.handle == 0 {
		return nil
	}
	handle := group.handle
	group.handle = 0
	return windows.CloseHandle(handle)
}

func terminateManagedProcess(command *exec.Cmd, group managedProcessGroup) error {
	if command == nil || command.Process == nil {
		return nil
	}
	err := exec.Command("taskkill.exe", "/PID", strconv.Itoa(command.Process.Pid), "/T").Run()
	if err == nil {
		return nil
	}
	if group != nil {
		if groupErr := group.terminate(); groupErr == nil {
			return nil
		} else {
			err = errors.Join(err, groupErr)
		}
	}
	if killErr := command.Process.Kill(); killErr != nil {
		return errors.Join(err, killErr)
	}
	if group != nil {
		return err
	}
	return nil
}

func killManagedProcessTree(command *exec.Cmd, group managedProcessGroup) error {
	if command == nil || command.Process == nil {
		return nil
	}
	if group != nil {
		if err := group.kill(); err == nil {
			return nil
		} else {
			groupErr := err
			taskKillErr := exec.Command("taskkill.exe", "/PID", strconv.Itoa(command.Process.Pid), "/T", "/F").Run()
			if taskKillErr == nil {
				return nil
			}
			if killErr := command.Process.Kill(); killErr != nil {
				return errors.Join(groupErr, taskKillErr, killErr)
			}
			return errors.Join(groupErr, taskKillErr, errors.New("managed process descendants may still be running"))
		}
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
