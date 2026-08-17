package agentstatus

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func customConfigService(home string) Service {
	return Service{
		Environ: func() []string { return nil },
		HomeDir: func() (string, error) { return home, nil },
	}
}

func TestProviderUsesCustomConfigEnvAPIKey(t *testing.T) {
	svc := customConfigService(t.TempDir())
	svc.Environ = func() []string { return []string{"ANTHROPIC_API_KEY=sk-test"} }
	if !svc.providerUsesCustomConfig(agentprovider.ClaudeCode) {
		t.Fatal("expected env API key to count as custom config")
	}
}

func TestProviderUsesCustomConfigEnvBaseURL(t *testing.T) {
	svc := customConfigService(t.TempDir())
	svc.Environ = func() []string { return []string{"OPENAI_BASE_URL=https://gw.local/v1"} }
	if !svc.providerUsesCustomConfig(agentprovider.Codex) {
		t.Fatal("expected env base URL to count as custom config")
	}
}

func TestProviderUsesCustomConfigCodexConfigToml(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".codex", "config.toml"), `
model_provider = "mycorp"
[model_providers.mycorp]
base_url = "https://gateway.mycorp.com/v1"
`)
	svc := customConfigService(home)
	if !svc.providerUsesCustomConfig(agentprovider.Codex) {
		t.Fatal("expected codex config.toml base_url to count as custom config")
	}
}

func TestProviderUsesCustomConfigCodexInlineAPIKey(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".codex", "config.toml"), `
[model_providers.openai]
api_key = "sk-inline"
`)
	svc := customConfigService(home)
	if !svc.providerUsesCustomConfig(agentprovider.Codex) {
		t.Fatal("expected codex inline api_key to count as custom config")
	}
}

func TestProviderUsesCustomConfigClaudeSettings(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".claude", "settings.json"),
		`{"env":{"ANTHROPIC_BASE_URL":"https://gw.local"}}`)
	svc := customConfigService(home)
	if !svc.providerUsesCustomConfig(agentprovider.ClaudeCode) {
		t.Fatal("expected claude settings ANTHROPIC_BASE_URL to count as custom config")
	}
}

func TestProviderUsesCustomConfigClaudeSettingsFromOverride(t *testing.T) {
	configDir := t.TempDir()
	writeFile(t, filepath.Join(configDir, "settings.json"),
		`{"env":{"ANTHROPIC_BASE_URL":"https://override.local"}}`)
	svc := customConfigService(t.TempDir())
	svc.Environ = func() []string { return []string{"CLAUDE_CONFIG_DIR=" + configDir} }
	if !svc.providerUsesCustomConfig(agentprovider.ClaudeCode) {
		t.Fatal("expected CLAUDE_CONFIG_DIR settings to count as custom config")
	}
}

func TestProviderUsesCustomConfigClaudeAuthToken(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".claude", "settings.json"),
		`{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-test"}}`)
	svc := customConfigService(home)
	if !svc.providerUsesCustomConfig(agentprovider.ClaudeCode) {
		t.Fatal("expected claude settings ANTHROPIC_AUTH_TOKEN to count as custom config")
	}
}

func TestProviderUsesCustomConfigClaudeApiKeyHelper(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".claude", "settings.json"),
		`{"apiKeyHelper":"/usr/local/bin/get-key.sh"}`)
	svc := customConfigService(home)
	if !svc.providerUsesCustomConfig(agentprovider.ClaudeCode) {
		t.Fatal("expected claude apiKeyHelper to count as custom config")
	}
}

func TestProviderUsesCustomConfigOpenCodeProviderEndpoint(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".config", "opencode", "opencode.json"), `{
		"provider": {
			"newapi": {"options": {"baseURL": "https://gateway.example/v1"}}
		}
	}`)
	svc := customConfigService(home)
	if !svc.providerUsesCustomConfig(agentprovider.OpenCode) {
		t.Fatal("expected OpenCode provider baseURL to count as custom config")
	}
}

