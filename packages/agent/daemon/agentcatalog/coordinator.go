package agentcatalog

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	defaultInteractiveWait = 10 * time.Second
	defaultResolverTimeout = 20 * time.Second
)

var (
	ErrResolverUnavailable = errors.New("agent catalog resolver unavailable")
	ErrInvalidModel        = errors.New("invalid agent model")
)

type CoordinatorOptions struct {
	Store           SnapshotStore
	Resolvers       map[string]ColdResolver
	Now             func() time.Time
	InteractiveWait time.Duration
	ResolverTimeout time.Duration
}

type flight struct {
	done   chan struct{}
	result ResolveModelsResult
	err    error
}

type Coordinator struct {
	store           SnapshotStore
	resolvers       map[string]ColdResolver
	resolverMu      sync.RWMutex
	now             func() time.Time
	interactiveWait time.Duration
	resolverTimeout time.Duration
	cache           *memoryCache
	lifecycleMu     sync.RWMutex

	mu      sync.Mutex
	flights map[SnapshotKey]*flight
}

// RegisterResolver permits composition roots to attach host-owned process
// adapters after constructing the shared coordinator.
func (c *Coordinator) RegisterResolver(kind string, resolver ColdResolver) error {
	kind = strings.TrimSpace(kind)
	if kind == "" || resolver == nil {
		return ErrResolverUnavailable
	}
	c.resolverMu.Lock()
	c.resolvers[kind] = resolver
	c.resolverMu.Unlock()
	return nil
}

func NewCoordinator(options CoordinatorOptions) *Coordinator {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	wait := options.InteractiveWait
	if wait <= 0 {
		wait = defaultInteractiveWait
	}
	timeout := options.ResolverTimeout
	if timeout <= 0 {
		timeout = defaultResolverTimeout
	}
	resolvers := make(map[string]ColdResolver, len(options.Resolvers))
	for kind, resolver := range options.Resolvers {
		resolvers[strings.TrimSpace(kind)] = resolver
	}
	return &Coordinator{
		store: options.Store, resolvers: resolvers, now: now,
		interactiveWait: wait, resolverTimeout: timeout,
		cache: newMemoryCache(), flights: make(map[SnapshotKey]*flight),
	}
}

func (c *Coordinator) ResolveModels(ctx context.Context, input ResolveModelsInput) (ResolveModelsResult, error) {
	if err := validateKey(input.Key); err != nil {
		return ResolveModelsResult{}, err
	}
	if !input.Policy.Enabled {
		return ResolveModelsResult{Value: ModelSnapshot{}, Source: SnapshotSourceFallback, Freshness: SnapshotFreshnessFresh}, nil
	}
	if input.ReadPolicy == "" {
		input.ReadPolicy = ReadPolicyInteractive
	}
	if input.ReadPolicy != ReadPolicyWait {
		if result, usable := c.readMemory(input); usable {
			if result.Freshness == SnapshotFreshnessStale && input.ReadPolicy != ReadPolicyCacheOnly {
				c.startRefresh(input)
				result.Refreshing = true
			}
			return result, nil
		}
		if result, usable := c.readDurable(ctx, input); usable {
			if result.Freshness == SnapshotFreshnessStale && input.ReadPolicy != ReadPolicyCacheOnly {
				c.startRefresh(input)
				result.Refreshing = true
			}
			return result, nil
		}
	}
	if input.ReadPolicy == ReadPolicyCacheOnly {
		return c.fallback(input, false), nil
	}

	f := c.startRefresh(input)
	if input.ReadPolicy == ReadPolicyWait {
		select {
		case <-ctx.Done():
			return ResolveModelsResult{}, ctx.Err()
		case <-f.done:
			if f.err == nil {
				return cloneResult(f.result), nil
			}
			return c.fallbackWithError(input, false, f.err), nil
		}
	}
	timer := time.NewTimer(c.interactiveWait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ResolveModelsResult{}, ctx.Err()
	case <-f.done:
		if f.err == nil {
			return cloneResult(f.result), nil
		}
		return c.fallbackWithError(input, false, f.err), nil
	case <-timer.C:
		return c.fallback(input, true), nil
	}
}

