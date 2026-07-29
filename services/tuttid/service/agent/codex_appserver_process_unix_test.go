//go:build !windows

package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestCodexCLIModelListerStopsProcessTreeOnTimeout(t *testing.T) {
	childPIDPath := filepath.Join(t.TempDir(), "model-child.pid")
	scriptPath := writeHangingCodexAppServer(t, childPIDPath)

	startedAt := time.Now()
	_, err := (CodexCLIModelLister{
		Command: scriptPath,
		Timeout: time.Second,
	}).ListModels(context.Background())
	if err == nil || !strings.Contains(err.Error(), "model/list timed out") {
		t.Fatalf("ListModels error = %v, want model/list timeout", err)
	}
	if elapsed := time.Since(startedAt); elapsed > 3*time.Second {
		t.Fatalf("ListModels returned after %s, want bounded process cleanup", elapsed)
	}
	assertProcessExited(t, readChildPID(t, childPIDPath))
}

func TestCodexCLICapabilityListerStopsProcessTreeOnTimeout(t *testing.T) {
	childPIDPath := filepath.Join(t.TempDir(), "capability-child.pid")
	scriptPath := writeHangingCodexAppServer(t, childPIDPath)

	startedAt := time.Now()
	_, err := (CodexCLICapabilityLister{
		Command: scriptPath,
		Timeout: time.Second,
	}).List(context.Background(), "")
	if err == nil || !strings.Contains(err.Error(), "capability discovery timed out") {
		t.Fatalf("List error = %v, want capability discovery timeout", err)
	}
	if elapsed := time.Since(startedAt); elapsed > 3*time.Second {
		t.Fatalf("List returned after %s, want bounded process cleanup", elapsed)
	}
	assertProcessExited(t, readChildPID(t, childPIDPath))
}

func writeHangingCodexAppServer(t *testing.T, childPIDPath string) string {
	t.Helper()
	scriptPath := filepath.Join(t.TempDir(), "codex")
	script := fmt.Sprintf(`#!/bin/sh
sleep 5 &
child_pid=$!
printf '%%s\n' "$child_pid" > %q
wait "$child_pid"
`, childPIDPath)
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake codex app-server: %v", err)
	}
	return scriptPath
}

func readChildPID(t *testing.T, path string) int {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read child pid: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("parse child pid %q: %v", raw, err)
	}
	return pid
}

func assertProcessExited(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("child process %d is still alive after app-server timeout", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
