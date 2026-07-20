//go:build darwin

package agentruntime

import (
	"errors"
	"os"
	"path/filepath"
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
