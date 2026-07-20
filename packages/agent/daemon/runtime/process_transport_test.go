package agentruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestVerifiedProcessExecutableFixture(_ *testing.T) {
	if os.Getenv("TUTTI_TEST_VERIFIED_PROCESS_EXECUTABLE") == "1" {
		fmt.Print("verified-original")
	}
}

func TestPrepareProcessExecutableExecutesVerifiedDescriptorAfterPathReplacement(t *testing.T) {
	path, identity := copyCurrentExecutableWithIdentity(t)
	prepared, err := prepareProcessExecutable(path, identity)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = prepared.Close() }()
	if err := os.Rename(path, path+".original"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(prepared.path, "-test.run=TestVerifiedProcessExecutableFixture")
	if prepared.file != nil {
		cmd.ExtraFiles = []*os.File{prepared.file}
	}
	cmd.Env = append(os.Environ(), "TUTTI_TEST_VERIFIED_PROCESS_EXECUTABLE=1")
	output, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "verified-original") {
		t.Fatalf("descriptor execution output = %q, error = %v", output, err)
	}
}

func TestRunVerifiedExecutableUsesVerifiedIdentity(t *testing.T) {
	path, identity := copyCurrentExecutableWithIdentity(t)
	t.Setenv("TUTTI_TEST_VERIFIED_PROCESS_EXECUTABLE", "1")
	output, err := RunVerifiedExecutable(
		context.Background(), path, []string{"-test.run=TestVerifiedProcessExecutableFixture"}, identity,
	)
	if err != nil || !strings.Contains(string(output), "verified-original") {
		t.Fatalf("verified execution output = %q, error = %v", output, err)
	}
	if err := os.WriteFile(path, []byte("changed executable"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := RunVerifiedExecutable(context.Background(), path, nil, identity); err == nil ||
		!strings.Contains(err.Error(), "expected identity") {
		t.Fatalf("changed verified execution error = %v", err)
	}
}

func TestLocalProcessTransportRejectsChangedExpectedExecutable(t *testing.T) {
	path, identity := copyCurrentExecutableWithIdentity(t)
	if err := os.WriteFile(path, []byte("changed executable"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := NewLocalProcessTransport().Start(context.Background(), ProcessSpec{
		Command: []string{path}, ExecutableIdentity: identity,
	})
	if err == nil || !strings.Contains(err.Error(), "expected identity") {
		t.Fatalf("changed executable start error = %v", err)
	}
}

func copyCurrentExecutableWithIdentity(t *testing.T) (string, *ExecutableIdentity) {
	t.Helper()
	source, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "verified-runtime")
	if err := os.WriteFile(path, data, 0o755); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	return path, &ExecutableIdentity{SHA256: hex.EncodeToString(digest[:]), SizeBytes: int64(len(data))}
}

func TestLocalProcessTransportOutlivesStartContext(t *testing.T) {
	catPath, err := exec.LookPath("cat")
	if err != nil {
		t.Skip("cat is unavailable")
	}

	ctx, cancel := context.WithCancel(context.Background())
	conn, err := NewLocalProcessTransport().Start(ctx, ProcessSpec{
		Command: []string{catPath},
	})
	if err != nil {
		t.Fatalf("start transport: %v", err)
	}
	defer func() {
		_ = conn.Close()
	}()

	cancel()
	if err := conn.Send([]byte("hello\n")); err != nil {
		t.Fatalf("send after start context cancel: %v", err)
	}

	done := make(chan ProcessFrame, 1)
	errs := make(chan error, 1)
	go func() {
		frame, err := conn.Recv()
		if err != nil {
			errs <- err
			return
		}
		done <- frame
	}()

	select {
	case frame := <-done:
		if string(frame.Stdout) != "hello\n" {
			t.Fatalf("stdout = %q, want echo", string(frame.Stdout))
		}
	case err := <-errs:
		t.Fatalf("recv after start context cancel: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for process stdout")
	}
}

func TestLocalProcessTransportFindsKnownNodeGlobalBin(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	writeRuntimeExecutable(t, filepath.Join(binDir, "fake-acp"), "#!/bin/sh\nhelper-cli\n")
	writeRuntimeExecutable(t, filepath.Join(binDir, "helper-cli"), "#!/bin/sh\nprintf 'nested-ok\\n'\n")
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/usr/bin:/bin")

	conn, err := NewLocalProcessTransport().Start(context.Background(), ProcessSpec{
		Command: []string{"fake-acp"},
	})
	if err != nil {
		t.Fatalf("start transport: %v", err)
	}
	defer func() {
		_ = conn.Close()
	}()

	frame := receiveRuntimeStdoutFrame(t, conn)
	if string(frame.Stdout) != "nested-ok\n" {
		t.Fatalf("stdout = %q, want nested-ok", string(frame.Stdout))
	}
}

func TestLocalProcessTransportDeliversFinalStdoutBeforeExit(t *testing.T) {
	shPath, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh is unavailable")
	}

	conn, err := NewLocalProcessTransport().Start(context.Background(), ProcessSpec{
		Command: []string{shPath, "-c", "printf 'final-output'"},
	})
	if err != nil {
		t.Fatalf("start transport: %v", err)
	}
	defer func() {
		_ = conn.Close()
	}()

	var stdout string
	for {
		frame, err := conn.Recv()
		if err != nil {
			t.Fatalf("recv frame: %v", err)
		}
		stdout += string(frame.Stdout)
		if frame.ExitCode == nil {
			continue
		}
		if *frame.ExitCode != 0 {
			t.Fatalf("exit code = %d, want 0", *frame.ExitCode)
		}
		break
	}
	if stdout != "final-output" {
		t.Fatalf("stdout before exit = %q, want final-output", stdout)
	}
}

func TestLocalProcessTransportCloseKillsProcessAfterGracefulShutdownFails(t *testing.T) {
	shPath, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh is unavailable")
	}

	conn, err := NewLocalProcessTransport().Start(context.Background(), ProcessSpec{
		Command: []string{shPath, "-c", "trap '' TERM; while true; do sleep 1; done"},
	})
	if err != nil {
		t.Fatalf("start transport: %v", err)
	}

	done := make(chan error, 1)
	startedAt := time.Now()
	go func() {
		done <- conn.Close()
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Close: %v", err)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("Close did not force-kill process after graceful shutdown failed")
	}
	if elapsed := time.Since(startedAt); elapsed < 900*time.Millisecond {
		t.Fatalf("Close returned after %s, want SIGTERM grace before kill fallback", elapsed)
	}
}

func TestProcessStartEnvDiagnosticsSummarizesFinalPath(t *testing.T) {
	tuttiBin := filepath.Join(string(os.PathSeparator), "Users", "Sun", ".tutti", "bin")
	managedBin := filepath.Join(string(os.PathSeparator), "managed", "node", "bin")
	env := []string{
		"PATH=" + managedBin + string(os.PathListSeparator) + tuttiBin + string(os.PathListSeparator) + "/usr/bin",
		"TUTTI_APP_NODE=" + filepath.Join(managedBin, "node"),
		"TUTTI_AGENT_SESSION_ID=agent-session-1",
	}
	diag := processStartEnvDiagnostics(ProcessSpec{
		Provider:       ProviderClaudeCode,
		AgentSessionID: "agent-session-1",
		Env: []string{
			"PATH=" + tuttiBin + string(os.PathListSeparator) + "/usr/bin",
			"PATH=" + managedBin + string(os.PathListSeparator) + "/usr/bin",
		},
	}, env)

	if got := diag["path_override_count"]; got != 2 {
		t.Fatalf("path_override_count = %v, want 2", got)
	}
	if got := diag["path_contains_tutti_bin"]; got != true {
		t.Fatalf("path_contains_tutti_bin = %v, want true", got)
	}
	if got := diag["path_contains_app_node_bin"]; got != true {
		t.Fatalf("path_contains_app_node_bin = %v, want true", got)
	}
	if got := diag["agent_session_env_present"]; got != true {
		t.Fatalf("agent_session_env_present = %v, want true", got)
	}
	wantHead := []string{managedBin, tuttiBin, "/usr/bin"}
	if got := diag["path_head"]; !reflect.DeepEqual(got, wantHead) {
		t.Fatalf("path_head = %#v, want %#v", got, wantHead)
	}
}

func receiveRuntimeStdoutFrame(t *testing.T, conn ProcessConnection) ProcessFrame {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		done := make(chan ProcessFrame, 1)
		errs := make(chan error, 1)
		go func() {
			frame, err := conn.Recv()
			if err != nil {
				errs <- err
				return
			}
			done <- frame
		}()
		select {
		case frame := <-done:
			if len(frame.Stdout) > 0 {
				return frame
			}
			if frame.ExitCode != nil {
				t.Fatalf("process exited before stdout, exit code %d", *frame.ExitCode)
			}
		case err := <-errs:
			t.Fatalf("recv stdout: %v", err)
		case <-deadline:
			t.Fatal("timed out waiting for process stdout")
		}
	}
}

func writeRuntimeExecutable(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o755); err != nil {
		t.Fatalf("write executable %s: %v", path, err)
	}
}
