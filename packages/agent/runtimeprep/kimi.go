package runtimeprep

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const kimiCodeHomeEnv = "KIMI_CODE_HOME"

const kimiRTKPluginManifest = `{
  "name": "tutti-rtk",
  "version": "0.1.0",
  "description": "Tutti session-scoped RTK shell-command policy.",
  "systemPrompt": "RTK is installed and available on PATH for this session. For every supported shell command, you MUST invoke it through RTK by prefixing the command with ` + "`rtk`" + `. Examples: ` + "`rtk ls -la`" + `, ` + "`rtk git status`" + `, ` + "`rtk go test ./...`" + `. Use ` + "`rtk proxy <command>`" + ` only when raw output is required. This requirement applies to every Bash tool call."
}
`

type kimiInstalledFile struct {
	Version int              `json:"version"`
	Plugins []map[string]any `json:"plugins"`
}

// KimiCodePreparer adds an enabled, session-scoped Kimi plugin because Kimi
// treats AGENTS.md as project reference data. Plugin systemPrompt content is
// part of Kimi's native system prompt and is therefore reliable for RTK policy.
type KimiCodePreparer struct{}

func (KimiCodePreparer) Provider() string { return "acp:kimi-code" }

func (KimiCodePreparer) Prepare(ctx context.Context, input ProviderPrepareInput) (ProviderPrepareResult, error) {
	base, err := (InstructionFilePreparer{}).Prepare(ctx, input)
	if err != nil || !input.RTKSaverMode {
		return base, err
	}

	sessionHome := filepath.Join(input.RuntimeRoot, "kimi-code")
	if err := os.MkdirAll(sessionHome, 0o700); err != nil {
		return ProviderPrepareResult{}, fmt.Errorf("create Kimi session home: %w", err)
	}
	sourceHome := resolveKimiCodeSourceHome()
	for _, name := range []string{
		"config.toml",
		"device_id",
		filepath.Join("oauth", "kimi-code"),
		filepath.Join("credentials", "kimi-code.json"),
	} {
		if sourceHome == "" {
			break
		}
		if err := copyExtensionRuntimeHomeFile(filepath.Join(sourceHome, name), filepath.Join(sessionHome, name)); err != nil {
			return ProviderPrepareResult{}, err
		}
	}
	if err := prepareKimiRTKPlugin(sourceHome, sessionHome); err != nil {
		return ProviderPrepareResult{}, err
	}
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(sessionHome, "provider-kimi-home", true)
	}
	base.Env = append(base.Env, kimiCodeHomeEnv+"="+sessionHome)
	return base, nil
}

func resolveKimiCodeSourceHome() string {
	if value := strings.TrimSpace(os.Getenv(kimiCodeHomeEnv)); value != "" {
		return value
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return ""
	}
	return filepath.Join(home, ".kimi-code")
}

func prepareKimiRTKPlugin(sourceHome, sessionHome string) error {
	pluginRoot := filepath.Join(sessionHome, "plugins", "managed", "tutti-rtk")
	if err := os.MkdirAll(pluginRoot, 0o700); err != nil {
		return fmt.Errorf("create Kimi RTK plugin directory: %w", err)
	}
	if err := os.WriteFile(filepath.Join(pluginRoot, "kimi.plugin.json"), []byte(kimiRTKPluginManifest), 0o600); err != nil {
		return fmt.Errorf("write Kimi RTK plugin manifest: %w", err)
	}

	installed := kimiInstalledFile{Version: 1, Plugins: []map[string]any{}}
	if sourceHome != "" {
		path := filepath.Join(sourceHome, "plugins", "installed.json")
		if data, err := os.ReadFile(path); err == nil {
			if err := json.Unmarshal(data, &installed); err != nil {
				return fmt.Errorf("parse Kimi installed plugins: %w", err)
			}
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("read Kimi installed plugins: %w", err)
		}
	}
	installed.Version = 1
	rtkPlugin := map[string]any{
		"id":          "tutti-rtk",
		"root":        pluginRoot,
		"source":      "local-path",
		"enabled":     true,
		"installedAt": "1970-01-01T00:00:00Z",
	}
	found := false
	for i := range installed.Plugins {
		if installed.Plugins[i]["id"] == "tutti-rtk" {
			installed.Plugins[i] = rtkPlugin
			found = true
			break
		}
	}
	if !found {
		installed.Plugins = append(installed.Plugins, rtkPlugin)
	}
	data, err := json.MarshalIndent(installed, "", "  ")
	if err != nil {
		return fmt.Errorf("encode Kimi installed plugins: %w", err)
	}
	installedPath := filepath.Join(sessionHome, "plugins", "installed.json")
	if err := os.WriteFile(installedPath, append(data, '\n'), 0o600); err != nil {
		return fmt.Errorf("write Kimi installed plugins: %w", err)
	}
	return nil
}
