package api

import (
	"context"
	"net/http"
	"testing"
	"time"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
)

type stubAgentStatusService struct {
	listFn      func(context.Context, agentstatusservice.ListInput) (agentstatusservice.Snapshot, error)
	probeFn     func(context.Context, agentstatusservice.ProbeInput) (agentstatusservice.ProbeResult, error)
	runActionFn func(context.Context, agentstatusservice.RunActionInput) (agentstatusservice.RunActionResult, error)
}

func (s stubAgentStatusService) List(ctx context.Context, input agentstatusservice.ListInput) (agentstatusservice.Snapshot, error) {
	if s.listFn == nil {
		return agentstatusservice.Snapshot{}, nil
	}
	return s.listFn(ctx, input)
}

func (s stubAgentStatusService) Probe(ctx context.Context, input agentstatusservice.ProbeInput) (agentstatusservice.ProbeResult, error) {
	if s.probeFn == nil {
		return agentstatusservice.ProbeResult{}, nil
	}
	return s.probeFn(ctx, input)
}

func (s stubAgentStatusService) RunAction(ctx context.Context, input agentstatusservice.RunActionInput) (agentstatusservice.RunActionResult, error) {
	if s.runActionFn == nil {
		return agentstatusservice.RunActionResult{}, nil
	}
	return s.runActionFn(ctx, input)
}

