package agentstatus

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCLIVersionCacheReusesVersionUntilExecutableChanges(t *testing.T) {
	binaryPath := filepath.Join(t.TempDir(), "agent-cli")
	if err := os.WriteFile(binaryPath, []byte("first"), 0o700); err != nil {
		t.Fatalf("write first binary: %v", err)
	}
	cache := NewCLIVersionCache()
	loads := 0
	load := func() string {
		loads++
		return "1.0.0"
	}

	if got := cache.load(binaryPath, load); got != "1.0.0" {
		t.Fatalf("first version = %q, want 1.0.0", got)
	}
	if got := cache.load(binaryPath, load); got != "1.0.0" {
		t.Fatalf("cached version = %q, want 1.0.0", got)
	}
	if loads != 1 {
		t.Fatalf("loads = %d, want 1 before binary change", loads)
	}

	replacementPath := filepath.Join(filepath.Dir(binaryPath), "replacement")
	if err := os.WriteFile(replacementPath, []byte("second binary"), 0o700); err != nil {
		t.Fatalf("write replacement binary: %v", err)
	}
	if err := os.Rename(replacementPath, binaryPath); err != nil {
		t.Fatalf("replace binary: %v", err)
	}
	if got := cache.load(binaryPath, load); got != "1.0.0" {
		t.Fatalf("version after replacement = %q, want 1.0.0", got)
	}
	if loads != 2 {
		t.Fatalf("loads = %d, want 2 after binary replacement", loads)
	}
}

func TestCLIVersionCacheDoesNotStoreFailedReads(t *testing.T) {
	binaryPath := filepath.Join(t.TempDir(), "agent-cli")
	if err := os.WriteFile(binaryPath, []byte("binary"), 0o700); err != nil {
		t.Fatalf("write binary: %v", err)
	}
	cache := NewCLIVersionCache()
	loads := 0
	load := func() string {
		loads++
		if loads == 1 {
			return ""
		}
		return "1.0.0"
	}

	if got := cache.load(binaryPath, load); got != "" {
		t.Fatalf("failed read = %q, want empty", got)
	}
	if got := cache.load(binaryPath, load); got != "1.0.0" {
		t.Fatalf("retry read = %q, want 1.0.0", got)
	}
	if loads != 2 {
		t.Fatalf("loads = %d, want failed read retried", loads)
	}
}

func TestAdapterProbeCacheStoresOnlyMatchingExecutable(t *testing.T) {
	binaryPath := filepath.Join(t.TempDir(), "adapter")
	if err := os.WriteFile(binaryPath, []byte("first"), 0o700); err != nil {
		t.Fatalf("write first adapter: %v", err)
	}
	cache := NewAdapterProbeCache()
	cache.markReady("codex", binaryPath)
	if !cache.ready("codex", binaryPath) {
		t.Fatal("ready = false after successful probe")
	}

	replacementPath := filepath.Join(filepath.Dir(binaryPath), "replacement")
	if err := os.WriteFile(replacementPath, []byte("second adapter"), 0o700); err != nil {
		t.Fatalf("write replacement adapter: %v", err)
	}
	if err := os.Rename(replacementPath, binaryPath); err != nil {
		t.Fatalf("replace adapter: %v", err)
	}
	if cache.ready("codex", binaryPath) {
		t.Fatal("ready = true after adapter replacement")
	}
}

func TestDetectionCommandLimiterBoundsConcurrentCommands(t *testing.T) {
	limiter := NewDetectionCommandLimiter(1)
	release, acquired := limiter.acquire(context.Background())
	if !acquired {
		t.Fatal("first command did not acquire limiter")
	}

	blockedContext, cancel := context.WithTimeout(
		context.Background(),
		20*time.Millisecond,
	)
	defer cancel()
	if _, acquired := limiter.acquire(blockedContext); acquired {
		t.Fatal("second command acquired a full limiter")
	}

	release()
	nextRelease, acquired := limiter.acquire(context.Background())
	if !acquired {
		t.Fatal("next command did not acquire released limiter")
	}
	nextRelease()
}
