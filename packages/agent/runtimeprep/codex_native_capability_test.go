package runtimeprep

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveNativeCapabilityPlanAutoNativeFirst(t *testing.T) {
	t.Parallel()

	evidence := []CodexNativeCapabilityEvidence{
		{
			PluginID: CodexNativePluginBrowser, Capability: CodexNativeCapabilityBrowser,
			Installed: true, Enabled: true,
		},
		{
			PluginID: CodexNativePluginComputerUse, Capability: CodexNativeCapabilityComputer,
			Installed: true, Enabled: false,
		},
		{
			PluginID: CodexNativePluginSites, Capability: CodexNativeCapabilitySites,
			Installed: false, Enabled: false,
		},
	}
	plan := ResolveNativeCapabilityPlan("/tmp/codex-home", evidence, NativeCapabilityResolveInput{
		TuttiBrowserOK:  true,
		TuttiComputerOK: true,
	})

	browser, ok := plan.Entry(CodexNativeCapabilityBrowser)
	if !ok || browser.Backend != CapabilityBackendCodexNative || browser.State != NativeCapabilityReady {
		t.Fatalf("browser = %#v", browser)
	}
	computer, ok := plan.Entry(CodexNativeCapabilityComputer)
	if !ok || computer.Backend != CapabilityBackendTuttiDaemon || computer.State != NativeCapabilityDisabled {
		t.Fatalf("computer = %#v", computer)
	}
	sites, ok := plan.Entry(CodexNativeCapabilitySites)
	if !ok || sites.Backend != CapabilityBackendUnavailable || sites.State != NativeCapabilityNotInstalled {
		t.Fatalf("sites = %#v", sites)
	}
}

func TestResolveNativeCapabilityPlanExplicitNativeNeverSilentFallback(t *testing.T) {
	t.Parallel()

	evidence := []CodexNativeCapabilityEvidence{{
		PluginID: CodexNativePluginBrowser, Capability: CodexNativeCapabilityBrowser,
		Installed: false, Enabled: false,
	}}
	plan := ResolveNativeCapabilityPlan("/tmp/codex-home", evidence, NativeCapabilityResolveInput{
		BrowserPreference: CapabilityBackendPreferenceNative,
		TuttiBrowserOK:    true,
	})
	browser, ok := plan.Entry(CodexNativeCapabilityBrowser)
	if !ok || browser.Backend != CapabilityBackendUnavailable || !browser.Explicit {
		t.Fatalf("explicit native must not fall back: %#v", browser)
	}
}

func TestResolveNativeCapabilityPlanExplicitTutti(t *testing.T) {
	t.Parallel()

	evidence := []CodexNativeCapabilityEvidence{{
		PluginID: CodexNativePluginComputerUse, Capability: CodexNativeCapabilityComputer,
		Installed: true, Enabled: true,
	}}
	plan := ResolveNativeCapabilityPlan("/tmp/codex-home", evidence, NativeCapabilityResolveInput{
		ComputerPreference: CapabilityBackendPreferenceTutti,
		TuttiComputerOK:    true,
	})
	computer, ok := plan.Entry(CodexNativeCapabilityComputer)
	if !ok || computer.Backend != CapabilityBackendTuttiDaemon || !computer.Explicit {
		t.Fatalf("computer = %#v", computer)
	}
}

