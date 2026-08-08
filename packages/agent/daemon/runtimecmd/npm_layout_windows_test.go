//go:build windows

package runtimecmd

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveNPMGlobalLayoutUsesRequestedBinAsWindowsPrefix(t *testing.T) {
	home := t.TempDir()
	requestedBin := filepath.Join(home, ".local", "bin")
	layout := ResolveNPMGlobalLayout(requestedBin)
	want := requestedBin
	if layout.PrefixDir != want || layout.BinDir != want {
		t.Fatalf("ResolveNPMGlobalLayout() = %#v, want prefix and bin %q", layout, want)
	}
}

func TestResolverFindsWindowsNPMGlobalShim(t *testing.T) {
	home := t.TempDir()
	shimDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(shimDir, 0o755); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(shimDir, "codex.cmd")
	if err := os.WriteFile(shim, []byte("@echo off\r\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	resolver := Resolver{
		Environ:  func() []string { return []string{"PATH=C:\\Windows\\System32"} },
		HomeDir:  func() (string, error) { return home, nil },
		LookPath: func(string) (string, error) { return "", os.ErrNotExist },
		IsExecutableFile: func(path string) bool {
			info, err := os.Stat(path)
			return err == nil && !info.IsDir()
		},
	}
	if got := resolver.ResolveBinary([]string{"codex.exe", "codex.cmd"}, nil); got != shim {
		t.Fatalf("ResolveBinary() = %q, want %q", got, shim)
	}
}
