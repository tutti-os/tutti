//go:build windows

package agentruntime

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewManagedProcessCommandRunsCmdShimWithSpaces(t *testing.T) {
	shim := filepath.Join(t.TempDir(), "node shim.cmd")
	if err := os.WriteFile(shim, []byte("@echo off\r\necho shim-ok\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	output, err := newManagedProcessCommand(context.Background(), shim).CombinedOutput()
	if err != nil {
		t.Fatalf("cmd shim failed: %v; output=%q", err, output)
	}
	if !strings.Contains(string(output), "shim-ok") {
		t.Fatalf("cmd shim output = %q, want shim-ok", output)
	}
}
