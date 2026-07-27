package agentstatus

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

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
	checkedAt   time.Time
}

// AdapterProbeCache stores only successful launch probes. Failures are always
// retried, and explicit refresh/probe paths bypass this cache.
type AdapterProbeCache struct {
	mu      sync.RWMutex
	entries map[string]adapterProbeCacheEntry
}

type bunGlobalBinCacheEntry struct {
	fingerprint executableFingerprint
	binDir      string
}

// BunGlobalBinCache caches only successful `bun pm bin -g` discoveries until
// the resolved Bun executable changes. Failures are retried so installing Bun
// or correcting bunfig.toml does not require a daemon restart.
type BunGlobalBinCache struct {
	mu      sync.RWMutex
	entries map[string]bunGlobalBinCacheEntry
	group   singleflight.Group
}

func NewBunGlobalBinCache() *BunGlobalBinCache {
	return &BunGlobalBinCache{entries: make(map[string]bunGlobalBinCacheEntry)}
}

func (c *BunGlobalBinCache) load(bunPath string, loader func() string) string {
	if c == nil {
		return loader()
	}
	key := filepath.Clean(strings.TrimSpace(bunPath))
	if binDir, ok := c.get(key); ok {
		return binDir
	}
	value, _, _ := c.group.Do(key, func() (any, error) {
		if binDir, ok := c.get(key); ok {
			return binDir, nil
		}
		binDir := loader()
		if binDir != "" {
			c.set(key, binDir)
		}
		return binDir, nil
	})
	return value.(string)
}

func (c *BunGlobalBinCache) get(bunPath string) (string, bool) {
	fingerprint, ok := readExecutableFingerprint(bunPath)
	if !ok {
		return "", false
	}
	c.mu.RLock()
	entry, found := c.entries[bunPath]
	c.mu.RUnlock()
	if !found || !sameExecutableFingerprint(entry.fingerprint, fingerprint) {
		return "", false
	}
	return entry.binDir, true
}

func (c *BunGlobalBinCache) set(bunPath string, binDir string) {
	fingerprint, ok := readExecutableFingerprint(bunPath)
	if !ok {
		return
	}
	c.mu.Lock()
	c.entries[bunPath] = bunGlobalBinCacheEntry{fingerprint: fingerprint, binDir: binDir}
	c.mu.Unlock()
}

func NewAdapterProbeCache() *AdapterProbeCache {
	return &AdapterProbeCache{entries: make(map[string]adapterProbeCacheEntry)}
}

func (c *AdapterProbeCache) ready(key string, binaryPath string) bool {
	return c.readyWithin(key, binaryPath, time.Now(), 0)
}

// readyWithin accepts only a prior successful protocol handshake whose
// executable identity and freshness window still match. A positive probe cache
// is a latency optimization for List; it is never a source of failure or repair
// evidence.
func (c *AdapterProbeCache) readyWithin(key string, binaryPath string, now time.Time, ttl time.Duration) bool {
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
	if !found || !sameExecutableFingerprint(entry.fingerprint, fingerprint) {
		return false
	}
	return ttl <= 0 || !now.After(entry.checkedAt.Add(ttl))
}

func (c *AdapterProbeCache) age(key string, binaryPath string, now time.Time) (time.Duration, bool) {
	if c == nil {
		return 0, false
	}
	fingerprint, ok := readExecutableFingerprint(binaryPath)
	if !ok {
		return 0, false
	}
	c.mu.RLock()
	entry, found := c.entries[key]
	c.mu.RUnlock()
	if !found || !sameExecutableFingerprint(entry.fingerprint, fingerprint) {
		return 0, false
	}
	return now.Sub(entry.checkedAt), true
}

func (c *AdapterProbeCache) markReady(key string, binaryPath string) {
	c.markReadyAt(key, binaryPath, time.Now())
}

func (c *AdapterProbeCache) markReadyAt(key string, binaryPath string, checkedAt time.Time) {
	if c == nil {
		return
	}
	fingerprint, ok := readExecutableFingerprint(binaryPath)
	if !ok {
		return
	}
	c.mu.Lock()
	c.entries[key] = adapterProbeCacheEntry{fingerprint: fingerprint, checkedAt: checkedAt}
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
