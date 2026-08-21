package agentextension

import (
	"context"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

const accountUsageProbeCacheTTL = 15 * time.Second

type accountUsageProbeCacheEntry struct {
	result    AccountUsageResult
	expiresAt time.Time
}

type accountUsageProbeCache struct {
	mu      sync.RWMutex
	entries map[string]accountUsageProbeCacheEntry
	group   singleflight.Group
	now     func() time.Time
	ttl     time.Duration
}

func newAccountUsageProbeCache() *accountUsageProbeCache {
	return &accountUsageProbeCache{
		entries: make(map[string]accountUsageProbeCacheEntry),
		now:     time.Now,
		ttl:     accountUsageProbeCacheTTL,
	}
}

func (m *Manager) accountUsageProbeResults() *accountUsageProbeCache {
	m.accountUsageOnce.Do(func() {
		m.accountUsageCache = newAccountUsageProbeCache()
	})
	return m.accountUsageCache
}

func (m *Manager) clearAccountUsageProbeResults() {
	if m == nil {
		return
	}
	m.accountUsageProbeResults().clear()
}

func (c *accountUsageProbeCache) load(
	ctx context.Context,
	targetID string,
	loader func() (AccountUsageResult, error),
) (AccountUsageResult, error) {
	if result, ok := c.get(targetID, c.now()); ok {
		return result, nil
	}
	resultChannel := c.group.DoChan(targetID, func() (any, error) {
		if result, ok := c.get(targetID, c.now()); ok {
			return result, nil
		}
		result, err := loader()
		completedAt := c.now()
		if err == nil {
			c.set(targetID, result, completedAt.Add(c.ttl))
		}
		return cloneAccountUsageResult(result), err
	})
	select {
	case <-ctx.Done():
		return AccountUsageResult{}, ctx.Err()
	case outcome := <-resultChannel:
		if outcome.Err != nil {
			return AccountUsageResult{}, outcome.Err
		}
		return cloneAccountUsageResult(outcome.Val.(AccountUsageResult)), nil
	}
}

func (c *accountUsageProbeCache) get(targetID string, now time.Time) (AccountUsageResult, bool) {
	c.mu.RLock()
	entry, ok := c.entries[targetID]
	c.mu.RUnlock()
	if !ok || !now.Before(entry.expiresAt) {
		return AccountUsageResult{}, false
	}
	return cloneAccountUsageResult(entry.result), true
}

func (c *accountUsageProbeCache) set(targetID string, result AccountUsageResult, expiresAt time.Time) {
	c.mu.Lock()
	c.entries[targetID] = accountUsageProbeCacheEntry{
		result: cloneAccountUsageResult(result), expiresAt: expiresAt,
	}
	c.mu.Unlock()
}

func (c *accountUsageProbeCache) clear() {
	c.mu.Lock()
	clear(c.entries)
	c.mu.Unlock()
}

func cloneAccountUsageResult(result AccountUsageResult) AccountUsageResult {
	result.Quotas = append([]AccountUsageQuota(nil), result.Quotas...)
	return result
}
