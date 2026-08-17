package agent

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const (
	defaultCapabilityCatalogCacheTTL      = 30 * time.Second
	defaultCapabilityCatalogErrorCacheTTL = 5 * time.Second
)

type composerCapabilityCatalogCache struct {
	mu      sync.Mutex
	entries map[string]composerCapabilityCatalogCacheEntry
}

type composerCapabilityCatalogCacheEntry struct {
	cachedAt time.Time
	errors   []string
	options  []ComposerCapabilityOption
}

func newComposerCapabilityCatalogCache() *composerCapabilityCatalogCache {
	return &composerCapabilityCatalogCache{
		entries: make(map[string]composerCapabilityCatalogCacheEntry),
	}
}

func (c *composerCapabilityCatalogCache) get(
	key string,
	now time.Time,
	successTTL time.Duration,
	errorTTL time.Duration,
) ([]ComposerCapabilityOption, []string, bool) {
	if c == nil {
		return nil, nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok {
		return nil, nil, false
	}
	ttl := successTTL
	if len(entry.errors) > 0 {
		ttl = errorTTL
	}
	if ttl <= 0 || now.Sub(entry.cachedAt) > ttl {
		delete(c.entries, key)
		return nil, nil, false
	}
	return cloneComposerCapabilityOptions(entry.options), append([]string(nil), entry.errors...), true
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

func (c *composerCapabilityCatalogCache) setFailure(key string, now time.Time, errors []string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = composerCapabilityCatalogCacheEntry{
		cachedAt: now,
		errors:   append([]string(nil), errors...),
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
	if cached, errors, ok := s.capabilityCatalogCache.get(
		cacheKey,
		now,
		s.capabilityCatalogCacheTTL(),
		defaultCapabilityCatalogErrorCacheTTL,
	); ok {
		return cached, errors
	}
	loaded, _, _ := s.capabilityCatalogGroup.Do(cacheKey, func() (any, error) {
		if cached, errors, ok := s.capabilityCatalogCache.get(
			cacheKey,
			time.Now().UTC(),
			s.capabilityCatalogCacheTTL(),
			defaultCapabilityCatalogErrorCacheTTL,
		); ok {
			return capabilityCatalogLoadResult{options: cached, errors: errors}, nil
		}
		options, errors := s.composerCapabilityLister().ListComposerCapabilityOptions(ctx, provider, cwd, fallbackSkills)
		if len(errors) == 0 {
			s.capabilityCatalogCache.set(cacheKey, time.Now().UTC(), options)
		} else {
			s.capabilityCatalogCache.setFailure(cacheKey, time.Now().UTC(), errors)
		}
		return capabilityCatalogLoadResult{options: options, errors: errors}, nil
	})
	result, ok := loaded.(capabilityCatalogLoadResult)
	if !ok {
		return nil, []string{"capability catalog load returned an invalid result"}
	}
	return cloneComposerCapabilityOptions(result.options), append([]string(nil), result.errors...)
}

type capabilityCatalogLoadResult struct {
	errors  []string
	options []ComposerCapabilityOption
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
