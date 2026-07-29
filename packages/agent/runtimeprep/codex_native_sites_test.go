package runtimeprep

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepareCodexNativeSites(t *testing.T) {
	t.Parallel()

	codexHome := t.TempDir()
	pluginRoot := filepath.Join(codexHome, "plugins", "cache", "openai-bundled", "sites", "1.0.0")
	mustMkdir(t, filepath.Join(pluginRoot, ".codex-plugin"))
	mustWrite(t, filepath.Join(pluginRoot, ".codex-plugin", "plugin.json"), `{"name":"sites"}`)
	mustWrite(t, filepath.Join(pluginRoot, "skills", "sites-building", "SKILL.md"), "# building\n")
	mustWrite(t, filepath.Join(pluginRoot, "skills", "sites-hosting", "SKILL.md"), "# hosting\n")
	mustWrite(t, filepath.Join(pluginRoot, ".app.json"), `{"apps":{"sites":{"id":"connector_1"}}}`)
	mustWrite(t, filepath.Join(codexHome, "config.toml"), `
[plugins."sites@openai-bundled"]
enabled = false
`)

	result, err := prepareCodexNativeSites(codexHome)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if !result.Prepared || !result.SkillsOK || !result.AppsManifestOK || result.OpenInCodexBridged {
		t.Fatalf("result = %#v", result)
	}
	if !strings.Contains(result.Reason, "open_in_codex") {
		t.Fatalf("reason should mention preview limitation: %#v", result)
	}
	content, _ := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if !strings.Contains(string(content), "enabled = true") {
		t.Fatalf("plugin should be enabled:\n%s", content)
	}

	plan, err := BuildCodexNativeCapabilityPlan(codexHome, NativeCapabilityResolveInput{})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.Backend(CodexNativeCapabilitySites) != CapabilityBackendCodexNative {
		entry, _ := plan.Entry(CodexNativeCapabilitySites)
		t.Fatalf("sites backend = %#v", entry)
	}
}

func TestPrepareCodexNativeSitesMissingSkills(t *testing.T) {
	t.Parallel()

	codexHome := t.TempDir()
	pluginRoot := filepath.Join(codexHome, "plugins", "cache", "openai-bundled", "sites", "1.0.0")
	mustMkdir(t, filepath.Join(pluginRoot, ".codex-plugin"))
	mustWrite(t, filepath.Join(pluginRoot, ".codex-plugin", "plugin.json"), `{}`)
	mustWrite(t, filepath.Join(codexHome, "config.toml"), "")
	result, err := prepareCodexNativeSites(codexHome)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if result.Prepared || !strings.Contains(result.Reason, "sites-building") {
		t.Fatalf("result = %#v", result)
	}
}
