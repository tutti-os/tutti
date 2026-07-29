package agentstatus

import (
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

const defaultProviderStatusCacheTTL = 30 * time.Minute

// ProviderStatusCache is the daemon-owned application cache for local provider
// readiness. Entries are keyed by provider rather than request shape so a
// whole-catalog probe also satisfies a later single-provider lookup.
type ProviderStatusCache struct {
	mu      sync.RWMutex
	entries map[string]providerStatusCacheEntry
	group   singleflight.Group
}

type providerStatusCacheEntry struct {
	cachedAt              time.Time
	credentialFingerprint string
	status                ProviderStatus
}

func NewProviderStatusCache() *ProviderStatusCache {
	return &ProviderStatusCache{entries: make(map[string]providerStatusCacheEntry)}
}

func (c *ProviderStatusCache) get(provider string, now time.Time, ttl time.Duration) (ProviderStatus, time.Time, string, bool) {
	if c == nil || ttl <= 0 {
		return ProviderStatus{}, time.Time{}, "", false
	}
	c.mu.RLock()
	entry, ok := c.entries[provider]
	c.mu.RUnlock()
	if !ok || now.Sub(entry.cachedAt) > ttl {
		return ProviderStatus{}, time.Time{}, "", false
	}
	return cloneProviderStatus(entry.status), entry.cachedAt, entry.credentialFingerprint, true
}

func (c *ProviderStatusCache) set(provider string, cachedAt time.Time, credentialFingerprint string, status ProviderStatus) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.entries[provider] = providerStatusCacheEntry{
		cachedAt:              cachedAt,
		credentialFingerprint: credentialFingerprint,
		status:                cloneProviderStatus(status),
	}
	c.mu.Unlock()
}

func (c *ProviderStatusCache) invalidate(provider string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	delete(c.entries, provider)
	c.mu.Unlock()
}

func (s Service) providerCredentialFingerprint(spec ProviderSpec) string {
	paths, complete := s.resolvedAuthMarkerPaths(spec)
	if len(paths) == 0 {
		if !complete {
			return "markers:unavailable"
		}
		return ""
	}
	parts := make([]string, 0, len(paths)+1)
	if !complete {
		parts = append(parts, "markers:incomplete")
	}
	for _, path := range paths {
		if modifiedAt, ok := s.fileModTime(path); ok {
			parts = append(parts, path+"="+modifiedAt.UTC().Format(time.RFC3339Nano))
			continue
		}
		if s.fileExists(path) {
			parts = append(parts, path+"=present")
			continue
		}
		parts = append(parts, path+"=missing")
	}
	return strings.Join(parts, "\x00")
}

func cloneProviderStatus(status ProviderStatus) ProviderStatus {
	result := status
	if status.Availability.CheckedAt != nil {
		checkedAt := *status.Availability.CheckedAt
		result.Availability.CheckedAt = &checkedAt
	}
	result.Adapter.Command = cloneStrings(status.Adapter.Command)
	if len(status.Actions) > 0 {
		result.Actions = make([]Action, len(status.Actions))
		for i, action := range status.Actions {
			result.Actions[i] = action
			if action.Command != nil {
				command := *action.Command
				result.Actions[i].Command = &command
			}
		}
	}
	result.Checks = append([]ProviderCheck(nil), status.Checks...)
	if status.LastError != nil {
		lastError := *status.LastError
		result.LastError = &lastError
	}
	if status.ActiveAction != nil {
		activeAction := *status.ActiveAction
		result.ActiveAction = &activeAction
	}
	return result
}