func TestInspectCodexNativeCapabilityEvidenceFromSessionHome(t *testing.T) {
	t.Parallel()

	codexHome := t.TempDir()
	browserInstall := filepath.Join(codexHome, "plugins", "cache", "openai-bundled", "browser", "1.0.0")
	sitesInstall := filepath.Join(codexHome, "plugins", "cache", "openai-bundled", "sites", "1.0.0")
	mustMkdir(t, filepath.Join(browserInstall, ".codex-plugin"))
	mustWrite(t, filepath.Join(browserInstall, ".codex-plugin", "plugin.json"), `{"name":"browser"}`)
	mustMkdir(t, filepath.Join(sitesInstall, ".codex-plugin"))
	mustWrite(t, filepath.Join(sitesInstall, ".codex-plugin", "plugin.json"), `{"name":"sites"}`)
	mustMkdir(t, filepath.Join(sitesInstall, "skills", "sites-building"))
	mustWrite(t, filepath.Join(sitesInstall, "skills", "sites-building", "SKILL.md"), "# building\n")
	mustMkdir(t, filepath.Join(sitesInstall, "skills", "sites-hosting"))
	mustWrite(t, filepath.Join(sitesInstall, "skills", "sites-hosting", "SKILL.md"), "# hosting\n")

	nodeRepl := filepath.Join(codexHome, "node_repl")
	mustWrite(t, nodeRepl, "#!/bin/sh\n")
	if err := os.Chmod(nodeRepl, 0o755); err != nil {
		t.Fatalf("chmod node_repl: %v", err)
	}

	config := `
[plugins."browser@openai-bundled"]
enabled = true

[plugins."computer-use@openai-bundled"]
enabled = true

[plugins."sites@openai-bundled"]
enabled = true

[mcp_servers.node_repl]
command = "` + nodeRepl + `"
enabled = true

[mcp_servers.node_repl.env]
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"

[mcp_servers.computer-use]
command = "./relative/SkyComputerUseClient"
cwd = "."
enabled = false
`
	mustWrite(t, filepath.Join(codexHome, "config.toml"), config)

	evidence, err := InspectCodexNativeCapabilityEvidence(codexHome)
	if err != nil {
		t.Fatalf("InspectCodexNativeCapabilityEvidence: %v", err)
	}
	byCapability := map[string]CodexNativeCapabilityEvidence{}
	for _, item := range evidence {
		byCapability[item.Capability] = item
	}

	browser := byCapability[CodexNativeCapabilityBrowser]
	if !browser.Installed || !browser.Enabled || browser.MCPEnabled == nil || !*browser.MCPEnabled {
		t.Fatalf("browser evidence = %#v", browser)
	}
	if len(browser.DependencyNotes) != 0 || browser.HostUnsupported {
		t.Fatalf("browser should be dependency-ready: %#v", browser)
	}

	computer := byCapability[CodexNativeCapabilityComputer]
	if !computer.Enabled || computer.Installed {
		t.Fatalf("computer evidence = %#v", computer)
	}
	if computer.MCPEnabled == nil || *computer.MCPEnabled {
		t.Fatalf("computer MCP should be disabled: %#v", computer)
	}

	sites := byCapability[CodexNativeCapabilitySites]
	if !sites.Installed || !sites.Enabled || len(sites.DependencyNotes) != 0 {
		t.Fatalf("sites evidence = %#v", sites)
	}

	plan := ResolveNativeCapabilityPlan(codexHome, evidence, NativeCapabilityResolveInput{
		TuttiBrowserOK:  true,
		TuttiComputerOK: true,
	})
	if plan.Backend(CodexNativeCapabilityBrowser) != CapabilityBackendCodexNative {
		t.Fatalf("browser backend = %s", plan.Backend(CodexNativeCapabilityBrowser))
	}
	if plan.Backend(CodexNativeCapabilityComputer) != CapabilityBackendTuttiDaemon {
		t.Fatalf("computer backend = %s", plan.Backend(CodexNativeCapabilityComputer))
	}
	if plan.Backend(CodexNativeCapabilitySites) != CapabilityBackendCodexNative {
		t.Fatalf("sites backend = %s", plan.Backend(CodexNativeCapabilitySites))
	}
}

func TestInspectCodexNativeCapabilityEvidenceMarksIABOnlyAsHostUnsupported(t *testing.T) {
	t.Parallel()

	codexHome := t.TempDir()
	browserInstall := filepath.Join(codexHome, "plugins", "cache", "openai-bundled", "browser", "1.0.0")
	mustMkdir(t, filepath.Join(browserInstall, ".codex-plugin"))
	mustWrite(t, filepath.Join(browserInstall, ".codex-plugin", "plugin.json"), `{}`)
	nodeRepl := filepath.Join(codexHome, "node_repl")
	mustWrite(t, nodeRepl, "#!/bin/sh\n")
	_ = os.Chmod(nodeRepl, 0o755)
	mustWrite(t, filepath.Join(codexHome, "config.toml"), `
[plugins."browser@openai-bundled"]
enabled = true

[mcp_servers.node_repl]
command = "`+nodeRepl+`"
enabled = true

[mcp_servers.node_repl.env]
BROWSER_USE_AVAILABLE_BACKENDS = "iab"
`)

	evidence, err := InspectCodexNativeCapabilityEvidence(codexHome)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	var browser CodexNativeCapabilityEvidence
	for _, item := range evidence {
		if item.Capability == CodexNativeCapabilityBrowser {
			browser = item
		}
	}
	if !browser.HostUnsupported {
		t.Fatalf("iab-only browser must be host_unsupported: %#v", browser)
	}
	plan := ResolveNativeCapabilityPlan(codexHome, evidence, NativeCapabilityResolveInput{TuttiBrowserOK: true})
	entry, _ := plan.Entry(CodexNativeCapabilityBrowser)
	if entry.State != NativeCapabilityHostUnsupported || entry.Backend != CapabilityBackendTuttiDaemon {
		t.Fatalf("entry = %#v", entry)
	}
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir parent %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
