package agent

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const defaultCapabilityCatalogCacheTTL = 30 * time.Second

type composerCapabilityCatalogCache struct {
	mu      sync.Mutex
	entries map[string]composerCapabilityCatalogCacheEntry
}

type composerCapabilityCatalogCacheEntry struct {
	cachedAt time.Time
	options  []ComposerCapabilityOption
}

func newComposerCapabilityCatalogCache() *composerCapabilityCatalogCache {
	return &composerCapabilityCatalogCache{
		entries: make(map[string]composerCapabilityCatalogCacheEntry),
	}
}

func (c *composerCapabilityCatalogCache) get(key string, now time.Time, ttl time.Duration) ([]ComposerCapabilityOption, bool) {
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
	return cloneComposerCapabilityOptions(entry.options), true
}

func (c *composerCapabilityCatalogCache) set(key string, now time.Time, options []ComposerCapabilityOption) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = composerCapabilityCatalogCacheEntry{
		cachedAt: now,
		options:  cloneComposerCapabilityOptions(options),
	}
}

func (s *Service) listComposerCapabilityOptions(
	ctx context.Context,
	provider string,
	cwd string,
	fallbackSkills []ComposerSkillOption,
) ([]ComposerCapabilityOption, []string) {
	cacheKey := composerCapabilityCatalogCacheKey(provider, cwd, fallbackSkills)
	now := time.Now().UTC()
	if cached, ok := s.capabilityCatalogCache.get(cacheKey, now, s.capabilityCatalogCacheTTL()); ok {
		return cached, nil
	}
	options, errors := s.composerCapabilityLister().ListComposerCapabilityOptions(ctx, provider, cwd, fallbackSkills)
	if len(errors) == 0 {
		s.capabilityCatalogCache.set(cacheKey, now, options)
	}
	return cloneComposerCapabilityOptions(options), append([]string(nil), errors...)
}

func (s *Service) capabilityCatalogCacheTTL() time.Duration {
	if s.CapabilityCatalogCacheTTL != 0 {
		return s.CapabilityCatalogCacheTTL
	}
	return defaultCapabilityCatalogCacheTTL
}

func composerCapabilityCatalogCacheKey(provider string, cwd string, skills []ComposerSkillOption) string {
	var builder strings.Builder
	builder.WriteString(agentprovider.Normalize(provider))
	builder.WriteByte('\n')
	builder.WriteString(strings.TrimSpace(cwd))
	for _, skill := range skills {
		builder.WriteByte('\n')
		builder.WriteString(skill.Name)
		builder.WriteByte('|')
		builder.WriteString(skill.Trigger)
		builder.WriteByte('|')
		builder.WriteString(skill.SourceKind)
		builder.WriteByte('|')
		builder.WriteString(skill.PluginName)
		builder.WriteByte('|')
		builder.WriteString(skill.Path)
	}
	return builder.String()
}

func cloneComposerCapabilityOptions(options []ComposerCapabilityOption) []ComposerCapabilityOption {
	if len(options) == 0 {
		return nil
	}
	return append([]ComposerCapabilityOption(nil), options...)
}
