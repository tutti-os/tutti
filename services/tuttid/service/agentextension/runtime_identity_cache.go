package agentextension

import (
	"fmt"
	"sync"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	"golang.org/x/sync/singleflight"
)

type runtimeExecutableIdentityCacheEntry struct {
	fingerprint runtimeVersionExecutableFingerprint
	identity    agentruntime.ExecutableIdentity
}

type runtimeExecutableIdentityCache struct {
	mu      sync.RWMutex
	entries map[string]runtimeExecutableIdentityCacheEntry
	group   singleflight.Group
}

func newRuntimeExecutableIdentityCache() *runtimeExecutableIdentityCache {
	return &runtimeExecutableIdentityCache{
		entries: make(map[string]runtimeExecutableIdentityCacheEntry),
	}
}

func (m *Manager) accountUsageNodeIdentity(path string) (*agentruntime.ExecutableIdentity, error) {
	m.nodeIdentityOnce.Do(func() {
		m.nodeIdentities = newRuntimeExecutableIdentityCache()
	})
	return m.nodeIdentities.load(path)
}

func (c *runtimeExecutableIdentityCache) load(path string) (*agentruntime.ExecutableIdentity, error) {
	fingerprint, ok := readRuntimeVersionExecutableFingerprint(path)
	if !ok {
		return nil, fmt.Errorf("read executable identity for %q", path)
	}
	if identity, ok := c.get(fingerprint); ok {
		return identity, nil
	}
	flightKey := fmt.Sprintf(
		"%s\x00%d\x00%d",
		fingerprint.resolvedPath,
		fingerprint.info.Size(),
		fingerprint.info.ModTime().UnixNano(),
	)
	value, err, _ := c.group.Do(flightKey, func() (any, error) {
		current, ok := readRuntimeVersionExecutableFingerprint(path)
		if !ok {
			return nil, fmt.Errorf("read executable identity for %q", path)
		}
		if identity, ok := c.get(current); ok {
			return *identity, nil
		}
		hashed, err := fingerprintRuntimeExecutable(current.resolvedPath)
		if err != nil {
			return nil, err
		}
		after, ok := readRuntimeVersionExecutableFingerprint(path)
		if !ok || !sameRuntimeVersionExecutableFingerprint(current, after) {
			return nil, fmt.Errorf("executable changed while deriving identity")
		}
		identity := *executableIdentity(hashed)
		c.set(after, identity)
		return identity, nil
	})
	if err != nil {
		return nil, err
	}
	identity := value.(agentruntime.ExecutableIdentity)
	return &identity, nil
}

func (c *runtimeExecutableIdentityCache) get(
	fingerprint runtimeVersionExecutableFingerprint,
) (*agentruntime.ExecutableIdentity, bool) {
	c.mu.RLock()
	entry, ok := c.entries[fingerprint.resolvedPath]
	c.mu.RUnlock()
	if !ok || !sameRuntimeVersionExecutableFingerprint(entry.fingerprint, fingerprint) {
		return nil, false
	}
	identity := entry.identity
	return &identity, true
}

func (c *runtimeExecutableIdentityCache) set(
	fingerprint runtimeVersionExecutableFingerprint,
	identity agentruntime.ExecutableIdentity,
) {
	c.mu.Lock()
	c.entries[fingerprint.resolvedPath] = runtimeExecutableIdentityCacheEntry{
		fingerprint: fingerprint,
		identity:    identity,
	}
	c.mu.Unlock()
}
