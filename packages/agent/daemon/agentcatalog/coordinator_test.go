package agentcatalog

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type memoryStore struct {
	mu      sync.Mutex
	entries map[SnapshotKey]StoredSnapshot
}

type blockingDeleteStore struct {
	*memoryStore
	deleteStarted chan struct{}
	deleteRelease chan struct{}
}

func (s *blockingDeleteStore) Delete(ctx context.Context, input InvalidateInput) error {
	close(s.deleteStarted)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.deleteRelease:
	}
	return s.memoryStore.Delete(ctx, input)
}

func (s *memoryStore) Load(_ context.Context, key SnapshotKey) (StoredSnapshot, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	stored, ok := s.entries[key]
	return cloneStoredSnapshot(stored), ok, nil
}

func (s *memoryStore) Save(_ context.Context, stored StoredSnapshot) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.entries == nil {
		s.entries = make(map[SnapshotKey]StoredSnapshot)
	}
	s.entries[stored.Key] = cloneStoredSnapshot(stored)
	return nil
}

func (s *memoryStore) Delete(_ context.Context, input InvalidateInput) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key := range s.entries {
		if matchesInvalidation(key, input) {
			delete(s.entries, key)
		}
	}
	return nil
}

func testKey(scope string) SnapshotKey {
	return SnapshotKey{Facet: FacetModels, ProviderID: "codex", AgentTargetID: "local:codex", ScopeKind: ScopeKindProvider, ScopeValue: scope, AuthRevision: "r1", DescriptorSchemaVersion: 1}
}

func testPolicy() ModelDiscoveryPolicy {
	return ModelDiscoveryPolicy{Enabled: true, ReuseRuntimeSnapshot: true, RuntimeAuthoritative: true, PersistLastGood: true, FreshTTL: time.Minute, MaxStale: time.Hour, ColdResolverKind: "test"}
}

func TestCoordinatorDefaultBudgets(t *testing.T) {
	coordinator := NewCoordinator(CoordinatorOptions{})
	if coordinator.interactiveWait != 10*time.Second {
		t.Fatalf("interactive wait = %s, want 10s", coordinator.interactiveWait)
	}
	if coordinator.resolverTimeout != 20*time.Second {
		t.Fatalf("resolver timeout = %s, want 20s", coordinator.resolverTimeout)
	}
}

