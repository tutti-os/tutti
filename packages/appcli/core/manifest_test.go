package core

import "testing"

func TestValidateManifestRejectsReservedHandlerPath(t *testing.T) {
	err := ValidateManifest(Manifest{
		SchemaVersion: ManifestSchemaVersion,
		Scope:         "automation",
		Commands: []ManifestCommand{{
			Path:    []string{"run"},
			Summary: "Run automation",
			Output:  ManifestCommandOutput{DefaultMode: OutputModeJSON, JSON: true},
			Handler: ManifestCommandHandler{Kind: "http", Method: "POST", Path: "/run"},
		}},
	})
	if err == nil {
		t.Fatal("ValidateManifest() error = nil, want handler path error")
	}
}

func TestValidateManifestRejectsUnknownVisibility(t *testing.T) {
	err := ValidateManifest(Manifest{
		SchemaVersion: ManifestSchemaVersion,
		Scope:         "automation",
		Commands: []ManifestCommand{{
			Path:       []string{"run"},
			Summary:    "Run automation",
			Visibility: "private",
			Output:     ManifestCommandOutput{DefaultMode: OutputModeJSON, JSON: true},
			Handler:    ManifestCommandHandler{Kind: "http", Method: "POST", Path: "/tutti/cli/run"},
		}},
	})
	if err == nil {
		t.Fatal("ValidateManifest() error = nil, want visibility error")
	}
}

func TestValidateManifestAcceptsEnumAndDefaultInputAnnotations(t *testing.T) {
	err := ValidateManifest(Manifest{
		SchemaVersion: ManifestSchemaVersion,
		Scope:         "automation",
		Commands: []ManifestCommand{{
			Path:    []string{"create"},
			Summary: "Create automation",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"schedule-type": map[string]any{
						"type":        "string",
						"description": "Schedule type.",
						"enum":        []any{"manual", "interval", "daily", "weekly", "cron"},
						"default":     "manual",
					},
					"enabled": map[string]any{
						"type":    "boolean",
						"default": true,
					},
					"interval-minutes": map[string]any{
						"type":    "integer",
						"default": 60,
					},
				},
			},
			Output:  ManifestCommandOutput{DefaultMode: OutputModeJSON, JSON: true},
			Handler: ManifestCommandHandler{Kind: "http", Method: "POST", Path: "/tutti/cli/create"},
		}},
	})
	if err != nil {
		t.Fatalf("ValidateManifest() error = %v", err)
	}
}

func TestValidateManifestRejectsEnumValuesWithWrongType(t *testing.T) {
	err := ValidateManifest(Manifest{
		SchemaVersion: ManifestSchemaVersion,
		Scope:         "automation",
		Commands: []ManifestCommand{{
			Path:    []string{"create"},
			Summary: "Create automation",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"schedule-type": map[string]any{
						"type": "string",
						"enum": []any{"manual", 1},
					},
				},
			},
			Output:  ManifestCommandOutput{DefaultMode: OutputModeJSON, JSON: true},
			Handler: ManifestCommandHandler{Kind: "http", Method: "POST", Path: "/tutti/cli/create"},
		}},
	})
	if err == nil {
		t.Fatal("ValidateManifest() error = nil, want enum type error")
	}
}

func TestBuildCommandsBuildsAppCapability(t *testing.T) {
	manifest := Manifest{
		SchemaVersion: ManifestSchemaVersion,
		Scope:         "automation",
		Description:   "Automation commands",
		Commands: []ManifestCommand{{
			Path:        []string{"run"},
			Summary:     "Run automation",
			Description: "Runs a job",
			Visibility:  CommandVisibilityIntegration,
			InputSchema: map[string]any{"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string"}}},
			Output:      ManifestCommandOutput{DefaultMode: OutputModeJSON, JSON: true},
			Handler:     ManifestCommandHandler{Kind: "http", Method: "POST", Path: "/tutti/cli/run"},
		}},
	}

	commands := BuildCommands(manifest, CommandBuildOptions{
		AppID:             "automation-app",
		AppName:           "Automation",
		IconURL:           "data:image/png;base64,abc",
		AppDescription:    "Test app",
		DocumentationFile: "COMMANDS.md",
		DocumentationPath: "/tmp/COMMANDS.md",
	})

	if len(commands) != 1 {
		t.Fatalf("commands = %#v", commands)
	}
	capability := commands[0].Capability
	if capability.ID != "app.automation-app.automation.run" || capability.Path[0] != "automation" {
		t.Fatalf("capability = %#v", capability)
	}
	if capability.Source.AppID != "automation-app" || capability.Source.CLIDescription != "Automation commands" {
		t.Fatalf("capability source = %#v", capability.Source)
	}
	if capability.Visibility != CommandVisibilityIntegration {
		t.Fatalf("capability visibility = %q", capability.Visibility)
	}
}

func TestBuildCommandsDefaultsVisibilityToPublic(t *testing.T) {
	commands := BuildCommands(Manifest{
		SchemaVersion: ManifestSchemaVersion,
		Scope:         "automation",
		Commands: []ManifestCommand{{
			Path:    []string{"run"},
			Summary: "Run automation",
			Output:  ManifestCommandOutput{DefaultMode: OutputModeJSON, JSON: true},
			Handler: ManifestCommandHandler{Kind: "http", Method: "POST", Path: "/tutti/cli/run"},
		}},
	}, CommandBuildOptions{AppID: "automation-app"})

	if len(commands) != 1 || commands[0].Capability.Visibility != CommandVisibilityPublic {
		t.Fatalf("commands = %#v", commands)
	}
}
