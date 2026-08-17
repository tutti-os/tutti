//go:build windows

package workspace

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkflowRevisionFilesPublishesContentOnWindows(t *testing.T) {
	t.Parallel()
	stateDir := t.TempDir()
	files := WorkflowRevisionFiles{StateDir: stateDir}
	raw := []byte("windows revision")

	documentPath, digest, err := files.Write("workflow-windows", raw)
	if err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	stored, err := files.Read("workflow-windows", documentPath, digest)
	if err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	if !bytes.Equal(stored, raw) {
		t.Fatalf("Read() = %q, want %q", stored, raw)
	}

	directory := filepath.Dir(filepath.Join(stateDir, documentPath))
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("ReadDir() error = %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != digest+".md" {
		t.Fatalf("revision directory entries = %v, want only %q", entries, digest+".md")
	}
}
