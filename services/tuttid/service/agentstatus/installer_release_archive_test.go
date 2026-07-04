package agentstatus

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type failingReleaseBinaryReader struct {
	wrote bool
}

func (reader *failingReleaseBinaryReader) Read(p []byte) (int, error) {
	if reader.wrote {
		return 0, errors.New("read failed")
	}
	reader.wrote = true
	return copy(p, "partial"), errors.New("read failed")
}

func TestWriteReleaseBinaryDoesNotClobberExistingBinaryOnCopyFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "codex-acp")
	if err := os.WriteFile(path, []byte("existing"), 0o755); err != nil {
		t.Fatalf("write existing binary: %v", err)
	}

	err := writeReleaseBinary(path, &failingReleaseBinaryReader{}, 0o755)
	if err == nil {
		t.Fatal("writeReleaseBinary error = nil, want copy failure")
	}
	content, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("read existing binary: %v", readErr)
	}
	if string(content) != "existing" {
		t.Fatalf("existing binary content = %q, want existing", string(content))
	}
}