func TestCoordinatorRuntimeSnapshotPrecedesResolverAndClones(t *testing.T) {
	var calls atomic.Int32
	coordinator := NewCoordinator(CoordinatorOptions{Resolvers: map[string]ColdResolver{"test": ColdResolverFunc(func(context.Context, ResolveModelsInput) (ModelSnapshot, error) {
		calls.Add(1)
		return ModelSnapshot{Models: []ModelOption{{Value: "cold"}}, Complete: true}, nil
	})}})
	key := testKey("one")
	models := ModelSnapshot{Models: []ModelOption{{Value: "runtime", SupportedReasoningEfforts: []ModelReasoningOption{{Value: "high"}}}}, Complete: true}
	if err := coordinator.IngestRuntimeSnapshot(context.Background(), RuntimeCatalogSnapshot{Key: key, Models: models}); err != nil {
		t.Fatal(err)
	}
	models.Models[0].Value = "mutated"
	result, err := coordinator.ResolveModels(context.Background(), ResolveModelsInput{Key: key, Policy: testPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	if got := result.Value.Models[0].Value; got != "runtime" {
		t.Fatalf("model = %q, want runtime", got)
	}
	result.Value.Models[0].Value = "caller-mutated"
	again, _ := coordinator.ResolveModels(context.Background(), ResolveModelsInput{Key: key, Policy: testPolicy()})
	if got := again.Value.Models[0].Value; got != "runtime" {
		t.Fatalf("cached model = %q, want runtime", got)
	}
	if calls.Load() != 0 {
		t.Fatalf("resolver calls = %d, want 0", calls.Load())
	}
}

func TestCoordinatorStaleReturnsImmediatelyAndRefreshesSingleFlight(t *testing.T) {
	now := time.Date(2026, 7, 16, 0, 0, 0, 0, time.UTC)
	key := testKey("one")
	store := &memoryStore{entries: map[SnapshotKey]StoredSnapshot{key: {
		Key: key, Models: ModelSnapshot{Models: []ModelOption{{Value: "stale"}}, Complete: true},
		Source: SnapshotSourceResolver, FetchedAt: now.Add(-time.Hour), ExpiresAt: now.Add(-time.Minute), StaleUntil: now.Add(time.Hour),
	}}}
	block := make(chan struct{})
	started := make(chan struct{})
	var calls atomic.Int32
	coordinator := NewCoordinator(CoordinatorOptions{Store: store, Now: func() time.Time { return now }, Resolvers: map[string]ColdResolver{"test": ColdResolverFunc(func(context.Context, ResolveModelsInput) (ModelSnapshot, error) {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-block
		return ModelSnapshot{Models: []ModelOption{{Value: "fresh"}}, Complete: true}, nil
	})}})
	for range 10 {
		result, err := coordinator.ResolveModels(context.Background(), ResolveModelsInput{Key: key, Policy: testPolicy()})
		if err != nil {
			t.Fatal(err)
		}
		if result.Freshness != SnapshotFreshnessStale || !result.Refreshing || result.Value.Models[0].Value != "stale" {
			t.Fatalf("unexpected stale result: %#v", result)
		}
	}
	<-started
	if calls.Load() != 1 {
		t.Fatalf("resolver calls = %d, want 1", calls.Load())
	}
	close(block)
}

func TestCoordinatorColdInteractiveFallsBackWhileRefreshContinues(t *testing.T) {
	resolved := make(chan struct{})
	coordinator := NewCoordinator(CoordinatorOptions{
		InteractiveWait: time.Millisecond,
		Resolvers: map[string]ColdResolver{"test": ColdResolverFunc(func(context.Context, ResolveModelsInput) (ModelSnapshot, error) {
			<-resolved
			return ModelSnapshot{Models: []ModelOption{{Value: "fresh"}}, Complete: true}, nil
		})},
	})
	input := ResolveModelsInput{Key: testKey("one"), Policy: testPolicy(), SelectedModel: "selected"}
	result, err := coordinator.ResolveModels(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Refreshing || result.Freshness != SnapshotFreshnessPending || result.Value.Models[0].Value != "selected" {
		t.Fatalf("unexpected fallback: %#v", result)
	}
	close(resolved)
	wait := input
	wait.ReadPolicy = ReadPolicyWait
	result, err = coordinator.ResolveModels(context.Background(), wait)
	if err != nil {
		t.Fatal(err)
	}
	if got := result.Value.Models[0].Value; got != "fresh" {
		t.Fatalf("model = %q, want fresh", got)
	}
}

func TestCoordinatorStructuredScopesDoNotJoin(t *testing.T) {
	var calls atomic.Int32
	coordinator := NewCoordinator(CoordinatorOptions{Resolvers: map[string]ColdResolver{"test": ColdResolverFunc(func(_ context.Context, input ResolveModelsInput) (ModelSnapshot, error) {
		calls.Add(1)
		return ModelSnapshot{Models: []ModelOption{{Value: input.Key.ScopeValue}}, Complete: true}, nil
	})}})
	for _, scope := range []string{"one", "two"} {
		result, err := coordinator.ResolveModels(context.Background(), ResolveModelsInput{Key: testKey(scope), Policy: testPolicy(), ReadPolicy: ReadPolicyWait})
		if err != nil || result.Value.Models[0].Value != scope {
			t.Fatalf("scope %q result=%#v err=%v", scope, result, err)
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("resolver calls = %d, want 2", calls.Load())
	}
}

func TestCoordinatorRegisterResolverAfterConstruction(t *testing.T) {
	coordinator := NewCoordinator(CoordinatorOptions{})
	if err := coordinator.RegisterResolver("dynamic", ColdResolverFunc(func(context.Context, ResolveModelsInput) (ModelSnapshot, error) {
		return ModelSnapshot{Models: []ModelOption{{Value: "registered"}}, Complete: true}, nil
	})); err != nil {
		t.Fatal(err)
	}
	policy := testPolicy()
	policy.ColdResolverKind = "dynamic"
	result, err := coordinator.ResolveModels(context.Background(), ResolveModelsInput{Key: testKey("dynamic"), Policy: policy, ReadPolicy: ReadPolicyWait})
	if err != nil {
		t.Fatal(err)
	}
	if got := result.Value.Models[0].Value; got != "registered" {
		t.Fatalf("model = %q, want registered", got)
	}
}

func TestCoordinatorInvalidationSupersedesInflightRefresh(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	coordinator := NewCoordinator(CoordinatorOptions{Resolvers: map[string]ColdResolver{"test": ColdResolverFunc(func(context.Context, ResolveModelsInput) (ModelSnapshot, error) {
		close(started)
		<-release
		return ModelSnapshot{Models: []ModelOption{{Value: "superseded"}}, Complete: true}, nil
	})}})
	input := ResolveModelsInput{Key: testKey("one"), Policy: testPolicy(), ReadPolicy: ReadPolicyWait}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = coordinator.ResolveModels(context.Background(), input)
	}()
	<-started
	if err := coordinator.Invalidate(context.Background(), InvalidateInput{Facet: FacetModels, ProviderID: "codex"}); err != nil {
		t.Fatal(err)
	}
	close(release)
	<-done
	result, err := coordinator.ResolveModels(context.Background(), ResolveModelsInput{Key: input.Key, Policy: input.Policy, ReadPolicy: ReadPolicyCacheOnly})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Value.Models) != 0 {
		t.Fatalf("superseded result was committed: %#v", result)
	}
}

func TestCoordinatorRuntimeIngestSupersedesInflightRefresh(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	coordinator := NewCoordinator(CoordinatorOptions{Resolvers: map[string]ColdResolver{"test": ColdResolverFunc(func(context.Context, ResolveModelsInput) (ModelSnapshot, error) {
		close(started)
		<-release
		return ModelSnapshot{Models: []ModelOption{{Value: "cold"}}, Complete: true}, nil
	})}})
	input := ResolveModelsInput{Key: testKey("one"), Policy: testPolicy(), ReadPolicy: ReadPolicyWait}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = coordinator.ResolveModels(context.Background(), input)
	}()
	<-started
	if err := coordinator.IngestRuntimeSnapshot(context.Background(), RuntimeCatalogSnapshot{
		Key: input.Key, Models: ModelSnapshot{Models: []ModelOption{{Value: "runtime"}}, Complete: true}, FetchedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	close(release)
	<-done
	result, err := coordinator.ResolveModels(context.Background(), ResolveModelsInput{Key: input.Key, Policy: input.Policy, ReadPolicy: ReadPolicyCacheOnly})
	if err != nil {
		t.Fatal(err)
	}
	if got := result.Value.Models[0].Value; got != "runtime" {
		t.Fatalf("model = %q, want authoritative runtime snapshot", got)
	}
}

func TestCoordinatorDurableReadCannotRaceInvalidationDelete(t *testing.T) {
	key := testKey("one")
	base := &memoryStore{entries: map[SnapshotKey]StoredSnapshot{key: {
		Key: key, Models: ModelSnapshot{Models: []ModelOption{{Value: "old"}}, Complete: true},
		Source: SnapshotSourceResolver, FetchedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour), StaleUntil: time.Now().Add(2 * time.Hour),
	}}}
	store := &blockingDeleteStore{memoryStore: base, deleteStarted: make(chan struct{}), deleteRelease: make(chan struct{})}
	coordinator := NewCoordinator(CoordinatorOptions{Store: store})
	invalidateDone := make(chan error, 1)
	go func() {
		invalidateDone <- coordinator.Invalidate(context.Background(), InvalidateInput{Facet: FacetModels, ProviderID: "codex"})
	}()
	<-store.deleteStarted
	readDone := make(chan ResolveModelsResult, 1)
	go func() {
		result, _ := coordinator.ResolveModels(context.Background(), ResolveModelsInput{Key: key, Policy: testPolicy(), ReadPolicy: ReadPolicyCacheOnly})
		readDone <- result
	}()
	select {
	case result := <-readDone:
		t.Fatalf("durable read completed while invalidation delete was blocked: %#v", result)
	case <-time.After(20 * time.Millisecond):
	}
	close(store.deleteRelease)
	if err := <-invalidateDone; err != nil {
		t.Fatal(err)
	}
	result := <-readDone
	if len(result.Value.Models) != 0 {
		t.Fatalf("invalidated durable model was revived: %#v", result)
	}
}

func TestCoordinatorRequiresCompleteAuthoritativeRuntimeSnapshot(t *testing.T) {
	coordinator := NewCoordinator(CoordinatorOptions{})
	key := testKey("one")
	if err := coordinator.IngestRuntimeSnapshot(context.Background(), RuntimeCatalogSnapshot{Key: key, Models: ModelSnapshot{Models: []ModelOption{{Value: "partial"}}, Complete: false}}); err != nil {
		t.Fatal(err)
	}
	policy := testPolicy()
	result, err := coordinator.ResolveModels(context.Background(), ResolveModelsInput{Key: key, Policy: policy, ReadPolicy: ReadPolicyCacheOnly})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Value.Models) != 0 {
		t.Fatalf("authoritative policy reused incomplete runtime snapshot: %#v", result)
	}
	policy.RuntimeAuthoritative = false
	result, err = coordinator.ResolveModels(context.Background(), ResolveModelsInput{Key: key, Policy: policy, ReadPolicy: ReadPolicyCacheOnly})
	if err != nil || result.Value.Models[0].Value != "partial" {
		t.Fatalf("non-authoritative policy result=%#v err=%v", result, err)
	}
}

func TestCoordinatorRejectsOversizedAndInvalidatesMatchingScope(t *testing.T) {
	coordinator := NewCoordinator(CoordinatorOptions{})
	models := make([]ModelOption, MaxModelOptions+1)
	for i := range models {
		models[i].Value = "model"
	}
	if err := coordinator.IngestRuntimeSnapshot(context.Background(), RuntimeCatalogSnapshot{Key: testKey("one"), Models: ModelSnapshot{Models: models}}); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatalf("error = %v, want ErrInvalidSnapshot", err)
	}
	for _, scope := range []string{"one", "two"} {
		if err := coordinator.IngestRuntimeSnapshot(context.Background(), RuntimeCatalogSnapshot{Key: testKey(scope), Models: ModelSnapshot{Models: []ModelOption{{Value: scope}}, Complete: true}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := coordinator.Invalidate(context.Background(), InvalidateInput{Facet: FacetModels, ProviderID: "codex", ScopeKind: ScopeKindProvider, ScopeValue: "one"}); err != nil {
		t.Fatal(err)
	}
	first, _ := coordinator.ResolveModels(context.Background(), ResolveModelsInput{Key: testKey("one"), Policy: ModelDiscoveryPolicy{Enabled: true, ReuseRuntimeSnapshot: true}, ReadPolicy: ReadPolicyCacheOnly})
	second, _ := coordinator.ResolveModels(context.Background(), ResolveModelsInput{Key: testKey("two"), Policy: ModelDiscoveryPolicy{Enabled: true, ReuseRuntimeSnapshot: true}, ReadPolicy: ReadPolicyCacheOnly})
	if len(first.Value.Models) != 0 || second.Value.Models[0].Value != "two" {
		t.Fatalf("unexpected invalidation results: first=%#v second=%#v", first, second)
	}
}
