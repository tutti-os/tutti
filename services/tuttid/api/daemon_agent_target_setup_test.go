package api

import (
	"context"
	"errors"
	"net/http"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
)

type stubAgentTargetSetupService struct {
	getFn          func(context.Context, agentextensionservice.InstallPlanInput) (agentextensionservice.SetupSnapshot, error)
	installFn      func(context.Context, agentextensionservice.InstallInput) (agentextensionservice.SetupSnapshot, error)
	authenticateFn func(context.Context, agentextensionservice.AuthenticateInput) (agentextensionservice.SetupSnapshot, error)
}

func (s stubAgentTargetSetupService) Authenticate(ctx context.Context, input agentextensionservice.AuthenticateInput) (agentextensionservice.SetupSnapshot, error) {
	return s.authenticateFn(ctx, input)
}

func (s stubAgentTargetSetupService) GetSetup(ctx context.Context, input agentextensionservice.InstallPlanInput) (agentextensionservice.SetupSnapshot, error) {
	return s.getFn(ctx, input)
}

func (s stubAgentTargetSetupService) Install(ctx context.Context, input agentextensionservice.InstallInput) (agentextensionservice.SetupSnapshot, error) {
	return s.installFn(ctx, input)
}

func TestDaemonAPIGeneratedRoutesAgentTargetSetupInstallAndAuthenticate(t *testing.T) {
	plan := agentextensionservice.InstallPlan{
		AgentTargetID:           "extension:codebuddy",
		ExtensionInstallationID: "codebuddy@1.0.0", AgentKey: "codebuddy", ExtensionVersion: "1.0.0",
		RuntimeKind: "standard-acp", Platform: "darwin-arm64", Runner: "npm",
		PackageName: "@tencent-ai/codebuddy-code", PackageVersion: "2.121.2",
		InstallRoot:    "/state/agent/runtimes/codebuddy/1.0.0",
		InstallCommand: []string{"npm", "install"}, Executable: "/state/agent/runtimes/codebuddy/1.0.0/codebuddy", LaunchArgs: []string{"--acp"},
		PlanDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	}
	var capturedInstall agentextensionservice.InstallInput
	var capturedAuthenticate agentextensionservice.AuthenticateInput
	service := stubAgentTargetSetupService{
		getFn: func(_ context.Context, input agentextensionservice.InstallPlanInput) (agentextensionservice.SetupSnapshot, error) {
			return agentextensionservice.SetupSnapshot{
				WorkspaceID: input.WorkspaceID, AgentTargetID: input.AgentTargetID,
				Status: agentextensionservice.SetupNotInstalled, Plan: &plan,
				AuthMethods: []agentextensionservice.RuntimeAuthMethod{
					{ID: "external", Name: "Login with Google/GitHub"},
					{ID: "login", Name: "Login with Fixture account", Type: "terminal", TerminalCommand: "/opt/fixture/bin/agent login"},
				},
				Account: &agentextensionservice.RuntimeAuthenticatedAccount{
					ID: "user-1", DisplayName: "Rhinoc", AuthMethodID: "external", Organization: "Tutti",
				},
			}, nil
		},
		installFn: func(_ context.Context, input agentextensionservice.InstallInput) (agentextensionservice.SetupSnapshot, error) {
			capturedInstall = input
			return agentextensionservice.SetupSnapshot{
				WorkspaceID: input.WorkspaceID, AgentTargetID: input.AgentTargetID,
				Status: agentextensionservice.SetupInstalling,
				Action: &agentextensionservice.SetupAction{ActionID: "action-1", ClientActionID: input.ClientActionID, Kind: agentextensionservice.SetupActionInstall, Status: agentextensionservice.SetupActionQueued, Phase: agentextensionservice.SetupPhasePreparing},
			}, nil
		},
		authenticateFn: func(_ context.Context, input agentextensionservice.AuthenticateInput) (agentextensionservice.SetupSnapshot, error) {
			capturedAuthenticate = input
			return agentextensionservice.SetupSnapshot{
				WorkspaceID: input.WorkspaceID, AgentTargetID: input.AgentTargetID,
				Status: agentextensionservice.SetupAuthenticating,
				Action: &agentextensionservice.SetupAction{ActionID: "auth-1", ClientActionID: input.ClientActionID, Kind: agentextensionservice.SetupActionAuthenticate, Status: agentextensionservice.SetupActionRunning, Phase: agentextensionservice.SetupPhaseAuthenticating},
			}, nil
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{AgentTargetSetupService: service}))

	getRecorder := performGeneratedRouteRequest(t, mux, http.MethodGet,
		"/v1/workspaces/workspace-1/agent-targets/extension:codebuddy/setup", nil)
	if getRecorder.Code != http.StatusOK {
		t.Fatalf("GET status = %d; body: %s", getRecorder.Code, getRecorder.Body.String())
	}
	var getResponse tuttigenerated.AgentTargetSetupSnapshot
	decodeGeneratedRouteResponse(t, getRecorder, &getResponse)
	if getResponse.Plan == nil || getResponse.Plan.PackageName != "@tencent-ai/codebuddy-code" || getResponse.Plan.PackageVersion != "2.121.2" {
		t.Fatalf("GET response = %#v", getResponse)
	}
	if len(getResponse.AuthMethods) != 2 || getResponse.AuthMethods[0].Id != "external" {
		t.Fatalf("GET auth methods = %#v", getResponse.AuthMethods)
	}
	terminalMethod := getResponse.AuthMethods[1]
	if terminalMethod.Type == nil || *terminalMethod.Type != "terminal" ||
		terminalMethod.TerminalCommand == nil || *terminalMethod.TerminalCommand != "/opt/fixture/bin/agent login" {
		t.Fatalf("GET terminal auth method = %#v", terminalMethod)
	}
	if getResponse.AuthMethods[0].Type != nil || getResponse.AuthMethods[0].TerminalCommand != nil {
		t.Fatalf("GET non-terminal auth method = %#v", getResponse.AuthMethods[0])
	}
	if getResponse.Account == nil || getResponse.Account.Id != "user-1" || getResponse.Account.DisplayName != "Rhinoc" ||
		getResponse.Account.AuthMethodId != "external" || getResponse.Account.Organization == nil || *getResponse.Account.Organization != "Tutti" {
		t.Fatalf("GET account = %#v", getResponse.Account)
	}

	postRecorder := performGeneratedRouteRequest(t, mux, http.MethodPost,
		"/v1/workspaces/workspace-1/agent-targets/extension:codebuddy/setup/install",
		map[string]any{"planDigest": plan.PlanDigest, "clientActionId": "ui-action-1"})
	if postRecorder.Code != http.StatusOK {
		t.Fatalf("POST status = %d; body: %s", postRecorder.Code, postRecorder.Body.String())
	}
	if capturedInstall.AgentTargetID != "extension:codebuddy" || capturedInstall.ClientActionID != "ui-action-1" || capturedInstall.PlanDigest != plan.PlanDigest {
		t.Fatalf("captured install = %#v", capturedInstall)
	}

	authRecorder := performGeneratedRouteRequest(t, mux, http.MethodPost,
		"/v1/workspaces/workspace-1/agent-targets/extension:codebuddy/setup/authenticate",
		map[string]any{"methodId": "external", "clientActionId": "ui-auth-1"})
	if authRecorder.Code != http.StatusOK {
		t.Fatalf("authenticate status = %d; body: %s", authRecorder.Code, authRecorder.Body.String())
	}
	if capturedAuthenticate.MethodID != "external" || capturedAuthenticate.ClientActionID != "ui-auth-1" {
		t.Fatalf("captured authenticate = %#v", capturedAuthenticate)
	}
}

