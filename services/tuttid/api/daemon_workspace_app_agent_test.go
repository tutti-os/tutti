package api

import (
	"context"
	"net/http"
	"reflect"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
)

func TestDaemonAPIRoutesWorkspaceAppAgentPreferencesRejectInvalidPath(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{}))
	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/%20/apps/canvas/preferences/agent",
		nil,
	)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
}

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
						{Provider: "hermes"},
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
	if !reflect.DeepEqual(capturedProviders, []string{"codex", "hermes", "opencode"}) {
		t.Fatalf("providers = %#v, want [codex hermes opencode]", capturedProviders)
	}

	var response tuttigenerated.AgentProviderStatusListResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	gotProviders := make([]string, 0, len(response.Providers))
	for _, provider := range response.Providers {
		gotProviders = append(gotProviders, string(provider.Provider))
	}
	if !reflect.DeepEqual(gotProviders, []string{"codex", "hermes", "opencode"}) {
		t.Fatalf("response providers = %#v, want [codex hermes opencode]", gotProviders)
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

func TestDaemonAPIRoutesWorkspaceAppComposerOptionsBindPathWorkspace(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			composerOptionsFn: func(_ context.Context, input agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error) {
				if input.WorkspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", input.WorkspaceID)
				}
				return agentservice.ComposerOptions{Provider: input.Provider}, nil
			},
		},
		AgentTargetService: stubAgentTargetService{
			listFn: func(context.Context) ([]agenttargetbiz.Target, error) {
				return []agenttargetbiz.Target{{
					ID:            agenttargetbiz.IDLocalCodex,
					Provider:      "codex",
					LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
					Name:          "Codex",
					Enabled:       true,
					Source:        agenttargetbiz.SourceSystem,
				}}, nil
			},
		},
		AppCenterService: installedWorkspaceAppCenter("canvas"),
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/apps/canvas/agent-providers/codex/composer-options",
		map[string]any{"workspaceId": "ws-2"},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
}

func TestDaemonAPIRoutesWorkspaceAppComposerOptionsRejectHiddenProvider(t *testing.T) {
	t.Parallel()

	composerOptionsCalled := false
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			composerOptionsFn: func(_ context.Context, input agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error) {
				composerOptionsCalled = true
				return agentservice.ComposerOptions{Provider: input.Provider}, nil
			},
		},
		AgentTargetService: stubAgentTargetService{
			listFn: func(context.Context) ([]agenttargetbiz.Target, error) {
				return []agenttargetbiz.Target{{
					ID:            agenttargetbiz.IDLocalCodex,
					Provider:      "codex",
					LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
					Name:          "Codex",
					Enabled:       true,
					Source:        agenttargetbiz.SourceSystem,
				}}, nil
			},
		},
		AppCenterService: installedWorkspaceAppCenter("canvas"),
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/apps/canvas/agent-providers/opencode/composer-options",
		nil,
	)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
	if composerOptionsCalled {
		t.Fatal("composer options service called for hidden provider")
	}
}

func installedWorkspaceAppCenter(appID string) stubWorkspaceAppCenterService {
	return stubWorkspaceAppCenterService{
		listFn: func(_ context.Context, _ string) ([]workspacebiz.WorkspaceApp, error) {
			return []workspacebiz.WorkspaceApp{workspaceAppForRouteTest(appID, workspacebiz.AppRuntimeStatusIdle)}, nil
		},
	}
}
