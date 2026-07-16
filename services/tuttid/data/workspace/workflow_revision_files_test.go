package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkflowRevisionFilesUsesOpaqueContentAddressedIdempotentPaths(t *testing.T) {
	stateDir := t.TempDir()
	files := WorkflowRevisionFiles{StateDir: stateDir}
	raw := []byte("first revision")

	path, digest, err := files.Write("workflow-1", raw)
	if err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	if strings.Contains(path, "workspace-") {
		t.Fatalf("Write() path = %q, must not expose workspace identity", path)
	}
	wantPrefix := filepath.Join("tutti-mode-plans", "workflow-1", "revisions") + string(os.PathSeparator)
	if !strings.HasPrefix(path, wantPrefix) || filepath.Base(path) != digest+".md" {
		t.Fatalf("Write() path = %q, want content-addressed path under %q", path, wantPrefix)
	}

	retryPath, retryDigest, err := files.Write("workflow-1", raw)
	if err != nil {
		t.Fatalf("idempotent Write() error = %v", err)
	}
	if retryPath != path || retryDigest != digest {
		t.Fatalf("idempotent Write() = (%q, %q), want (%q, %q)", retryPath, retryDigest, path, digest)
	}

	changedPath, _, err := files.Write("workflow-1", []byte("replacement revision"))
	if err != nil {
		t.Fatalf("changed Write() error = %v", err)
	}
	if changedPath == path {
		t.Fatal("changed Write() reused the prior content path")
	}
}

func TestWorkflowRevisionFilesValidatesIdentityAndDigest(t *testing.T) {
	stateDir := t.TempDir()
	files := WorkflowRevisionFiles{StateDir: stateDir}
	path, digest, err := files.Write("workflow-1", []byte("revision"))
	if err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, path), []byte("tampered"), 0o600); err != nil {
		t.Fatalf("tamper revision: %v", err)
	}
	if _, err := files.Read("workflow-1", path, digest); !errors.Is(err, ErrWorkflowRevisionDigestMismatch) {
		t.Fatalf("Read(tampered) error = %v, want ErrWorkflowRevisionDigestMismatch", err)
	}
	if _, _, err := files.Write("../outside", []byte("revision")); !errors.Is(err, ErrInvalidWorkflowRevisionIdentity) {
		t.Fatalf("Write(unsafe) error = %v, want ErrInvalidWorkflowRevisionIdentity", err)
	}
	if _, err := files.Read("workflow-1", "../outside.md", digest); !errors.Is(err, ErrInvalidWorkflowRevisionIdentity) {
		t.Fatalf("Read(unsafe) error = %v, want ErrInvalidWorkflowRevisionIdentity", err)
	}
}
