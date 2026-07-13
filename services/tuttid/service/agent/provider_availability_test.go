package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
)

type fakeAgentProviderStatusLister struct {
	err       error
	input     agentstatusservice.ListInput
	snapshot  agentstatusservice.Snapshot
	callCount int
}

func (f *fakeAgentProviderStatusLister) List(_ context.Context, input agentstatusservice.ListInput) (agentstatusservice.Snapshot, error) {
	f.callCount++
	f.input = input
	if f.err != nil {
		return agentstatusservice.Snapshot{}, f.err
	}
	return f.snapshot, nil
}

func TestServiceListProviderAvailabilityUsesAgentStatusSnapshot(t *testing.T) {
	capturedAt := time.Unix(10, 0).UTC()
	checkedAt := time.Unix(11, 0).UTC()
	lister := &fakeAgentProviderStatusLister{
		snapshot: agentstatusservice.Snapshot{
			CapturedAt: capturedAt,
			Providers: []agentstatusservice.ProviderStatus{{
				Provider: "codex",
				Availability: agentstatusservice.Availability{
					CheckedAt:  &checkedAt,
					ReasonCode: "auth_required",
					Status:     agentstatusservice.AvailabilityAuthRequired,
				},
				CLI: agentstatusservice.CLIStatus{
					Installed:  true,
					BinaryPath: "/usr/local/bin/codex",
				},
				Adapter: agentstatusservice.AdapterStatus{
					Installed:  true,
					BinaryPath: "/usr/local/bin/codex-acp",
				},
				Auth: agentstatusservice.AuthInfo{Status: agentstatusservice.AuthRequired},
			}},
		},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.AvailabilityChecker = AgentStatusProviderAvailabilityChecker{Service: lister}

	availability, err := service.ListProviderAvailability(context.Background(), ProviderAvailabilityInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("ListProviderAvailability returned error: %v", err)
	}
	if lister.callCount != 1 || len(lister.input.Providers) != 1 || lister.input.Providers[0] != "codex" {
		t.Fatalf("status input = %#v, callCount = %d", lister.input, lister.callCount)
	}
	if len(availability) != 1 {
		t.Fatalf("availability len = %d, want 1", len(availability))
	}
	got := availability[0]
	if got.Provider != "codex" || got.Status != ProviderAvailabilityUnavailable {
		t.Fatalf("availability = %#v, want codex unavailable", got)
	}
	if !got.CapturedAt.Equal(checkedAt) {
		t.Fatalf("capturedAt = %s, want %s", got.CapturedAt, checkedAt)
	}
	if got.LastError == nil || got.LastError.Code != "auth_required" {
		t.Fatalf("lastError = %#v, want auth_required", got.LastError)
	}
	if len(got.Checks) != 3 || !got.Checks[0].Passed || !got.Checks[1].Passed || got.Checks[2].Passed {
		t.Fatalf("checks = %#v", got.Checks)
	}
}

func TestServiceListProviderAvailabilityUsesClaudeSDKSidecarDetail(t *testing.T) {
	capturedAt := time.Unix(10, 0).UTC()
	lister := &fakeAgentProviderStatusLister{
		snapshot: agentstatusservice.Snapshot{
			CapturedAt: capturedAt,
			Providers: []agentstatusservice.ProviderStatus{{
				Provider: "claude-code",
				Availability: agentstatusservice.Availability{
					CheckedAt:  &capturedAt,
					ReasonCode: agentstatusservice.ReasonClaudeSDKSidecarUnavailable,
					Status:     agentstatusservice.AvailabilityNotInstalled,
				},
				CLI: agentstatusservice.CLIStatus{
					Installed:  true,
					BinaryPath: "/usr/local/bin/claude",
				},
				Adapter: agentstatusservice.AdapterStatus{Installed: false},
				Auth:    agentstatusservice.AuthInfo{Status: agentstatusservice.AuthAuthenticated},
			}},
		},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.AvailabilityChecker = AgentStatusProviderAvailabilityChecker{Service: lister}

	availability, err := service.ListProviderAvailability(context.Background(), ProviderAvailabilityInput{
		Provider: "claude-code",
	})
	if err != nil {
		t.Fatalf("ListProviderAvailability returned error: %v", err)
	}
	got := availability[0]
	if got.LastError == nil || got.LastError.Message != "Claude SDK sidecar not found" {
		t.Fatalf("lastError = %#v, want SDK sidecar message", got.LastError)
	}
	if len(got.Checks) < 2 || got.Checks[1].Detail != "Claude SDK sidecar not found" {
		t.Fatalf("checks = %#v, want SDK sidecar adapter detail", got.Checks)
	}
}

func TestServiceListProviderAvailabilityUsesShortCache(t *testing.T) {
	capturedAt := time.Unix(10, 0).UTC()
	lister := &fakeAgentProviderStatusLister{
		snapshot: agentstatusservice.Snapshot{
			CapturedAt: capturedAt,
			Providers: []agentstatusservice.ProviderStatus{{
				Provider: "codex",
				Availability: agentstatusservice.Availability{
					CheckedAt: &capturedAt,
					Status:    agentstatusservice.AvailabilityReady,
				},
				CLI: agentstatusservice.CLIStatus{
					Installed:  true,
					BinaryPath: "/usr/local/bin/codex",
				},
				Adapter: agentstatusservice.AdapterStatus{
					Installed:  true,
					BinaryPath: "/usr/local/bin/codex-acp",
				},
				Auth: agentstatusservice.AuthInfo{Status: agentstatusservice.AuthAuthenticated},
			}},
		},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.AvailabilityChecker = AgentStatusProviderAvailabilityChecker{Service: lister}

	first, err := service.ListProviderAvailability(context.Background(), ProviderAvailabilityInput{Provider: "codex"})
	if err != nil {
		t.Fatalf("ListProviderAvailability first returned error: %v", err)
	}
	first[0].Provider = "mutated"
	second, err := service.ListProviderAvailability(context.Background(), ProviderAvailabilityInput{Provider: "codex"})
	if err != nil {
		t.Fatalf("ListProviderAvailability second returned error: %v", err)
	}
	if lister.callCount != 1 {
		t.Fatalf("status lister calls = %d, want 1", lister.callCount)
	}
	if second[0].Provider != "codex" {
		t.Fatalf("cached availability = %#v, want unmutated codex", second[0])
	}
}

func TestServiceListProviderAvailabilityCacheCanBeDisabled(t *testing.T) {
	lister := &fakeAgentProviderStatusLister{
		snapshot: agentstatusservice.Snapshot{
			Providers: []agentstatusservice.ProviderStatus{{
				Provider: "codex",
				Availability: agentstatusservice.Availability{
					Status: agentstatusservice.AvailabilityReady,
				},
			}},
		},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.ProviderAvailabilityCacheTTL = -1
	service.AvailabilityChecker = AgentStatusProviderAvailabilityChecker{Service: lister}

	for i := 0; i < 2; i++ {
		if _, err := service.ListProviderAvailability(context.Background(), ProviderAvailabilityInput{Provider: "codex"}); err != nil {
			t.Fatalf("ListProviderAvailability returned error: %v", err)
		}
	}
	if lister.callCount != 2 {
		t.Fatalf("status lister calls = %d, want 2", lister.callCount)
	}
}

func TestServiceListProviderAvailabilityAcceptsSupportedRuntimeProvider(t *testing.T) {
	lister := &fakeAgentProviderStatusLister{}
	service := newIsolatedAgentService(newFakeRuntime())
	service.AvailabilityChecker = AgentStatusProviderAvailabilityChecker{Service: lister}

	if _, err := service.ListProviderAvailability(context.Background(), ProviderAvailabilityInput{
		Provider: "openclaw",
	}); err != nil {
		t.Fatalf("ListProviderAvailability(openclaw) returned error: %v", err)
	}
	if len(lister.input.Providers) != 1 || lister.input.Providers[0] != "openclaw" {
		t.Fatalf("providers = %#v, want openclaw", lister.input.Providers)
	}
}

func TestServiceListProviderAvailabilityMapsUnsupportedProviderAsUnavailable(t *testing.T) {
	checkedAt := time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
	lister := &fakeAgentProviderStatusLister{
		snapshot: agentstatusservice.Snapshot{
			CapturedAt: checkedAt,
			Providers: []agentstatusservice.ProviderStatus{{
				Provider: "openclaw",
				Availability: agentstatusservice.Availability{
					CheckedAt:  &checkedAt,
					ReasonCode: agentstatusservice.DisabledReasonProviderTemporarilyUnsupported,
					Status:     agentstatusservice.AvailabilityUnsupported,
				},
				Auth: agentstatusservice.AuthInfo{Status: agentstatusservice.AuthUnknown},
			}},
		},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.AvailabilityChecker = AgentStatusProviderAvailabilityChecker{Service: lister}

	availability, err := service.ListProviderAvailability(context.Background(), ProviderAvailabilityInput{
		Provider: "openclaw",
	})
	if err != nil {
		t.Fatalf("ListProviderAvailability returned error: %v", err)
	}
	if len(availability) != 1 {
		t.Fatalf("availability len = %d, want 1", len(availability))
	}
	got := availability[0]
	if got.Provider != "openclaw" || got.Status != ProviderAvailabilityUnavailable {
		t.Fatalf("availability = %#v, want openclaw unavailable", got)
	}
	if got.LastError == nil || got.LastError.Code != agentstatusservice.DisabledReasonProviderTemporarilyUnsupported || got.LastError.Message != "provider is temporarily unsupported" {
		t.Fatalf("lastError = %#v, want temporarily unsupported", got.LastError)
	}
	if len(got.Checks) != 1 || got.Checks[0].Name != "support" || got.Checks[0].Passed {
		t.Fatalf("checks = %#v, want failed support check", got.Checks)
	}
}

func TestServiceListProviderAvailabilityPreservesUnfilteredRegistry(t *testing.T) {
	lister := &fakeAgentProviderStatusLister{}
	service := newIsolatedAgentService(newFakeRuntime())
	service.AvailabilityChecker = AgentStatusProviderAvailabilityChecker{Service: lister}

	if _, err := service.ListProviderAvailability(context.Background(), ProviderAvailabilityInput{}); err != nil {
		t.Fatalf("ListProviderAvailability returned error: %v", err)
	}
	if lister.callCount != 1 {
		t.Fatalf("callCount = %d, want 1", lister.callCount)
	}
	if lister.input.Providers != nil {
		t.Fatalf("providers = %#v, want nil", lister.input.Providers)
	}
}

func TestServiceListProviderAvailabilityMapsInvalidProvider(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())

	if _, err := service.ListProviderAvailability(context.Background(), ProviderAvailabilityInput{
		Provider: "unsupported",
	}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("ListProviderAvailability error = %v, want ErrInvalidArgument", err)
	}
}
