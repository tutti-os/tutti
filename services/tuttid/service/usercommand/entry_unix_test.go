//go:build !windows

package usercommand

import (
	"os"
	"path/filepath"
	"testing"
)

func writeTestExecutable(t *testing.T, runtimeRoot, relative string) string {
	t.Helper()
	executable := filepath.Join(runtimeRoot, relative)
	if err := os.MkdirAll(filepath.Dir(executable), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return executable
}

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
	published, err := entry.Publish()
	if err != nil {
		t.Fatal(err)
	}
	if !published {
		t.Fatal("Publish() reported a skipped user entry on an empty user bin dir")
	}
	if err := entry.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestUnixEntrySkipsForeignSymlinkUserCommand(t *testing.T) {
	runtimeRoot := t.TempDir()
	userBinDir := t.TempDir()
	foreignTarget := writeTestExecutable(t, t.TempDir(), "tools/hermes/bin/hermes")
	finalExecutable := writeTestExecutable(t, runtimeRoot, "runtime-id/bin/hermes")
	entry, err := NewEntry(runtimeRoot, userBinDir, "hermes", finalExecutable)
	if err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(userBinDir, "hermes")
	if err := os.Symlink(foreignTarget, foreign); err != nil {
		t.Fatal(err)
	}

	if err := entry.Validate(); err != nil {
		t.Fatalf("Validate() rejected a foreign user command: %v", err)
	}
	published, err := entry.Publish()
	if err != nil {
		t.Fatalf("Publish() failed on a foreign user command: %v", err)
	}
	if published {
		t.Fatal("Publish() reported it published over a foreign user command")
	}
	target, err := os.Readlink(foreign)
	if err != nil {
		t.Fatalf("foreign user command was replaced: %v", err)
	}
	if target != foreignTarget {
		t.Fatalf("foreign user command target changed: %q", target)
	}
	if err := entry.Verify(); err != nil {
		t.Fatalf("Verify() rejected a runtime with a skipped user command: %v", err)
	}
	// The internal stable hop must still be refreshed. The platform entry
	// stores a directory-relative symlink target, so resolve it first.
	stableTarget, err := os.Readlink(entry.StablePath)
	if err != nil {
		t.Fatalf("stable entry missing after Publish: %v", err)
	}
	resolvedStableTarget, err := resolvedSymlinkTarget(entry.StablePath)
	if err != nil {
		t.Fatalf("resolve stable entry target: %v", err)
	}
	if resolvedStableTarget != finalExecutable {
		t.Fatalf("stable entry target = %q, want %q", stableTarget, finalExecutable)
	}
}

func TestUnixEntrySkipsForeignFileUserCommand(t *testing.T) {
	runtimeRoot := t.TempDir()
	userBinDir := t.TempDir()
	finalExecutable := writeTestExecutable(t, runtimeRoot, "runtime-id/bin/hermes")
	entry, err := NewEntry(runtimeRoot, userBinDir, "hermes", finalExecutable)
	if err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(userBinDir, "hermes")
	if err := os.WriteFile(foreign, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	published, err := entry.Publish()
	if err != nil {
		t.Fatalf("Publish() failed on a foreign regular file: %v", err)
	}
	if published {
		t.Fatal("Publish() reported it published over a foreign regular file")
	}
	if err := entry.Verify(); err != nil {
		t.Fatalf("Verify() rejected a runtime with a skipped user command: %v", err)
	}
	content, err := os.ReadFile(foreign)
	if err != nil || string(content) != "#!/bin/sh\n" {
		t.Fatalf("foreign regular file was modified: %q err=%v", content, err)
	}
}
