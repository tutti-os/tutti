//go:build windows

package workspace

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

const appProcessJobHelperModeEnv = "TUTTI_TEST_APP_PROCESS_JOB_HELPER"

func TestAppProcessJobClosesEntireDescendantTree(t *testing.T) {
	switch os.Getenv(appProcessJobHelperModeEnv) {
	case "parent":
		runAppProcessJobParentHelper()
		return
	case "child":
		for {
			time.Sleep(time.Hour)
		}
	}

	tempDir := t.TempDir()
	childPIDPath := filepath.Join(tempDir, "child.pid")
	command := exec.Command(os.Args[0], "-test.run=^TestAppProcessJobClosesEntireDescendantTree$")
	command.Env = append(
		os.Environ(),
		appProcessJobHelperModeEnv+"=parent",
		"TUTTI_TEST_APP_PROCESS_JOB_CHILD_PID="+childPIDPath,
	)
	prepareAppProcessCommand(command)
	if err := command.Start(); err != nil {
		t.Fatalf("start helper parent: %v", err)
	}
	process := &appProcess{command: command}
	t.Cleanup(func() {
		_ = killAppProcess(process)
		if process.containment != nil {
			_ = process.containment.close()
		}
	})

	containment, err := containAppProcess(command)
	if err != nil {
		t.Fatalf("contain helper parent: %v", err)
	}
	process.containment = containment
	if err := releaseAppProcessCommand(command); err != nil {
		t.Fatalf("release contained helper parent: %v", err)
	}

	childPID := waitForAppProcessJobChildPID(t, childPIDPath)
	childHandle, err := windows.OpenProcess(
		windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION,
		false,
		uint32(childPID),
	)
	if err != nil {
		t.Fatalf("open helper child process %d: %v", childPID, err)
	}
	defer windows.CloseHandle(childHandle)

	if err := containment.close(); err != nil {
		t.Fatalf("close app process job: %v", err)
	}
	process.containment = nil
	waitResult, err := windows.WaitForSingleObject(childHandle, 5_000)
	if err != nil {
		t.Fatalf("wait for helper child exit: %v", err)
	}
	if waitResult != windows.WAIT_OBJECT_0 {
		t.Fatalf("helper child wait result = %d, want WAIT_OBJECT_0", waitResult)
	}

	waitDone := make(chan error, 1)
	go func() { waitDone <- command.Wait() }()
	select {
	case <-waitDone:
	case <-time.After(5 * time.Second):
		t.Fatal("helper parent survived closing its app process job")
	}
}

func runAppProcessJobParentHelper() {
	childPIDPath := os.Getenv("TUTTI_TEST_APP_PROCESS_JOB_CHILD_PID")
	child := exec.Command(os.Args[0], "-test.run=^TestAppProcessJobClosesEntireDescendantTree$")
	child.Env = append(os.Environ(), appProcessJobHelperModeEnv+"=child")
	if err := child.Start(); err != nil {
		os.Exit(2)
	}
	if err := os.WriteFile(childPIDPath, []byte(strconv.Itoa(child.Process.Pid)), 0o600); err != nil {
		_ = child.Process.Kill()
		os.Exit(3)
	}
	_ = child.Wait()
	os.Exit(0)
}

func waitForAppProcessJobChildPID(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil {
			pid, parseErr := strconv.Atoi(strings.TrimSpace(string(data)))
			if parseErr != nil {
				t.Fatalf("parse helper child pid: %v", parseErr)
			}
			return pid
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out waiting for helper child pid")
	return 0
}
