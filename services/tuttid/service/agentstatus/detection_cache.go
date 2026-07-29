package agentstatus

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/sync/singleflight"
)

type executableFingerprint struct {
	info         os.FileInfo
	resolvedPath string
}

func readExecutableFingerprint(path string) (executableFingerprint, bool) {
	path = strings.TrimSpace(path)
	if path == "" {
		return executableFingerprint{}, false
	}
	resolvedPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		resolvedPath = filepath.Clean(path)
	}
	info, err := os.Stat(resolvedPath)
	if err != nil {
		return executableFingerprint{}, false
	}
	return executableFingerprint{
		info:         info,
		resolvedPath: filepath.Clean(resolvedPath),
	}, true
}

func sameExecutableFingerprint(left executableFingerprint, right executableFingerprint) bool {
	return left.resolvedPath == right.resolvedPath &&
		left.info.Size() == right.info.Size() &&
		left.info.ModTime().Equal(right.info.ModTime()) &&
		os.SameFile(left.info, right.info)
}

type cliVersionCacheEntry struct {
	fingerprint executableFingerprint
	output      string
}

// CLIVersionCache reuses successful `--version` output until the resolved
// executable changes. A forced auth/readiness refresh does not need to restart
// an unchanged binary just to rediscover the same version.
type CLIVersionCache struct {
	mu      sync.RWMutex
	entries map[string]cliVersionCacheEntry
	group   singleflight.Group
}

func NewCLIVersionCache() *CLIVersionCache {
	return &CLIVersionCache{entries: make(map[string]cliVersionCacheEntry)}
}

func (c *CLIVersionCache) load(binaryPath string, loader func() string) string {
	if c == nil {
		return loader()
	}
	key := filepath.Clean(strings.TrimSpace(binaryPath))
	if output, ok := c.get(key); ok {
		return output
	}
	value, _, _ := c.group.Do(key, func() (any, error) {
		if output, ok := c.get(key); ok {
			return output, nil
		}
		output := loader()
		if output != "" {
			c.set(key, output)
		}
		return output, nil
	})
	return value.(string)
}

func (c *CLIVersionCache) get(binaryPath string) (string, bool) {
	fingerprint, ok := readExecutableFingerprint(binaryPath)
	if !ok {
		return "", false
	}
	c.mu.RLock()
	entry, found := c.entries[binaryPath]
	c.mu.RUnlock()
	if !found || !sameExecutableFingerprint(entry.fingerprint, fingerprint) {
		return "", false
	}
	return entry.output, true
}

func (c *CLIVersionCache) set(binaryPath string, output string) {
	fingerprint, ok := readExecutableFingerprint(binaryPath)
	if !ok {
		return
	}
	c.mu.Lock()
	c.entries[binaryPath] = cliVersionCacheEntry{
		fingerprint: fingerprint,
		output:      output,
	}
	c.mu.Unlock()
}

type adapterProbeCacheEntry struct {
	fingerprint executableFingerprint
}

// AdapterProbeCache stores only successful launch probes. Failures are always
// retried, and explicit refresh/probe paths bypass this cache.
type AdapterProbeCache struct {
	mu      sync.RWMutex
	entries map[string]adapterProbeCacheEntry
}

func NewAdapterProbeCache() *AdapterProbeCache {
	return &AdapterProbeCache{entries: make(map[string]adapterProbeCacheEntry)}
}

func (c *AdapterProbeCache) ready(key string, binaryPath string) bool {
	if c == nil {
		return false
	}
	fingerprint, ok := readExecutableFingerprint(binaryPath)
	if !ok {
		return false
	}
	c.mu.RLock()
	entry, found := c.entries[key]
	c.mu.RUnlock()
	return found && sameExecutableFingerprint(entry.fingerprint, fingerprint)
}

func (c *AdapterProbeCache) markReady(key string, binaryPath string) {
	if c == nil {
		return
	}
	fingerprint, ok := readExecutableFingerprint(binaryPath)
	if !ok {
		return
	}
	c.mu.Lock()
	c.entries[key] = adapterProbeCacheEntry{fingerprint: fingerprint}
	c.mu.Unlock()
}

// DetectionCommandLimiter bounds actual auth/version/adapter subprocesses
// across concurrent List requests. Provider-level concurrency alone does not
// cover the multiple commands started inside each provider.
type DetectionCommandLimiter struct {
	slots chan struct{}
}

func NewDetectionCommandLimiter(limit int) *DetectionCommandLimiter {
	if limit < 1 {
		limit = 1
	}
	return &DetectionCommandLimiter{slots: make(chan struct{}, limit)}
}

func (l *DetectionCommandLimiter) acquire(ctx context.Context) (func(), bool) {
	if l == nil {
		return func() {}, true
	}
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case l.slots <- struct{}{}:
		return func() { <-l.slots }, true
	case <-ctx.Done():
		return nil, false
	}
}
