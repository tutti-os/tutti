package workbenchapps

import (
	"context"
	"errors"
	"testing"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

type fakeCommandCatalog struct {
	caps       []cliservice.Capability
	gotContext cliservice.InvokeContext
}

func (f *fakeCommandCatalog) Capabilities(_ context.Context, ic cliservice.InvokeContext) []cliservice.Capability {
	f.gotContext = ic
	return f.caps
}

func sampleCatalog() *fakeCommandCatalog {
	return &fakeCommandCatalog{caps: []cliservice.Capability{
		{
			ID:      "issue-manager.issue.list",
			Path:    []string{"issue", "list"},
			Summary: "List issues",
			Source:  cliservice.CapabilitySource{Kind: cliservice.CapabilitySourceBuiltin},
		},
		{
			ID:          "ai-doc.doc.read",
			Path:        []string{"doc", "read"},
			Summary:     "Read doc",
			Description: "Read the document.",
			Visibility:  cliservice.CapabilityVisibilityPublic,
			InputSchema: map[string]any{"required": []any{"doc-id"}},
			Source: cliservice.CapabilitySource{
				Kind:           cliservice.CapabilitySourceApp,
				AppID:          "ai-doc",
				AppName:        "AI Doc",
				AppDescription: "Collaborative docs.",
			},
		},
		{
			ID:      "ai-doc.doc.write",
			Path:    []string{"doc", "write"},
			Summary: "Write doc",
			Source: cliservice.CapabilitySource{
				Kind:    cliservice.CapabilitySourceApp,
				AppID:   "ai-doc",
				AppName: "AI Doc",
			},
		},
		{
			ID:      "ai-media-canvas.aimc.open",
			Path:    []string{"aimc", "open"},
			Summary: "Open canvas",
			Source: cliservice.CapabilitySource{
				Kind:    cliservice.CapabilitySourceApp,
				AppID:   "ai-media-canvas",
				AppName: "AI Canvas",
			},
		},
	}}
}

func appsFromOutput(t *testing.T, out cliservice.CommandOutput) []map[string]any {
	t.Helper()
	raw, ok := out.Value["apps"].([]map[string]any)
	if !ok {
		t.Fatalf("output value missing apps: %#v", out.Value)
	}
	return raw
}

func runCommands(t *testing.T, catalog CommandCatalog, input map[string]any) (cliservice.CommandOutput, error) {
	t.Helper()
	cmd := NewCommandsCommand(fakeWorkspaceCatalog{startupID: "ws-1"}, catalog)
	return cmd.Handler(context.Background(), cliservice.InvokeRequest{
		Context: cliservice.InvokeContext{Source: "agent-runtime"},
		Input:   input,
	})
}

func TestAppCommandsByAppID(t *testing.T) {
	catalog := sampleCatalog()
	out, err := runCommands(t, catalog, map[string]any{"app-id": "ai-doc"})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	apps := appsFromOutput(t, out)
	if len(apps) != 1 || apps[0]["appId"] != "ai-doc" {
		t.Fatalf("expected only ai-doc, got %#v", apps)
	}
	commands, _ := apps[0]["commands"].([]map[string]any)
	if len(commands) != 2 {
		t.Fatalf("expected 2 ai-doc commands, got %#v", commands)
	}
	// Sorted by id: doc.read before doc.write.
	if commands[0]["id"] != "ai-doc.doc.read" || commands[0]["command"] != "doc read" {
		t.Fatalf("unexpected first command: %#v", commands[0])
	}
	if required, _ := commands[0]["required"].([]string); len(required) != 1 || required[0] != "doc-id" {
		t.Fatalf("required not extracted: %#v", commands[0]["required"])
	}
	// Table rows carry only ai-doc.
	for _, row := range out.Rows {
		if row["appId"] != "ai-doc" {
			t.Fatalf("unexpected row app: %#v", row)
		}
	}
	// Builtin capability must be excluded.
	if catalog.gotContext.WorkspaceID != "ws-1" {
		t.Fatalf("workspace not resolved into context: %#v", catalog.gotContext)
	}
}

func TestAppCommandsAll(t *testing.T) {
	out, err := runCommands(t, sampleCatalog(), map[string]any{"all": true})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	apps := appsFromOutput(t, out)
	if len(apps) != 2 {
		t.Fatalf("expected 2 apps, got %#v", apps)
	}
	// Sorted by app id: ai-doc before ai-media-canvas.
	if apps[0]["appId"] != "ai-doc" || apps[1]["appId"] != "ai-media-canvas" {
		t.Fatalf("apps not sorted: %#v", apps)
	}
	total, _ := out.Value["totalCommands"].(int)
	if total != 3 {
		t.Fatalf("expected 3 total commands (builtin excluded), got %d", total)
	}
}

func TestAppCommandsRequiresAppIDOrAll(t *testing.T) {
	_, err := runCommands(t, sampleCatalog(), map[string]any{})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("expected invalid-input error, got %v", err)
	}
}

func TestAppCommandsRejectsAppIDWithAll(t *testing.T) {
	_, err := runCommands(t, sampleCatalog(), map[string]any{"app-id": "ai-doc", "all": true})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("expected invalid-input error, got %v", err)
	}
}

func TestAppCommandsUnknownAppReturnsEmpty(t *testing.T) {
	out, err := runCommands(t, sampleCatalog(), map[string]any{"app-id": "nope"})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(appsFromOutput(t, out)) != 0 || len(out.Rows) != 0 {
		t.Fatalf("expected empty result, got %#v", out)
	}
}

func TestNewCommandsCommandCapabilityShape(t *testing.T) {
	cmd := NewCommandsCommand(fakeWorkspaceCatalog{startupID: "ws-1"}, sampleCatalog())
	cap := cmd.Capability
	if cap.ID != "workspace-apps.app.commands" {
		t.Fatalf("unexpected id: %q", cap.ID)
	}
	if len(cap.Path) != 2 || cap.Path[0] != "app" || cap.Path[1] != "commands" {
		t.Fatalf("unexpected path: %#v", cap.Path)
	}
	if cap.Summary == "" || cap.Description == "" {
		t.Fatalf("summary/description must be set")
	}
	if typ, _ := cap.InputSchema["type"].(string); typ != "object" {
		t.Fatalf("input schema type = %v", cap.InputSchema["type"])
	}
}