func (c *Coordinator) ValidateModel(ctx context.Context, input ResolveModelsInput, model string) error {
	model = strings.TrimSpace(model)
	if model == "" {
		return nil
	}
	// Validation deliberately uses the same key and snapshot coordinator as
	// composer. It does not invoke a second provider-specific path.
	result, err := c.ResolveModels(ctx, input)
	if err != nil {
		return err
	}
	if len(result.Value.Models) == 0 || !result.Value.Complete {
		return nil
	}
	for _, option := range result.Value.Models {
		if option.Value == model {
			return nil
		}
	}
	return fmt.Errorf("%w %q for provider %q", ErrInvalidModel, model, input.Key.ProviderID)
}

func (c *Coordinator) IngestRuntimeSnapshot(ctx context.Context, input RuntimeCatalogSnapshot) error {
	c.lifecycleMu.RLock()
	defer c.lifecycleMu.RUnlock()
	if err := validateKey(input.Key); err != nil {
		return err
	}
	normalized, err := normalizeModels(input.Models)
	if err != nil {
		return err
	}
	if len(normalized.Models) == 0 {
		return ErrInvalidSnapshot
	}
	fetchedAt := input.FetchedAt.UTC()
	if fetchedAt.IsZero() {
		fetchedAt = c.now().UTC()
	}
	stored := StoredSnapshot{Key: input.Key, Models: normalized, Source: SnapshotSourceRuntime, FetchedAt: fetchedAt}
	// Runtime observations remain fresh until replaced/invalidated. Host policy
	// controls whether they are eligible for durable persistence on reads.
	c.cache.writeRuntime(stored)
	return nil
}

func (c *Coordinator) Invalidate(ctx context.Context, input InvalidateInput) error {
	c.lifecycleMu.Lock()
	defer c.lifecycleMu.Unlock()
	c.cache.invalidate(input)
	c.mu.Lock()
	for key := range c.flights {
		if matchesInvalidation(key, input) {
			delete(c.flights, key)
		}
	}
	c.mu.Unlock()
	if c.store != nil {
		return c.store.Delete(ctx, input)
	}
	return nil
}

func (c *Coordinator) readMemory(input ResolveModelsInput) (ResolveModelsResult, bool) {
	c.lifecycleMu.RLock()
	defer c.lifecycleMu.RUnlock()
	stored, ok := c.cache.read(input.Key)
	if !ok {
		return ResolveModelsResult{}, false
	}
	if stored.Source == SnapshotSourceRuntime && !input.Policy.ReuseRuntimeSnapshot {
		return ResolveModelsResult{}, false
	}
	if stored.Source == SnapshotSourceRuntime && input.Policy.RuntimeAuthoritative && !stored.Models.Complete {
		return ResolveModelsResult{}, false
	}
	freshness := classify(stored, c.now().UTC())
	if freshness == SnapshotFreshnessPending {
		return ResolveModelsResult{}, false
	}
	source := stored.Source
	if source != SnapshotSourceRuntime {
		source = SnapshotSourceMemory
	}
	return resultFromStored(stored, source, freshness), true
}

func (c *Coordinator) readDurable(ctx context.Context, input ResolveModelsInput) (ResolveModelsResult, bool) {
	c.lifecycleMu.RLock()
	defer c.lifecycleMu.RUnlock()
	if c.store == nil || !input.Policy.PersistLastGood {
		return ResolveModelsResult{}, false
	}
	generation := c.cache.currentGeneration(input.Key)
	stored, ok, err := c.store.Load(ctx, input.Key)
	if err != nil || !ok {
		return ResolveModelsResult{}, false
	}
	normalized, err := normalizeModels(stored.Models)
	if err != nil || len(normalized.Models) == 0 {
		return ResolveModelsResult{}, false
	}
	stored.Models = normalized
	freshness := classify(stored, c.now().UTC())
	if freshness == SnapshotFreshnessPending {
		return ResolveModelsResult{}, false
	}
	if !c.cache.write(stored, generation) {
		return ResolveModelsResult{}, false
	}
	return resultFromStored(stored, SnapshotSourceDurable, freshness), true
}

