package runtime

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSecureConnectorStateDirRejectsTraversalBeforeCreatingIt(t *testing.T) {
	root := filepath.Join(t.TempDir(), "state")
	escaped := filepath.Join(filepath.Dir(root), "escaped")
	if _, err := SecureConnectorStateDir(root, "../escaped", "github"); err == nil {
		t.Fatal("expected traversal identity to be rejected")
	}
	if _, err := os.Stat(escaped); !os.IsNotExist(err) {
		t.Fatalf("escaped directory was created before validation: %v", err)
	}
}

func TestExecutionSnapshotterRemoveRejectsPathsOutsideItsNamespace(t *testing.T) {
	stateRoot := t.TempDir()
	snapshotter, err := NewExecutionSnapshotter(stateRoot)
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "keep")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := snapshotter.Remove(outside); err == nil {
		t.Fatal("expected out-of-namespace removal to be rejected")
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("outside directory was removed: %v", err)
	}
}
