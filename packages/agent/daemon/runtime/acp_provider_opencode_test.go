package agentruntime

import (
	"context"
	"strings"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func newOpenCodeTestAdapter(transport ProcessTransport) *standardACPAdapter {
	descriptor, ok := providerregistry.Find(ProviderOpenCode)
	if !ok {
		panic("opencode provider descriptor is missing")
	}
	return newStandardACPAdapterFromProviderDescriptor(
		descriptor,
		transport,
		LegacyHostMetadata(),
		nil,
	)
}

func TestOpenCodeAdapterUsesOfficialACPCommand(t *testing.T) {
	t.Parallel()

	adapter := newOpenCodeTestAdapter(nil)
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
	if got := adapter.config.permissionModeID("build"); got != "build" {
		t.Fatalf("build mode id = %q, want build", got)
	}
	if got := adapter.config.permissionModeID("anything"); got != "" {
		t.Fatalf("unknown mode id = %q, want empty", got)
	}
}

func TestOpenCodeACPEnvInjectsModelConfigContent(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderOpenCode)
	session.Settings = &SessionSettings{Model: "anthropic/claude-sonnet-4-5"}

	env := newOpenCodeTestAdapter(nil).config.env(session)
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

	adapter := newOpenCodeTestAdapter(nil)
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
	adapter := newOpenCodeTestAdapter(transport)
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
	adapter := newOpenCodeTestAdapter(transport)
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
	adapter := newOpenCodeTestAdapter(transport)
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
