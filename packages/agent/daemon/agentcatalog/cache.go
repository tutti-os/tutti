package agentcatalog

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	MaxModelOptions       = 500
	MaxSnapshotPayloadLen = 256 << 10
)

var ErrInvalidSnapshot = errors.New("invalid agent catalog snapshot")

type cacheEntry struct {
	stored StoredSnapshot
}

type memoryCache struct {
	mu         sync.RWMutex
	entries    map[SnapshotKey]cacheEntry
	generation map[SnapshotKey]uint64
}

func newMemoryCache() *memoryCache {
	return &memoryCache{entries: make(map[SnapshotKey]cacheEntry), generation: make(map[SnapshotKey]uint64)}
}

func (c *memoryCache) read(key SnapshotKey) (StoredSnapshot, bool) {
	c.mu.RLock()
	entry, ok := c.entries[key]
	c.mu.RUnlock()
	if !ok {
		return StoredSnapshot{}, false
	}
	return cloneStoredSnapshot(entry.stored), true
}

func (c *memoryCache) write(stored StoredSnapshot, generation uint64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.generation[stored.Key] != generation {
		return false
	}
	c.entries[stored.Key] = cacheEntry{stored: cloneStoredSnapshot(stored)}
	return true
}

// writeRuntime atomically publishes an authoritative runtime observation and
// advances the key generation so an older detached resolver cannot overwrite
// it when that resolver eventually completes.
func (c *memoryCache) writeRuntime(stored StoredSnapshot) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.entries[stored.Key]; ok &&
		existing.stored.Source == SnapshotSourceRuntime &&
		!stored.FetchedAt.After(existing.stored.FetchedAt) {
		return false
	}
	c.generation[stored.Key]++
	c.entries[stored.Key] = cacheEntry{stored: cloneStoredSnapshot(stored)}
	return true
}

func (c *memoryCache) currentGeneration(key SnapshotKey) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.generation[key]; !ok {
		c.generation[key] = 0
	}
	return c.generation[key]
}

func (c *memoryCache) invalidate(filter InvalidateInput) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key := range c.entries {
		if matchesInvalidation(key, filter) {
			delete(c.entries, key)
		}
	}
	// Generation keys are created before a refresh starts, so this also
	// supersedes in-flight work when no cache entry has been committed yet.
	for key := range c.generation {
		if matchesInvalidation(key, filter) {
			c.generation[key]++
		}
	}
}

func matchesInvalidation(key SnapshotKey, filter InvalidateInput) bool {
	return (filter.Facet == "" || key.Facet == filter.Facet) &&
		(strings.TrimSpace(filter.ProviderID) == "" || key.ProviderID == strings.TrimSpace(filter.ProviderID)) &&
		(strings.TrimSpace(filter.AgentTargetID) == "" || key.AgentTargetID == strings.TrimSpace(filter.AgentTargetID)) &&
		(filter.ScopeKind == "" || key.ScopeKind == filter.ScopeKind) &&
		(strings.TrimSpace(filter.ScopeValue) == "" || key.ScopeValue == strings.TrimSpace(filter.ScopeValue)) &&
		(strings.TrimSpace(filter.AuthRevision) == "" || key.AuthRevision == strings.TrimSpace(filter.AuthRevision))
}

func validateKey(key SnapshotKey) error {
	if key.Facet != FacetModels || strings.TrimSpace(key.ProviderID) == "" || key.DescriptorSchemaVersion <= 0 {
		return fmt.Errorf("%w: incomplete snapshot key", ErrInvalidSnapshot)
	}
	switch key.ScopeKind {
	case ScopeKindAccount, ScopeKindProvider, ScopeKindCWD, ScopeKindTarget:
	default:
		return fmt.Errorf("%w: unsupported scope kind %q", ErrInvalidSnapshot, key.ScopeKind)
	}
	if strings.TrimSpace(key.ScopeValue) == "" {
		return fmt.Errorf("%w: scope value is required", ErrInvalidSnapshot)
	}
	return nil
}

func normalizeModels(snapshot ModelSnapshot) (ModelSnapshot, error) {
	if len(snapshot.Models) > MaxModelOptions {
		return ModelSnapshot{}, fmt.Errorf("%w: model count exceeds %d", ErrInvalidSnapshot, MaxModelOptions)
	}
	result := ModelSnapshot{Revision: strings.TrimSpace(snapshot.Revision), ResolverSource: strings.TrimSpace(snapshot.ResolverSource), Complete: snapshot.Complete}
	seen := make(map[string]struct{}, len(snapshot.Models))
	for _, model := range snapshot.Models {
		model.Value = strings.TrimSpace(model.Value)
		if model.Value == "" {
			continue
		}
		if _, exists := seen[model.Value]; exists {
			continue
		}
		seen[model.Value] = struct{}{}
		model.Label = strings.TrimSpace(model.Label)
		model.Description = strings.TrimSpace(model.Description)
		model.DefaultReasoningEffort = strings.TrimSpace(model.DefaultReasoningEffort)
		model.SupportedReasoningEfforts = cloneReasoningOptions(model.SupportedReasoningEfforts)
		result.Models = append(result.Models, cloneModelOption(model))
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return ModelSnapshot{}, fmt.Errorf("%w: encode: %v", ErrInvalidSnapshot, err)
	}
	if len(payload) > MaxSnapshotPayloadLen {
		return ModelSnapshot{}, fmt.Errorf("%w: payload exceeds %d bytes", ErrInvalidSnapshot, MaxSnapshotPayloadLen)
	}
	return result, nil
}

func classify(stored StoredSnapshot, now time.Time) SnapshotFreshness {
	if stored.ExpiresAt.IsZero() || !now.After(stored.ExpiresAt) {
		return SnapshotFreshnessFresh
	}
	if stored.StaleUntil.IsZero() || !now.After(stored.StaleUntil) {
		return SnapshotFreshnessStale
	}
	return SnapshotFreshnessPending
}

func cloneStoredSnapshot(stored StoredSnapshot) StoredSnapshot {
	stored.Models = cloneModelSnapshot(stored.Models)
	return stored
}

func cloneModelSnapshot(snapshot ModelSnapshot) ModelSnapshot {
	result := snapshot
	result.Models = make([]ModelOption, len(snapshot.Models))
	for i, option := range snapshot.Models {
		result.Models[i] = cloneModelOption(option)
	}
	return result
}

func cloneModelOption(option ModelOption) ModelOption {
	option.SupportedReasoningEfforts = cloneReasoningOptions(option.SupportedReasoningEfforts)
	if option.SupportsImageInput != nil {
		value := *option.SupportsImageInput
		option.SupportsImageInput = &value
	}
	return option
}

func cloneReasoningOptions(options []ModelReasoningOption) []ModelReasoningOption {
	if len(options) == 0 {
		return nil
	}
	return append([]ModelReasoningOption(nil), options...)
}
