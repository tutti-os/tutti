package linkmanager

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultProbeTTL      = 10 * time.Minute
	defaultProbeCapacity = 64
)

var defaultProbeBackoff = []time.Duration{
	0,
	0,
	time.Minute,
	5 * time.Minute,
	15 * time.Minute,
	30 * time.Minute,
}

type ProbeCacheConfig struct {
	TTL      time.Duration
	Capacity int
	Backoff  []time.Duration
}

type ProbeDecision struct {
	RecentFailure bool
	ProbeDue      bool
}

type probeOutcome struct {
	consecutiveFailures int
	lastFailureAt       time.Time
	nextProbeAt         time.Time
	environment         string
}

func (o *probeOutcome) horizon(ttl time.Duration) time.Duration {
	backoff := o.nextProbeAt.Sub(o.lastFailureAt)
	if backoff < 0 {
		backoff = 0
	}
	return backoff + ttl
}

// ProbeCache remembers categorical direct-path failures without knowing what
// the preferred or fallback paths mean. Callers provide an opaque peer key and
// a sanitized environment fingerprint.
type ProbeCache struct {
	cfg ProbeCacheConfig

	mu               sync.Mutex
	entries          map[string]*probeOutcome
	probing          map[string]uint64
	probeGenerations map[string]uint64
	globalGeneration uint64
	nextProbeLeaseID uint64
}

// ProbeLease owns one peer's failure accounting in the generations that were
// current when ClaimProbe succeeded. A lease completed after invalidation is
// ignored and cannot recreate stale negative state.
type ProbeLease struct {
	cache            *ProbeCache
	peerKey          string
	id               uint64
	globalGeneration uint64
	peerGeneration   uint64
	once             sync.Once
}

func NewProbeCache(cfg ProbeCacheConfig) *ProbeCache {
	if cfg.TTL == 0 {
		cfg.TTL = defaultProbeTTL
	}
	if cfg.Capacity <= 0 {
		cfg.Capacity = defaultProbeCapacity
	}
	if len(cfg.Backoff) == 0 {
		cfg.Backoff = append([]time.Duration(nil), defaultProbeBackoff...)
	} else {
		cfg.Backoff = append([]time.Duration(nil), cfg.Backoff...)
		for index, delay := range cfg.Backoff {
			if delay < 0 {
				cfg.Backoff[index] = 0
			}
		}
	}
	return &ProbeCache{cfg: cfg}
}

