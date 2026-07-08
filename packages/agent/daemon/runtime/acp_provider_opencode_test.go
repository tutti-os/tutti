package agentruntime

import (
	"context"
	"strings"
	"testing"
)

func TestOpenCodeAdapterUsesOfficialACPCommand(t *testing.T) {
	t.Parallel()

	adapter := NewOpenCodeAdapter(nil)
	if adapter.config.provider != ProviderOpenCode {
		t.Fatalf("provider = %q, want %q", adapter.config.provider, ProviderOpenCode)
	}
	if len(adapter.config.command) != 2 || adapter.config.command[0] != "opencode" || adapter.config.command[1] != "acp" {
		t.Fatalf("command = %#v, want opencode acp", adapter.config.command)
	}
	if got := adapter.config.permissionModeID("anything"); got != "" {
		t.Fatalf("permissionModeID = %q, want empty", got)
	}
}

func TestOpenCodeACPEnvInjectsModelConfigContent(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderOpenCode)
	session.Settings = &SessionSettings{Model: "anthropic/claude-sonnet-4-5"}

	env := opencodeACPEnv(session, LegacyHostMetadata())
	found := false
	for _, item := range env {
		if strings.HasPrefix(item, "OPENCODE_CONFIG_CONTENT=") {
			found = true
			if item != `OPENCODE_CONFIG_CONTENT={"model":"anthropic/claude-sonnet-4-5"}` {
				t.Fatalf("OPENCODE_CONFIG_CONTENT = %q", item)
			}
		}
	}
	if !found {
		t.Fatalf("env = %#v, want OPENCODE_CONFIG_CONTENT", env)
	}
}

func TestOpenCodeDoesNotRequireNewSessionForModelSettings(t *testing.T) {
	t.Parallel()

	adapter := NewOpenCodeAdapter(nil)
	model := "openai/gpt-5"
	if adapter.RequiresNewSessionForSettings(Session{}, SessionSettingsPatch{Model: &model}) {
		t.Fatal("model patch required a new session")
	}
	if adapter.RequiresNewSessionForSettings(Session{}, SessionSettingsPatch{}) {
		t.Fatal("empty patch required a new session")
	}
}

func TestOpenCodeApplySessionSettingsSendsLiveModelAndEffortConfigOptions(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-1")
	adapter := NewOpenCodeAdapter(transport)
	session := standardTestSession(ProviderOpenCode)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	session.Settings = &SessionSettings{
		Model:           "openai/gpt-5.3-codex-spark",
		ReasoningEffort: "high",
	}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Model:           stringPtr("openai/gpt-5.3-codex-spark"),
		ReasoningEffort: stringPtr("high"),
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 2 {
		t.Fatalf("config option calls = %#v, want model + effort", calls)
	}
	if got, _ := calls[0]["configId"].(string); got != "model" {
		t.Fatalf("first config id = %q, want model", got)
	}
	if got, _ := calls[0]["value"].(string); got != "openai/gpt-5.3-codex-spark" {
		t.Fatalf("first config value = %q, want openai/gpt-5.3-codex-spark", got)
	}
	if got, _ := calls[1]["configId"].(string); got != "effort" {
		t.Fatalf("second config id = %q, want effort", got)
	}
	if got, _ := calls[1]["value"].(string); got != "high" {
		t.Fatalf("second config value = %q, want high", got)
	}
}
