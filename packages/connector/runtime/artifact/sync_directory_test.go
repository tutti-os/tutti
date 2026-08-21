package artifact

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSyncDirectoryAcceptsExistingDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "artifact"), []byte("verified"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := syncDirectory(root); err != nil {
		t.Fatalf("syncDirectory() error = %v, want nil", err)
	}
}

func TestSyncDirectoryRejectsMissingDirectory(t *testing.T) {
	if err := syncDirectory(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("syncDirectory() error = nil, want missing directory rejected")
	}
}
