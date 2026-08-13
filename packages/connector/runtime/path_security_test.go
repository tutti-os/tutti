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

func TestExecutionSnapshotterCleanupOrphansRemovesOnlyManagedSnapshots(t *testing.T) {
	stateRoot := t.TempDir()
	snapshotter, err := NewExecutionSnapshotter(stateRoot)
	if err != nil {
		t.Fatal(err)
	}
	parent := filepath.Join(stateRoot, "execution-snapshots")
	ready := filepath.Join(parent, ".staging-old.ready")
	staging := filepath.Join(parent, ".staging-interrupted")
	unmanaged := filepath.Join(parent, "keep")
	for _, path := range []string{ready, staging, unmanaged} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(ready, "entrypoint"), []byte("old"), 0o400); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(ready, 0o500); err != nil {
		t.Fatal(err)
	}

	if err := snapshotter.CleanupOrphans(); err != nil {
		t.Fatal(err)
	}
	for _, removed := range []string{ready, staging} {
		if _, err := os.Stat(removed); !os.IsNotExist(err) {
			t.Fatalf("orphan snapshot %q remains: %v", removed, err)
		}
	}
	if _, err := os.Stat(unmanaged); err != nil {
		t.Fatalf("unmanaged directory was removed: %v", err)
	}
}
