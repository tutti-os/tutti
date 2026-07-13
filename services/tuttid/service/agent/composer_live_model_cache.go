package agent

import (
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const defaultLiveModelCacheTTL = 10 * time.Minute

type composerLiveModelCache struct {
	mu      sync.Mutex
	entries map[string]composerLiveModelCacheEntry
}

type composerLiveModelCacheEntry struct {
	cachedAt time.Time
	options  []ComposerConfigOptionValue
}

func newComposerLiveModelCache() *composerLiveModelCache {
	return &composerLiveModelCache{
		entries: make(map[string]composerLiveModelCacheEntry),
	}
}

func (c *composerLiveModelCache) get(key string, now time.Time, ttl time.Duration) ([]ComposerConfigOptionValue, bool, bool) {
	if c == nil {
		return nil, false, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok {
		return nil, false, false
	}
	// ttl <= 0 means the entry never expires (last-known-good). Claude Code uses
	// this: a real session's model list is always better than the static
	// fallback, and expiring it only decays the picker back to the static list
	// with no way to re-probe (hidden discovery runs at most once per key).
	if ttl > 0 && now.Sub(entry.cachedAt) > ttl {
		delete(c.entries, key)
		return nil, false, true
	}
	return cloneComposerConfigOptionValues(entry.options), true, false
}

func (c *composerLiveModelCache) set(key string, now time.Time, options []ComposerConfigOptionValue) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = composerLiveModelCacheEntry{
		cachedAt: now,
		options:  cloneComposerConfigOptionValues(options),
	}
}

func (c *composerLiveModelCache) invalidateProvider(provider string) int {
	if c == nil {
		return 0
	}
	prefix := "live-model:" + agentprovider.Normalize(provider) + ":"
	c.mu.Lock()
	defer c.mu.Unlock()
	deleted := 0
	for key := range c.entries {
		if strings.HasPrefix(key, prefix) {
			delete(c.entries, key)
			deleted++
		}
	}
	return deleted
}

// InvalidateLiveComposerModels drops the discovered model lists (and the
// once-per-key discovery attempt markers) for the given provider so composer
// options can re-discover models after the provider's auth or config files
// changed on disk.
func (s *Service) InvalidateLiveComposerModels(provider string) {
	if s == nil {
		return
	}
	normalized := agentprovider.Normalize(provider)
	if normalized == "" {
		return
	}
	nowUnixMS := time.Now().UnixMilli()
	deletedCacheEntries := s.liveComposerModelCache().invalidateProvider(normalized)
	prefix := "live-model:" + normalized + ":"
	s.liveModelDiscoveryMu.Lock()
	if s.liveModelInvalidatedAtUnixMS == nil {
		s.liveModelInvalidatedAtUnixMS = make(map[string]int64)
	}
	s.liveModelInvalidatedAtUnixMS[normalized] = nowUnixMS
	deletedAttemptMarkers := 0
	for key := range s.liveModelDiscoveryAttempted {
		if strings.HasPrefix(key, prefix) {
			delete(s.liveModelDiscoveryAttempted, key)
			deletedAttemptMarkers++
		}
	}
	for key := range s.liveModelPersistedScanMissAtUnixMS {
		if strings.HasPrefix(key, prefix) {
			delete(s.liveModelPersistedScanMissAtUnixMS, key)
		}
	}
	logClaudeModelCatalogInvalidationDebug("live_composer_models_invalidated", map[string]any{
		"provider":              normalized,
		"deletedCacheEntries":   deletedCacheEntries,
		"deletedAttemptMarkers": deletedAttemptMarkers,
		"occurredAtUnixMs":      nowUnixMS,
	})
	s.liveModelDiscoveryMu.Unlock()
}

func (s *Service) liveModelCacheTTL(provider string) time.Duration {
	if s.LiveModelCacheTTL != 0 {
		return s.LiveModelCacheTTL
	}
	// Cursor cannot start a hidden probe, so expiry would only discard its
	// last-known-good list. Claude can safely re-discover after the TTL.
	if composerProfileFor(provider).Behavior.PreserveLiveModelCache {
		return 0
	}
	return defaultLiveModelCacheTTL
}

func (s *Service) liveComposerModelCache() *composerLiveModelCache {
	if s.liveModelCache == nil {
		s.liveModelCache = newComposerLiveModelCache()
	}
	return s.liveModelCache
}

func (s *Service) getLiveComposerModelOptions(provider, workspaceID, cwd string, now time.Time) ([]ComposerConfigOptionValue, bool) {
	return s.getLiveComposerModelOptionsForScope(newComposerLiveModelScope(provider, workspaceID, cwd, ""), now)
}

func (s *Service) setLiveComposerModelOptions(provider, workspaceID, cwd string, now time.Time, options []ComposerConfigOptionValue) {
	if len(options) == 0 {
		return
	}
	s.setLiveComposerModelOptionsForScope(newComposerLiveModelScope(provider, workspaceID, cwd, ""), now, options)
}

func (s *Service) getLiveComposerModelOptionsForScope(scope composerLiveModelScope, now time.Time) ([]ComposerConfigOptionValue, bool) {
	options, ok, expired := s.liveComposerModelCache().get(scope.key(), now, s.liveModelCacheTTL(scope.provider))
	if expired {
		s.clearLiveModelDiscoveryAttempt(scope.key())
	}
	return options, ok
}

func (s *Service) setLiveComposerModelOptionsForScope(scope composerLiveModelScope, now time.Time, options []ComposerConfigOptionValue) {
	if len(options) == 0 {
		return
	}
	s.liveComposerModelCache().set(scope.key(), now, options)
}

// composerLiveModelCacheKey buckets the cache by provider, workspace, cwd scope,
// and (for auth-sensitive providers) an auth-context fingerprint. Claude uses
// one account-level cwd scope so UI project selection cannot duplicate hidden
// discovery. Other providers retain their caller cwd. The same key also scopes
// the once-per-key hidden discovery guard.
func composerLiveModelCacheKey(provider, workspaceID, cwd, authScope string) string {
	scope := newComposerLiveModelScope(provider, workspaceID, cwd, "")
	scope.authScope = strings.TrimSpace(authScope)
	return scope.key()
}

func cloneComposerConfigOptionValues(options []ComposerConfigOptionValue) []ComposerConfigOptionValue {
	if len(options) == 0 {
		return nil
	}
	return append([]ComposerConfigOptionValue(nil), options...)
}
