package api

import (
	"context"
	"net/http"
	"reflect"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
)

func TestDaemonAPIRoutesWorkspaceAppAgentProviderStatusesDefaultToEnabledAgentTargets(t *testing.T) {
	t.Parallel()

	var capturedProviders []string
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentStatusService: stubAgentStatusService{
			listFn: func(_ context.Context, input agentstatusservice.ListInput) (agentstatusservice.Snapshot, error) {
				capturedProviders = append([]string(nil), input.Providers...)
				return agentstatusservice.Snapshot{
					Providers: []agentstatusservice.ProviderStatus{
						{Provider: "codex"},
						{Provider: "opencode"},
					},
				}, nil
			},
		},
		AgentTargetService: stubAgentTargetService{
			listFn: func(context.Context) ([]agenttargetbiz.Target, error) {
				return []agenttargetbiz.Target{
					{
						ID:            agenttargetbiz.IDLocalCodex,
						Provider:      "codex",
						LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
						Name:          "Codex",
						Enabled:       true,
						Source:        agenttargetbiz.SourceSystem,
					},
					{
						ID:            "local:hermes",
						Provider:      "hermes",
						LaunchRefJSON: `{"type":"local_cli","provider":"hermes"}`,
						Name:          "Hermes",
						Enabled:       true,
						Source:        agenttargetbiz.SourceSystem,
					},
					{
						ID:            agenttargetbiz.IDLocalCursor,
						Provider:      "cursor",
						LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("cursor"),
						Name:          "Cursor",
						Enabled:       false,
						Source:        agenttargetbiz.SourceSystem,
					},
					{
						ID:            agenttargetbiz.IDLocalOpenCode,
						Provider:      "opencode",
						LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("opencode"),
						Name:          "OpenCode",
						Enabled:       true,
						Source:        agenttargetbiz.SourceSystem,
					},
				}, nil
			},
		},
		AppCenterService: installedWorkspaceAppCenter("canvas"),
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/apps/canvas/agent-providers/status",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if !reflect.DeepEqual(capturedProviders, []string{"codex", "opencode"}) {
		t.Fatalf("providers = %#v, want [codex opencode]", capturedProviders)
	}

	var response tuttigenerated.AgentProviderStatusListResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	gotProviders := make([]string, 0, len(response.Providers))
	for _, provider := range response.Providers {
		gotProviders = append(gotProviders, string(provider.Provider))
	}
	if !reflect.DeepEqual(gotProviders, []string{"codex", "opencode"}) {
		t.Fatalf("response providers = %#v, want [codex opencode]", gotProviders)
	}
}

func TestDaemonAPIRoutesWorkspaceAppAgentProviderStatusesNarrowExplicitProvidersToAgentTargets(t *testing.T) {
	t.Parallel()

	var capturedProviders []string
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentStatusService: stubAgentStatusService{
			listFn: func(_ context.Context, input agentstatusservice.ListInput) (agentstatusservice.Snapshot, error) {
				capturedProviders = append([]string(nil), input.Providers...)
				return agentstatusservice.Snapshot{
					Providers: []agentstatusservice.ProviderStatus{{Provider: "codex"}},
				}, nil
			},
		},
		AgentTargetService: stubAgentTargetService{
			listFn: func(context.Context) ([]agenttargetbiz.Target, error) {
				return []agenttargetbiz.Target{
					{
						ID:            agenttargetbiz.IDLocalCodex,
						Provider:      "codex",
						LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
						Name:          "Codex",
						Enabled:       true,
						Source:        agenttargetbiz.SourceSystem,
					},
				}, nil
			},
		},
		AppCenterService: installedWorkspaceAppCenter("canvas"),
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/apps/canvas/agent-providers/status?providers=codex&providers=hermes",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if !reflect.DeepEqual(capturedProviders, []string{"codex"}) {
		t.Fatalf("providers = %#v, want [codex]", capturedProviders)
	}
}

func installedWorkspaceAppCenter(appID string) stubWorkspaceAppCenterService {
	return stubWorkspaceAppCenterService{
		listFn: func(_ context.Context, _ string) ([]workspacebiz.WorkspaceApp, error) {
			return []workspacebiz.WorkspaceApp{workspaceAppForRouteTest(appID, workspacebiz.AppRuntimeStatusIdle)}, nil
		},
	}
}
