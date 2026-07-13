package runtimeprep

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveCLICommandUsesStateRootShim(t *testing.T) {
	stateDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(stateDir, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "bin", "tutti-dev"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	if got := resolveCLICommand(stateDir); got != "tutti-dev" {
		t.Fatalf("resolveCLICommand() = %q, want tutti-dev", got)
	}
}

func TestResolveCLICommandDefaultsToProductionName(t *testing.T) {
	if got := resolveCLICommand(t.TempDir()); got != "tutti" {
		t.Fatalf("resolveCLICommand() = %q, want tutti", got)
	}
}
