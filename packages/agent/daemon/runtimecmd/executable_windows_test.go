package runtimecmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolverPrefersWindowsNPMShimOverPOSIXShim(t *testing.T) {
	dir := t.TempDir()
	posixShim := filepath.Join(dir, "opencode")
	windowsShim := filepath.Join(dir, "opencode.cmd")
	if err := os.WriteFile(posixShim, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(windowsShim, []byte("@echo off\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	resolver := Resolver{
		Environ: func() []string { return []string{"PATH=" + dir} },
		HomeDir: func() (string, error) { return t.TempDir(), nil },
	}
	if got := resolver.Resolve("opencode", resolver.Env(nil)); !strings.EqualFold(got, windowsShim) {
		t.Fatalf("Resolve() = %q, want Windows shim %q", got, windowsShim)
	}
}
