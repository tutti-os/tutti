package agent

import (
	"context"
	"errors"
	"testing"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	modelgatewayservice "github.com/tutti-os/tutti/services/tuttid/service/modelgateway"
)

type fakeModelGateway struct {
	endpoint        modelgatewayservice.ClientEndpoint
	err             error
	registeredRoute *modelgatewayservice.Route
	registerCalls   *int
	unregisterCalls *[][2]string
}

func (f fakeModelGateway) Register(_ context.Context, route modelgatewayservice.Route) (modelgatewayservice.ClientEndpoint, error) {
	if f.registerCalls != nil {
		*f.registerCalls++
	}
	if f.registeredRoute != nil {
		*f.registeredRoute = route
	}
	return f.endpoint, f.err
}

func (f fakeModelGateway) Unregister(_ context.Context, workspaceID string, agentSessionID string) {
	if f.unregisterCalls != nil {
		*f.unregisterCalls = append(*f.unregisterCalls, [2]string{workspaceID, agentSessionID})
	}
}

func TestPrepareRuntimeCodexGatewayUsesTemporaryCredentialAndRollsBackFailure(t *testing.T) {
	t.Parallel()

	upstreamKey := "sk-upstream-secret"
	var preparedInput runtimeprep.PrepareInput
	var registeredRoute modelgatewayservice.Route
	var unregisterCalls [][2]string
	service := &Service{
		RuntimePreparer: fakeRuntimePreparer{
			input: &preparedInput,
			err:   errors.New("prepare failed"),
		},
		ModelGateway: fakeModelGateway{
			endpoint: modelgatewayservice.ClientEndpoint{
				BaseURL: "http://127.0.0.1:40000/v1",
				Token:   "temporary-token",
				WireAPI: "responses",
			},
			registeredRoute: &registeredRoute,
			unregisterCalls: &unregisterCalls,
		},
	}
	_, err := service.prepareRuntimeWithModelEndpoint(
		context.Background(),
		"workspace",
		"/repo",
		CreateSessionInput{
			AgentSessionID: "session",
			Provider:       "codex",
			Model:          stringPointer("model-a"),
		},
		&runtimeprep.ModelEndpointConfig{
			Protocol: "openai",
			BaseURL:  "https://upstream.example/v1",
			APIKey:   upstreamKey,
			Model:    "model-a",
			Models:   []runtimeprep.ModelEndpointModel{{ID: "model-a"}},
		},
	)
	if err == nil || err.Error() != "prepare failed" {
		t.Fatalf("prepareRuntimeWithModelEndpoint() error = %v", err)
	}
	if registeredRoute.UpstreamAPIKey != upstreamKey ||
		registeredRoute.UpstreamURL != "https://upstream.example/v1" {
		t.Fatalf("registered route = %#v", registeredRoute)
	}
	if preparedInput.ModelEndpoint == nil ||
		preparedInput.ModelEndpoint.APIKey != "temporary-token" ||
		preparedInput.ModelEndpoint.BaseURL != "http://127.0.0.1:40000/v1" ||
		preparedInput.ModelEndpoint.WireAPI != "responses" {
		t.Fatalf("prepared endpoint = %#v", preparedInput.ModelEndpoint)
	}
	if len(unregisterCalls) != 2 {
		t.Fatalf("unregister calls = %#v, want replacement revoke and rollback revoke", unregisterCalls)
	}
}

func TestPrepareRuntimeOpenCodeKeepsDirectModelPlanEndpoint(t *testing.T) {
	t.Parallel()

	var preparedInput runtimeprep.PrepareInput
	registerCalls := 0
	service := &Service{
		RuntimePreparer: fakeRuntimePreparer{input: &preparedInput},
		ModelGateway: fakeModelGateway{
			registerCalls: &registerCalls,
		},
	}
	endpoint := &runtimeprep.ModelEndpointConfig{
		Protocol: "openai",
		BaseURL:  "https://upstream.example/v1",
		APIKey:   "sk-direct",
		Model:    "tutti-model-plan/model-a",
	}
	if _, err := service.prepareRuntimeWithModelEndpoint(
		context.Background(),
		"workspace",
		"/repo",
		CreateSessionInput{
			AgentSessionID: "session",
			Provider:       "opencode",
		},
		endpoint,
	); err != nil {
		t.Fatalf("prepareRuntimeWithModelEndpoint() error = %v", err)
	}
	if registerCalls != 0 {
		t.Fatalf("gateway Register() calls = %d, want 0", registerCalls)
	}
	if preparedInput.ModelEndpoint != endpoint ||
		preparedInput.ModelEndpoint.APIKey != "sk-direct" ||
		preparedInput.ModelEndpoint.WireAPI != "" {
		t.Fatalf("OpenCode endpoint = %#v, want direct plan endpoint", preparedInput.ModelEndpoint)
	}
}

func TestCleanupRuntimeRevokesGatewayWithoutRuntimePreparer(t *testing.T) {
	t.Parallel()

	var unregisterCalls [][2]string
	service := &Service{
		ModelGateway: fakeModelGateway{unregisterCalls: &unregisterCalls},
	}
	if err := service.cleanupRuntime(context.Background(), "workspace", "session"); err != nil {
		t.Fatalf("cleanupRuntime() error = %v", err)
	}
	if len(unregisterCalls) != 1 || unregisterCalls[0] != [2]string{"workspace", "session"} {
		t.Fatalf("unregister calls = %#v", unregisterCalls)
	}
}
