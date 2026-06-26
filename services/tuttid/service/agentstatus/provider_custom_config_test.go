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

func TestProviderUsesCustomConfigClaudeApiKeyHelper(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".claude", "settings.json"),
		`{"apiKeyHelper":"/usr/local/bin/get-key.sh"}`)
	svc := customConfigService(home)
	if !svc.providerUsesCustomConfig(agentprovider.ClaudeCode) {
		t.Fatal("expected claude apiKeyHelper to count as custom config")
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
