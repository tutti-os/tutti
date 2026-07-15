package main

import (
	"bufio"
	"bytes"
	"errors"
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
	lookup := func(_ int) (string, error) {
		return "/test/tuttid", nil
	}
	pidPath := tuttitypes.TuttidPIDPath()
	if err := os.MkdirAll(filepath.Dir(pidPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	lease, err := acquirePIDFileWithProcessLookup(lookup)
	if err == nil {
		lease.Release()
		t.Fatal("acquirePIDFile() succeeded with a live owner")
	}
	if !strings.Contains(err.Error(), strconv.Itoa(os.Getpid())) {
		t.Fatalf("acquirePIDFile() error = %q, want owner pid", err)
	}
}

func TestAcquirePIDFileIgnoresReusedPIDForUnrelatedProcess(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("TUTTI_STATE_DIR", stateDir)
	lookup := func(_ int) (string, error) {
		return "/test/unrelated", nil
	}
	pidPath := tuttitypes.TuttidPIDPath()
	if err := os.MkdirAll(filepath.Dir(pidPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	lease, err := acquirePIDFileWithProcessLookup(lookup)
	if err != nil {
		t.Fatalf("acquirePIDFile() error = %v", err)
	}
	lease.Release()
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

func TestPIDFileLeaseSerializesStateRootAcrossPathOverrides(t *testing.T) {
	tests := []struct {
		name          string
		firstRunDir   string
		firstPIDPath  string
		secondRunDir  string
		secondPIDPath string
	}{
		{
			name:          "pid path",
			firstPIDPath:  filepath.Join(t.TempDir(), "first.pid"),
			secondPIDPath: filepath.Join(t.TempDir(), "second.pid"),
		},
		{
			name:         "run directory",
			firstRunDir:  filepath.Join(t.TempDir(), "first-run"),
			secondRunDir: filepath.Join(t.TempDir(), "second-run"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("TUTTI_STATE_DIR", t.TempDir())
			t.Setenv("TUTTID_RUN_DIR", tt.firstRunDir)
			t.Setenv("TUTTID_PID_PATH", tt.firstPIDPath)

			lease, err := acquirePIDFile()
			if err != nil {
				t.Fatalf("first acquirePIDFile() error = %v", err)
			}
			defer lease.Release()

			t.Setenv("TUTTID_RUN_DIR", tt.secondRunDir)
			t.Setenv("TUTTID_PID_PATH", tt.secondPIDPath)
			secondPIDPath := tuttitypes.TuttidPIDPath()
			secondLease, err := acquirePIDFile()
			if err == nil {
				secondLease.Release()
				t.Fatal("second acquirePIDFile() succeeded for the same state root")
			}
			if !strings.Contains(err.Error(), "already owned") {
				t.Fatalf("second acquirePIDFile() error = %q", err)
			}
			if _, err := os.Stat(secondPIDPath); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("second pid file exists or stat failed: %v", err)
			}
		})
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

func TestPIDFileLeaseReleaseLeavesPIDMarkerForStaleRecovery(t *testing.T) {
	t.Setenv("TUTTI_STATE_DIR", t.TempDir())
	lease, err := acquirePIDFile()
	if err != nil {
		t.Fatalf("acquirePIDFile() error = %v", err)
	}
	pidPath := tuttitypes.TuttidPIDPath()
	lease.Release()

	body, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatalf("read retained pid file: %v", err)
	}
	if got := strings.TrimSpace(string(body)); got != strconv.Itoa(os.Getpid()) {
		t.Fatalf("retained pid file = %q, want %d", got, os.Getpid())
	}
}

func TestParsePIDAcceptsEveryPositivePID(t *testing.T) {
	for _, body := range []string{"1", "2", "4242\n"} {
		if _, ok := parsePID([]byte(body)); !ok {
			t.Errorf("parsePID(%q) rejected a positive pid", body)
		}
	}
	for _, body := range []string{"", "0", "-1", "nope"} {
		if _, ok := parsePID([]byte(body)); ok {
			t.Errorf("parsePID(%q) accepted an invalid pid", body)
		}
	}
}

func TestIsTuttidExecutablePath(t *testing.T) {
	tests := map[string]bool{
		"/Applications/Tutti.app/Contents/Resources/bin/tuttid": true,
		"/tmp/tuttid (deleted)":                                 true,
		`C:\Program Files\Tutti\tuttid.exe`:                     true,
		"tuttid":                                                true,
		"/tmp/tuttid-helper":                                    false,
		"/tmp/unrelated":                                        false,
		"":                                                      false,
	}
	for executablePath, want := range tests {
		if got := isTuttidExecutablePath(executablePath); got != want {
			t.Errorf("isTuttidExecutablePath(%q) = %t, want %t", executablePath, got, want)
		}
	}
}

func TestProcessExecutablePathFindsCurrentProcess(t *testing.T) {
	executablePath, err := processExecutablePath(os.Getpid())
	if err != nil {
		t.Fatalf("processExecutablePath(os.Getpid()) error = %v", err)
	}
	if strings.TrimSpace(executablePath) == "" {
		t.Fatal("processExecutablePath(os.Getpid()) returned an empty path")
	}
}