func (c *Coordinator) startRefresh(input ResolveModelsInput) *flight {
	c.lifecycleMu.RLock()
	defer c.lifecycleMu.RUnlock()
	c.mu.Lock()
	if existing := c.flights[input.Key]; existing != nil {
		c.mu.Unlock()
		return existing
	}
	f := &flight{done: make(chan struct{})}
	c.flights[input.Key] = f
	generation := c.cache.currentGeneration(input.Key)
	c.mu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), c.resolverTimeout)
		defer cancel()
		f.result, f.err = c.resolveAndStore(ctx, input, generation)
		close(f.done)
		c.mu.Lock()
		if c.flights[input.Key] == f {
			delete(c.flights, input.Key)
		}
		c.mu.Unlock()
	}()
	return f
}

func (c *Coordinator) resolveAndStore(ctx context.Context, input ResolveModelsInput, generation uint64) (ResolveModelsResult, error) {
	c.resolverMu.RLock()
	resolver := c.resolvers[strings.TrimSpace(input.Policy.ColdResolverKind)]
	c.resolverMu.RUnlock()
	if resolver == nil {
		return ResolveModelsResult{}, ErrResolverUnavailable
	}
	snapshot, err := resolver.ResolveModels(ctx, input)
	if err != nil {
		return ResolveModelsResult{}, err
	}
	normalized, err := normalizeModels(snapshot)
	if err != nil {
		return ResolveModelsResult{}, err
	}
	if len(normalized.Models) == 0 {
		return ResolveModelsResult{}, ErrInvalidSnapshot
	}
	now := c.now().UTC()
	stored := StoredSnapshot{
		Key: input.Key, Models: normalized, Source: SnapshotSourceResolver, FetchedAt: now,
		ExpiresAt:  now.Add(nonNegative(input.Policy.FreshTTL)),
		StaleUntil: now.Add(nonNegative(input.Policy.FreshTTL) + nonNegative(input.Policy.MaxStale)),
	}
	c.lifecycleMu.RLock()
	defer c.lifecycleMu.RUnlock()
	if !c.cache.write(stored, generation) {
		return ResolveModelsResult{}, errors.New("agent catalog refresh superseded")
	}
	if c.store != nil && input.Policy.PersistLastGood {
		if err := c.store.Save(ctx, cloneStoredSnapshot(stored)); err != nil {
			// A persistence failure must not hide a valid freshly resolved list.
			return resultFromStored(stored, SnapshotSourceResolver, SnapshotFreshnessFresh), nil
		}
	}
	return resultFromStored(stored, SnapshotSourceResolver, SnapshotFreshnessFresh), nil
}

func (c *Coordinator) fallback(input ResolveModelsInput, refreshing bool) ResolveModelsResult {
	return c.fallbackWithError(input, refreshing, nil)
}

func (c *Coordinator) fallbackWithError(input ResolveModelsInput, refreshing bool, resolverErr error) ResolveModelsResult {
	models, _ := normalizeModels(ModelSnapshot{Models: input.Policy.FallbackModels, Complete: false})
	if len(models.Models) == 0 && strings.TrimSpace(input.SelectedModel) != "" {
		models.Models = []ModelOption{{Value: strings.TrimSpace(input.SelectedModel), Label: strings.TrimSpace(input.SelectedModel), IsDefault: true}}
	}
	result := ResolveModelsResult{Value: models, Source: SnapshotSourceFallback, Freshness: SnapshotFreshnessPending, FetchedAt: c.now().UTC(), Refreshing: refreshing}
	if resolverErr != nil {
		result.ErrorCode = "model_discovery_failed"
	}
	return result
}

func resultFromStored(stored StoredSnapshot, source SnapshotSource, freshness SnapshotFreshness) ResolveModelsResult {
	return ResolveModelsResult{Value: cloneModelSnapshot(stored.Models), Source: source, Freshness: freshness, FetchedAt: stored.FetchedAt}
}

func cloneResult(result ResolveModelsResult) ResolveModelsResult {
	result.Value = cloneModelSnapshot(result.Value)
	return result
}

func nonNegative(value time.Duration) time.Duration {
	if value < 0 {
		return 0
	}
	return value
}
