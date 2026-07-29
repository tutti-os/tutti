package agentstatus

import (
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

const defaultProviderUpdateCacheTTL = 6 * time.Hour

// ProviderUpdateCache stores remote release-discovery outcomes independently
// from local readiness. Both successful checks and non-fatal failures are
// cached so a blocked registry is not hammered by repeated settings reads.
type ProviderUpdateCache struct {
	mu      sync.RWMutex
	entries map[string]providerUpdateCacheEntry
	group   singleflight.Group
}

type providerUpdateCacheEntry struct {
	checkedAt     time.Time
	latestVersion string
	reasonCode    string
}

func NewProviderUpdateCache() *ProviderUpdateCache {
	return &ProviderUpdateCache{entries: make(map[string]providerUpdateCacheEntry)}
}

func (c *ProviderUpdateCache) get(provider string, now time.Time, ttl time.Duration) (providerUpdateCacheEntry, bool) {
	if c == nil || ttl <= 0 {
		return providerUpdateCacheEntry{}, false
	}
	c.mu.RLock()
	entry, ok := c.entries[provider]
	c.mu.RUnlock()
	if !ok || now.Sub(entry.checkedAt) > ttl {
		return providerUpdateCacheEntry{}, false
	}
	return entry, true
}

func (c *ProviderUpdateCache) set(provider string, entry providerUpdateCacheEntry) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.entries[provider] = entry
	c.mu.Unlock()
}

func (c *ProviderUpdateCache) invalidate(provider string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	delete(c.entries, provider)
	c.mu.Unlock()
}
