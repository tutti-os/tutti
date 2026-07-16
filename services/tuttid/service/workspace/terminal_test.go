package workspace

import (
	"context"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestResolveTerminalShellInvocation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows shell invocation keeps default behavior")
	}

	tests := []struct {
		name  string
		shell string
		want  []string
	}{
		{
			name:  "zsh uses interactive login mode",
			shell: "/bin/zsh",
			want:  []string{"-il"},
		},
		{
			name:  "bash uses interactive login mode",
			shell: "/usr/bin/bash",
			want:  []string{"-il"},
		},
		{
			name:  "fish uses split login interactive flags",
			shell: "/opt/homebrew/bin/fish",
			want:  []string{"-l", "-i"},
		},
		{
			name:  "other shells keep default invocation",
			shell: "/bin/sh",
			want:  nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveTerminalShellInvocation(tt.shell)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("resolveTerminalShellInvocation(%q) = %#v, want %#v", tt.shell, got, tt.want)
			}
		})
	}
}

func TestTerminalServiceCreatesLocalPTYAndSnapshotsOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows terminal support needs ConPTY-specific implementation")
	}

	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)

	service := &TerminalService{}
	initialInput := "printf tutti-terminal-test\\n\r"

	session, err := service.Create(context.Background(), "ws-1", CreateTerminalInput{
		InitialInput: &initialInput,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = service.Terminate(context.Background(), "ws-1", session.ID)
	})

	if session.Status != TerminalStatusRunning {
		t.Fatalf("session status = %q, want %q", session.Status, TerminalStatusRunning)
	}
	if session.Cwd == nil || *session.Cwd != homeDir {
		t.Fatalf("session cwd = %v, want %q", session.Cwd, homeDir)
	}

	var snapshot TerminalSnapshot
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snapshot, err = service.Snapshot(context.Background(), "ws-1", session.ID)
		if err != nil {
			t.Fatalf("Snapshot() error = %v", err)
		}
		if strings.Contains(snapshot.Data, "tutti-terminal-test") {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !strings.Contains(snapshot.Data, "tutti-terminal-test") {
		t.Fatalf("snapshot data = %q, want terminal output", snapshot.Data)
	}

	resized, err := service.Resize(context.Background(), "ws-1", session.ID, ResizeTerminalInput{
		Cols: 100,
		Rows: 32,
	})
	if err != nil {
		t.Fatalf("Resize() error = %v", err)
	}
	if resized.Cols != 100 || resized.Rows != 32 {
		t.Fatalf("resize = %dx%d, want 100x32", resized.Cols, resized.Rows)
	}

	guard, err := service.CloseGuard(context.Background(), "ws-1", session.ID)
	if err != nil {
		t.Fatalf("CloseGuard() error = %v", err)
	}
	if guard.RequiresConfirmation || guard.Reason != "not-running" {
		t.Fatalf("close guard = %#v, want idle terminal without confirmation", guard)
	}

	terminated, err := service.Terminate(context.Background(), "ws-1", session.ID)
	if err != nil {
		t.Fatalf("Terminate() error = %v", err)
	}
	if terminated.Status != TerminalStatusExited {
		t.Fatalf("terminated status = %q, want %q", terminated.Status, TerminalStatusExited)
	}
}

func TestTerminalServiceCreatesShellWithXtermEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows terminal support needs ConPTY-specific implementation")
	}

	t.Setenv("HOME", t.TempDir())
	t.Setenv("SHELL", "/bin/sh")
	t.Setenv("TERM", "dumb")
	t.Setenv("COLORTERM", "")

	service := &TerminalService{}
	initialInput := "printf 'term-env:%s:%s\\n' \"$TERM\" \"$COLORTERM\"\r"

	session, err := service.Create(context.Background(), "ws-1", CreateTerminalInput{
		InitialInput: &initialInput,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = service.Terminate(context.Background(), "ws-1", session.ID)
	})

	var snapshot TerminalSnapshot
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snapshot, err = service.Snapshot(context.Background(), "ws-1", session.ID)
		if err != nil {
			t.Fatalf("Snapshot() error = %v", err)
		}
		if strings.Contains(snapshot.Data, "term-env:xterm-256color:truecolor") {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("snapshot data = %q, want xterm terminal environment", snapshot.Data)
}

func TestTerminalServiceAddsUTF8LocaleForMacOSShell(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS GUI processes need the terminal locale fallback")
	}

	t.Setenv("HOME", t.TempDir())
	t.Setenv("SHELL", "/bin/zsh")
	t.Setenv("LANG", "")
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_CTYPE", "")

	service := &TerminalService{}
	initialInput := "locale charmap\r"

	session, err := service.Create(context.Background(), "ws-1", CreateTerminalInput{
		InitialInput: &initialInput,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = service.Terminate(context.Background(), "ws-1", session.ID)
	})

	var snapshot TerminalSnapshot
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snapshot, err = service.Snapshot(context.Background(), "ws-1", session.ID)
		if err != nil {
			t.Fatalf("Snapshot() error = %v", err)
		}
		if strings.Contains(snapshot.Data, "UTF-8") {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("snapshot data = %q, want UTF-8 locale", snapshot.Data)
}

