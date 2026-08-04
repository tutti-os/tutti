//go:build windows

package agentstatus

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestNewInstallShellCommandUsesCmdInterpreter(t *testing.T) {
	t.Setenv("ComSpec", `C:\Windows\System32\cmd.exe`)
	command := newInstallShellCommand(context.Background(), "echo tutti")
	want := []string{`C:\Windows\System32\cmd.exe`, "/D", "/S", "/C", "echo tutti"}
	if !reflect.DeepEqual(command.Args, want) {
		t.Fatalf("command args = %#v, want %#v", command.Args, want)
	}
}

func TestPlatformExecutableFileAcceptsPlainWindowsFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "command.exe")
	if err := os.WriteFile(path, []byte("command"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !platformExecutableFile(info) {
		t.Fatal("platformExecutableFile() = false")
	}
}
