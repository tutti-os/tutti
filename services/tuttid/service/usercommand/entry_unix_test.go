//go:build !windows

package usercommand

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUnixEntryVerifiesSymlinkFinalExecutable(t *testing.T) {
	runtimeRoot := t.TempDir()
	userBinDir := t.TempDir()
	realExecutable := filepath.Join(runtimeRoot, "package", "agent.js")
	if err := os.MkdirAll(filepath.Dir(realExecutable), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(realExecutable, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	finalExecutable := filepath.Join(runtimeRoot, "node_modules", ".bin", "agent")
	if err := os.MkdirAll(filepath.Dir(finalExecutable), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realExecutable, finalExecutable); err != nil {
		t.Fatal(err)
	}
	entry, err := NewEntry(runtimeRoot, userBinDir, "agent", finalExecutable)
	if err != nil {
		t.Fatal(err)
	}
	if err := entry.Publish(); err != nil {
		t.Fatal(err)
	}
	if err := entry.Verify(); err != nil {
		t.Fatal(err)
	}
}
