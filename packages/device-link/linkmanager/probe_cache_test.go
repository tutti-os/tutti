package linkmanager

import (
	"testing"
	"time"
)

func TestProbeCacheAnnealsFailuresAndPreservesDueWindow(t *testing.T) {
	t.Parallel()
	cache := NewProbeCache(ProbeCacheConfig{
		TTL:     10 * time.Minute,
		Backoff: []time.Duration{0, 0, time.Minute, 5 * time.Minute},
	})
	now := time.Unix(100, 0)
	const peer = "peer"
	const environment = "environment"

	for failure := 1; failure <= 3; failure++ {
		recordProbeFailure(t, cache, peer, environment, now)
		decision := cache.Decision(peer, environment, now)
		if !decision.RecentFailure {
			t.Fatalf("failure %d did not produce a recent verdict", failure)
		}
		wantDue := failure <= 2
		if decision.ProbeDue != wantDue {
			t.Fatalf("failure %d ProbeDue = %v, want %v", failure, decision.ProbeDue, wantDue)
		}
	}
	dueAt := now.Add(time.Minute)
	if decision := cache.Decision(peer, environment, dueAt); !decision.RecentFailure || !decision.ProbeDue {
		t.Fatalf("decision at due time = %#v, want recent due probe", decision)
	}
}

func TestProbeCacheEnvironmentChangeAndSuccessClearVerdict(t *testing.T) {
	t.Parallel()
	cache := NewProbeCache(ProbeCacheConfig{})
	now := time.Now()
	recordProbeFailure(t, cache, "peer", "old", now)
	if decision := cache.Decision("peer", "new", now); decision.RecentFailure || !decision.ProbeDue {
		t.Fatalf("environment change decision = %#v, want fresh probe", decision)
	}
	recordProbeFailure(t, cache, "peer", "new", now)
	cache.RecordSuccess("peer")
	if decision := cache.Decision("peer", "new", now); decision.RecentFailure || !decision.ProbeDue {
		t.Fatalf("success decision = %#v, want fresh probe", decision)
	}
}

func TestProbeCacheRecordFailureResetsBackoffForNewEnvironment(t *testing.T) {
	t.Parallel()
	cache := NewProbeCache(ProbeCacheConfig{
		Backoff: []time.Duration{0, time.Minute},
	})
	now := time.Now()
	recordProbeFailure(t, cache, "peer", "old", now)
	recordProbeFailure(t, cache, "peer", "old", now)
	if decision := cache.Decision("peer", "old", now); decision.ProbeDue {
		t.Fatalf("second old-environment failure decision = %#v, want annealed probe", decision)
	}
	recordProbeFailure(t, cache, "peer", "new", now)
	if decision := cache.Decision("peer", "new", now); !decision.RecentFailure || !decision.ProbeDue {
		t.Fatalf("new-environment failure decision = %#v, want reset backoff", decision)
	}
}

func TestProbeCacheClaimsOneConcurrentProbe(t *testing.T) {
	t.Parallel()
	cache := NewProbeCache(ProbeCacheConfig{})
	first := cache.ClaimProbe("peer")
	if first == nil {
		t.Fatal("first probe was not claimed")
	}
	if cache.ClaimProbe("peer") != nil {
		t.Fatal("second concurrent probe was claimed")
	}
	first.Close()
	if cache.ClaimProbe("peer") == nil {
		t.Fatal("probe was not claimable after finish")
	}
}

func TestProbeCacheInvalidationFencesStaleLeaseResults(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		invalidate func(*ProbeCache)
	}{
		{name: "peer", invalidate: func(cache *ProbeCache) { cache.Invalidate("peer") }},
		{name: "all", invalidate: func(cache *ProbeCache) { cache.InvalidateAll() }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cache := NewProbeCache(ProbeCacheConfig{})
			now := time.Now()
			stale := cache.ClaimProbe("peer")
			if stale == nil {
				t.Fatal("stale probe was not claimed")
			}
			tt.invalidate(cache)
			current := cache.ClaimProbe("peer")
			if current == nil {
				t.Fatal("new generation probe was not claimed")
			}
			if !current.RecordSuccess() {
				t.Fatal("current success was not applied")
			}
			if stale.RecordFailure("old-environment", now) {
				t.Fatal("stale failure was applied after invalidation")
			}
			if decision := cache.Decision("peer", "old-environment", now); decision.RecentFailure {
				t.Fatalf("stale failure recreated verdict: %#v", decision)
			}
		})
	}
}

func TestProbeCachePreservesLongBackoffDueWindow(t *testing.T) {
	t.Parallel()
	cache := NewProbeCache(ProbeCacheConfig{})
	now := time.Unix(100, 0)
	for range 6 {
		recordProbeFailure(t, cache, "peer", "environment", now)
	}
	dueAt := now.Add(30 * time.Minute)
	if decision := cache.Decision("peer", "environment", dueAt); !decision.RecentFailure || !decision.ProbeDue {
		t.Fatalf("30-minute due decision = %#v, want retained due probe", decision)
	}
}

func TestEnvironmentFingerprintIsBoundedAndOrderSensitive(t *testing.T) {
	t.Parallel()
	first := EnvironmentFingerprint("direct", "stun-a", "network-a")
	second := EnvironmentFingerprint("direct", "stun-a", "network-a")
	reordered := EnvironmentFingerprint("network-a", "stun-a", "direct")
	if len(first) != 16 || first != second || first == reordered {
		t.Fatalf("fingerprints first=%q second=%q reordered=%q", first, second, reordered)
	}
}

func recordProbeFailure(
	t *testing.T,
	cache *ProbeCache,
	peerKey, environment string,
	now time.Time,
) {
	t.Helper()
	lease := cache.ClaimProbe(peerKey)
	if lease == nil {
		t.Fatalf("probe %q was not claimable", peerKey)
	}
	if !lease.RecordFailure(environment, now) {
		t.Fatalf("probe %q failure was not applied", peerKey)
	}
}