func TestProviderHasAPICredentialOpenCodeProviderAPIKey(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".config", "opencode", "opencode.json"), `{
		"provider": {
			"newapi": {"options": {"apiKey": "sk-test"}}
		}
	}`)
	svc := customConfigService(home)
	if !svc.providerHasAPICredential(agentprovider.OpenCode) {
		t.Fatal("expected OpenCode provider apiKey to count as an API credential")
	}
}

func TestProviderHasAPICredentialOpenCodeConfigDir(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(home, "custom-opencode")
	writeFile(t, filepath.Join(configDir, "opencode.json"), `{
		"provider": {
			"newapi": {"options": {"apiKey": "sk-override"}}
		}
	}`)
	svc := customConfigService(home)
	svc.Environ = func() []string { return []string{"OPENCODE_CONFIG_DIR=" + configDir} }
	if !svc.providerHasAPICredential(agentprovider.OpenCode) {
		t.Fatal("expected OPENCODE_CONFIG_DIR provider apiKey to be detected")
	}
}

func TestProviderHasAPICredentialOpenCodeConfigContentEnvReference(t *testing.T) {
	svc := customConfigService(t.TempDir())
	svc.Environ = func() []string {
		return []string{
			"OPENCODE_CONFIG_CONTENT={\"provider\":{\"newapi\":{\"options\":{\"apiKey\":\"{env:NEWAPI_KEY}\"}}}}",
			"NEWAPI_KEY=sk-env",
		}
	}
	if !svc.providerHasAPICredential(agentprovider.OpenCode) {
		t.Fatal("expected OpenCode config content env reference to be detected")
	}
}

func TestProviderHasAPICredentialOpenCodeEndpointOnlyIsNotCredential(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".config", "opencode", "opencode.json"), `{
		"provider": {
			"newapi": {"options": {"baseURL": "https://gateway.example/v1"}}
		}
	}`)
	svc := customConfigService(home)
	if svc.providerHasAPICredential(agentprovider.OpenCode) {
		t.Fatal("an OpenCode endpoint without apiKey must not count as an API credential")
	}
	if !svc.providerUsesCustomConfig(agentprovider.OpenCode) {
		t.Fatal("an OpenCode endpoint should still count as custom config")
	}
}

func TestProviderHasAPICredentialOpenCodeJSONC(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".config", "opencode", "opencode.jsonc"), `{
		// CCSwitch/OpenCode also accept JSONC config files.
		"provider": {
			"newapi": {
				"options": {
					"apiKey": "sk-jsonc",
				},
			},
		},
	}`)
	if !customConfigService(home).providerHasAPICredential(agentprovider.OpenCode) {
		t.Fatal("expected OpenCode JSONC apiKey to be detected")
	}
}

func TestProviderHasAPICredentialOpenCodeConfigPrecedence(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(home, ".config", "opencode")
	writeFile(t, filepath.Join(configDir, "config.json"), `{
		"provider": {"newapi": {"options": {"apiKey": "sk-global"}}}
	}`)
	writeFile(t, filepath.Join(configDir, "opencode.jsonc"), `{
		"provider": {"newapi": {"options": {"apiKey": null}}}
	}`)
	if customConfigService(home).providerHasAPICredential(agentprovider.OpenCode) {
		t.Fatal("a later JSONC null must override an earlier provider apiKey")
	}

	overrideHome := t.TempDir()
	overrideConfigDir := filepath.Join(overrideHome, ".config", "opencode")
	writeFile(t, filepath.Join(overrideConfigDir, "opencode.json"), `{
		"provider": {"newapi": {"options": {"apiKey": "sk-global"}}}
	}`)
	override := filepath.Join(overrideHome, "override.json")
	writeFile(t, override, `{
		"provider": {"newapi": {"options": {"apiKey": null}}}
	}`)
	svc := customConfigService(overrideHome)
	svc.Environ = func() []string { return []string{"OPENCODE_CONFIG=" + override} }
	if svc.providerHasAPICredential(agentprovider.OpenCode) {
		t.Fatal("OPENCODE_CONFIG must override an earlier global provider apiKey")
	}
}