// Decision reports whether the preference window should be skipped because of
// a recent failure and whether an annealed probe is due on this attempt.
func (c *ProbeCache) Decision(peerKey, environment string, now time.Time) ProbeDecision {
	if c == nil {
		return ProbeDecision{ProbeDue: true}
	}
	peerKey = strings.TrimSpace(peerKey)
	if peerKey == "" || c.cfg.TTL <= 0 {
		return ProbeDecision{ProbeDue: true}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry := c.entries[peerKey]
	if entry == nil {
		return ProbeDecision{ProbeDue: true}
	}
	if entry.environment != environment {
		if c.probeGenerations == nil {
			c.probeGenerations = make(map[string]uint64)
		}
		c.probeGenerations[peerKey]++
		delete(c.probing, peerKey)
		delete(c.entries, peerKey)
		return ProbeDecision{ProbeDue: true}
	}
	if now.Sub(entry.lastFailureAt) >= entry.horizon(c.cfg.TTL) {
		delete(c.entries, peerKey)
		return ProbeDecision{ProbeDue: true}
	}
	return ProbeDecision{
		RecentFailure: true,
		ProbeDue:      !now.Before(entry.nextProbeAt),
	}
}

// ClaimProbe ensures one concurrent attempt owns failure accounting for a
// peer. The caller must complete the lease with RecordFailure, RecordSuccess,
// or Close.
func (c *ProbeCache) ClaimProbe(peerKey string) *ProbeLease {
	if c == nil {
		return nil
	}
	peerKey = strings.TrimSpace(peerKey)
	if peerKey == "" {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.probing == nil {
		c.probing = make(map[string]uint64)
	}
	if c.probing[peerKey] != 0 {
		return nil
	}
	c.nextProbeLeaseID++
	if c.nextProbeLeaseID == 0 {
		c.nextProbeLeaseID++
	}
	id := c.nextProbeLeaseID
	c.probing[peerKey] = id
	return &ProbeLease{
		cache:            c,
		peerKey:          peerKey,
		id:               id,
		globalGeneration: c.globalGeneration,
		peerGeneration:   c.probeGenerations[peerKey],
	}
}

// Close releases a probe claim without changing reachability state.
func (l *ProbeLease) Close() {
	l.complete(nil)
}

// RecordFailure atomically records one current probe failure and releases the
// claim. It returns false when the lease was already completed or invalidated.
func (l *ProbeLease) RecordFailure(environment string, now time.Time) bool {
	return l.complete(func(c *ProbeCache) {
		c.recordFailureLocked(l.peerKey, environment, now)
	})
}

// RecordSuccess clears negative state and releases the current probe claim.
func (l *ProbeLease) RecordSuccess() bool {
	return l.complete(func(c *ProbeCache) {
		delete(c.entries, l.peerKey)
	})
}

func (l *ProbeLease) complete(apply func(*ProbeCache)) bool {
	if l == nil || l.cache == nil {
		return false
	}
	applied := false
	l.once.Do(func() {
		c := l.cache
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.probing[l.peerKey] != l.id ||
			c.globalGeneration != l.globalGeneration ||
			c.probeGenerations[l.peerKey] != l.peerGeneration {
			return
		}
		delete(c.probing, l.peerKey)
		if apply != nil {
			apply(c)
		}
		applied = true
	})
	return applied
}

func (c *ProbeCache) recordFailureLocked(peerKey, environment string, now time.Time) {
	if c.cfg.TTL <= 0 {
		return
	}
	if c.entries == nil {
		c.entries = make(map[string]*probeOutcome)
	}
	entry := c.entries[peerKey]
	if entry == nil {
		if len(c.entries) >= c.cfg.Capacity {
			c.evictOldestLocked()
		}
		entry = &probeOutcome{}
		c.entries[peerKey] = entry
	} else if entry.environment != environment {
		entry.consecutiveFailures = 0
	}
	entry.consecutiveFailures++
	entry.lastFailureAt = now
	entry.nextProbeAt = now.Add(c.backoffFor(entry.consecutiveFailures))
	entry.environment = environment
}

// RecordSuccess clears a peer verdict and fences any older in-flight probe.
func (c *ProbeCache) RecordSuccess(peerKey string) {
	c.Invalidate(peerKey)
}

func (c *ProbeCache) Invalidate(peerKey string) {
	if c == nil {
		return
	}
	peerKey = strings.TrimSpace(peerKey)
	if peerKey == "" {
		return
	}
	c.mu.Lock()
	if c.probeGenerations == nil {
		c.probeGenerations = make(map[string]uint64)
	}
	c.probeGenerations[peerKey]++
	delete(c.entries, peerKey)
	delete(c.probing, peerKey)
	c.mu.Unlock()
}

func (c *ProbeCache) InvalidateAll() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.globalGeneration++
	c.entries = nil
	c.probing = nil
	c.probeGenerations = nil
	c.mu.Unlock()
}

func (c *ProbeCache) backoffFor(consecutiveFailures int) time.Duration {
	if consecutiveFailures < 1 {
		consecutiveFailures = 1
	}
	index := consecutiveFailures - 1
	if index >= len(c.cfg.Backoff) {
		index = len(c.cfg.Backoff) - 1
	}
	return c.cfg.Backoff[index]
}

func (c *ProbeCache) evictOldestLocked() {
	oldestKey := ""
	var oldestAt time.Time
	for key, entry := range c.entries {
		if oldestKey == "" || entry.lastFailureAt.Before(oldestAt) {
			oldestKey = key
			oldestAt = entry.lastFailureAt
		}
	}
	if oldestKey != "" {
		delete(c.entries, oldestKey)
	}
}

// EnvironmentFingerprint creates a bounded opaque token from product-owned
// lane, policy, STUN snapshot, and local-network generation inputs.
func EnvironmentFingerprint(parts ...string) string {
	digest := sha256.New()
	for _, part := range parts {
		part = strings.TrimSpace(part)
		_, _ = digest.Write([]byte(strconv.Itoa(len(part))))
		_, _ = digest.Write([]byte{0})
		_, _ = digest.Write([]byte(part))
		_, _ = digest.Write([]byte{0})
	}
	sum := digest.Sum(nil)
	return hex.EncodeToString(sum[:8])
}
