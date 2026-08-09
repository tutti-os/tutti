package agentcontext

import (
	"context"
	"strings"
	"sync"
	"time"

	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
	"golang.org/x/sync/singleflight"
)

const (
	extensionAvailabilityCacheTTL = 30 * time.Second
	extensionSetupProbeTimeout    = 25 * time.Second
)

type extensionAvailabilityCacheEntry struct {
	cachedAt time.Time
	snapshot agentextensionservice.SetupSnapshot
}

// extensionAvailabilityCache coalesces target-scoped setup probes across both
// current exact-target callers and legacy broad-catalog callers in the daemon.
// The bounded TTL keeps sequential app startups from repeating authentication
// while explicit refreshes bypass it and probes remain independently bounded.
type extensionAvailabilityCache struct {
	reader  AgentTargetSetupReader
	mu      sync.RWMutex
	entries map[string]extensionAvailabilityCacheEntry
	group   singleflight.Group
}

func newExtensionAvailabilityCache(reader AgentTargetSetupReader) *extensionAvailabilityCache {
	if reader == nil {
		return nil
	}
	return &extensionAvailabilityCache{
		reader:  reader,
		entries: make(map[string]extensionAvailabilityCacheEntry),
	}
}

func (c *extensionAvailabilityCache) load(
	ctx context.Context,
	input agentextensionservice.InstallPlanInput,
	refresh bool,
) (agentextensionservice.SetupSnapshot, error) {
	if c == nil || c.reader == nil {
		return agentextensionservice.SetupSnapshot{}, context.Canceled
	}
	key := strings.TrimSpace(input.WorkspaceID) + "\x00" + strings.TrimSpace(input.AgentTargetID)
	if !refresh {
		if snapshot, ok := c.get(key, time.Now()); ok {
			return snapshot, nil
		}
	}

	result := c.group.DoChan(key, func() (any, error) {
		if !refresh {
			if snapshot, ok := c.get(key, time.Now()); ok {
				return snapshot, nil
			}
		}
		probeCtx, cancel := context.WithTimeout(context.Background(), extensionSetupProbeTimeout)
		defer cancel()
		snapshot, err := c.reader.GetSetup(probeCtx, input)
		if err == nil {
			c.set(key, time.Now(), snapshot)
		}
		return snapshot, err
	})
	select {
	case <-ctx.Done():
		return agentextensionservice.SetupSnapshot{}, ctx.Err()
	case loaded := <-result:
		if loaded.Err != nil {
			return agentextensionservice.SetupSnapshot{}, loaded.Err
		}
		return loaded.Val.(agentextensionservice.SetupSnapshot), nil
	}
}

func (c *extensionAvailabilityCache) get(
	key string,
	now time.Time,
) (agentextensionservice.SetupSnapshot, bool) {
	c.mu.RLock()
	entry, ok := c.entries[key]
	c.mu.RUnlock()
	if !ok || now.Sub(entry.cachedAt) > extensionAvailabilityCacheTTL {
		return agentextensionservice.SetupSnapshot{}, false
	}
	return entry.snapshot, true
}

func (c *extensionAvailabilityCache) set(
	key string,
	cachedAt time.Time,
	snapshot agentextensionservice.SetupSnapshot,
) {
	c.mu.Lock()
	c.entries[key] = extensionAvailabilityCacheEntry{cachedAt: cachedAt, snapshot: snapshot}
	c.mu.Unlock()
}
