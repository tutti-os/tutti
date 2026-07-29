package agentextension

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
)

func TestRuntimeVersionCacheCoalescesConcurrentSuccessfulLoads(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "agent-cli")
	if err := os.WriteFile(executable, []byte("binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	cache := newRuntimeVersionCache()
	var loads atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	loader := func() (string, error) {
		if loads.Add(1) == 1 {
			close(started)
		}
		<-release
		return "1.2.3", nil
	}

	const callers = 20
	var wait sync.WaitGroup
	errs := make(chan error, callers)
	wait.Add(callers)
	for range callers {
		go func() {
			defer wait.Done()
			version, err := cache.load(executable, []string{"--version"}, ">=1.0.0 <2.0.0", loader)
			if err != nil {
				errs <- err
				return
			}
			if version != "1.2.3" {
				errs <- errors.New("unexpected cached version")
			}
		}()
	}
	<-started
	close(release)
	wait.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if got := loads.Load(); got != 1 {
		t.Fatalf("version loads = %d, want 1", got)
	}
}

func TestRuntimeVersionCacheRetriesFailuresAndInvalidatesExecutableReplacement(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "agent-cli")
	if err := os.WriteFile(executable, []byte("first"), 0o700); err != nil {
		t.Fatal(err)
	}
	cache := newRuntimeVersionCache()
	loads := 0
	loader := func() (string, error) {
		loads++
		if loads == 1 {
			return "", errors.New("version probe failed")
		}
		return "1.2.3", nil
	}

	if _, err := cache.load(executable, []string{"--version"}, ">=1.0.0 <2.0.0", loader); err == nil {
		t.Fatal("first load error = nil")
	}
	for range 2 {
		version, err := cache.load(executable, []string{"--version"}, ">=1.0.0 <2.0.0", loader)
		if err != nil || version != "1.2.3" {
			t.Fatalf("cached load = %q, %v", version, err)
		}
	}
	if loads != 2 {
		t.Fatalf("version loads = %d, want 2 after failure recovery", loads)
	}

	replacement := filepath.Join(root, "replacement")
	if err := os.WriteFile(replacement, []byte("replacement binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, executable); err != nil {
		t.Fatal(err)
	}
	version, err := cache.load(executable, []string{"--version"}, ">=1.0.0 <2.0.0", loader)
	if err != nil || version != "1.2.3" {
		t.Fatalf("load after replacement = %q, %v", version, err)
	}
	if loads != 3 {
		t.Fatalf("version loads = %d, want 3 after executable replacement", loads)
	}
}
