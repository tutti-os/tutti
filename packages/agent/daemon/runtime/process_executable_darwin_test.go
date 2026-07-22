//go:build darwin

package agentruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

func TestPrepareProcessExecutableCreatesImmutablePrivateSnapshot(t *testing.T) {
	path, identity := copyCurrentExecutableWithIdentity(t)
	prepared, err := prepareProcessExecutable(path, identity)
	if err != nil {
		t.Fatal(err)
	}
	snapshotPath := prepared.path
	privateDir := prepared.privateDir
	for _, path := range []string{snapshotPath, privateDir} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Flags&unix.UF_IMMUTABLE == 0 {
			t.Fatalf("verified snapshot is not immutable: path=%q stat=%#v", path, stat)
		}
	}
	if err := os.WriteFile(snapshotPath, []byte("replacement"), 0o500); err == nil {
		t.Fatal("immutable verified snapshot accepted replacement")
	}
	if err := prepared.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(snapshotPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("verified snapshot remains after close: %v", err)
	}
	if _, err := os.Lstat(filepath.Dir(snapshotPath)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("verified snapshot directory remains after close: %v", err)
	}
}

func TestLocalProcessTransportKeepsVerifiedSnapshotUntilProcessExit(t *testing.T) {
	script := filepath.Join(t.TempDir(), "runtime")
	contents := []byte("#!/bin/sh\nsleep 0.1\nif [ -f \"$0\" ]; then printf available; else printf missing; fi\n")
	if err := os.WriteFile(script, contents, 0o700); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(contents)
	conn, err := NewLocalProcessTransport().Start(context.Background(), ProcessSpec{
		Command: []string{script},
		ExecutableIdentity: &ExecutableIdentity{
			SHA256: hex.EncodeToString(digest[:]), SizeBytes: int64(len(contents)),
		},
	})
	if err != nil {
		t.Fatalf("start verified process: %v", err)
	}
	defer func() { _ = conn.Close() }()

	var output strings.Builder
	for {
		frame, err := conn.Recv()
		if err != nil {
			t.Fatalf("receive process frame: %v", err)
		}
		output.Write(frame.Stdout)
		if frame.ExitCode != nil {
			if *frame.ExitCode != 0 {
				t.Fatalf("verified process exit code = %d", *frame.ExitCode)
			}
			break
		}
	}
	if got := output.String(); got != "available" {
		t.Fatalf("verified process snapshot state = %q, want available", got)
	}
}
