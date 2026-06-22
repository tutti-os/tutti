package agent

import (
	"strings"
	"sync"
	"time"
)

const defaultProviderAvailabilityCacheTTL = 10 * time.Second

type providerAvailabilityCache struct {
	mu      sync.Mutex
	entries map[string]providerAvailabilityCacheEntry
}

type providerAvailabilityCacheEntry struct {
	cachedAt     time.Time
	availability []ProviderAvailability
}

func newProviderAvailabilityCache() *providerAvailabilityCache {
	return &providerAvailabilityCache{
		entries: make(map[string]providerAvailabilityCacheEntry),
	}
}

func (c *providerAvailabilityCache) get(key string, now time.Time, ttl time.Duration) ([]ProviderAvailability, bool) {
	if c == nil || ttl <= 0 {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	if now.Sub(entry.cachedAt) > ttl {
		delete(c.entries, key)
		return nil, false
	}
	return cloneProviderAvailability(entry.availability), true
}

func (c *providerAvailabilityCache) set(key string, now time.Time, availability []ProviderAvailability) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = providerAvailabilityCacheEntry{
		cachedAt:     now,
		availability: cloneProviderAvailability(availability),
	}
}

func providerAvailabilityCacheKey(providers []string) string {
	if len(providers) == 0 {
		return "<all>"
	}
	return strings.Join(providers, "\x00")
}

func cloneProviderAvailability(items []ProviderAvailability) []ProviderAvailability {
	if len(items) == 0 {
		return nil
	}
	result := make([]ProviderAvailability, len(items))
	for i, item := range items {
		result[i] = item
		if len(item.Checks) > 0 {
			result[i].Checks = append([]ProviderAvailabilityCheck(nil), item.Checks...)
		}
		if item.LastError != nil {
			errorCopy := *item.LastError
			result[i].LastError = &errorCopy
		}
	}
	return result
}
