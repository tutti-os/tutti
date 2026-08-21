//go:build windows

package workspace

import (
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func prepareAppProcessCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_SUSPENDED,
	}
}

func releaseAppProcessCommand(command *exec.Cmd) error {
	if command == nil || command.Process == nil {
		return errors.New("app process is not started")
	}
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return fmt.Errorf("snapshot process threads: %w", err)
	}
	defer windows.CloseHandle(snapshot)

	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	if err := windows.Thread32First(snapshot, &entry); err != nil {
		return fmt.Errorf("enumerate process threads: %w", err)
	}
	for {
		if entry.OwnerProcessID == uint32(command.Process.Pid) {
			thread, err := windows.OpenThread(
				windows.THREAD_SUSPEND_RESUME,
				false,
				entry.ThreadID,
			)
			if err != nil {
				return fmt.Errorf("open app process thread: %w", err)
			}
			_, resumeErr := windows.ResumeThread(thread)
			_ = windows.CloseHandle(thread)
			if resumeErr != nil {
				return fmt.Errorf("resume app process thread: %w", resumeErr)
			}
			return nil
		}
		if err := windows.Thread32Next(snapshot, &entry); err != nil {
			if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
				break
			}
			return fmt.Errorf("enumerate process threads: %w", err)
		}
	}
	return fmt.Errorf("app process thread not found for pid %d", command.Process.Pid)
}

func interruptAppProcess(command *exec.Cmd) error {
	return signalWindowsAppProcessTree(command, false)
}

type windowsAppProcessContainment struct {
	mu  sync.Mutex
	job windows.Handle
}

func containAppProcess(command *exec.Cmd) (appProcessContainment, error) {
	if command == nil || command.Process == nil {
		return nil, errors.New("app process is not started")
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	closeJob := true
	defer func() {
		if closeJob {
			_ = windows.CloseHandle(job)
		}
	}()

	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)),
		uint32(unsafe.Sizeof(limits)),
	); err != nil {
		return nil, err
	}
	processHandle, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(command.Process.Pid),
	)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(processHandle)
	if err := windows.AssignProcessToJobObject(job, processHandle); err != nil {
		return nil, err
	}
	closeJob = false
	return &windowsAppProcessContainment{job: job}, nil
}

func (c *windowsAppProcessContainment) close() error {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.job == 0 {
		return nil
	}
	err := windows.CloseHandle(c.job)
	c.job = 0
	return err
}

func (c *windowsAppProcessContainment) kill() error {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.job == 0 {
		return nil
	}
	return windows.TerminateJobObject(c.job, 1)
}

func killAppProcess(process *appProcess) error {
	if process == nil {
		return nil
	}
	if process.containment != nil {
		if err := process.containment.kill(); err == nil {
			return nil
		}
	}
	return signalWindowsAppProcessTree(process.command, true)
}

func signalAppProcessTree(command *exec.Cmd, force bool) error {
	return signalWindowsAppProcessTree(command, force)
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
