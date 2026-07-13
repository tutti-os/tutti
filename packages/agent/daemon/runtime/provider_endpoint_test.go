package agentruntime

import (
	"os"
	"path/filepath"
	"testing"
)

func TestClaudeSettingsBaseURLReadsUserSettingsEnv(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	settingsDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(settingsDir, 0o700); err != nil {
		t.Fatalf("create settings dir: %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(settingsDir, "settings.json"),
		[]byte(`{"env":{"ANTHROPIC_BASE_URL":"https://anthropic.user.test"}}`),
		0o600,
	); err != nil {
		t.Fatalf("write settings: %v", err)
	}

	if got := claudeSettingsBaseURL(nil, ""); got != "https://anthropic.user.test" {
		t.Fatalf("claude settings base URL = %q, want user settings URL", got)
	}
}

func TestClaudeSettingsBaseURLPrefersProjectLocalSettings(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o700); err != nil {
		t.Fatalf("create user settings dir: %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(home, ".claude", "settings.json"),
		[]byte(`{"env":{"ANTHROPIC_BASE_URL":"https://anthropic.user.test"}}`),
		0o600,
	); err != nil {
		t.Fatalf("write user settings: %v", err)
	}
	project := filepath.Join(t.TempDir(), "project", "nested")
	if err := os.MkdirAll(filepath.Join(project, ".claude"), 0o700); err != nil {
		t.Fatalf("create project settings dir: %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(project, ".claude", "settings.local.json"),
		[]byte(`{"env":{"ANTHROPIC_BASE_URL":"https://anthropic.project.test"}}`),
		0o600,
	); err != nil {
		t.Fatalf("write project settings: %v", err)
	}

	if got := claudeSettingsBaseURL(nil, project); got != "https://anthropic.project.test" {
		t.Fatalf("claude settings base URL = %q, want project settings URL", got)
	}
}

func TestClaudeSettingsBaseURLRespectsClaudeConfigDir(t *testing.T) {
	configDir := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(configDir, "settings.json"),
		[]byte(`{"env":{"ANTHROPIC_BASE_URL":"https://anthropic.override.test"}}`),
		0o600,
	); err != nil {
		t.Fatalf("write settings: %v", err)
	}

	if got := claudeSettingsBaseURL(
		[]string{"CLAUDE_CONFIG_DIR=" + configDir},
		"",
	); got != "https://anthropic.override.test" {
		t.Fatalf("claude settings base URL = %q, want override URL", got)
	}
}

func TestProviderBaseURLUsesMigratedRuntimeEndpointDescriptor(t *testing.T) {
	t.Setenv("OPENAI_BASE_URL", "")
	t.Setenv("OPENAI_API_BASE_URL", "")
	t.Setenv("OPENAI_API_BASE", "")

	session := Session{Env: []string{"OPENAI_API_BASE_URL=https://openai.session.test"}}
	if got := providerBaseURL(session, " codex "); got != "https://openai.session.test" {
		t.Fatalf("provider base URL = %q, want descriptor-declared env URL", got)
	}
}

func TestProviderBaseURLUsesMigratedRuntimeConfigKind(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("OPENAI_BASE_URL", "")
	t.Setenv("OPENAI_API_BASE_URL", "")
	t.Setenv("OPENAI_API_BASE", "")
	if err := os.WriteFile(
		filepath.Join(codexHome, "config.toml"),
		[]byte("chatgpt_base_url = \"https://openai.config.test\"\n"),
		0o600,
	); err != nil {
		t.Fatalf("write codex config: %v", err)
	}

	session := Session{Env: []string{"CODEX_HOME=" + codexHome}}
	if got := providerBaseURL(session, "codex"); got != "https://openai.config.test" {
		t.Fatalf("provider base URL = %q, want descriptor-selected config URL", got)
	}
}
