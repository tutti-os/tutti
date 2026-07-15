package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func TestAcquirePIDFileRejectsLiveOwner(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("TUTTI_STATE_DIR", stateDir)
	pidPath := tuttitypes.TuttidPIDPath()
	if err := os.MkdirAll(filepath.Dir(pidPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	lease, err := acquirePIDFile()
	if err == nil {
		lease.Release()
		t.Fatal("acquirePIDFile() succeeded with a live owner")
	}
	if !strings.Contains(err.Error(), strconv.Itoa(os.Getpid())) {
		t.Fatalf("acquirePIDFile() error = %q, want owner pid", err)
	}
}

func TestAcquirePIDFileRecoversStaleOwnerAndSerializesAccess(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("TUTTI_STATE_DIR", stateDir)
	pidPath := tuttitypes.TuttidPIDPath()
	if err := os.MkdirAll(filepath.Dir(pidPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pidPath, []byte("999999999\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	lease, err := acquirePIDFile()
	if err != nil {
		t.Fatalf("acquirePIDFile() error = %v", err)
	}
	defer lease.Release()

	body, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(body)); got != strconv.Itoa(os.Getpid()) {
		t.Fatalf("pid file = %q, want %d", got, os.Getpid())
	}

	secondLease, err := acquirePIDFile()
	if err == nil {
		secondLease.Release()
		t.Fatal("second acquirePIDFile() succeeded while lease is held")
	}
	if !strings.Contains(err.Error(), "already owned") {
		t.Fatalf("second acquirePIDFile() error = %q", err)
	}
}

func TestPIDFileLeaseSerializesProcesses(t *testing.T) {
	t.Setenv("TUTTI_STATE_DIR", t.TempDir())
	cmd := exec.Command(os.Args[0], "-test.run=^TestPIDFileLeaseHelper$")
	cmd.Env = append(os.Environ(), "TUTTI_PID_LEASE_HELPER=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = stdin.Close()
		if err := cmd.Wait(); err != nil {
			t.Errorf("lease helper failed: %v; stderr=%s", err, stderr.String())
		}
	}()

	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() || scanner.Text() != "ready" {
		t.Fatalf("lease helper did not become ready; stderr=%s", stderr.String())
	}
	lease, err := acquirePIDFile()
	if err == nil {
		lease.Release()
		t.Fatal("acquirePIDFile() succeeded while another process held the lease")
	}
	if !strings.Contains(err.Error(), "already owned") {
		t.Fatalf("acquirePIDFile() error = %q", err)
	}
}

func TestPIDFileLeaseHelper(t *testing.T) {
	if os.Getenv("TUTTI_PID_LEASE_HELPER") != "1" {
		return
	}
	lease, err := acquirePIDFile()
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	fmt.Fprintln(os.Stdout, "ready")
	_, _ = io.Copy(io.Discard, os.Stdin)
}

func TestPIDFileLeaseDoesNotRemoveReplacementOwner(t *testing.T) {
	t.Setenv("TUTTI_STATE_DIR", t.TempDir())
	lease, err := acquirePIDFile()
	if err != nil {
		t.Fatalf("acquirePIDFile() error = %v", err)
	}

	replacement := []byte("424242\n")
	if err := os.WriteFile(lease.pidPath, replacement, 0o644); err != nil {
		t.Fatal(err)
	}
	lease.Release()

	body, err := os.ReadFile(lease.pidPath)
	if err != nil {
		t.Fatalf("read replacement pid file: %v", err)
	}
	if string(body) != string(replacement) {
		t.Fatalf("replacement pid file = %q", body)
	}
}
