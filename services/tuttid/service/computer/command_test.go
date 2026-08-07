package computer

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestResolveComputerMCPCommandHonorsExplicitOverrides(t *testing.T) {
	t.Setenv(computerMCPCommandOverrideEnv, "custom-cua-driver")
	t.Setenv(computerMCPEntryPathEnv, "ignored-entry")
	if got := resolveComputerMCPCommand(context.TODO()); len(got) != 2 || got[0] != "custom-cua-driver" || got[1] != "mcp" {
		t.Fatalf("resolveComputerMCPCommand() = %#v", got)
	}
}

func TestResolveComputerMCPCommandDiscoversWindowsInstall(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows-only installed driver discovery")
	}
	root := t.TempDir()
	entry := filepath.Join(root, "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe")
	if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte("stub"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(computerMCPCommandOverrideEnv, "")
	t.Setenv(computerMCPEntryPathEnv, "")
	t.Setenv("LOCALAPPDATA", root)
	got := resolveComputerMCPCommand(context.TODO())
	if len(got) != 2 || got[0] != entry || got[1] != "mcp" {
		t.Fatalf("resolveComputerMCPCommand() = %#v, want %q", got, entry)
	}
}
