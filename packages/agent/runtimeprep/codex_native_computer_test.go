package runtimeprep

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepareCodexNativeComputerUseRequiresAuthorizationToEnable(t *testing.T) {
	t.Parallel()

	codexHome := t.TempDir()
	pluginRoot := filepath.Join(codexHome, "market", "plugins", "computer-use")
	mustMkdir(t, filepath.Join(pluginRoot, ".codex-plugin"))
	mustWrite(t, filepath.Join(pluginRoot, ".codex-plugin", "plugin.json"), `{"name":"computer-use"}`)
	launcher := filepath.Join(pluginRoot, "bin", "computer-use-client-launcher")
	mustWrite(t, launcher, "#!/bin/sh\n")
	_ = os.Chmod(launcher, 0o755)
	mustWrite(t, filepath.Join(pluginRoot, ".mcp.json"), `{
  "mcpServers": {
    "computer-use": {
      "command": "./bin/computer-use-client-launcher",
      "args": ["mcp"],
      "cwd": ".",
      "env_vars": ["CODEX_HOME"]
    }
  }
}`)
	client := filepath.Join(codexHome, filepath.FromSlash(codexNativeComputerClientRel))
	mustWrite(t, client, "binary")
	_ = os.Chmod(client, 0o755)
	mustWrite(t, filepath.Join(codexHome, "config.toml"), `
[marketplaces.openai-bundled]
source = "`+filepath.Join(codexHome, "market")+`"

[mcp_servers.computer-use]
command = "./relative"
cwd = "."
enabled = false
`)

	unauthorized, err := prepareCodexNativeComputerUse(codexHome, false)
	if err != nil {
		t.Fatalf("prepare unauthorized: %v", err)
	}
	if unauthorized.Prepared || !strings.Contains(unauthorized.Reason, "authorization") {
		t.Fatalf("unauthorized result = %#v", unauthorized)
	}
	content, _ := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if strings.Contains(string(content), "enabled = true") {
		t.Fatalf("unauthorized prepare must not enable MCP: %s", content)
	}

	authorized, err := prepareCodexNativeComputerUse(codexHome, true)
	if err != nil {
		t.Fatalf("prepare authorized: %v", err)
	}
	if !authorized.Prepared || authorized.LauncherPath != launcher {
		t.Fatalf("authorized result = %#v", authorized)
	}
	content, _ = os.ReadFile(filepath.Join(codexHome, "config.toml"))
	text := string(content)
	if !strings.Contains(text, "command = "+strconvQuoteForTest(launcher)) {
		t.Fatalf("expected absolute launcher in config:\n%s", text)
	}
	if !strings.Contains(text, `CODEX_HOME = `+strconvQuoteForTest(codexHome)) {
		t.Fatalf("expected session CODEX_HOME env:\n%s", text)
	}
	if !strings.Contains(text, `[plugins."computer-use@openai-bundled"]`) || !strings.Contains(text, "enabled = true") {
		t.Fatalf("expected plugin enablement:\n%s", text)
	}
	if strings.Contains(text, `command = "./relative"`) {
		t.Fatalf("relative command must be replaced:\n%s", text)
	}

	plan, err := BuildCodexNativeCapabilityPlan(codexHome, NativeCapabilityResolveInput{TuttiComputerOK: true})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.Backend(CodexNativeCapabilityComputer) != CapabilityBackendCodexNative {
		entry, _ := plan.Entry(CodexNativeCapabilityComputer)
		t.Fatalf("computer backend after prepare = %#v", entry)
	}
}

func TestPrepareCodexNativeComputerUseRepairsEnabledRelativeCommandWithoutAuth(t *testing.T) {
	t.Parallel()

	codexHome := t.TempDir()
	pluginRoot := filepath.Join(codexHome, "plugins", "cache", "openai-bundled", "computer-use", "1.0.0")
	mustMkdir(t, filepath.Join(pluginRoot, ".codex-plugin"))
	mustWrite(t, filepath.Join(pluginRoot, ".codex-plugin", "plugin.json"), `{}`)
	launcher := filepath.Join(pluginRoot, "bin", "computer-use-client-launcher")
	mustWrite(t, launcher, "#!/bin/sh\n")
	_ = os.Chmod(launcher, 0o755)
	mustWrite(t, filepath.Join(pluginRoot, ".mcp.json"), `{
  "mcpServers":{"computer-use":{"command":"./bin/computer-use-client-launcher","args":["mcp"],"cwd":"."}}
}`)
	client := filepath.Join(codexHome, filepath.FromSlash(codexNativeComputerClientRel))
	mustWrite(t, client, "binary")
	_ = os.Chmod(client, 0o755)
	mustWrite(t, filepath.Join(codexHome, "config.toml"), `
[plugins."computer-use@openai-bundled"]
enabled = true

[mcp_servers.computer-use]
command = "./relative"
cwd = "."
enabled = true
`)

	result, err := prepareCodexNativeComputerUse(codexHome, false)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if !result.Prepared {
		t.Fatalf("result = %#v", result)
	}
	content, _ := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if !strings.Contains(string(content), launcher) {
		t.Fatalf("config = %s", content)
	}
}

func TestVerifyCodexNativeComputerMCPStatus(t *testing.T) {
	t.Parallel()

	ok, reason := VerifyCodexNativeComputerMCPStatus(json.RawMessage(`{
		"data":[{"name":"computer-use","status":"connected","tools":[{"name":"screenshot"}]}]
	}`))
	if !ok {
		t.Fatalf("want healthy, reason=%s", reason)
	}

	ok, reason = VerifyCodexNativeComputerMCPStatus(json.RawMessage(`{
		"data":[{"name":"computer-use","status":"failed","tools":[{"name":"screenshot"}]}]
	}`))
	if ok || !strings.Contains(reason, "failed") {
		t.Fatalf("want failed status, ok=%v reason=%s", ok, reason)
	}

	ok, reason = VerifyCodexNativeComputerMCPStatus(json.RawMessage(`{
		"data":[{"name":"computer-use","status":"connected","tools":[]}]
	}`))
	if ok || !strings.Contains(reason, "no tools") {
		t.Fatalf("want empty tools failure, ok=%v reason=%s", ok, reason)
	}
}

func strconvQuoteForTest(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
