package runtimeprep

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepareCodexNativeBrowserRequiresChromeBackend(t *testing.T) {
	t.Parallel()

	codexHome := t.TempDir()
	pluginRoot := filepath.Join(codexHome, "plugins", "cache", "openai-bundled", "browser", "1.0.0")
	mustMkdir(t, filepath.Join(pluginRoot, ".codex-plugin"))
	mustWrite(t, filepath.Join(pluginRoot, ".codex-plugin", "plugin.json"), `{"name":"browser"}`)
	mustWrite(t, filepath.Join(pluginRoot, "scripts", "browser-client.mjs"), "export {}\n")
	nodeRepl := filepath.Join(codexHome, "node_repl")
	mustWrite(t, nodeRepl, "#!/bin/sh\n")
	_ = os.Chmod(nodeRepl, 0o755)
	mustWrite(t, filepath.Join(codexHome, "config.toml"), `
[plugins."browser@openai-bundled"]
enabled = true

[features]
js_repl = false

[mcp_servers.node_repl]
command = "`+nodeRepl+`"
startup_timeout_sec = 90
enabled = true

[mcp_servers.node_repl.env]
BROWSER_USE_AVAILABLE_BACKENDS = "iab"
CODEX_HOME = "/tmp/old"
NODE_REPL_TRUSTED_CODE_PATHS = "/tmp/old"
`)

	unsupported, err := prepareCodexNativeBrowser(codexHome)
	if err != nil {
		t.Fatalf("prepare iab-only: %v", err)
	}
	if unsupported.Prepared || !unsupported.HostUnsupported {
		t.Fatalf("iab-only result = %#v", unsupported)
	}

	mustWrite(t, filepath.Join(codexHome, "config.toml"), `
[plugins."browser@openai-bundled"]
enabled = false

[features]
js_repl = false

[mcp_servers.node_repl]
command = "`+nodeRepl+`"
startup_timeout_sec = 90
enabled = true

[mcp_servers.node_repl.env]
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"
CODEX_HOME = "/tmp/old"
NODE_REPL_TRUSTED_CODE_PATHS = "/tmp/old"
`)

	prepared, err := prepareCodexNativeBrowser(codexHome)
	if err != nil {
		t.Fatalf("prepare chrome: %v", err)
	}
	if !prepared.Prepared || prepared.BrowserClient == "" {
		t.Fatalf("prepared = %#v", prepared)
	}
	content, _ := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	text := string(content)
	if !strings.Contains(text, "CODEX_HOME = "+strconvQuoteForTest(codexHome)) {
		t.Fatalf("session CODEX_HOME missing:\n%s", text)
	}
	if !strings.Contains(text, "js_repl = true") {
		t.Fatalf("js_repl should be enabled:\n%s", text)
	}
	if !strings.Contains(text, `enabled = true`) || !strings.Contains(text, `[plugins."browser@openai-bundled"]`) {
		t.Fatalf("browser plugin should be enabled:\n%s", text)
	}
	if !strings.Contains(text, "startup_timeout_sec = 90") {
		t.Fatalf("startup timeout should be preserved:\n%s", text)
	}

	plan, err := BuildCodexNativeCapabilityPlan(codexHome, NativeCapabilityResolveInput{TuttiBrowserOK: true})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.Backend(CodexNativeCapabilityBrowser) != CapabilityBackendCodexNative {
		entry, _ := plan.Entry(CodexNativeCapabilityBrowser)
		t.Fatalf("browser backend = %#v", entry)
	}
}

func TestPrepareCodexNativeBrowserMissingClient(t *testing.T) {
	t.Parallel()

	codexHome := t.TempDir()
	pluginRoot := filepath.Join(codexHome, "plugins", "cache", "openai-bundled", "browser", "1.0.0")
	mustMkdir(t, filepath.Join(pluginRoot, ".codex-plugin"))
	mustWrite(t, filepath.Join(pluginRoot, ".codex-plugin", "plugin.json"), `{}`)
	mustWrite(t, filepath.Join(codexHome, "config.toml"), `[plugins."browser@openai-bundled"]
enabled = true
`)
	result, err := prepareCodexNativeBrowser(codexHome)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if result.Prepared || !strings.Contains(result.Reason, "browser-client") {
		t.Fatalf("result = %#v", result)
	}
}
