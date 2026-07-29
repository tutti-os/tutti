package runtimeprep

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// CodexNativeSitesPrepareResult reports session-scoped Sites native prep.
type CodexNativeSitesPrepareResult struct {
	Prepared           bool
	PluginPath         string
	SkillsOK           bool
	AppsManifestOK     bool
	OpenInCodexBridged bool
	Reason             string
}

// prepareCodexNativeSites verifies Sites plugin skills/apps and enables the
// plugin in the session config. It never edits ~/.codex. Tutti does not bridge
// `open_in_codex`; build/hosting remain available and the reason records the
// preview limitation without inventing a Tutti fallback website generator.
func prepareCodexNativeSites(codexHome string) (CodexNativeSitesPrepareResult, error) {
	codexHome = strings.TrimSpace(codexHome)
	result := CodexNativeSitesPrepareResult{}
	if codexHome == "" {
		return result, fmt.Errorf("codex home is required")
	}

	pluginPath, ok := locateCodexPluginPackage(codexHome, CodexNativePluginSites)
	if !ok {
		result.Reason = "sites plugin package is not installed in session CODEX_HOME"
		return result, nil
	}
	result.PluginPath = pluginPath

	requiredSkills := []string{
		filepath.Join(pluginPath, "skills", "sites-building", "SKILL.md"),
		filepath.Join(pluginPath, "skills", "sites-hosting", "SKILL.md"),
	}
	for _, skillPath := range requiredSkills {
		if info, err := os.Stat(skillPath); err != nil || info.IsDir() {
			result.Reason = "sites plugin is missing required skill " + filepath.Base(filepath.Dir(skillPath))
			return result, nil
		}
	}
	result.SkillsOK = true

	appManifestPath := filepath.Join(pluginPath, ".app.json")
	raw, err := os.ReadFile(appManifestPath)
	if err != nil {
		result.Reason = "sites plugin is missing .app.json"
		return result, nil
	}
	var manifest struct {
		Apps map[string]any `json:"apps"`
	}
	if json.Unmarshal(raw, &manifest) != nil || len(manifest.Apps) == 0 {
		result.Reason = "sites plugin .app.json is invalid"
		return result, nil
	}
	result.AppsManifestOK = true

	configPath := filepath.Join(codexHome, "config.toml")
	contentBytes, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return result, fmt.Errorf("read session codex config: %w", err)
	}
	next, changed := codexConfigWithPluginEnabled(string(contentBytes), CodexNativePluginSites, true)
	if changed {
		if err := os.WriteFile(configPath, []byte(next), 0o600); err != nil {
			return result, fmt.Errorf("write session sites plugin enablement: %w", err)
		}
	}

	result.Prepared = true
	result.OpenInCodexBridged = false
	result.Reason = "sites native plugin ready; open_in_codex preview is not bridged in Tutti"
	return result, nil
}