func TestProviderHasAPICredentialOpenCodeFileReference(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(home, ".config", "opencode")
	writeFile(t, filepath.Join(configDir, "secrets", "api-key"), "sk-file\n")
	writeFile(t, filepath.Join(configDir, "opencode.json"), `{
		"provider": {"newapi": {"options": {"apiKey": "{file:secrets/api-key}"}}}
	}`)
	if !customConfigService(home).providerHasAPICredential(agentprovider.OpenCode) {
		t.Fatal("expected OpenCode {file:...} apiKey to be detected")
	}
}

func TestProviderHasAPICredentialOpenCodeWindowsHomeFileReference(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, "api-key"), "sk-home-file\n")
	writeFile(t, filepath.Join(home, ".config", "opencode", "opencode.json"), `{
		"provider": {"newapi": {"options": {"apiKey": "{file:~\\api-key}"}}}
	}`)
	if !customConfigService(home).providerHasAPICredential(agentprovider.OpenCode) {
		t.Fatal("expected OpenCode Windows-style home file reference to be detected")
	}
}

func TestProviderUsesCustomConfigCleanCodexLoginIsNotCustom(t *testing.T) {
	home := t.TempDir()
	// A normal ChatGPT-login config.toml with only a model pin — no custom key
	// or endpoint — must NOT be treated as a custom config.
	writeFile(t, filepath.Join(home, ".codex", "config.toml"), `model = "gpt-5-codex"`)
	svc := customConfigService(home)
	if svc.providerUsesCustomConfig(agentprovider.Codex) {
		t.Fatal("a clean login config must not count as custom")
	}
}

func TestProviderUsesCustomConfigNoConfigNoEnv(t *testing.T) {
	svc := customConfigService(t.TempDir())
	if svc.providerUsesCustomConfig(agentprovider.Codex) {
		t.Fatal("no env and no config should not be custom")
	}
	if svc.providerUsesCustomConfig(agentprovider.ClaudeCode) {
		t.Fatal("no env and no config should not be custom")
	}
}

func TestProviderHasAPICredentialEnvAPIKey(t *testing.T) {
	svc := customConfigService(t.TempDir())
	svc.Environ = func() []string { return []string{"ANTHROPIC_API_KEY=sk-test"} }
	if !svc.providerHasAPICredential(agentprovider.ClaudeCode) {
		t.Fatal("expected env ANTHROPIC_API_KEY to count as an API credential")
	}
}

func TestProviderHasAPICredentialEnvAuthToken(t *testing.T) {
	svc := customConfigService(t.TempDir())
	svc.Environ = func() []string { return []string{"ANTHROPIC_AUTH_TOKEN=sk-test"} }
	if !svc.providerHasAPICredential(agentprovider.ClaudeCode) {
		t.Fatal("expected env ANTHROPIC_AUTH_TOKEN to count as an API credential")
	}
}

func TestProviderHasAPICredentialSettingsAuthToken(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".claude", "settings.json"),
		`{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-test"}}`)
	svc := customConfigService(home)
	if !svc.providerHasAPICredential(agentprovider.ClaudeCode) {
		t.Fatal("expected settings ANTHROPIC_AUTH_TOKEN to count as an API credential")
	}
}

func TestProviderHasAPICredentialSettingsApiKeyHelper(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".claude", "settings.json"),
		`{"apiKeyHelper":"/usr/local/bin/get-key.sh"}`)
	svc := customConfigService(home)
	if !svc.providerHasAPICredential(agentprovider.ClaudeCode) {
		t.Fatal("expected apiKeyHelper to count as an API credential")
	}
}

