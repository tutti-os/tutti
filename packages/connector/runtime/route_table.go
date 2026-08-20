package runtime

import (
	"errors"
	"fmt"
	"sync"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

// ManagedRoute is the host-neutral lifecycle contract owned by RouteTable.
// Product adapters attach their protocol-specific capability payloads to an
// implementation while the runtime owns generation fencing and replacement.
type ManagedRoute interface {
	RouteID() string
	RouteGeneration() market.HostGeneration
	RouteReleaseDigest() string
	Fence()
	Close(time.Time) error
}

// RouteTable atomically publishes one generation-fenced route per connection
// and connector. It is reusable by any daemon embedding connector/runtime.
type RouteTable struct {
	mu          sync.RWMutex
	routes      map[string]ManagedRoute
	retiring    map[string]ManagedRoute
	fences      map[string]market.HostGeneration
	transitions map[string]*sync.Mutex
	published   bool
	closed      bool
}

func NewRouteTable() *RouteTable {
	return &RouteTable{routes: make(map[string]ManagedRoute), retiring: make(map[string]ManagedRoute), fences: make(map[string]market.HostGeneration),
		transitions: make(map[string]*sync.Mutex), published: true}
}

func (table *RouteTable) SetPublished(enabled bool) {
	table.mu.Lock()
	table.published = enabled
	table.mu.Unlock()
}

func (table *RouteTable) PublishedRoutes() []ManagedRoute {
	table.mu.RLock()
	defer table.mu.RUnlock()
	if !table.published {
		return nil
	}
	routes := make([]ManagedRoute, 0, len(table.routes))
	for _, route := range table.routes {
		routes = append(routes, route)
	}
	return routes
}

func (table *RouteTable) IsCurrent(route ManagedRoute) bool {
	if table == nil || route == nil {
		return false
	}
	table.mu.RLock()
	defer table.mu.RUnlock()
	return table.routes[route.RouteID()] == route
}

func (table *RouteTable) Route(key string) ManagedRoute {
	if table == nil {
		return nil
	}
	table.mu.RLock()
	defer table.mu.RUnlock()
	if route := table.routes[key]; route != nil {
		return route
	}
	return table.retiring[key]
}

func (table *RouteTable) Commit(next ManagedRoute) error {
	if table == nil || next == nil {
		return errors.New("connector runtime route is required")
	}
	key := next.RouteID()
	transition := table.transition(key)
	transition.Lock()
	defer transition.Unlock()

	table.mu.Lock()
	if table.closed {
		table.mu.Unlock()
		return errors.New("connector runtime route table is closed")
	}
	generation := next.RouteGeneration()
	if fence, exists := table.fences[key]; exists && fence.BootEpoch == generation.BootEpoch && generation.Generation <= fence.Generation {
		table.mu.Unlock()
		return errors.New("connector runtime reconcile generation is fenced")
	}
	current := table.routes[key]
	retiring := table.retiring[key]
	if current != nil && !newerOrEqualGeneration(generation, current.RouteGeneration()) {
		table.mu.Unlock()
		return errors.New("connector runtime reconcile generation is stale")
	}
	table.mu.Unlock()

	// Finish older cleanup debt before creating another retired generation.
	// The current published route remains available throughout this wait.
	if retiring != nil {
		if err := retiring.Close(time.Now().Add(3 * time.Second)); err != nil {
			return fmt.Errorf("retire previous connector route: %w", err)
		}
		table.mu.Lock()
		if table.retiring[key] == retiring {
			delete(table.retiring, key)
		}
		table.mu.Unlock()
	}

	table.mu.Lock()
	if table.closed || table.routes[key] != current {
		table.mu.Unlock()
		return errors.New("connector runtime route changed while committing")
	}
	// Publish the ready candidate before fencing the previous route. Consumers
	// therefore always see old or next; close failure is cleanup debt, not an
	// availability gap.
	table.routes[key] = next
	if current != nil {
		table.retiring[key] = current
		current.Fence()
	}
	table.mu.Unlock()
	if current != nil {
		if err := current.Close(time.Now().Add(3 * time.Second)); err != nil {
			return fmt.Errorf("retire previous connector route: %w", err)
		}
		table.mu.Lock()
		if table.retiring[key] == current {
			delete(table.retiring, key)
		}
		table.mu.Unlock()
	}
	return nil
}

func (table *RouteTable) Remove(key string, generation market.HostGeneration, releaseDigest string, deadline time.Time) error {
	if table == nil {
		return nil
	}
	transition := table.transition(key)
	transition.Lock()
	defer transition.Unlock()
	table.mu.Lock()
	current := table.routes[key]
	if current == nil {
		current = table.retiring[key]
	}
	if current == nil {
		table.advanceFenceLocked(key, generation)
		table.mu.Unlock()
		return nil
	}
	if releaseDigest != "" && current.RouteReleaseDigest() != releaseDigest {
		table.mu.Unlock()
		return errors.New("connector runtime deactivation release digest does not match active route")
	}
	currentGeneration := current.RouteGeneration()
	if generation.BootEpoch != currentGeneration.BootEpoch {
		table.mu.Unlock()
		return errors.New("connector runtime deactivation boot epoch does not match active route")
	}
	if generation.Generation < currentGeneration.Generation {
		table.mu.Unlock()
		return nil
	}
	delete(table.routes, key)
	table.retiring[key] = current
	table.advanceFenceLocked(key, generation)
	current.Fence()
	table.mu.Unlock()
	if err := current.Close(deadline); err != nil {
		return err
	}
	table.mu.Lock()
	if table.retiring[key] == current {
		delete(table.retiring, key)
	}
	table.mu.Unlock()
	return nil
}

// RemoveMatching fences and closes every route selected from a stable snapshot.
// Callers that need to exclude concurrent commits must serialize their host
// lifecycle mutations around this method.
func (table *RouteTable) RemoveMatching(
	match func(ManagedRoute) bool,
	generation market.HostGeneration,
	deadline time.Time,
) error {
	if table == nil || match == nil {
		return nil
	}
	table.mu.RLock()
	targets := make([]ManagedRoute, 0)
	seen := make(map[string]struct{})
	for _, routes := range []map[string]ManagedRoute{table.routes, table.retiring} {
		for _, route := range routes {
			if _, exists := seen[route.RouteID()]; exists || !match(route) {
				continue
			}
			seen[route.RouteID()] = struct{}{}
			targets = append(targets, route)
		}
	}
	table.mu.RUnlock()
	var errs []error
	for _, route := range targets {
		errs = append(errs, table.Remove(route.RouteID(), generation, route.RouteReleaseDigest(), deadline))
	}
	return errors.Join(errs...)
}

func (table *RouteTable) RetireExact(route ManagedRoute, deadline time.Time) error {
	if table == nil || route == nil {
		return nil
	}
	transition := table.transition(route.RouteID())
	transition.Lock()
	defer transition.Unlock()
	table.mu.Lock()
	if table.routes[route.RouteID()] != route && table.retiring[route.RouteID()] != route {
		table.mu.Unlock()
		return nil
	}
	delete(table.routes, route.RouteID())
	table.retiring[route.RouteID()] = route
	route.Fence()
	table.mu.Unlock()
	if err := route.Close(deadline); err != nil {
		return err
	}
	table.mu.Lock()
	if table.retiring[route.RouteID()] == route {
		delete(table.retiring, route.RouteID())
	}
	table.mu.Unlock()
	return nil
}

func (table *RouteTable) FenceAll(deadline time.Time) error {
	if table == nil {
		return nil
	}
	table.mu.RLock()
	targets := make([]ManagedRoute, 0, len(table.routes))
	for _, route := range table.routes {
		targets = append(targets, route)
	}
	for _, route := range table.retiring {
		targets = append(targets, route)
	}
	table.mu.RUnlock()
	var errs []error
	for _, route := range targets {
		errs = append(errs, table.Remove(route.RouteID(), route.RouteGeneration(), route.RouteReleaseDigest(), deadline))
	}
	return errors.Join(errs...)
}

func (table *RouteTable) Close(deadline time.Time) error {
	if table == nil {
		return nil
	}
	table.mu.Lock()
	table.closed = true
	table.published = false
	routes := make([]ManagedRoute, 0, len(table.routes))
	for key, route := range table.routes {
		delete(table.routes, key)
		table.retiring[key] = route
		route.Fence()
		routes = append(routes, route)
	}
	for _, route := range table.retiring {
		if !containsRoute(routes, route) {
			routes = append(routes, route)
		}
	}
	table.mu.Unlock()
	var errs []error
	for _, route := range routes {
		errs = append(errs, route.Close(deadline))
	}
	return errors.Join(errs...)
}

func containsRoute(routes []ManagedRoute, wanted ManagedRoute) bool {
	for _, route := range routes {
		if route == wanted {
			return true
		}
	}
	return false
}

func (table *RouteTable) transition(key string) *sync.Mutex {
	table.mu.Lock()
	defer table.mu.Unlock()
	transition := table.transitions[key]
	if transition == nil {
		transition = &sync.Mutex{}
		table.transitions[key] = transition
	}
	return transition
}

func (table *RouteTable) advanceFenceLocked(key string, generation market.HostGeneration) {
	current, exists := table.fences[key]
	if !exists || current.BootEpoch != generation.BootEpoch || generation.Generation > current.Generation {
		table.fences[key] = generation
	}
}

func newerOrEqualGeneration(candidate, current market.HostGeneration) bool {
	return candidate.BootEpoch == current.BootEpoch && candidate.Generation >= current.Generation
}
