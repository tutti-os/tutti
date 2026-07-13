package runtimeprep

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalStoreRuntimeRootUsesSessionScopedPath(t *testing.T) {
	stateDir := t.TempDir()
	root, err := LocalStore{StateDir: stateDir}.RuntimeRoot("workspace-1", "session-1")
	if err != nil {
		t.Fatalf("RuntimeRoot() error = %v", err)
	}

	if want := filepath.Join(stateDir, "agent", "runs", "session-1"); root != want {
		t.Fatalf("RuntimeRoot() = %q, want %q", root, want)
	}
	if strings.Contains(root, "workspace-1") {
		t.Fatalf("runtime root leaks workspace id: %q", root)
	}
}

func TestLocalStoreCleanupRemovesSessionScopedRuntimeRoot(t *testing.T) {
	stateDir := t.TempDir()
	store := LocalStore{StateDir: stateDir}
	runtimeRoot, err := store.RuntimeRoot("workspace-1", "session-1")
	if err != nil {
		t.Fatalf("RuntimeRoot() error = %v", err)
	}
	if err := os.MkdirAll(runtimeRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runtimeRoot, "runtime.txt"), []byte("runtime"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := store.CleanupRuntime(StoreCleanupInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
	}); err != nil {
		t.Fatalf("CleanupRuntime() error = %v", err)
	}

	if _, err := os.Stat(runtimeRoot); !os.IsNotExist(err) {
		t.Fatalf("runtime root still exists, err = %v", err)
	}
}

func TestReplaceManagedBlockPreservesUserContentAndReplacesPreviousBlock(t *testing.T) {
	existing := "user notes\n\n" + managedBlockBegin + "\nold\n" + managedBlockEnd + "\n\nmore notes\n"
	next := replaceManagedBlock(existing, "new policy")

	if !strings.Contains(next, "user notes") || !strings.Contains(next, "more notes") {
		t.Fatalf("user content was not preserved: %q", next)
	}
	if strings.Contains(next, "old") {
		t.Fatalf("old managed block content still present: %q", next)
	}
	if count := strings.Count(next, managedBlockBegin); count != 1 {
		t.Fatalf("managed block count = %d, want 1: %q", count, next)
	}
	if !strings.Contains(next, "new policy") {
		t.Fatalf("new content missing: %q", next)
	}
}

func TestRemoveManagedBlockCanDeleteCreatedEmptyFile(t *testing.T) {
	path := t.TempDir() + "/AGENTS.md"
	store := LocalStore{StateDir: t.TempDir()}
	if _, err := store.WriteManagedBlock(path, "managed"); err != nil {
		t.Fatal(err)
	}
	if err := removeManagedBlock(path, true); err != nil {
		t.Fatalf("removeManagedBlock() error = %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("managed file still exists, err = %v", err)
	}
}

func TestRemoveManagedBlockPreservesUserContent(t *testing.T) {
	path := t.TempDir() + "/AGENTS.md"
	store := LocalStore{StateDir: t.TempDir()}
	if err := os.WriteFile(path, []byte("user content\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteManagedBlock(path, "managed"); err != nil {
		t.Fatal(err)
	}
	if err := removeManagedBlock(path, false); err != nil {
		t.Fatalf("removeManagedBlock() error = %v", err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(content), managedBlockBegin) || !strings.Contains(string(content), "user content") {
		t.Fatalf("rolled back content = %q", string(content))
	}
}
