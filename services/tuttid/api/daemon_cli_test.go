package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	cliruntime "github.com/tutti-os/tutti/packages/cli/runtime"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func TestInvokeCLIHTTPDecoderMatchesSharedVectors(t *testing.T) {
	corpus, err := cliruntime.LoadHTTPVectors()
	if err != nil {
		t.Fatalf("LoadHTTPVectors() error = %v", err)
	}
	for _, vector := range corpus.InvokeDecodeCases {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			invoked := false
			workspaceID := ""
			cliRegistry, err := cliservice.NewRegistryFromProviders(testCLIProviderFunc(func(_ context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
				invoked = true
				workspaceID = request.Context.WorkspaceID
				return cliservice.CommandOutput{Kind: cliservice.OutputModePlain, Text: "ok"}, nil
			}))
			if err != nil {
				t.Fatal(err)
			}
			mux := http.NewServeMux()
			RegisterRoutes(mux, NewRoutes(DaemonAPI{CLIRegistry: cliRegistry}))
			request := httptest.NewRequest(http.MethodPost, cliruntime.CommandInvokePath("diagnostics.vector"), strings.NewReader(vector.Body))
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, request)
			if response.Code != vector.ExpectedStatusCode {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, vector.ExpectedStatusCode, response.Body.String())
			}
			if invoked != vector.ExpectedInvoked || workspaceID != vector.ExpectedWorkspaceID {
				t.Fatalf("invoked = %t workspaceID = %q", invoked, workspaceID)
			}
			if vector.ExpectedReason != "" {
				var errorResponse cliruntime.APIErrorResponse
				if err := json.Unmarshal(response.Body.Bytes(), &errorResponse); err != nil {
					t.Fatalf("decode error response: %v", err)
				}
				if errorResponse.Error.Reason == nil || *errorResponse.Error.Reason != vector.ExpectedReason {
					t.Fatalf("error response = %#v", errorResponse)
				}
			}
		})
	}
}

func TestInvokeCLIHTTPErrorsMatchSharedVectors(t *testing.T) {
	corpus, err := cliruntime.LoadHTTPVectors()
	if err != nil {
		t.Fatalf("LoadHTTPVectors() error = %v", err)
	}
	for _, vector := range corpus.ErrorResponses {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			cliRegistry, err := cliservice.NewRegistryFromProviders(testCLIProviderFunc(func(context.Context, cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
				return cliservice.CommandOutput{}, sharedHTTPVectorError(vector.Name)
			}))
			if err != nil {
				t.Fatal(err)
			}
			mux := http.NewServeMux()
			RegisterRoutes(mux, NewRoutes(DaemonAPI{CLIRegistry: cliRegistry}))
			request := httptest.NewRequest(http.MethodPost, cliruntime.CommandInvokePath("diagnostics.vector"), strings.NewReader(`{}`))
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, request)
			if response.Code != vector.StatusCode {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, vector.StatusCode, response.Body.String())
			}
			assertSemanticJSONEqual(t, response.Body.Bytes(), []byte(vector.JSON))
		})
	}
}

func sharedHTTPVectorError(name string) error {
	switch name {
	case "command-not-found":
		return cliservice.ErrCommandNotFound
	case "invalid-input":
		return cliservice.ErrInvalidInput
	case "app-runtime-unavailable":
		return cliservice.ServiceUnavailableError("app_cli_runtime_unavailable", errors.New("app runtime unavailable"))
	case "workspace-operation":
		return cliservice.WorkspaceOperationError("app_cli_handler_bad_response", errors.New("app handler bad response"))
	default:
		return errors.New("unknown shared error vector")
	}
}

type testCLIProviderFunc cliservice.Handler

func (testCLIProviderFunc) AppID() string { return "diagnostics" }

func (handler testCLIProviderFunc) Commands() []cliservice.Command {
	return []cliservice.Command{{
		Capability: cliservice.Capability{
			ID: "diagnostics.vector", Path: []string{"diagnostics", "vector"}, Summary: "Vector",
			Output: cliservice.CapabilityOutput{DefaultMode: cliservice.OutputModePlain},
		},
		Handler: cliservice.Handler(handler),
	}}
}

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
