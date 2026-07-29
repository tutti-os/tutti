package agentextension

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestValidateNativeExecutablePlatformRejectsFormatAndArchitectureMismatch(t *testing.T) {
	notNative := filepath.Join(t.TempDir(), "runtime")
	if err := os.WriteFile(notNative, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := validateNativeExecutablePlatform(notNative, runtimePlatform()); err == nil {
		t.Fatal("script passed native executable validation")
	}

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	otherArchitecture := "arm64"
	if runtime.GOARCH == "arm64" {
		otherArchitecture = "amd64"
	}
	err = validateNativeExecutablePlatform(executable, runtime.GOOS+"-"+otherArchitecture)
	if err == nil || !strings.Contains(err.Error(), "architecture") {
		t.Fatalf("native architecture mismatch error = %v", err)
	}
}

func TestVerifyRuntimeExecutableUnchangedRejectsFileAndLinkReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime")
	if err := os.WriteFile(path, []byte("original executable"), 0o700); err != nil {
		t.Fatal(err)
	}
	fingerprint, err := fingerprintRuntimeExecutable(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyRuntimeExecutableUnchanged(path, fingerprint); err != nil {
		t.Fatalf("unchanged executable error = %v", err)
	}
	if err := os.WriteFile(path, []byte("replacement executable"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := verifyRuntimeExecutableUnchanged(path, fingerprint); err == nil || !strings.Contains(err.Error(), "changed") {
		t.Fatalf("file replacement error = %v", err)
	}

	target := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(target, []byte("original executable"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if err := verifyRuntimeExecutableUnchanged(path, fingerprint); err == nil || !strings.Contains(err.Error(), "ordinary executable") {
		t.Fatalf("symlink replacement error = %v", err)
	}
}
