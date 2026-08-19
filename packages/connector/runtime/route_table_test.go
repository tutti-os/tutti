package runtime

import (
	"errors"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

type routeTableStub struct {
	id         string
	digest     string
	generation market.HostGeneration
	closeErrs  int
	closeCalls int
	fenced     bool
}

func (route *routeTableStub) RouteID() string                        { return route.id }
func (route *routeTableStub) RouteGeneration() market.HostGeneration { return route.generation }
func (route *routeTableStub) RouteReleaseDigest() string             { return route.digest }
func (route *routeTableStub) Fence()                                 { route.fenced = true }
func (route *routeTableStub) Close(time.Time) error {
	route.closeCalls++
	if route.closeErrs > 0 {
		route.closeErrs--
		return errors.New("close failed")
	}
	return nil
}

func TestRouteTableRetainsFencedRouteUntilCloseRetrySucceeds(t *testing.T) {
	table := NewRouteTable()
	generation := market.HostGeneration{BootEpoch: "boot-1", Generation: 2}
	route := &routeTableStub{id: "workspace\x00github", digest: "release-1", generation: generation, closeErrs: 1}
	if err := table.Commit(route); err != nil {
		t.Fatal(err)
	}
	if err := table.Remove(route.id, generation, route.digest, time.Now().Add(time.Second)); err == nil {
		t.Fatal("first close unexpectedly succeeded")
	}
	if !route.fenced || table.IsCurrent(route) || len(table.PublishedRoutes()) != 0 {
		t.Fatalf("failed close remained published: fenced=%v current=%v", route.fenced, table.IsCurrent(route))
	}
	if err := table.Remove(route.id, generation, route.digest, time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if route.closeCalls != 2 || table.Route(route.id) != nil {
		t.Fatalf("close calls=%d retained=%v", route.closeCalls, table.Route(route.id) != nil)
	}
}

func TestRouteTableRejectsGenerationAtOrBehindFence(t *testing.T) {
	table := NewRouteTable()
	generation := market.HostGeneration{BootEpoch: "boot-1", Generation: 4}
	if err := table.Remove("workspace\x00github", generation, "", time.Time{}); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []uint64{3, 4} {
		route := &routeTableStub{id: "workspace\x00github", digest: "release-1", generation: market.HostGeneration{BootEpoch: "boot-1", Generation: candidate}}
		if err := table.Commit(route); err == nil {
			t.Fatalf("generation %d unexpectedly crossed fence", candidate)
		}
	}
}

func TestRouteTablePublishesReadyCandidateBeforeOldRouteCleanup(t *testing.T) {
	table := NewRouteTable()
	key := "workspace\x00github"
	old := &routeTableStub{id: key, digest: "release-1", generation: market.HostGeneration{BootEpoch: "boot-1", Generation: 1}, closeErrs: 1}
	next := &routeTableStub{id: key, digest: "release-2", generation: market.HostGeneration{BootEpoch: "boot-1", Generation: 2}}
	if err := table.Commit(old); err != nil {
		t.Fatal(err)
	}
	if err := table.Commit(next); err == nil {
		t.Fatal("old route cleanup failure was not reported")
	}
	if table.Route(key) != next || !table.IsCurrent(next) || old.fenced == false {
		t.Fatalf("candidate was not retained after cleanup failure: current=%v oldFenced=%t", table.Route(key) == next, old.fenced)
	}
}

func TestRouteTableRemoveMatchingClosesEverySelectedConnection(t *testing.T) {
	table := NewRouteTable()
	generation := market.HostGeneration{BootEpoch: "boot-1", Generation: 4}
	first := &routeTableStub{id: "connection-a\x00github", digest: "release-1", generation: generation}
	second := &routeTableStub{id: "connection-b\x00github", digest: "release-1", generation: generation}
	unrelated := &routeTableStub{id: "connection-a\x00notion", digest: "release-2", generation: generation}
	for _, route := range []*routeTableStub{first, second, unrelated} {
		if err := table.Commit(route); err != nil {
			t.Fatal(err)
		}
	}
	if err := table.RemoveMatching(func(route ManagedRoute) bool {
		return route.RouteReleaseDigest() == "release-1"
	}, generation, time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if table.Route(first.id) != nil || table.Route(second.id) != nil || first.closeCalls != 1 || second.closeCalls != 1 {
		t.Fatalf("matching routes were not closed: first=%d second=%d", first.closeCalls, second.closeCalls)
	}
	if table.Route(unrelated.id) != unrelated || unrelated.closeCalls != 0 {
		t.Fatalf("unrelated route changed: route=%v closes=%d", table.Route(unrelated.id), unrelated.closeCalls)
	}
}
