package agent

import (
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const defaultLiveModelCacheTTL = 10 * time.Minute

type composerLiveModelCache struct {
	mu             sync.Mutex
	entries        map[string]composerLiveModelCacheEntry
	targetCatalogs map[string]composerLiveModelCacheEntry
}

type composerLiveModelCacheEntry struct {
	agentTargetID  string
	cachedAt       time.Time
	options        []ComposerConfigOptionValue
	provider       string
	runtimeContext map[string]any
}

func newComposerLiveModelCache() *composerLiveModelCache {
	return &composerLiveModelCache{
		entries:        make(map[string]composerLiveModelCacheEntry),
		targetCatalogs: make(map[string]composerLiveModelCacheEntry),
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

func (c *composerLiveModelCache) set(scope composerLiveModelScope, now time.Time, options []ComposerConfigOptionValue) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	key := scope.key()
	entry := c.entries[key]
	entry.agentTargetID = strings.TrimSpace(scope.agentTargetID)
	entry.cachedAt = now
	entry.options = cloneComposerConfigOptionValues(options)
	entry.provider = agentprovider.NormalizeOpen(scope.provider)
	c.entries[key] = entry
	if entry.agentTargetID != "" {
		// The scoped entry serves composer presentation and may expire. Keep a
		// separate last-known-good target catalog for sparse defaults patches,
		// which carry no workspace/cwd and therefore cannot safely rediscover
		// the menu's descriptor at mutation time.
		c.targetCatalogs[key] = entry
	}
}

func (c *composerLiveModelCache) optionsForTarget(
	provider string,
	agentTargetID string,
) ([]ComposerConfigOptionValue, bool) {
	if c == nil {
		return nil, false
	}
	provider = agentprovider.NormalizeOpen(provider)
	agentTargetID = strings.TrimSpace(agentTargetID)
	if provider == "" || agentTargetID == "" {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	result := make([]ComposerConfigOptionValue, 0)
	seen := make(map[string]struct{})
	for _, entry := range c.targetCatalogs {
		if entry.provider != provider || entry.agentTargetID != agentTargetID {
			continue
		}
		for _, option := range entry.options {
			value := strings.TrimSpace(option.Value)
			if value == "" {
				continue
			}
			if _, ok := seen[value]; ok {
				continue
			}
			seen[value] = struct{}{}
			result = append(result, option)
		}
	}
	return cloneComposerConfigOptionValues(result), len(result) > 0
}

func (c *composerLiveModelCache) getRuntimeContext(key string, now time.Time, ttl time.Duration) (map[string]any, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok || len(entry.runtimeContext) == 0 {
		return nil, false
	}
	if ttl > 0 && now.Sub(entry.cachedAt) > ttl {
		delete(c.entries, key)
		return nil, false
	}
	return clonePayload(entry.runtimeContext), true
}

func (c *composerLiveModelCache) setRuntimeContext(key string, now time.Time, runtimeContext map[string]any) {
	if c == nil || len(runtimeContext) == 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry := c.entries[key]
	entry.cachedAt = now
	entry.runtimeContext = clonePayload(runtimeContext)
	c.entries[key] = entry
}

func (c *composerLiveModelCache) invalidateProvider(provider string) int {
	if c == nil {
		return 0
	}
	prefix := "live-model:" + agentprovider.NormalizeOpen(provider) + ":"
	c.mu.Lock()
	defer c.mu.Unlock()
	deleted := 0
	for key := range c.entries {
		if strings.HasPrefix(key, prefix) {
			delete(c.entries, key)
			deleted++
		}
	}
	for key := range c.targetCatalogs {
		if strings.HasPrefix(key, prefix) {
			delete(c.targetCatalogs, key)
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
	normalized := agentprovider.NormalizeOpen(provider)
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
	// Providers with a preserved cache keep their last-known-good catalog until
	// an explicit invalidation or a running session advertises a fresher list.
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
	s.liveComposerModelCache().set(scope, now, options)
}

func (s *Service) liveComposerModelOptionsForTarget(
	provider string,
	agentTargetID string,
) ([]ComposerConfigOptionValue, bool) {
	// Defaults are target-scoped rather than workspace/cwd-scoped. Union only
	// last-known-good catalogs the daemon actually observed for this exact
	// target. Display cache TTL does not expire this validation evidence because
	// the sparse patch has no scope with which to rediscover it. Create still
	// validates the selected default against its actual caller scope.
	return s.liveComposerModelCache().optionsForTarget(
		provider,
		agentTargetID,
	)
}

func (s *Service) getComposerRuntimeContextForScope(scope composerLiveModelScope, now time.Time) (map[string]any, bool) {
	return s.liveComposerModelCache().getRuntimeContext(scope.key(), now, s.liveModelCacheTTL(scope.provider))
}

func (s *Service) setComposerRuntimeContextForScope(scope composerLiveModelScope, now time.Time, runtimeContext map[string]any) {
	s.liveComposerModelCache().setRuntimeContext(scope.key(), now, runtimeContext)
}

// composerLiveModelCacheKey buckets the cache by provider, workspace, cwd scope,
// and (for auth-sensitive providers) an auth-context fingerprint. Providers
// with credential-scoped catalogs use one account-level workspace/cwd scope so
// UI project selection cannot duplicate hidden discovery. Other providers
// retain their caller scope. The same key also scopes the once-per-key hidden
// discovery guard.
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