// The claude-sdk-sidecar resolves settings.json under $CLAUDE_CONFIG_DIR when
// set; the status probe must look at the same file or the wizard and the
// runtime would disagree about whether credentials exist.
func TestProviderHasAPICredentialRespectsClaudeConfigDir(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(home, "custom-claude-config")
	writeFile(t, filepath.Join(configDir, "settings.json"),
		`{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-test"}}`)
	svc := customConfigService(home)
	svc.Environ = func() []string { return []string{"CLAUDE_CONFIG_DIR=" + configDir} }
	if !svc.providerHasAPICredential(agentprovider.ClaudeCode) {
		t.Fatal("expected CLAUDE_CONFIG_DIR settings.json credential to be detected")
	}
	// The default ~/.claude location must not be consulted when the override
	// is set.
	writeFile(t, filepath.Join(home, ".claude", "settings.json"),
		`{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-ignored"}}`)
	svc.Environ = func() []string { return []string{"CLAUDE_CONFIG_DIR=" + filepath.Join(home, "empty-dir")} }
	if svc.providerHasAPICredential(agentprovider.ClaudeCode) {
		t.Fatal("expected empty CLAUDE_CONFIG_DIR to hide the default settings.json")
	}
}

// A bare custom endpoint without any API credential must NOT be reported as an
// API credential: the user may still be on an OAuth/subscription session against
// that endpoint, so labeling them "API Usage Billing" would be wrong.
func TestProviderHasAPICredentialCustomEndpointOnlyIsNotCredential(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".claude", "settings.json"),
		`{"env":{"ANTHROPIC_BASE_URL":"https://gw.local"}}`)
	svc := customConfigService(home)
	if svc.providerHasAPICredential(agentprovider.ClaudeCode) {
		t.Fatal("a custom endpoint without a credential must not count as API billing")
	}
	// ...but it still counts as custom config for the network-probe skip.
	if !svc.providerUsesCustomConfig(agentprovider.ClaudeCode) {
		t.Fatal("a custom endpoint should still count as custom config")
	}
}

func TestProviderHasAPICredentialEnvBaseUrlOnlyIsNotCredential(t *testing.T) {
	svc := customConfigService(t.TempDir())
	svc.Environ = func() []string { return []string{"ANTHROPIC_BASE_URL=https://gw.local"} }
	if svc.providerHasAPICredential(agentprovider.ClaudeCode) {
		t.Fatal("env ANTHROPIC_BASE_URL alone must not count as an API credential")
	}
}

func TestProviderHasAPICredentialCodexConfigTomlInlineKey(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".codex", "config.toml"),
		`[model_providers.openai]`+"\n"+`api_key = "sk-inline"`)
	svc := customConfigService(home)
	if !svc.providerHasAPICredential(agentprovider.Codex) {
		t.Fatal("expected codex config.toml api_key to count as an API credential")
	}
}

func TestProviderHasAPICredentialCodexAuthJSONAPIKey(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".codex", "auth.json"), `{"OPENAI_API_KEY":"sk-test"}`)
	svc := customConfigService(home)
	if !svc.providerHasAPICredential(agentprovider.Codex) {
		t.Fatal("expected codex auth.json OPENAI_API_KEY to count as an API credential")
	}
}

func TestProviderHasAPICredentialCodexAuthJSONEmptyKeyIsNotCredential(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".codex", "auth.json"), `{"OPENAI_API_KEY":"","tokens":{"access_token":"x"}}`)
	svc := customConfigService(home)
	if svc.providerHasAPICredential(agentprovider.Codex) {
		t.Fatal("empty OPENAI_API_KEY in auth.json must not count as an API credential")
	}
}

func TestProviderHasAPICredentialCodexConfigTomlEndpointOnlyIsNotCredential(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".codex", "config.toml"), `
model_provider = "mycorp"
[model_providers.mycorp]
base_url = "https://gateway.mycorp.com/v1"
`)
	svc := customConfigService(home)
	if svc.providerHasAPICredential(agentprovider.Codex) {
		t.Fatal("codex config.toml base_url without api_key must not count as an API credential")
	}
}

func TestProviderHasAPICredentialNone(t *testing.T) {
	svc := customConfigService(t.TempDir())
	if svc.providerHasAPICredential(agentprovider.ClaudeCode) {
		t.Fatal("no env and no config should not have an API credential")
	}
	if svc.providerHasAPICredential(agentprovider.Codex) {
		t.Fatal("no env and no config should not have an API credential")
	}
}
