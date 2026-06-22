package appcli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func TestRegistryActivateExposesAppCapabilities(t *testing.T) {
	registry := NewRegistry(fakeWorkspaceCatalog{workspaceID: "ws-1"}, nil)
	appPackage := writeTestPackage(t, "automation-app", "automation", `[
    {
      "path": ["run"],
      "summary": "Run automation",
      "inputSchema": {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]},
      "output": {"defaultMode":"json","json":true},
      "handler": {"kind":"http","method":"POST","path":"/tutti/cli/run"}
    }
  ]`)

	state := registry.Activate(context.Background(), Activation{
		WorkspaceID: "ws-1",
		AppPackage:  appPackage,
		BaseURL:     "http://127.0.0.1:1",
	})
	if state.Status != workspacebiz.AppCLIStatusActive || !state.Active || state.Scope != "automation" {
		t.Fatalf("Activate() state = %#v", state)
	}

	capabilities := registry.Capabilities(context.Background(), cliservice.InvokeContext{Source: "cli"})
	if len(capabilities) != 1 {
		t.Fatalf("capabilities = %#v", capabilities)
	}
	if capabilities[0].ID != "app.automation-app.automation.run" || capabilities[0].Path[0] != "automation" {
		t.Fatalf("capability = %#v", capabilities[0])
	}
	if capabilities[0].Source.Kind != cliservice.CapabilitySourceApp || capabilities[0].Source.AppID != "automation-app" {
		t.Fatalf("capability source = %#v", capabilities[0].Source)
	}
	if capabilities[0].Source.AppDescription != "Test app" {
		t.Fatalf("capability source app description = %q, want Test app", capabilities[0].Source.AppDescription)
	}
	if capabilities[0].Source.CLIDescription != "Test CLI scope" {
		t.Fatalf("capability source cli description = %q, want Test CLI scope", capabilities[0].Source.CLIDescription)
	}
	if capabilities[0].Source.IconURL == "" {
		t.Fatalf("capability source icon URL is empty")
	}
}

func TestRegistryActivateExposesDocumentationFile(t *testing.T) {
	registry := NewRegistry(fakeWorkspaceCatalog{workspaceID: "ws-1"}, nil)
	appPackage := writeTestPackageWithDocumentation(t, "automation-app", "automation", "COMMANDS.md", testJSONCommand())

	state := registry.Activate(context.Background(), Activation{
		WorkspaceID: "ws-1",
		AppPackage:  appPackage,
		BaseURL:     "http://127.0.0.1:1",
	})
	if state.Status != workspacebiz.AppCLIStatusActive {
		t.Fatalf("Activate() state = %#v", state)
	}

	capabilities := registry.Capabilities(context.Background(), cliservice.InvokeContext{Source: "cli"})
	if len(capabilities) != 1 {
		t.Fatalf("capabilities = %#v", capabilities)
	}
	if capabilities[0].Source.DocumentationFile != "COMMANDS.md" {
		t.Fatalf("documentation file = %q", capabilities[0].Source.DocumentationFile)
	}
	if capabilities[0].Source.DocumentationPath != filepath.Join(appPackage.PackageDir, "COMMANDS.md") {
		t.Fatalf("documentation path = %q", capabilities[0].Source.DocumentationPath)
	}
}

func TestRegistryActivateRejectsMissingDocumentationFile(t *testing.T) {
	registry := NewRegistry(fakeWorkspaceCatalog{workspaceID: "ws-1"}, nil)
	appPackage := writeTestPackageWithDocumentation(t, "automation-app", "automation", "MISSING.md", testJSONCommand())

	state := registry.Activate(context.Background(), Activation{
		WorkspaceID: "ws-1",
		AppPackage:  appPackage,
		BaseURL:     "http://127.0.0.1:1",
	})
	if state.Status != workspacebiz.AppCLIStatusError || len(state.Issues) != 1 || state.Issues[0].Code != "app_cli_documentation_missing" {
		t.Fatalf("Activate() state = %#v", state)
	}
}

