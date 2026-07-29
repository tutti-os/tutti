package tuttiagent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteTuttiAgentAuthSafelyReplacesExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeTuttiAgentAuthSafely(path, []byte("new"), 0o600); err != nil {
		t.Fatalf("writeTuttiAgentAuthSafely() error = %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new" {
		t.Fatalf("auth contents = %q, want new", got)
	}
}
