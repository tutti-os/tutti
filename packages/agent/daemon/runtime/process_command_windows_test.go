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
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestNewManagedProcessCommandRunsCmdShimWithSpaces(t *testing.T) {
	shim := filepath.Join(t.TempDir(), "node shim.cmd")
	if err := os.WriteFile(shim, []byte("@echo off\r\necho shim-ok\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	output, err := newManagedProcessCommand(context.Background(), shim).CombinedOutput()
	if err != nil {
		t.Fatalf("cmd shim failed: %v; output=%q", err, output)
	}
	if !strings.Contains(string(output), "shim-ok") {
		t.Fatalf("cmd shim output = %q, want shim-ok", output)
	}
}

func TestLocalProcessTransportKillsCmdDescendantAfterShimExit(t *testing.T) {
	const (
		roleEnv       = "TUTTI_TEST_WINDOWS_PROCESS_TREE_ROLE"
		releaseEnv    = "TUTTI_TEST_WINDOWS_PROCESS_TREE_RELEASE"
		childReadyEnv = "TUTTI_TEST_WINDOWS_PROCESS_TREE_CHILD_READY"
		rootDoneEnv   = "TUTTI_TEST_WINDOWS_PROCESS_TREE_ROOT_DONE"
	)

	switch os.Getenv(roleEnv) {
	case "child":
		if err := os.WriteFile(os.Getenv(childReadyEnv), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
			os.Exit(2)
		}
		select {}
	case "root":
		childReady := os.Getenv(childReadyEnv)
		child := exec.Command(os.Args[0], "-test.run=TestLocalProcessTransportKillsCmdDescendantAfterShimExit")
		child.Env = append(os.Environ(),
			roleEnv+"=child",
			childReadyEnv+"="+childReady,
		)
		child.Stdout = os.Stdout
		child.Stderr = os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(3)
		}
		if err := waitForWindowsProcessTestFile(childReady, 10*time.Second); err != nil {
			os.Exit(4)
		}
		if err := os.WriteFile(os.Getenv(rootDoneEnv), []byte("ready"), 0o600); err != nil {
			os.Exit(5)
		}
		return
	default:
		executable, err := os.Executable()
		if err != nil {
			t.Fatalf("resolve test executable: %v", err)
		}
		tempDir := t.TempDir()
		release := filepath.Join(tempDir, "release")
		childReady := filepath.Join(tempDir, "child-ready")
		rootDone := filepath.Join(tempDir, "root-done")
		shim := filepath.Join(tempDir, "provider.cmd")
		shimBody := fmt.Sprintf(
			"@echo off\r\n:wait\r\nif exist \"%s\" goto launch\r\nping.exe -n 2 127.0.0.1 > nul\r\ngoto wait\r\n:launch\r\n\"%s\" -test.run=TestLocalProcessTransportKillsCmdDescendantAfterShimExit\r\n",
			release,
			executable,
		)
		if err := os.WriteFile(shim, []byte(shimBody), 0o600); err != nil {
			t.Fatalf("write process shim: %v", err)
		}

		connection, err := NewLocalProcessTransport().Start(context.Background(), ProcessSpec{
			Command: []string{shim},
			Env: append(os.Environ(),
				roleEnv+"=root",
				releaseEnv+"="+release,
				childReadyEnv+"="+childReady,
				rootDoneEnv+"="+rootDone,
			),
		})
		if err != nil {
			t.Fatalf("start process shim: %v", err)
		}
		defer func() { _ = connection.Close() }()
		localConnection, ok := connection.(*localProcessConnection)
		if !ok || localConnection.processGroup == nil {
			t.Skip("Windows process job attachment is unavailable in this host")
		}
		if err := os.WriteFile(release, []byte("start"), 0o600); err != nil {
			t.Fatalf("release process shim: %v", err)
		}
		if err := waitForWindowsProcessTestFile(rootDone, 10*time.Second); err != nil {
			t.Fatalf("wait for shim descendant: %v", err)
		}

		pidBytes, err := os.ReadFile(childReady)
		if err != nil {
			t.Fatalf("read child pid: %v", err)
		}
		pid, err := strconv.ParseUint(strings.TrimSpace(string(pidBytes)), 10, 32)
		if err != nil {
			t.Fatalf("parse child pid %q: %v", pidBytes, err)
		}
		if err := connection.Close(); err != nil {
			t.Fatalf("close process tree: %v", err)
		}
		handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
		if err != nil {
			if errors.Is(err, windows.ERROR_INVALID_PARAMETER) || errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
				return
			}
			t.Fatalf("open child process after cleanup: %v", err)
		}
		defer func() { _ = windows.CloseHandle(handle) }()
		event, err := windows.WaitForSingleObject(handle, 5000)
		if err != nil {
			t.Fatalf("wait for child process cleanup: %v", err)
		}
		if event != windows.WAIT_OBJECT_0 {
			t.Fatalf("child process wait state after close = %#x, want exited", event)
		}
	}
}

func waitForWindowsProcessTestFile(path string, timeout time.Duration) error {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return nil
		}
		select {
		case <-deadline.C:
			return fmt.Errorf("timed out waiting for %s", path)
		case <-ticker.C:
		}
	}
}
