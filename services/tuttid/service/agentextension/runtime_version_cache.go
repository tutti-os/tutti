package agentextension

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/sync/singleflight"
)

type runtimeVersionExecutableFingerprint struct {
	info         os.FileInfo
	resolvedPath string
}

func readRuntimeVersionExecutableFingerprint(path string) (runtimeVersionExecutableFingerprint, bool) {
	path = strings.TrimSpace(path)
	if path == "" {
		return runtimeVersionExecutableFingerprint{}, false
	}
	resolvedPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		resolvedPath = filepath.Clean(path)
	}
	info, err := os.Stat(resolvedPath)
	if err != nil {
		return runtimeVersionExecutableFingerprint{}, false
	}
	return runtimeVersionExecutableFingerprint{
		info:         info,
		resolvedPath: filepath.Clean(resolvedPath),
	}, true
}

func sameRuntimeVersionExecutableFingerprint(
	left runtimeVersionExecutableFingerprint,
	right runtimeVersionExecutableFingerprint,
) bool {
	return left.resolvedPath == right.resolvedPath &&
		left.info.Size() == right.info.Size() &&
		left.info.ModTime().Equal(right.info.ModTime()) &&
		os.SameFile(left.info, right.info)
}

type runtimeVersionCacheEntry struct {
	fingerprint runtimeVersionExecutableFingerprint
	version     string
}

type runtimeVersionCache struct {
	mu      sync.RWMutex
	entries map[string]runtimeVersionCacheEntry
	group   singleflight.Group
}

func newRuntimeVersionCache() *runtimeVersionCache {
	return &runtimeVersionCache{entries: make(map[string]runtimeVersionCacheEntry)}
}

func (c *runtimeVersionCache) load(
	executable string,
	args []string,
	constraint string,
	loader func() (string, error),
) (string, error) {
	if c == nil {
		return loader()
	}
	key := runtimeVersionCacheKey(executable, args, constraint)
	fingerprint, ok := readRuntimeVersionExecutableFingerprint(executable)
	if !ok {
		return loader()
	}
	if version, ok := c.get(key, fingerprint); ok {
		return version, nil
	}
	flightKey := fmt.Sprintf(
		"%s\x00%s\x00%d\x00%d",
		key,
		fingerprint.resolvedPath,
		fingerprint.info.Size(),
		fingerprint.info.ModTime().UnixNano(),
	)
	value, err, _ := c.group.Do(flightKey, func() (any, error) {
		current, ok := readRuntimeVersionExecutableFingerprint(executable)
		if !ok {
			return loader()
		}
		if version, ok := c.get(key, current); ok {
			return version, nil
		}
		version, err := loader()
		if err != nil {
			return "", err
		}
		after, ok := readRuntimeVersionExecutableFingerprint(executable)
		if ok && sameRuntimeVersionExecutableFingerprint(current, after) {
			c.set(key, after, version)
		}
		return version, nil
	})
	if err != nil {
		return "", err
	}
	return value.(string), nil
}

func runtimeVersionCacheKey(executable string, args []string, constraint string) string {
	return filepath.Clean(strings.TrimSpace(executable)) +
		"\x00" + strings.Join(args, "\x00") +
		"\x00" + strings.TrimSpace(constraint)
}

func (c *runtimeVersionCache) get(
	key string,
	fingerprint runtimeVersionExecutableFingerprint,
) (string, bool) {
	c.mu.RLock()
	entry, found := c.entries[key]
	c.mu.RUnlock()
	if !found || !sameRuntimeVersionExecutableFingerprint(entry.fingerprint, fingerprint) {
		return "", false
	}
	return entry.version, true
}

func (c *runtimeVersionCache) set(
	key string,
	fingerprint runtimeVersionExecutableFingerprint,
	version string,
) {
	c.mu.Lock()
	c.entries[key] = runtimeVersionCacheEntry{
		fingerprint: fingerprint,
		version:     version,
	}
	c.mu.Unlock()
}
