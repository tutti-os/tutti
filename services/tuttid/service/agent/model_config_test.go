package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadClaudeCodeConfiguredDefaultModelKeepsConcreteModel(t *testing.T) {
	configDir := t.TempDir()
	settingsPath := filepath.Join(configDir, "settings.json")
	if err := os.WriteFile(settingsPath, []byte(`{"model":"claude-opus-4-6"}`), 0o600); err != nil {
		t.Fatalf("write settings.json: %v", err)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)

	if got := readClaudeCodeConfiguredDefaultModel(); got != "claude-opus-4-6" {
		t.Fatalf("readClaudeCodeConfiguredDefaultModel() = %q, want claude-opus-4-6", got)
	}
}

func TestReadClaudeCodeConfiguredDefaultModelSurfacesInCatalog(t *testing.T) {
	configDir := t.TempDir()
	settingsPath := filepath.Join(configDir, "settings.json")
	if err := os.WriteFile(settingsPath, []byte(`{"model":"claude-opus-4-6"}`), 0o600); err != nil {
		t.Fatalf("write settings.json: %v", err)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)

	models := listClaudeCodeModels()
	var found bool
	for _, model := range models {
		if model.ID == "claude-opus-4-6" {
			found = true
			if !model.IsDefault {
				t.Fatalf("model %q should be marked default", model.ID)
			}
		}
	}
	if !found {
		t.Fatalf("listClaudeCodeModels() = %#v, want it to include configured default claude-opus-4-6", models)
	}
}
