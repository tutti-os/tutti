//go:build windows

package workspace

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestPlatformAppShellAdapterUsesManagedShell(t *testing.T) {
	shellPath := filepath.Join(t.TempDir(), "usr", "bin", "bash.exe")
	if err := os.MkdirAll(filepath.Dir(shellPath), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(shellPath, []byte("stub"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	t.Setenv(managedPosixShellEnv, shellPath)

	scriptPath := filepath.Join(t.TempDir(), "bootstrap.sh")
	command, binDirs, err := (platformAppShellAdapter{}).Command(context.Background(), scriptPath)
	if err != nil {
		t.Fatalf("Command() error = %v", err)
	}
	if got, want := command.Path, shellPath; got != want {
		t.Fatalf("command path = %q, want %q", got, want)
	}
	wantArgs := []string{shellPath, "--noprofile", "--norc", scriptPath}
	if len(command.Args) != len(wantArgs) {
		t.Fatalf("command args = %#v, want %#v", command.Args, wantArgs)
	}
	for i := range wantArgs {
		if command.Args[i] != wantArgs[i] {
			t.Fatalf("command args = %#v, want %#v", command.Args, wantArgs)
		}
	}
	if len(binDirs) != 1 || binDirs[0] != filepath.Dir(shellPath) {
		t.Fatalf("bin dirs = %#v, want shell bin dir", binDirs)
	}
}

func TestPlatformAppShellAdapterRequiresManagedShell(t *testing.T) {
	t.Setenv(managedPosixShellEnv, "")
	if _, _, err := (platformAppShellAdapter{}).Command(context.Background(), `C:\\app\\bootstrap.sh`); err == nil {
		t.Fatal("Command() error = nil")
	}
}

func TestPlatformAppShellAdapterValidatesPlainWindowsScriptFile(t *testing.T) {
	adapter := platformAppShellAdapter{}
	scriptPath := filepath.Join(t.TempDir(), "bootstrap.sh")
	if err := os.WriteFile(scriptPath, []byte("exit 0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := adapter.ValidateScript(scriptPath); err != nil {
		t.Fatalf("ValidateScript() error = %v", err)
	}
	if err := adapter.ValidateScript(t.TempDir()); err == nil {
		t.Fatal("ValidateScript(directory) error = nil")
	}
}