func TestDaemonAPIGeneratedRouteMapsAgentTargetSetupErrors(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{name: "workspace missing", err: workspacedata.ErrWorkspaceNotFound, want: http.StatusNotFound},
		{name: "target missing", err: workspacedata.ErrAgentTargetNotFound, want: http.StatusBadRequest},
		{name: "invalid request", err: agentextensionservice.ErrInvalidInstallPlanRequest, want: http.StatusBadRequest},
		{name: "storage failure", err: errors.New("storage failure"), want: http.StatusBadGateway},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mux := http.NewServeMux()
			RegisterRoutes(mux, NewRoutes(DaemonAPI{AgentTargetSetupService: stubAgentTargetSetupService{
				getFn: func(context.Context, agentextensionservice.InstallPlanInput) (agentextensionservice.SetupSnapshot, error) {
					return agentextensionservice.SetupSnapshot{}, test.err
				},
			}}))
			recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/workspaces/workspace-1/agent-targets/extension:gemini/setup", nil)
			if recorder.Code != test.want {
				t.Fatalf("status = %d, want %d; body: %s", recorder.Code, test.want, recorder.Body.String())
			}
		})
	}
}

func TestDaemonAPIGeneratedRouteRequiresAgentTargetSetupService(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/workspaces/workspace-1/agent-targets/extension:gemini/setup", nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusServiceUnavailable, recorder.Body.String())
	}
}