func TestDaemonAPIRoutesAgentProviderStatuses(t *testing.T) {
	capturedAt := time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentStatusService: stubAgentStatusService{
			listFn: func(_ context.Context, input agentstatusservice.ListInput) (agentstatusservice.Snapshot, error) {
				if len(input.Providers) != 1 || input.Providers[0] != "claude-code" {
					t.Fatalf("providers = %#v, want [claude-code]", input.Providers)
				}
				if !input.ForceRefresh {
					t.Fatal("ForceRefresh = false, want true")
				}
				if !input.IncludeUpdates {
					t.Fatal("IncludeUpdates = false, want true")
				}
				if !input.RefreshUpdates {
					t.Fatal("RefreshUpdates = false, want true")
				}
				updateAvailable := true
				return agentstatusservice.Snapshot{
					CapturedAt: capturedAt,
					Providers: []agentstatusservice.ProviderStatus{{
						ActiveAction: &agentstatusservice.ActiveAction{
							ID:       agentstatusservice.ActionInstall,
							Status:   "running",
							Step:     "adapter",
							Registry: "https://registry.example.test",
							Stdout:   "installing adapter\nstill installing",
						},
						Actions: []agentstatusservice.Action{{
							ID:   agentstatusservice.ActionRefresh,
							Kind: agentstatusservice.ActionKindRefresh,
						}},
						Auth: agentstatusservice.AuthInfo{
							Status: agentstatusservice.AuthUnknown,
						},
						Availability: agentstatusservice.Availability{
							Status: agentstatusservice.AvailabilityUnknown,
						},
						CLI: agentstatusservice.CLIStatus{
							Installed: true,
						},
						Update: agentstatusservice.UpdateStatus{
							Capability:      agentstatusservice.UpdateCapabilitySupported,
							Source:          agentstatusservice.UpdateSourceNPM,
							CurrentVersion:  "1.0.0",
							LatestVersion:   "1.1.0",
							UpdateAvailable: &updateAvailable,
							LastCheckedAt:   &capturedAt,
						},
						Provider: "claude-code",
					}},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/agent-providers/status?providers=claude-code&includeUpdates=true&refreshUpdates=true&refresh=true", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.AgentProviderStatusListResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if !response.CapturedAt.Equal(capturedAt) {
		t.Fatalf("capturedAt = %s, want %s", response.CapturedAt, capturedAt)
	}
	if len(response.Providers) != 1 {
		t.Fatalf("providers length = %d, want 1", len(response.Providers))
	}
	if response.Providers[0].Provider != "claude-code" {
		t.Fatalf("provider = %q, want claude-code", response.Providers[0].Provider)
	}
	activeAction := response.Providers[0].ActiveAction
	if activeAction == nil {
		t.Fatal("activeAction = nil, want install progress")
	}
	if activeAction.Phase != tuttigenerated.AgentProviderActiveActionPhaseInstall {
		t.Fatalf("activeAction.phase = %q, want install", activeAction.Phase)
	}
	if activeAction.Registry == nil || *activeAction.Registry != "https://registry.example.test" {
		t.Fatalf("activeAction.registry = %#v, want registry", activeAction.Registry)
	}
	if len(activeAction.Log) != 2 || activeAction.Log[0] != "installing adapter" {
		t.Fatalf("activeAction.log = %#v, want split installer stdout", activeAction.Log)
	}
	update := response.Providers[0].Update
	if update.Capability != tuttigenerated.AgentProviderUpdateCapabilitySupported || update.Source == nil || *update.Source != tuttigenerated.AgentProviderUpdateSourceNpm ||
		update.CurrentVersion == nil || *update.CurrentVersion != "1.0.0" || update.LatestVersion == nil || *update.LatestVersion != "1.1.0" ||
		update.UpdateAvailable == nil || !*update.UpdateAvailable || update.LastCheckedAt == nil {
		t.Fatalf("update = %#v", update)
	}
}

func TestDaemonAPIRoutesUnsupportedAgentProviderStatus(t *testing.T) {
	capturedAt := time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentStatusService: stubAgentStatusService{
			listFn: func(_ context.Context, input agentstatusservice.ListInput) (agentstatusservice.Snapshot, error) {
				if len(input.Providers) != 1 || input.Providers[0] != "hermes" {
					t.Fatalf("providers = %#v, want [hermes]", input.Providers)
				}
				checkedAt := capturedAt
				return agentstatusservice.Snapshot{
					CapturedAt: capturedAt,
					Providers: []agentstatusservice.ProviderStatus{{
						Actions: []agentstatusservice.Action{},
						Auth: agentstatusservice.AuthInfo{
							Status: agentstatusservice.AuthUnknown,
						},
						Availability: agentstatusservice.Availability{
							CheckedAt:  &checkedAt,
							ReasonCode: agentstatusservice.DisabledReasonProviderTemporarilyUnsupported,
							Status:     agentstatusservice.AvailabilityUnsupported,
						},
						Adapter: agentstatusservice.AdapterStatus{
							Installed: false,
						},
						CLI: agentstatusservice.CLIStatus{
							Installed: false,
						},
						Provider: "hermes",
					}},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/agent-providers/status?providers=hermes", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.AgentProviderStatusListResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if len(response.Providers) != 1 {
		t.Fatalf("providers length = %d, want 1", len(response.Providers))
	}
	status := response.Providers[0]
	if status.Provider != tuttigenerated.WorkspaceAgentProvider("hermes") {
		t.Fatalf("provider = %q, want hermes", status.Provider)
	}
	if status.Availability.Status != tuttigenerated.AgentProviderAvailabilityStatusUnsupported {
		t.Fatalf("availability = %q, want unsupported", status.Availability.Status)
	}
	if status.Availability.ReasonCode == nil || *status.Availability.ReasonCode != agentstatusservice.DisabledReasonProviderTemporarilyUnsupported {
		t.Fatalf("reasonCode = %#v, want temporarily unsupported", status.Availability.ReasonCode)
	}
	if status.Cli.Installed || status.Adapter.Installed {
		t.Fatalf("status = %#v, want CLI and adapter not installed", status)
	}
	if len(status.Actions) != 0 {
		t.Fatalf("actions = %#v, want none", status.Actions)
	}
}

func TestDaemonAPIRoutesAgentProviderAuthIncludesAuthMethod(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentStatusService: stubAgentStatusService{
			listFn: func(_ context.Context, input agentstatusservice.ListInput) (agentstatusservice.Snapshot, error) {
				if len(input.Providers) != 1 || input.Providers[0] != "claude-code" {
					t.Fatalf("providers = %#v, want [claude-code]", input.Providers)
				}
				return agentstatusservice.Snapshot{
					Providers: []agentstatusservice.ProviderStatus{{
						Actions: []agentstatusservice.Action{},
						Auth: agentstatusservice.AuthInfo{
							Status:       agentstatusservice.AuthAuthenticated,
							AccountLabel: "API Usage Billing",
							AuthMethod:   "apiKey",
						},
						Availability: agentstatusservice.Availability{
							Status: agentstatusservice.AvailabilityReady,
						},
						CLI:      agentstatusservice.CLIStatus{Installed: true, BinaryPath: "/usr/local/bin/claude"},
						Adapter:  agentstatusservice.AdapterStatus{Installed: true},
						Provider: "claude-code",
					}},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/agent-providers/status?providers=claude-code", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.AgentProviderStatusListResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if len(response.Providers) != 1 {
		t.Fatalf("providers length = %d, want 1", len(response.Providers))
	}
	auth := response.Providers[0].Auth
	if auth.Status != tuttigenerated.AgentProviderAuthStatusAuthenticated {
		t.Fatalf("auth status = %q, want authenticated", auth.Status)
	}
	if auth.AccountLabel == nil || *auth.AccountLabel != "API Usage Billing" {
		t.Fatalf("accountLabel = %#v, want API Usage Billing", auth.AccountLabel)
	}
	if auth.AuthMethod == nil || *auth.AuthMethod != "apiKey" {
		t.Fatalf("authMethod = %#v, want apiKey", auth.AuthMethod)
	}
}

func TestDaemonAPIRoutesAgentProviderProbe(t *testing.T) {
	checkedAt := time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentStatusService: stubAgentStatusService{
			probeFn: func(_ context.Context, input agentstatusservice.ProbeInput) (agentstatusservice.ProbeResult, error) {
				if input.Provider != "codex" {
					t.Fatalf("provider = %q, want codex", input.Provider)
				}
				return agentstatusservice.ProbeResult{
					Provider:   "codex",
					Status:     agentstatusservice.ProbeFailed,
					CheckedAt:  checkedAt,
					ReasonCode: "probe_exited",
					Message:    "adapter boom",
					BinaryPath: "/usr/local/bin/codex-acp",
					Command:    []string{"/usr/local/bin/codex-acp"},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-providers/codex/probe", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.AgentProviderProbeResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Status != tuttigenerated.AgentProviderProbeStatusFailed {
		t.Fatalf("status = %q, want failed", response.Status)
	}
	if response.ReasonCode == nil || *response.ReasonCode != "probe_exited" {
		t.Fatalf("reasonCode = %#v, want probe_exited", response.ReasonCode)
	}
	if response.Message == nil || *response.Message != "adapter boom" {
		t.Fatalf("message = %#v, want adapter boom", response.Message)
	}
}

func TestDaemonAPIRoutesRunAgentProviderAction(t *testing.T) {
	completedAt := time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentStatusService: stubAgentStatusService{
			runActionFn: func(_ context.Context, input agentstatusservice.RunActionInput) (agentstatusservice.RunActionResult, error) {
				if input.Provider != "codex" {
					t.Fatalf("provider = %q, want codex", input.Provider)
				}
				if input.ActionID != agentstatusservice.ActionInstall {
					t.Fatalf("actionID = %q, want install", input.ActionID)
				}
				return agentstatusservice.RunActionResult{
					Provider:    "codex",
					ActionID:    agentstatusservice.ActionInstall,
					Status:      agentstatusservice.RunActionFailed,
					CompletedAt: completedAt,
					ReasonCode:  "post_install_probe_failed",
					Message:     "adapter boom",
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-providers/codex/actions/install/run", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.AgentProviderActionRunResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Status != tuttigenerated.AgentProviderActionRunStatusFailed {
		t.Fatalf("status = %q, want failed", response.Status)
	}
	if response.ReasonCode == nil || *response.ReasonCode != "post_install_probe_failed" {
		t.Fatalf("reasonCode = %#v, want post_install_probe_failed", response.ReasonCode)
	}
	if response.Message == nil || *response.Message != "adapter boom" {
		t.Fatalf("message = %#v, want adapter boom", response.Message)
	}
}

func TestDaemonAPIRoutesRunAgentProviderUpdateAction(t *testing.T) {
	completedAt := time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentStatusService: stubAgentStatusService{
			runActionFn: func(_ context.Context, input agentstatusservice.RunActionInput) (agentstatusservice.RunActionResult, error) {
				if input.Provider != "tutti-agent" || input.ActionID != agentstatusservice.ActionUpdate {
					t.Fatalf("input = %#v, want tutti-agent update", input)
				}
				return agentstatusservice.RunActionResult{
					Provider:    "tutti-agent",
					ActionID:    agentstatusservice.ActionUpdate,
					Status:      agentstatusservice.RunActionCompleted,
					CompletedAt: completedAt,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-providers/tutti-agent/actions/update/run", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	var response tuttigenerated.AgentProviderActionRunResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.ActionID != tuttigenerated.AgentProviderActionIDUpdate || response.Status != tuttigenerated.AgentProviderActionRunStatusCompleted {
		t.Fatalf("response = %#v", response)
	}
}
