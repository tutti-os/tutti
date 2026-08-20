package api

import (
	"context"
	"errors"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func TestListCliCapabilitiesAppliesProviderFiltersByDefault(t *testing.T) {
	api := DaemonAPI{CLIRegistry: newTestFilteredCLIRegistry(t)}

	response, err := api.ListCliCapabilities(context.Background(), tuttigenerated.ListCliCapabilitiesRequestObject{
		Params: tuttigenerated.ListCliCapabilitiesParams{},
	})
	if err != nil {
		t.Fatalf("ListCliCapabilities: %v", err)
	}

	commands := response.(tuttigenerated.ListCliCapabilities200JSONResponse).Commands
	if got, want := generatedCommandIDs(commands), []string{"diagnostics.visible"}; !equalStringSlices(got, want) {
		t.Fatalf("command ids = %#v, want %#v", got, want)
	}
}

func TestListCliCapabilitiesCanIncludeHiddenCapabilities(t *testing.T) {
	includeHidden := true
	api := DaemonAPI{CLIRegistry: newTestFilteredCLIRegistry(t)}

	response, err := api.ListCliCapabilities(context.Background(), tuttigenerated.ListCliCapabilitiesRequestObject{
		Params: tuttigenerated.ListCliCapabilitiesParams{
			IncludeHidden: &includeHidden,
		},
	})
	if err != nil {
		t.Fatalf("ListCliCapabilities: %v", err)
	}

	commands := response.(tuttigenerated.ListCliCapabilities200JSONResponse).Commands
	if got, want := generatedCommandIDs(commands), []string{"diagnostics.hidden", "diagnostics.visible", "diagnostics.internal"}; !equalStringSlices(got, want) {
		t.Fatalf("command ids = %#v, want %#v", got, want)
	}
}

func TestListCliCapabilitiesCanIncludeIntegrationCapabilities(t *testing.T) {
	includeIntegration := true
	api := DaemonAPI{CLIRegistry: newTestFilteredCLIRegistry(t)}

	response, err := api.ListCliCapabilities(context.Background(), tuttigenerated.ListCliCapabilitiesRequestObject{
		Params: tuttigenerated.ListCliCapabilitiesParams{},
	})
	if err != nil {
		t.Fatalf("ListCliCapabilities: %v", err)
	}
	commands := response.(tuttigenerated.ListCliCapabilities200JSONResponse).Commands
	if got, want := generatedCommandIDs(commands), []string{"diagnostics.visible"}; !equalStringSlices(got, want) {
		t.Fatalf("command ids = %#v, want %#v", got, want)
	}
	if commands[0].Visibility == nil || *commands[0].Visibility != tuttigenerated.Public {
		t.Fatalf("visibility = %#v, want public", commands[0].Visibility)
	}

	response, err = api.ListCliCapabilities(context.Background(), tuttigenerated.ListCliCapabilitiesRequestObject{
		Params: tuttigenerated.ListCliCapabilitiesParams{
			IncludeIntegration: &includeIntegration,
		},
	})
	if err != nil {
		t.Fatalf("ListCliCapabilities include integration: %v", err)
	}
	commands = response.(tuttigenerated.ListCliCapabilities200JSONResponse).Commands
	if got, want := generatedCommandIDs(commands), []string{"diagnostics.visible", "diagnostics.internal"}; !equalStringSlices(got, want) {
		t.Fatalf("command ids with integration = %#v, want %#v", got, want)
	}
	if commands[1].Visibility == nil || *commands[1].Visibility != tuttigenerated.Integration {
		t.Fatalf("integration visibility = %#v", commands[1].Visibility)
	}
}

func TestListCliCapabilitiesAppliesPersistedAgentSessionProjection(t *testing.T) {
	agentSessionID := "review-session-1"
	workspaceID := "workspace-1"
	registry := newTestFilteredCLIRegistry(t)
	registry.AgentSessionCapabilities = apiAgentSessionCapabilityResolver{}
	api := DaemonAPI{CLIRegistry: registry}

	response, err := api.ListCliCapabilities(
		context.Background(),
		tuttigenerated.ListCliCapabilitiesRequestObject{
			Params: tuttigenerated.ListCliCapabilitiesParams{
				WorkspaceID:    &workspaceID,
				AgentSessionID: &agentSessionID,
			},
		},
	)
	if err != nil {
		t.Fatalf("ListCliCapabilities: %v", err)
	}
	commands := response.(tuttigenerated.ListCliCapabilities200JSONResponse).Commands
	if got, want := generatedCommandIDs(commands), []string{
		"diagnostics.internal",
	}; !equalStringSlices(got, want) {
		t.Fatalf("projected command ids = %#v, want %#v", got, want)
	}
}

type apiAgentSessionCapabilityResolver struct{}

func (apiAgentSessionCapabilityResolver) ResolveAgentSessionCapabilityProjection(
	_ context.Context,
	workspaceID string,
	sessionID string,
) (cliservice.AgentSessionCapabilityProjection, error) {
	if workspaceID != "workspace-1" || sessionID != "review-session-1" {
		return cliservice.AgentSessionCapabilityProjection{}, errors.New(
			"unexpected agent session identity",
		)
	}
	return cliservice.AgentSessionCapabilityProjection{
		IncludeIntegrationIDs: []string{"diagnostics.internal"},
		ExcludeIDs:            []string{"diagnostics.visible"},
	}, nil
}

func TestGeneratedCliWaitContractPreservesExecutionAndContinuation(t *testing.T) {
	capability := generatedCliCapability(cliservice.Capability{
		ID:               "app.workflow.runs.wait",
		Path:             []string{"workflow", "runs", "wait"},
		Summary:          "Wait for a run",
		Output:           cliservice.CapabilityOutput{DefaultMode: cliservice.OutputModeJSON, JSON: true},
		Execution:        &cliservice.CommandExecution{Mode: cliservice.CommandExecutionModeWait},
		HandlerTimeoutMs: 45000,
		Source:           cliservice.CapabilitySource{Kind: cliservice.CapabilitySourceApp},
	})
	if capability.Execution == nil || capability.Execution.Mode != tuttigenerated.Wait ||
		capability.HandlerTimeoutMs == nil || *capability.HandlerTimeoutMs != 45000 {
		t.Fatalf("capability = %#v", capability)
	}
	output := generatedCliCommandOutput(cliservice.CommandOutput{
		Kind:  cliservice.OutputModeJSON,
		Value: map[string]any{"status": "running"},
		Continuation: &cliservice.CommandContinuation{
			State: cliservice.CommandContinuationStatePending, RetryAfterMs: 500,
		},
	})
	if output.Continuation == nil || output.Continuation.State != tuttigenerated.CliCommandContinuationStatePending ||
		output.Continuation.RetryAfterMs != 500 {
		t.Fatalf("output = %#v", output)
	}
}

func TestWriteInvokeCliCommandErrorPreservesStableInvalidInputReason(t *testing.T) {
	response := writeInvokeCliCommandError(cliservice.InvalidInputReasonError(
		"stale_graph_revision",
		"schedule rejected. Hint: refresh the execution snapshot",
		nil,
	))
	rejected, ok := response.(tuttigenerated.InvokeCliCommand400JSONResponse)
	if !ok {
		t.Fatalf("writeInvokeCliCommandError() = %#v", response)
	}
	payload := tuttigenerated.ApiErrorResponse(rejected.InvalidRequestErrorJSONResponse)
	if payload.Error.Reason == nil || *payload.Error.Reason != "stale_graph_revision" {
		t.Fatalf("error.reason = %#v", payload.Error.Reason)
	}
}

func TestServiceCliContextCarriesAgentRuntimeContext(t *testing.T) {
	cwd := "/workspace/project/worktree"
	railPlacementJSON := `{"version":1,"kind":"project","projectPath":"/workspace/project","sectionKey":"project:/workspace/project"}`

	contextValue := serviceCliContext(&tuttigenerated.CliInvokeContext{
		Source:                 "cli",
		AgentCwd:               &cwd,
		AgentRailPlacementJSON: &railPlacementJSON,
	})

	if contextValue.AgentCWD != cwd || contextValue.AgentRailPlacementJSON != railPlacementJSON {
		t.Fatalf("service CLI context = %#v", contextValue)
	}
}

type testFilteringCLIProvider struct{}

func (testFilteringCLIProvider) AppID() string {
	return "diagnostics"
}

func (testFilteringCLIProvider) Commands() []cliservice.Command {
	internal := testCLICommand("diagnostics.internal", []string{"internal"})
	internal.Capability.Visibility = cliservice.CapabilityVisibilityIntegration
	return []cliservice.Command{
		testCLICommand("diagnostics.hidden", []string{"hidden"}),
		testCLICommand("diagnostics.visible", []string{"visible"}),
		internal,
	}
}

func (testFilteringCLIProvider) FilterCapabilities(_ context.Context, _ cliservice.InvokeContext, capabilities []cliservice.Capability) []cliservice.Capability {
	result := make([]cliservice.Capability, 0, len(capabilities))
	for _, capability := range capabilities {
		if capability.ID != "diagnostics.hidden" {
			result = append(result, capability)
		}
	}
	return result
}

func newTestFilteredCLIRegistry(t *testing.T) *cliservice.Registry {
	t.Helper()
	registry, err := cliservice.NewRegistryFromProviders(testFilteringCLIProvider{})
	if err != nil {
		t.Fatalf("NewRegistryFromProviders: %v", err)
	}
	return registry
}

func testCLICommand(id string, path []string) cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:      id,
			Path:    path,
			Summary: "Test command",
			Output: cliservice.CapabilityOutput{
				DefaultMode: cliservice.OutputModePlain,
				JSON:        true,
			},
		},
		Handler: func(context.Context, cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			return cliservice.CommandOutput{Kind: cliservice.OutputModePlain, Text: "ok"}, nil
		},
	}
}

func generatedCommandIDs(commands []tuttigenerated.CliCapability) []string {
	ids := make([]string, 0, len(commands))
	for _, command := range commands {
		ids = append(ids, command.Id)
	}
	return ids
}

func equalStringSlices(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
