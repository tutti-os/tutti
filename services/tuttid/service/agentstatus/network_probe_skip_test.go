package agentstatus

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"sync/atomic"
	"testing"
)

// The network connectivity probe is opt-in. Without IncludeNetwork, List is
// purely local — no network call and no Network on the result — so the dock /
// startup path never blocks on a slow or black-holed network. With
// IncludeNetwork it probes, except for a provider mid-install (the network
// doesn't change during an install, so re-probing a flaky proxy on every
// progress poll would flicker).
func TestListNetworkProbeIsOptIn(t *testing.T) {
	const provider = "codex"

	// Force a clean active-action baseline for this provider.
	resetCtx := withActiveActionToken(context.Background(), nextActiveActionToken())
	claimActiveAction(resetCtx, provider, ActiveAction{})
	clearActiveAction(resetCtx, provider)

	// Atomic because the registry ranking probe hits the transport from one
	// goroutine per registry concurrently.
	var networkCalls atomic.Int64
	newService := func() Service {
		s := testService(func(_ string) (string, error) {
			return "", errors.New("not found")
		}, map[string]bool{})
		s.HTTPClient = &http.Client{Transport: networkRoundTripFunc(func(*http.Request) (*http.Response, error) {
			networkCalls.Add(1)
			return &http.Response{StatusCode: http.StatusNoContent, Body: http.NoBody}, nil
		})}
		s.ResolveProxy = func(*http.Request) (*url.URL, error) { return nil, nil }
		return s
	}

	// Default (IncludeNetwork=false): local-only. No network call, no Network,
	// but full local availability is still resolved.
	networkCalls.Store(0)
	local, err := newService().List(context.Background(), ListInput{Providers: []string{provider}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(local.Providers) != 1 {
		t.Fatalf("local: providers = %#v, want 1", local.Providers)
	}
	if calls := networkCalls.Load(); calls != 0 {
		t.Fatalf("local: network probed %d times, want 0", calls)
	}
	if local.Providers[0].Network != nil {
		t.Fatalf("local: Network = %#v, want nil (probe not requested)", local.Providers[0].Network)
	}
	if local.Providers[0].Availability.Status == "" {
		t.Fatal("local: Availability is empty, want local availability resolved")
	}

	// IncludeNetwork=true, not installing: List probes the network.
	networkCalls.Store(0)
	probed, err := newService().List(context.Background(), ListInput{
		Providers:      []string{provider},
		IncludeNetwork: true,
	})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if probed.Providers[0].Network == nil {
		t.Fatalf("opted-in: Network = nil, want probed")
	}
	if networkCalls.Load() == 0 {
		t.Fatal("opted-in: expected the network to be probed")
	}

	// IncludeNetwork=true, but a running install action: skip the probe.
	installCtx := withActiveActionToken(context.Background(), nextActiveActionToken())
	claimActiveAction(installCtx, provider, ActiveAction{
		ID:     ActionInstall,
		Status: "running",
		Step:   "adapter",
	})
	t.Cleanup(func() { clearActiveAction(installCtx, provider) })

	networkCalls.Store(0)
	installing, err := newService().List(context.Background(), ListInput{
		Providers:      []string{provider},
		IncludeNetwork: true,
	})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if installing.Providers[0].Network != nil {
		t.Fatalf("installing: Network = %#v, want nil (probe skipped)", installing.Providers[0].Network)
	}
	if calls := networkCalls.Load(); calls != 0 {
		t.Fatalf("installing: network probed %d times, want 0", calls)
	}
	if installing.Providers[0].ActiveAction == nil {
		t.Fatal("installing: ActiveAction = nil, want the running install action surfaced")
	}
}
