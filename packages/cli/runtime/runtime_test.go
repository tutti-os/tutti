package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

type vectorClient struct {
	capability Capability
	commandID  string
	request    *InvokeRequest
	catalogErr error
	invokeErr  error
}

func (client *vectorClient) ListCapabilities(context.Context, string, CapabilityListOptions) (CapabilityList, error) {
	if client.catalogErr != nil {
		return CapabilityList{}, client.catalogErr
	}
	return CapabilityList{Commands: []Capability{client.capability}}, nil
}

func (client *vectorClient) Invoke(_ context.Context, commandID string, request InvokeRequest) (InvokeResponse, error) {
	client.commandID = commandID
	client.request = &request
	return InvokeResponse{OK: client.invokeErr == nil}, client.invokeErr
}

func TestArgvVectors(t *testing.T) {
	manifest, err := LoadCanonicalManifest()
	if err != nil {
		t.Fatal(err)
	}
	corpus, err := LoadArgvVectors()
	if err != nil {
		t.Fatal(err)
	}
	for _, vector := range corpus.Cases {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			capability, ok := manifestCapability(manifest, vector.CapabilityID)
			if !ok {
				t.Fatalf("capability %q is absent from manifest", vector.CapabilityID)
			}
			client := &vectorClient{capability: capability}
			if vector.CatalogError != "" {
				client.catalogErr = errors.New(vector.CatalogError)
			}
			if vector.InvokeError != "" {
				client.invokeErr = errors.New(vector.InvokeError)
			}
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			exit := (Runner{Client: client, CommandName: "tutti", InvokeContext: corpus.InvokeContext}).RunArgs(
				context.Background(), vector.Args, &stdout, &stderr,
			)
			if exit != vector.ExpectedExit {
				t.Fatalf("exit = %d, want %d; stderr=%q", exit, vector.ExpectedExit, stderr.String())
			}
			if stdout.String() != vector.ExpectedStdout {
				t.Fatalf("stdout = %q, want %q", stdout.String(), vector.ExpectedStdout)
			}
			if stderr.String() != vector.ExpectedStderr {
				t.Fatalf("stderr = %q, want %q", stderr.String(), vector.ExpectedStderr)
			}
			if !vector.ExpectedInvoke {
				if client.request != nil {
					t.Fatal("command unexpectedly invoked")
				}
				return
			}
			if client.request == nil {
				t.Fatal("command was not invoked")
			}
			if client.commandID != vector.CapabilityID {
				t.Fatalf("command id = %q, want %q", client.commandID, vector.CapabilityID)
			}
			assertJSONEqual(t, valueOrZero(client.request.Input), vector.ExpectedInput)
			if valueOrZero(client.request.OutputMode) != vector.ExpectedOutputMode {
				t.Fatalf("output mode = %q, want %q", valueOrZero(client.request.OutputMode), vector.ExpectedOutputMode)
			}
			if !reflect.DeepEqual(valueOrZero(client.request.Context), corpus.InvokeContext) {
				t.Fatalf("invoke context = %#v, want %#v", client.request.Context, corpus.InvokeContext)
			}
		})
	}
}

func TestRunnerUsesLongestPrefixMatch(t *testing.T) {
	client := &multiCapabilityClient{capabilities: []Capability{
		{ID: "short", Path: []string{"agent"}, Output: CapabilityOutput{DefaultMode: "plain"}},
		{ID: "long", Path: []string{"agent", "session", "messages"}, Output: CapabilityOutput{DefaultMode: "json"}},
	}}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exit := (Runner{Client: client}).Run(context.Background(), []string{"agent", "session", "messages"}, Options{}, &stdout, &stderr)
	if exit != ExitSuccess || client.commandID != "long" {
		t.Fatalf("exit = %d command id = %q stderr = %q", exit, client.commandID, stderr.String())
	}
}