func TestRegistryScopeConflictKeepsDeterministicWinner(t *testing.T) {
	registry := NewRegistry(fakeWorkspaceCatalog{workspaceID: "ws-1"}, nil)
	loser := writeTestPackage(t, "z-app", "automation", testJSONCommand())
	winner := writeTestPackage(t, "a-app", "automation", testJSONCommand())

	registry.Activate(context.Background(), Activation{WorkspaceID: "ws-1", AppPackage: loser, BaseURL: "http://127.0.0.1:1"})
	registry.Activate(context.Background(), Activation{WorkspaceID: "ws-1", AppPackage: winner, BaseURL: "http://127.0.0.1:1"})

	capabilities := registry.Capabilities(context.Background(), cliservice.InvokeContext{WorkspaceID: "ws-1"})
	if len(capabilities) != 1 || capabilities[0].Source.AppID != "a-app" {
		t.Fatalf("capabilities = %#v", capabilities)
	}
	loserState := registry.Status("ws-1", workspacebiz.WorkspaceApp{Package: loser, Installation: &workspacebiz.AppInstallation{WorkspaceID: "ws-1", AppID: "z-app", Enabled: true}})
	if loserState.Status != workspacebiz.AppCLIStatusWarning || len(loserState.Issues) != 1 {
		t.Fatalf("loser state = %#v", loserState)
	}
}

func TestRegistryInvokeIgnoresUnknownInput(t *testing.T) {
	var envelope map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
			t.Fatalf("decode envelope: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"kind":"json","value":{"ok":true}}`))
	}))
	defer server.Close()

	registry := NewRegistry(fakeWorkspaceCatalog{workspaceID: "ws-1"}, fakeRuntime{baseURL: server.URL})
	appPackage := writeTestPackage(t, "automation-app", "automation", testJSONCommand())
	registry.Activate(context.Background(), Activation{WorkspaceID: "ws-1", AppPackage: appPackage, BaseURL: server.URL})

	output, err := registry.Invoke(context.Background(), cliservice.InvokeRequest{
		CommandID: "app.automation-app.automation.run",
		Input:     map[string]any{"name": "daily", "unknown": "x"},
		Context:   cliservice.InvokeContext{WorkspaceID: "ws-1"},
	})
	if err != nil {
		t.Fatalf("Invoke() error = %v", err)
	}
	if output.Kind != cliservice.OutputModeJSON {
		t.Fatalf("output = %#v", output)
	}
	input, ok := envelope["input"].(map[string]any)
	if !ok || input["name"] != "daily" {
		t.Fatalf("envelope input = %#v", envelope["input"])
	}
	if _, ok := input["unknown"]; ok {
		t.Fatalf("unknown input was forwarded: %#v", input)
	}
}

func TestRegistryInvokePostsEnvelopeAndFillsTableColumns(t *testing.T) {
	var envelope map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/tutti/cli/run" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
			t.Fatalf("decode envelope: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"kind":"table","rows":[{"id":"job-1"}]}`))
	}))
	defer server.Close()

	registry := NewRegistry(fakeWorkspaceCatalog{workspaceID: "ws-1"}, fakeRuntime{baseURL: server.URL})
	appPackage := writeTestPackage(t, "automation-app", "automation", `[
    {
      "path": ["run"],
      "summary": "Run automation",
      "inputSchema": {"type":"object","properties":{"count":{"type":"integer"},"dry-run":{"type":"boolean"}},"required":["count"]},
      "output": {"defaultMode":"table","json":true,"table":{"columns":[{"key":"id","label":"ID"}]}},
      "handler": {"kind":"http","method":"POST","path":"/tutti/cli/run"}
    }
  ]`)
	registry.Activate(context.Background(), Activation{WorkspaceID: "ws-1", AppPackage: appPackage, BaseURL: server.URL})

	output, err := registry.Invoke(context.Background(), cliservice.InvokeRequest{
		CommandID: "app.automation-app.automation.run",
		Input:     map[string]any{"count": "2", "dry-run": "true"},
		Context:   cliservice.InvokeContext{WorkspaceID: "ws-1"},
	})
	if err != nil {
		t.Fatalf("Invoke() error = %v", err)
	}
	if output.Kind != cliservice.OutputModeTable || len(output.Columns) != 1 || output.Columns[0].Key != "id" {
		t.Fatalf("output = %#v", output)
	}
	if envelope["schemaVersion"] != invokeSchemaVersion || envelope["workspaceId"] != "ws-1" {
		t.Fatalf("envelope = %#v", envelope)
	}
	input, ok := envelope["input"].(map[string]any)
	if !ok || input["dry-run"] != true {
		t.Fatalf("envelope input = %#v", envelope["input"])
	}
}

