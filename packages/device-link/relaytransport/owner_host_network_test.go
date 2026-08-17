package relaytransport

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestOwnerHostNetworkAdvanceReusesLifecycleAndClosesOldTransport(t *testing.T) {
	relay := newTestOwnerRelay(t)
	defer relay.Close()
	lifecycle := newTestOwnerLifecycle(testOwnerSession(relay.OwnerEndpoint(), "network-owner"))
	events := make(chan OwnerEvent, 32)
	host := newTestOwnerHost(t, lifecycle, StreamHandlerFunc(func(context.Context, net.Conn) error { return nil }), func(cfg *OwnerHostConfig) {
		cfg.Observe = func(event OwnerEvent) { events <- event }
	})
	if err := host.Acquire(context.Background(), "owner"); err != nil {
		t.Fatal(err)
	}
	first := relay.WaitSession(t)
	host.AdvanceNetworkGeneration(2)
	select {
	case <-first.mux.CloseChan():
	case <-time.After(2 * time.Second):
		t.Fatal("old Relay mux was not closed after network generation advance")
	}
	second := relay.WaitSession(t)
	if first == second {
		t.Fatal("network generation advance reused the old Relay session")
	}
	if got := lifecycle.PrepareCount(); got < 2 {
		t.Fatalf("Prepare() count = %d, want at least 2", got)
	}
	if got := lifecycle.ReleaseCount(); got != 0 {
		t.Fatalf("lifecycle Release() count before demand end = %d, want 0", got)
	}

	var networkEnd OwnerEvent
	deadline := time.After(2 * time.Second)
	for networkEnd.EndReason == "" {
		select {
		case event := <-events:
			if event.EndReason == OwnerEndReasonNetworkChanged {
				networkEnd = event
			}
		case <-deadline:
			t.Fatal("network generation end event was not observed")
		}
	}
	if networkEnd.Generation != 2 || networkEnd.Outcome != OwnerOutcomeEnded {
		t.Fatalf("network end event = %#v, want generation 2 ended", networkEnd)
	}
	var generationErr *NetworkGenerationChangedError
	if !errors.As(networkEnd.Error, &generationErr) {
		t.Fatalf("network end error = %T %v, want NetworkGenerationChangedError", networkEnd.Error, networkEnd.Error)
	}
	if generationErr.PreviousGeneration != 1 || generationErr.Generation != 2 {
		t.Fatalf("network generation error = %#v, want 1 -> 2", generationErr)
	}
	if err := host.Release("owner"); err != nil {
		t.Fatal(err)
	}
}

func TestOwnerHostNetworkAdvanceInterruptsBackoffImmediately(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "retry", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	endpoint := "ws" + server.URL[len("http"):]
	lifecycle := newTestOwnerLifecycle(testOwnerSession(endpoint, "backoff-owner"))
	sleepStarted := make(chan struct{})
	var sleepOnce sync.Once
	host := newTestOwnerHost(t, lifecycle, StreamHandlerFunc(func(context.Context, net.Conn) error { return nil }), func(cfg *OwnerHostConfig) {
		cfg.Sleep = func(ctx context.Context, _ time.Duration) error {
			sleepOnce.Do(func() { close(sleepStarted) })
			<-ctx.Done()
			return ctx.Err()
		}
	})
	if err := host.Acquire(context.Background(), "owner"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-sleepStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("owner host did not enter retry backoff")
	}
	started := time.Now()
	host.AdvanceNetworkGeneration(2)
	deadline := time.After(500 * time.Millisecond)
	for lifecycle.PrepareCount() < 2 {
		select {
		case <-deadline:
			t.Fatal("network generation advance did not interrupt retry backoff")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if elapsed := time.Since(started); elapsed >= 500*time.Millisecond {
		t.Fatalf("retry after network generation took %s", elapsed)
	}
	if err := host.Release("owner"); err != nil {
		t.Fatal(err)
	}
}

func TestOwnerHostIgnoresConcurrentOlderNetworkGenerations(t *testing.T) {
	lifecycle := newTestOwnerLifecycle(OwnerSession{Key: "generation-owner"})
	prepared := make(chan OwnerEvent, 1)
	host := newTestOwnerHost(t, lifecycle, StreamHandlerFunc(func(context.Context, net.Conn) error { return nil }), func(cfg *OwnerHostConfig) {
		cfg.Observe = func(event OwnerEvent) {
			if event.Phase == OwnerPhasePrepare {
				prepared <- event
			}
		}
		cfg.Sleep = func(ctx context.Context, _ time.Duration) error {
			<-ctx.Done()
			return ctx.Err()
		}
	})
	var group sync.WaitGroup
	for generation := uint64(2); generation <= 64; generation++ {
		generation := generation
		group.Add(1)
		go func() {
			defer group.Done()
			host.AdvanceNetworkGeneration(generation)
		}()
	}
	group.Wait()
	if err := host.Acquire(context.Background(), "owner"); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = host.Release("owner") }()
	select {
	case event := <-prepared:
		if event.Generation != 64 {
			t.Fatalf("prepare generation = %d, want 64", event.Generation)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("owner host did not prepare after concurrent generation updates")
	}
	host.AdvanceNetworkGeneration(63)
	if lifecycle.PrepareCount() != 1 {
		t.Fatalf("older generation caused another Prepare() call: %d", lifecycle.PrepareCount())
	}
}