func TestHTTPVectorsMatchProtocolPathBuilders(t *testing.T) {
	corpus, err := LoadHTTPVectors()
	if err != nil {
		t.Fatalf("LoadHTTPVectors() error = %v", err)
	}
	for _, vector := range corpus.CapabilityRequests {
		got := CapabilitiesRequestPath(vector.WorkspaceID, CapabilityListOptions{
			IncludeHidden:      vector.IncludeHidden,
			IncludeIntegration: vector.IncludeIntegration,
		})
		if got != vector.ExpectedPath {
			t.Errorf("CapabilitiesRequestPath(%s) = %q, want %q", vector.Name, got, vector.ExpectedPath)
		}
	}
	for _, vector := range corpus.InvokePaths {
		if got := CommandInvokePath(vector.CommandID); got != vector.ExpectedPath {
			t.Errorf("CommandInvokePath(%s) = %q, want %q", vector.Name, got, vector.ExpectedPath)
		}
	}
	assertExactJSONRoundTrip[InvokeRequest](t, "invoke request", corpus.InvokeRequestJSON)
	assertExactJSONRoundTrip[CapabilityList](t, "capability response", corpus.CapabilityResponseJSON)
	assertExactJSONRoundTrip[InvokeResponse](t, "invoke response", corpus.InvokeResponseJSON)
	for _, vector := range corpus.ErrorResponses {
		assertExactJSONRoundTrip[APIErrorResponse](t, "error response "+vector.Name, vector.JSON)
	}
}

func assertExactJSONRoundTrip[T any](t *testing.T, name string, document string) {
	t.Helper()
	var value T
	if err := json.Unmarshal([]byte(document), &value); err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encode %s: %v", name, err)
	}
	if string(encoded) != document {
		t.Fatalf("%s is not the canonical public DTO wire shape\ngot:  %s\nwant: %s", name, encoded, document)
	}
}

type multiCapabilityClient struct {
	capabilities []Capability
	commandID    string
}

func (client *multiCapabilityClient) ListCapabilities(context.Context, string, CapabilityListOptions) (CapabilityList, error) {
	return CapabilityList{Commands: client.capabilities}, nil
}

func (client *multiCapabilityClient) Invoke(_ context.Context, commandID string, _ InvokeRequest) (InvokeResponse, error) {
	client.commandID = commandID
	return InvokeResponse{OK: true}, nil
}

func TestRenderVectors(t *testing.T) {
	corpus, err := LoadRenderVectors()
	if err != nil {
		t.Fatal(err)
	}
	for _, vector := range corpus.Cases {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			exit := RenderOutput(&stdout, &stderr, vector.Output, vector.JSON)
			if exit != vector.ExpectedExit || stdout.String() != vector.ExpectedStdout || stderr.String() != vector.ExpectedStderr {
				t.Fatalf("render = exit %d stdout %q stderr %q", exit, stdout.String(), stderr.String())
			}
		})
	}
}

func TestCanonicalManifestAndGateVectors(t *testing.T) {
	manifest, err := LoadCanonicalManifest()
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := LoadManifestVectors()
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Commands) != fixture.ExpectedCommandCount {
		t.Fatalf("manifest command count = %d, want %d", len(manifest.Commands), fixture.ExpectedCommandCount)
	}
	ids := map[string]bool{}
	gateCounts := map[string]int{}
	visibility := stringSet(fixture.AllowedVisibility)
	sourceKinds := stringSet(fixture.AllowedSourceKinds)
	for _, command := range manifest.Commands {
		if ids[command.Capability.ID] {
			t.Fatalf("duplicate command id %q", command.Capability.ID)
		}
		ids[command.Capability.ID] = true
		if len(command.Conditions.RegistrationGates) == 0 {
			t.Fatalf("command %q has no registration gate", command.Capability.ID)
		}
		for _, gate := range command.Conditions.RegistrationGates {
			gateCounts[gate]++
		}
		if !visibility[valueOrZero(command.Capability.Visibility)] {
			t.Fatalf("command %q visibility = %q", command.Capability.ID, valueOrZero(command.Capability.Visibility))
		}
		if !sourceKinds[command.Capability.Source.Kind] {
			t.Fatalf("command %q source kind = %q", command.Capability.ID, command.Capability.Source.Kind)
		}
	}
	if !reflect.DeepEqual(gateCounts, fixture.RegistrationGateCounts) {
		t.Fatalf("registration gate counts = %#v, want %#v", gateCounts, fixture.RegistrationGateCounts)
	}
	corpus, err := LoadGateVectors()
	if err != nil {
		t.Fatal(err)
	}
	for _, snapshot := range corpus.Snapshots {
		commands, err := SelectManifestCommands(manifest, snapshot)
		if err != nil {
			t.Errorf("snapshot %q: %v", snapshot.Name, err)
			continue
		}
		count := len(commands)
		if count != snapshot.ExpectedCommandCount {
			t.Errorf("snapshot %q command count = %d, want %d", snapshot.Name, count, snapshot.ExpectedCommandCount)
		}
	}
}

