//go:build !windows

package agentstatus

import (
	"context"
	"os"
	"reflect"
	"testing"
)

func TestNewInstallShellCommandUsesPOSIXLoginShell(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	command := newInstallShellCommand(context.Background(), "printf tutti")
	if got, want := command.Args, []string{"/bin/sh", "-lc", "printf tutti"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("command args = %#v, want %#v", got, want)
	}
}

func TestPlatformExecutableFileRequiresExecutableBit(t *testing.T) {
	path := t.TempDir() + "/command"
	if err := os.WriteFile(path, []byte("command"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if platformExecutableFile(info) {
		t.Fatal("platformExecutableFile() = true for non-executable file")
	}
}
