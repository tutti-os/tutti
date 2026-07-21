package workspace

import "testing"

func TestWorkspaceAppProcessEnvUsesAllowlistAndExplicitOverrides(t *testing.T) {
	for key, value := range map[string]string{
		"PATH":                     "/host/bin",
		"HOME":                     "/home/tester",
		"USER":                     "tester",
		"TMPDIR":                   "/tmp/tester",
		"LANG":                     "zh_CN.UTF-8",
		"LC_MESSAGES":              "zh_CN.UTF-8",
		"HTTPS_PROXY":              "http://proxy.example:8080",
		"SSL_CERT_FILE":            "/etc/ssl/test.pem",
		"SystemRoot":               `C:\Windows`,
		"XDG_CONFIG_HOME":          "/home/tester/.config-custom",
		"CODEX_HOME":               "/home/tester/.codex-custom",
		"CLAUDE_CONFIG_DIR":        "/home/tester/.claude-custom",
		"OPENAI_API_KEY":           "openai-test-key",
		"OPENAI_BASE_URL":          "https://openai.example/v1",
		"ANTHROPIC_AUTH_TOKEN":     "anthropic-test-token",
		"ANTHROPIC_BASE_URL":       "https://anthropic.example",
		"CURSOR_API_KEY":           "cursor-test-key",
		"CURSOR_ACP_BIN":           "/home/tester/bin/cursor-agent",
		"OPENCODE_CONFIG":          "/home/tester/opencode.json",
		"OPENCODE_CONFIG_DIR":      "/home/tester/.config-custom/opencode",
		"OPENCODE_CONFIG_CONTENT":  `{"provider":"test"}`,
		"OPENCODE_PERMISSION":      `{"bash":"ask"}`,
		"OPENCODE_ACP_BIN":         "/home/tester/bin/opencode",
		"TUTTI_AGENT_HOME":         "/home/tester/.tutti-agent-custom",
		"RANDOM_DAEMON_SECRET":     "must-not-leak",
		"DATABASE_URL":             "sqlite:///daemon.db",
		"RELEASE_SIGNING_KEY":      "must-not-leak",
		"TUTTI_STATE_DIR":          "/daemon/state",
		"TUTTI_APP_AMBIENT_SECRET": "must-not-leak",
		"TUTTI_WORKSPACE_ROOT":     "/legacy/workspace",
	} {
		t.Setenv(key, value)
	}
	t.Setenv(removedWorkspaceRootCompatibilityEnvKey, "/legacy/workspace")

	env := workspaceAppProcessEnv(
		"PATH=/managed/bin",
		"TUTTI_APP_RUNTIME_ROOT=/managed/runtime",
		"TUTTI_APP_NODE=/managed/node",
		"TUTTI_APP_SERVER_TOKEN=app-scoped-token",
		"CUSTOM_EXPLICIT_OVERRIDE=explicit-value",
		"TUTTI_WORKSPACE_ROOT=/explicit/legacy-root",
		removedWorkspaceRootCompatibilityEnvKey+"=/explicit/legacy-root",
	)

	for key, want := range map[string]string{
		"PATH":                     "/managed/bin",
		"HOME":                     "/home/tester",
		"USER":                     "tester",
		"TMPDIR":                   "/tmp/tester",
		"LANG":                     "zh_CN.UTF-8",
		"LC_MESSAGES":              "zh_CN.UTF-8",
		"HTTPS_PROXY":              "http://proxy.example:8080",
		"SSL_CERT_FILE":            "/etc/ssl/test.pem",
		"SystemRoot":               `C:\Windows`,
		"XDG_CONFIG_HOME":          "/home/tester/.config-custom",
		"CODEX_HOME":               "/home/tester/.codex-custom",
		"CLAUDE_CONFIG_DIR":        "/home/tester/.claude-custom",
		"OPENAI_API_KEY":           "openai-test-key",
		"OPENAI_BASE_URL":          "https://openai.example/v1",
		"ANTHROPIC_AUTH_TOKEN":     "anthropic-test-token",
		"ANTHROPIC_BASE_URL":       "https://anthropic.example",
		"CURSOR_API_KEY":           "cursor-test-key",
		"CURSOR_ACP_BIN":           "/home/tester/bin/cursor-agent",
		"OPENCODE_CONFIG":          "/home/tester/opencode.json",
		"OPENCODE_CONFIG_DIR":      "/home/tester/.config-custom/opencode",
		"OPENCODE_CONFIG_CONTENT":  `{"provider":"test"}`,
		"OPENCODE_PERMISSION":      `{"bash":"ask"}`,
		"OPENCODE_ACP_BIN":         "/home/tester/bin/opencode",
		"TUTTI_AGENT_HOME":         "/home/tester/.tutti-agent-custom",
		"TUTTI_APP_RUNTIME_ROOT":   "/managed/runtime",
		"TUTTI_APP_NODE":           "/managed/node",
		"TUTTI_APP_SERVER_TOKEN":   "app-scoped-token",
		"CUSTOM_EXPLICIT_OVERRIDE": "explicit-value",
	} {
		if got := envValue(env, key); got != want {
			t.Fatalf("env[%s] = %q, want %q", key, got, want)
		}
	}

	for _, key := range []string{
		"RANDOM_DAEMON_SECRET",
		"DATABASE_URL",
		"RELEASE_SIGNING_KEY",
		"TUTTI_STATE_DIR",
		"TUTTI_APP_AMBIENT_SECRET",
		"TUTTI_WORKSPACE_ROOT",
		removedWorkspaceRootCompatibilityEnvKey,
	} {
		if got := envValue(env, key); got != "" {
			t.Fatalf("env[%s] = %q, want omitted", key, got)
		}
	}
}
