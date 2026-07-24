package runtimeprep

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCommandResolverRendersOnlyAdvertisedInputsAndOutputModes(t *testing.T) {
	resolver, err := newCommandResolver("tutti-dev", []CommandCapability{{
		ID:      "notes.note.create",
		Path:    []string{"notes", "create"},
		Summary: "Create note",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"title":  map[string]any{"type": "string"},
				"public": map[string]any{"type": "boolean"},
			},
			"required": []string{"title"},
		},
		Output: CommandCapabilityOutput{DefaultMode: "table", JSON: true},
		Source: CommandSource{Kind: CommandSourceApp, AppID: "notes", AppName: "Notes"},
	}})
	if err != nil {
		t.Fatal(err)
	}

	arguments, err := commandTemplateArguments("title", "Release notes", "public", true)
	if err != nil {
		t.Fatal(err)
	}
	command, err := resolver.Command("notes.note.create", arguments)
	if err != nil {
		t.Fatal(err)
	}
	if command != `tutti-dev notes create --title "Release notes" --public --json` {
		t.Fatalf("Command() = %q", command)
	}
	if !resolver.Has("notes.note.create") ||
		!resolver.HasAll("notes.note.create") ||
		!resolver.HasFamily("notes") ||
		!resolver.HasInput("notes.note.create", "public") {
		t.Fatalf("resolver lookup failed: %#v", resolver)
	}
	guide, err := resolver.Guide()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"Create note",
		"`tutti-dev notes create --title <title> --json`",
		"Provided by workspace app Notes.",
		"App id: notes.",
	} {
		if !strings.Contains(guide, want) {
			t.Fatalf("Guide() missing %q: %s", want, guide)
		}
	}
}

func TestCommandResolverRejectsInvalidSnapshotAndTemplateArguments(t *testing.T) {
	t.Run("duplicate command id", func(t *testing.T) {
		_, err := newCommandResolver("tutti", []CommandCapability{
			{ID: "same", Path: []string{"one"}},
			{ID: "same", Path: []string{"two"}},
		})
		if err == nil || !strings.Contains(err.Error(), "duplicated") {
			t.Fatalf("newCommandResolver() error = %v", err)
		}
	})

	t.Run("required input missing from schema", func(t *testing.T) {
		_, err := newCommandResolver("tutti", []CommandCapability{{
			ID:   "broken",
			Path: []string{"broken"},
			InputSchema: map[string]any{
				"properties": map[string]any{},
				"required":   []string{"missing"},
			},
		}})
		if err == nil || !strings.Contains(err.Error(), `requires unknown input "missing"`) {
			t.Fatalf("newCommandResolver() error = %v", err)
		}
	})

	t.Run("malformed input schema", func(t *testing.T) {
		_, err := newCommandResolver("tutti", []CommandCapability{{
			ID:          "broken",
			Path:        []string{"broken"},
			InputSchema: map[string]any{"properties": "not-an-object"},
		}})
		if err == nil || !strings.Contains(err.Error(), "invalid properties schema") {
			t.Fatalf("newCommandResolver() error = %v", err)
		}
	})

	resolver, err := newCommandResolver("tutti", []CommandCapability{{
		ID:   "agent.get",
		Path: []string{"agent", "get"},
		InputSchema: map[string]any{"properties": map[string]any{
			"view": map[string]any{"type": "string", "enum": []string{"recent", "turns"}},
		}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	for name, arguments := range map[string]commandArguments{
		"unknown flag": {values: []commandArgument{{name: "bogus", value: "x"}}},
		"invalid enum": {values: []commandArgument{{name: "view", value: "trace"}}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := resolver.Command("agent.get", arguments); err == nil {
				t.Fatalf("Command() error = nil")
			}
		})
	}
	if _, err := resolver.Command("agent.missing"); err == nil {
		t.Fatal("Command() accepted unknown command")
	}
}

func TestCommandResolverOwnsImmutableSnapshot(t *testing.T) {
	schema := map[string]any{
		"properties": map[string]any{"id": map[string]any{"type": "string"}},
		"required":   []string{"id"},
	}
	table := &CommandTableOutput{Columns: []CommandTableColumn{{Key: "id", Label: "ID"}}}
	capabilities := []CommandCapability{{
		ID:          "item.get",
		Path:        []string{"item", "get"},
		InputSchema: schema,
		Output:      CommandCapabilityOutput{JSON: true, Table: table},
	}}
	resolver, err := newCommandResolver("tutti", capabilities)
	if err != nil {
		t.Fatal(err)
	}

	capabilities[0].Path[0] = "mutated"
	mapSchemaValue(schema["properties"])["id"] = map[string]any{"type": "boolean"}
	table.Columns[0].Label = "Mutated"

	command, err := resolver.Command("item.get")
	if err != nil {
		t.Fatal(err)
	}
	if command != "tutti item get --id <id> --json" {
		t.Fatalf("Command() changed after source mutation: %q", command)
	}
	capability, ok := resolver.capability("item.get")
	if !ok || capability.Output.Table.Columns[0].Label != "ID" {
		t.Fatalf("output metadata changed after source mutation: %#v", capability.Output)
	}
}

func TestResolveCommandCapabilitiesFiltersIntegrationAndAddsWaitTimeout(t *testing.T) {
	catalog := staticCommandCatalog{
		{
			ID:            "public.wait",
			Path:          []string{"public", "wait"},
			ExecutionMode: "wait",
			InputSchema:   map[string]any{"properties": map[string]any{}},
		},
		{
			ID:         "browser.hidden",
			Path:       []string{"browser", "navigate"},
			Visibility: "integration",
		},
	}
	resolver, err := resolveCommandCapabilities(context.Background(), catalog, "workspace-1", "tutti")
	if err != nil {
		t.Fatal(err)
	}
	if !resolver.HasInput("public.wait", "timeout-ms") {
		t.Fatal("wait command missing wrapper-owned timeout input")
	}
	if resolver.Has("browser.hidden") || resolver.HasFamily("browser") {
		t.Fatal("integration command leaked into agent-facing snapshot")
	}
	if _, err := resolveCommandCapabilities(context.Background(), nil, "workspace-1", "tutti"); err == nil {
		t.Fatal("nil command catalog did not fail")
	}
}

func TestPrepareRejectsMissingCommandCatalogBeforeCreatingRuntimeState(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	_, err := NewDefaultPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "codex",
		Cwd:            root,
	})
	if err == nil || !strings.Contains(err.Error(), "requires a command catalog") {
		t.Fatalf("Prepare() error = %v", err)
	}
	if _, statErr := os.Stat(stateDir); !os.IsNotExist(statErr) {
		t.Fatalf("runtime state exists after catalog failure: %v", statErr)
	}
}