func TestTerminalServiceCloseGuardRequiresConfirmationForForegroundProcess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows terminal support needs ConPTY-specific implementation")
	}

	t.Setenv("HOME", t.TempDir())
	t.Setenv("SHELL", "/bin/sh")

	service := &TerminalService{}

	session, err := service.Create(context.Background(), "ws-1", CreateTerminalInput{})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = service.Terminate(context.Background(), "ws-1", session.ID)
	})

	idleGuard := waitForTerminalCloseGuard(t, service, session.ID, func(guard TerminalCloseGuard) bool {
		return guard.Reason == "not-running" && !guard.RequiresConfirmation
	})
	if idleGuard.Status != TerminalStatusRunning {
		t.Fatalf("idle guard status = %q, want %q", idleGuard.Status, TerminalStatusRunning)
	}

	if err := service.Write(context.Background(), "ws-1", session.ID, "sleep 5\r"); err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	foregroundGuard := waitForTerminalCloseGuard(t, service, session.ID, func(guard TerminalCloseGuard) bool {
		return guard.Reason == "foreground-process" && guard.RequiresConfirmation
	})
	if foregroundGuard.Status != TerminalStatusRunning {
		t.Fatalf("foreground guard status = %q, want %q", foregroundGuard.Status, TerminalStatusRunning)
	}
}

func TestTerminalServiceAttachStreamWritesAndReceivesOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows terminal support needs ConPTY-specific implementation")
	}

	t.Setenv("HOME", t.TempDir())
	t.Setenv("SHELL", "/bin/sh")

	service := &TerminalService{}

	session, err := service.Create(context.Background(), "ws-1", CreateTerminalInput{})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = service.Terminate(context.Background(), "ws-1", session.ID)
	})

	stream, err := service.AttachStream(context.Background(), "ws-1", session.ID, AttachTerminalInput{})
	if err != nil {
		t.Fatalf("AttachStream() error = %v", err)
	}
	defer stream.Close()

	if err := service.Write(context.Background(), "ws-1", session.ID, "printf stream-terminal-test\\n\r"); err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-stream.Events:
			if event.Type == TerminalStreamEventOutput && strings.Contains(event.Data, "stream-terminal-test") {
				if event.Seq == nil || *event.Seq <= 0 {
					t.Fatalf("stream event seq = %v, want positive sequence", event.Seq)
				}
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for terminal stream output")
		}
	}
}

func TestTerminalServiceAttachStreamReplaysMetadataAndDetachedStatus(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows terminal support needs ConPTY-specific implementation")
	}

	t.Setenv("HOME", t.TempDir())

	service := &TerminalService{}

	session, err := service.Create(context.Background(), "ws-1", CreateTerminalInput{})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = service.Terminate(context.Background(), "ws-1", session.ID)
	})

	stream, err := service.AttachStream(context.Background(), "ws-1", session.ID, AttachTerminalInput{})
	if err != nil {
		t.Fatalf("AttachStream() error = %v", err)
	}

	var sawMetadata bool
	var sawState bool
	deadline := time.After(2 * time.Second)
	for !sawMetadata || !sawState {
		select {
		case event := <-stream.Events:
			switch event.Type {
			case TerminalStreamEventMeta:
				sawMetadata = true
				if event.RuntimeKind == nil || *event.RuntimeKind != "local" {
					t.Fatalf("metadata runtime kind = %v, want local", event.RuntimeKind)
				}
				if event.Cwd == nil || *event.Cwd == "" {
					t.Fatal("metadata cwd missing")
				}
			case TerminalStreamEventState:
				sawState = true
				if event.Status != TerminalStatusRunning {
					t.Fatalf("state status = %q, want %q", event.Status, TerminalStatusRunning)
				}
			}
		case <-deadline:
			t.Fatal("timed out waiting for metadata/state replay")
		}
	}

	stream.Close()

	detached, err := service.Get(context.Background(), "ws-1", session.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if detached.Status != TerminalStatusDetached {
		t.Fatalf("status after detach = %q, want %q", detached.Status, TerminalStatusDetached)
	}
}

func TestTerminalServiceAttachStreamExitEventCarriesExitCode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows terminal support needs ConPTY-specific implementation")
	}

	t.Setenv("HOME", t.TempDir())
	t.Setenv("SHELL", "/bin/sh")

	service := &TerminalService{}

	session, err := service.Create(context.Background(), "ws-1", CreateTerminalInput{})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	stream, err := service.AttachStream(context.Background(), "ws-1", session.ID, AttachTerminalInput{})
	if err != nil {
		t.Fatalf("AttachStream() error = %v", err)
	}
	defer stream.Close()

	readyMarker := "tutti-terminal-exit-ready"
	if err := service.Write(context.Background(), "ws-1", session.ID, "printf 'tutti-terminal-%s\\n' 'exit-ready'\r"); err != nil {
		t.Fatalf("Write() ready error = %v", err)
	}

	shellReady := false
	deadline := time.After(10 * time.Second)
	for !shellReady {
		select {
		case event := <-stream.Events:
			if event.Type == TerminalStreamEventOutput && strings.Contains(event.Data, readyMarker) {
				shellReady = true
			}
		case <-deadline:
			t.Fatal("timed out waiting for terminal ready output")
		}
	}

	if err := service.Write(context.Background(), "ws-1", session.ID, "exit 7\r"); err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	deadline = time.After(10 * time.Second)
	for {
		select {
		case event := <-stream.Events:
			if event.Type != TerminalStreamEventExit {
				continue
			}
			if event.Code == nil || *event.Code != 7 {
				t.Fatalf("exit code = %v, want 7", event.Code)
			}
			return
		case <-deadline:
			t.Fatal("timed out waiting for exit event")
		}
	}
}

func waitForTerminalCloseGuard(
	t *testing.T,
	service *TerminalService,
	sessionID string,
	match func(TerminalCloseGuard) bool,
) TerminalCloseGuard {
	t.Helper()

	var guard TerminalCloseGuard
	var err error
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		guard, err = service.CloseGuard(context.Background(), "ws-1", sessionID)
		if err != nil {
			t.Fatalf("CloseGuard() error = %v", err)
		}
		if match(guard) {
			return guard
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for matching close guard, last guard = %#v", guard)
	return TerminalCloseGuard{}
}