func TestValidateManifestRejectsReservedHandlerPath(t *testing.T) {
	err := ValidateManifest(Manifest{
		SchemaVersion: ManifestSchemaVersion,
		Scope:         "automation",
		Commands: []ManifestCommand{{
			Path:    []string{"run"},
			Summary: "Run automation",
			Output:  ManifestCommandOutput{DefaultMode: cliservice.OutputModeJSON, JSON: true},
			Handler: ManifestCommandHandler{Kind: "http", Method: "POST", Path: "/run"},
		}},
	})
	if err == nil {
		t.Fatal("ValidateManifest() error = nil, want handler path error")
	}
}

type fakeWorkspaceCatalog struct {
	workspaceID string
}

func (f fakeWorkspaceCatalog) Startup(context.Context) (*workspacebiz.Summary, error) {
	return &workspacebiz.Summary{ID: f.workspaceID, Name: "Workspace"}, nil
}

func (fakeWorkspaceCatalog) Get(_ context.Context, workspaceID string) (workspacebiz.Summary, error) {
	return workspacebiz.Summary{ID: workspaceID, Name: "Workspace"}, nil
}

type fakeRuntime struct {
	baseURL string
}

func (f fakeRuntime) EnsureAppRunningForCLI(context.Context, string, string) (string, error) {
	return f.baseURL, nil
}

func writeTestPackage(t *testing.T, appID string, scope string, commandsJSON string) workspacebiz.AppPackage {
	return writeTestPackageWithDocumentation(t, appID, scope, "", commandsJSON)
}

func writeTestPackageWithDocumentation(t *testing.T, appID string, scope string, documentationFile string, commandsJSON string) workspacebiz.AppPackage {
	t.Helper()
	packageDir := t.TempDir()
	manifestPath := filepath.Join(packageDir, "tutti.cli.json")
	documentationJSON := ""
	if documentationFile != "" {
		documentationJSON = `,"documentation":{"file":"` + documentationFile + `"}`
		if documentationFile == "COMMANDS.md" {
			if err := os.WriteFile(filepath.Join(packageDir, documentationFile), []byte("# Commands\n"), 0o644); err != nil {
				t.Fatalf("write documentation: %v", err)
			}
		}
	}
	cliManifest := `{"schemaVersion":"tutti.app.cli.v1","scope":"` + scope + `","description":"Test CLI scope"` + documentationJSON + `,"commands":` + commandsJSON + `}`
	if err := os.WriteFile(manifestPath, []byte(cliManifest), 0o644); err != nil {
		t.Fatalf("write cli manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "icon.png"), []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, 0o644); err != nil {
		t.Fatalf("write icon: %v", err)
	}
	return workspacebiz.AppPackage{
		AppID:      appID,
		Version:    "0.1.0",
		PackageDir: packageDir,
		Manifest: workspacebiz.AppManifest{
			SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
			AppID:         appID,
			Version:       "0.1.0",
			Name:          appID,
			Description:   "Test app",
			Icon: workspacebiz.AppManifestIcon{
				Type: "image/png",
				Src:  "icon.png",
			},
			Runtime: workspacebiz.AppManifestRuntime{
				Bootstrap:       "bootstrap.sh",
				HealthcheckPath: "/healthz",
			},
			CLI: &workspacebiz.AppManifestCLI{Manifest: "tutti.cli.json"},
		},
	}
}

func testJSONCommand() string {
	return `[
    {
      "path": ["run"],
      "summary": "Run automation",
      "inputSchema": {"type":"object","properties":{"name":{"type":"string"}}},
      "output": {"defaultMode":"json","json":true},
      "handler": {"kind":"http","method":"POST","path":"/tutti/cli/run"}
    }
  ]`
}