func stringSet(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}

func TestGateSnapshotFailsClosed(t *testing.T) {
	manifest, err := LoadCanonicalManifest()
	if err != nil {
		t.Fatal(err)
	}
	corpus, err := LoadGateVectors()
	if err != nil {
		t.Fatal(err)
	}
	snapshot := corpus.Snapshots[0]
	snapshot.RegistrationGates = cloneBoolMap(snapshot.RegistrationGates)
	delete(snapshot.RegistrationGates, "browser")
	if _, err := SelectManifestCommands(manifest, snapshot); err == nil {
		t.Fatal("snapshot missing a known registration gate was accepted")
	}
	snapshot = corpus.Snapshots[0]
	snapshot.RegistrationGates = cloneBoolMap(snapshot.RegistrationGates)
	snapshot.RegistrationGates["future-domain"] = true
	if _, err := SelectManifestCommands(manifest, snapshot); err == nil {
		t.Fatal("snapshot with an unknown registration gate was accepted")
	}
}

func cloneBoolMap(source map[string]bool) map[string]bool {
	result := make(map[string]bool, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func TestProtocolSourcePreservesIconURL(t *testing.T) {
	appID := "demo"
	iconURL := "data:image/png;base64,AA=="
	source := CapabilitySource{Kind: "app", AppID: &appID, IconURL: &iconURL}
	content, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	var decoded CapabilitySource
	if err := json.Unmarshal(content, &decoded); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decoded, source) {
		t.Fatalf("decoded source = %#v, want %#v", decoded, source)
	}
}

func TestDomainScenarioVectorsReferenceCanonicalCommands(t *testing.T) {
	manifest, err := LoadCanonicalManifest()
	if err != nil {
		t.Fatal(err)
	}
	corpus, err := LoadDomainScenarios()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, scenario := range corpus.Scenarios {
		if scenario.ID == "" || seen[scenario.ID] {
			t.Fatalf("invalid or duplicate scenario id %q", scenario.ID)
		}
		seen[scenario.ID] = true
		if _, ok := manifestCapability(manifest, scenario.CommandID); !ok {
			t.Fatalf("scenario %q references unknown command %q", scenario.ID, scenario.CommandID)
		}
		if len(scenario.Postconditions) == 0 {
			t.Fatalf("scenario %q has no postconditions", scenario.ID)
		}
	}
}

func manifestCapability(manifest CanonicalManifest, id string) (Capability, bool) {
	for _, command := range manifest.Commands {
		if command.Capability.ID == id {
			return command.Capability, true
		}
	}
	return Capability{}, false
}

func assertJSONEqual(t *testing.T, actual any, expected any) {
	t.Helper()
	actualJSON, err := json.Marshal(actual)
	if err != nil {
		t.Fatal(err)
	}
	expectedJSON, err := json.Marshal(expected)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actualJSON, expectedJSON) {
		t.Fatalf("actual JSON %s, want %s", actualJSON, expectedJSON)
	}
}
