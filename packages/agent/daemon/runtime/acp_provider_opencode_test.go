package agentruntime

import (
	"context"
	"encoding/json"
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
	if got := adapter.config.permissionModeID("plan"); got != "plan" {
		t.Fatalf("plan mode id = %q, want plan", got)
	}
	if got := adapter.config.permissionModeID(""); got != "build" {
		t.Fatalf("default mode id = %q, want build", got)
	}
	if got := adapter.config.permissionModeID("anything"); got != "" {
		t.Fatalf("unknown mode id = %q, want empty", got)
	}
}

func TestOpenCodeACPEnvInjectsConfigContent(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderOpenCode)
	session.Settings = &SessionSettings{Model: "anthropic/claude-sonnet-4-5"}

	env := opencodeACPEnv(session, LegacyHostMetadata())
	var configContent string
	for _, item := range env {
		if strings.HasPrefix(item, "OPENCODE_CONFIG_CONTENT=") {
			configContent = strings.TrimPrefix(item, "OPENCODE_CONFIG_CONTENT=")
		}
	}
	if configContent == "" {
		t.Fatalf("env = %#v, want OPENCODE_CONFIG_CONTENT", env)
	}
	var config map[string]any
	if err := json.Unmarshal([]byte(configContent), &config); err != nil {
		t.Fatalf("OPENCODE_CONFIG_CONTENT invalid JSON: %v", err)
	}
	if got, _ := config["model"].(string); got != "anthropic/claude-sonnet-4-5" {
		t.Fatalf("model = %q, want anthropic/claude-sonnet-4-5", got)
	}
	commands, _ := config["command"].(map[string]any)
	review, _ := commands["review"].(map[string]any)
	if review == nil {
		t.Fatalf("command config = %#v, want review command", config["command"])
	}
	if got, _ := review["description"].(string); got != "Review code changes" {
		t.Fatalf("review description = %q, want Review code changes", got)
	}
	if template, _ := review["template"].(string); !strings.Contains(template, "$ARGUMENTS") {
		t.Fatalf("review template = %q, want argument placeholder", template)
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

func TestOpenCodeAdapterStartAppliesPlanMode(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-plan")
	adapter := NewOpenCodeAdapter(transport)
	session := standardTestSession(ProviderOpenCode)
	session.Settings = &SessionSettings{PlanMode: true}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "plan" {
		t.Fatalf("mode id = %q, want plan", transport.conn.lastModeID())
	}
}

func TestOpenCodeAdapterApplySessionSettingsTogglesPlanMode(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-plan-toggle")
	adapter := NewOpenCodeAdapter(transport)
	session := standardTestSession(ProviderOpenCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "build" {
		t.Fatalf("initial mode id = %q, want build", transport.conn.lastModeID())
	}

	planMode := true
	session.ProviderSessionID = "opencode-session-plan-toggle"
	session.Settings = &SessionSettings{PlanMode: planMode}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		PlanMode: &planMode,
	}); err != nil {
		t.Fatalf("ApplySessionSettings plan on: %v", err)
	}
	if transport.conn.lastModeID() != "plan" {
		t.Fatalf("mode id = %q, want plan", transport.conn.lastModeID())
	}

	planMode = false
	session.Settings.PlanMode = planMode
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		PlanMode: &planMode,
	}); err != nil {
		t.Fatalf("ApplySessionSettings plan off: %v", err)
	}
	if transport.conn.lastModeID() != "build" {
		t.Fatalf("mode id = %q, want build", transport.conn.lastModeID())
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
