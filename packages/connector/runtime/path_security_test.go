package runtime

import (
	"os"
	"path/filepath"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/host"
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

func TestExecutionSnapshotterMarksOnlyDeclaredArtifactNativeEntrypointExecutable(t *testing.T) {
	source := t.TempDir()
	executableRelative := "runtime/linux-arm64/gh"
	executable := filepath.Join(source, filepath.FromSlash(executableRelative))
	data := filepath.Join(source, "implementation", "broker.mjs")
	for _, file := range []string{executable, data} {
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(filepath.Base(file)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	digest, err := ExecutionInventoryDigest(source)
	if err != nil {
		t.Fatal(err)
	}
	snapshotter, err := NewExecutionSnapshotter(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := snapshotter.Create(market.PreparedArtifactReceipt{PreparedPath: source, InventoryDigest: digest}, executableRelative)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := snapshotter.Remove(snapshot); err != nil {
			t.Errorf("remove execution snapshot: %v", err)
		}
	}()
	executableInfo, err := os.Stat(filepath.Join(snapshot, filepath.FromSlash(executableRelative)))
	if err != nil {
		t.Fatal(err)
	}
	dataInfo, err := os.Stat(filepath.Join(snapshot, "implementation", "broker.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	if executableInfo.Mode()&0o111 == 0 || dataInfo.Mode()&0o111 != 0 {
		t.Fatalf("snapshot modes executable=%o data=%o", executableInfo.Mode().Perm(), dataInfo.Mode().Perm())
	}
}
