package agentsidecar

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const cursorPluginDirEnv = "TUTTI_CURSOR_PLUGIN_DIR"

type CursorPreparer struct{}

func (CursorPreparer) Provider() string {
	return "cursor"
}

func (CursorPreparer) Prepare(_ context.Context, input ProviderPrepareInput) (ProviderPrepareResult, error) {
	pluginDir := filepath.Join(input.RuntimeRoot, "cursor-plugin", "tutti-cli")
	if err := installCursorTuttiPlugin(pluginDir, input.PrepareInput); err != nil {
		return ProviderPrepareResult{}, err
	}
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(pluginDir, "provider-plugin", true)
	}
	return ProviderPrepareResult{
		Cwd: input.Cwd,
		Env: []string{cursorPluginDirEnv + "=" + pluginDir},
	}, nil
}

func installCursorTuttiPlugin(pluginDir string, input PrepareInput) error {
	manifestDir := filepath.Join(pluginDir, ".cursor-plugin")
	if err := os.MkdirAll(manifestDir, 0o700); err != nil {
		return fmt.Errorf("create cursor plugin manifest directory: %w", err)
	}
	manifest := struct {
		Name        string            `json:"name"`
		DisplayName string            `json:"displayName"`
		Version     string            `json:"version"`
		Description string            `json:"description"`
		Author      map[string]string `json:"author"`
		License     string            `json:"license"`
		Skills      string            `json:"skills"`
	}{
		Name:        "tutti-cli",
		DisplayName: "Tutti CLI",
		Version:     "0.1.0",
		Description: "Tutti CLI skills for AgentGUI sessions.",
		Author: map[string]string{
			"name": "Tutti",
		},
		License: "UNLICENSED",
		Skills:  "./skills/",
	}
	content, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode cursor plugin manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(manifestDir, "plugin.json"), append(content, '\n'), 0o600); err != nil {
		return fmt.Errorf("write cursor plugin manifest: %w", err)
	}
	if _, err := installProviderNativeSkills(filepath.Join(pluginDir, "skills"), input); err != nil {
		return fmt.Errorf("install cursor tutti skill plugin: %w", err)
	}
	return nil
}
