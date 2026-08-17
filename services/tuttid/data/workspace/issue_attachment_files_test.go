package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type issueAttachmentReferenceMap map[string]bool

func (refs issueAttachmentReferenceMap) HasIssueAttachmentReferencePath(_ context.Context, path string) (bool, error) {
	return refs[path], nil
}

func TestIssueAttachmentFilesWritesExclusivelyAndRemovesManagedFile(t *testing.T) {
	stateDir := t.TempDir()
	store := IssueAttachmentFiles{StateDir: stateDir}
	const attachmentID = "fbeec26b-1dde-4509-9368-f40c78e24a38"
	first := []byte("first")
	path, err := store.WriteExclusive(attachmentID, ".png", first)
	if err != nil {
		t.Fatalf("WriteExclusive() error = %v", err)
	}
	wantPath := filepath.Join(stateDir, "agent-prompt-assets", "issues", attachmentID+".png")
	if path != wantPath || !store.IsManagedPath(path) {
		t.Fatalf("WriteExclusive() path = %q, want managed %q", path, wantPath)
	}
	if _, err := store.WriteExclusive(attachmentID, ".png", []byte("second")); !errors.Is(err, os.ErrExist) {
		t.Fatalf("second WriteExclusive() error = %v, want os.ErrExist", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(got) != string(first) {
		t.Fatalf("persisted data = %q, want %q", got, first)
	}
	if err := store.Remove(path); err != nil {
		t.Fatalf("Remove() error = %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("managed attachment still exists after Remove(): %v", err)
	}
}

func TestIssueAttachmentFilesNeverRemovesExternalPath(t *testing.T) {
	store := IssueAttachmentFiles{StateDir: t.TempDir()}
	external := filepath.Join(t.TempDir(), "external.png")
	if err := os.WriteFile(external, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(external); err != nil {
		t.Fatalf("Remove() error = %v", err)
	}
	if _, err := os.Stat(external); err != nil {
		t.Fatalf("external file was removed: %v", err)
	}
}

func TestIssueAttachmentFilesReconcileRemovesOnlyOrphans(t *testing.T) {
	store := IssueAttachmentFiles{StateDir: t.TempDir()}
	referenced, err := store.WriteExclusive("fbeec26b-1dde-4509-9368-f40c78e24a38", ".png", []byte("keep"))
	if err != nil {
		t.Fatal(err)
	}
	orphan, err := store.WriteExclusive("3b6902af-f1b4-4340-8daa-69167b8ba956", ".jpg", []byte("remove"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Reconcile(context.Background(), issueAttachmentReferenceMap{referenced: true}); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if _, err := os.Stat(referenced); err != nil {
		t.Fatalf("referenced attachment was removed: %v", err)
	}
	if _, err := os.Stat(orphan); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("orphan attachment still exists: %v", err)
	}
}
