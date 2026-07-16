package agentruntime

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func newOpenCodeTestAdapter(transport ProcessTransport) *standardACPAdapter {
	descriptor, ok := providerregistry.Find(ProviderOpenCode)
	if !ok {
		panic("opencode provider descriptor is missing")
	}
	return newOpenCodeAdapterFromProviderDescriptor(
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
	if adapter.config.planModeRuntimeID != "plan" || adapter.config.planModeDisabledRuntimeID != "build" {
		t.Fatalf("plan mode ids = %q/%q, want plan/build", adapter.config.planModeRuntimeID, adapter.config.planModeDisabledRuntimeID)
	}
	for _, permissionModeID := range []string{"read-only", "ask", "full-access"} {
		if got := adapter.config.permissionModeID(permissionModeID); got != "" {
			t.Fatalf("permission mode %q mapped to ACP mode %q", permissionModeID, got)
		}
	}
}

func TestOpenCodeACPEnvInjectsModelConfigContent(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderOpenCode)
	session.Settings = &SessionSettings{Model: "anthropic/claude-sonnet-4-5"}

	adapter := newOpenCodeTestAdapter(nil)
	env, err := adapter.config.finalizeEnv(adapter.config.env(session), session)
	if err != nil {
		t.Fatalf("finalize OpenCode env: %v", err)
	}
	found := false
	for _, item := range env {
		if strings.HasPrefix(item, "OPENCODE_CONFIG_CONTENT=") {
			found = true
			var config map[string]any
			if err := json.Unmarshal([]byte(strings.TrimPrefix(item, "OPENCODE_CONFIG_CONTENT=")), &config); err != nil {
				t.Fatalf("decode OPENCODE_CONFIG_CONTENT: %v", err)
			}
			if config["model"] != "anthropic/claude-sonnet-4-5" {
				t.Fatalf("model config = %#v", config["model"])
			}
			permission, _ := config["permission"].(map[string]any)
			if permission["*"] != "ask" || permission["glob"] != "allow" {
				t.Fatalf("permission config = %#v", permission)
			}
			read, _ := permission["read"].(map[string]any)
			if read["*.env"] != "deny" || read["*.env.example"] != "allow" {
				t.Fatalf("read permission config = %#v", read)
			}
			agents, _ := config["agent"].(map[string]any)
			plan, _ := agents["plan"].(map[string]any)
			planPermission, _ := plan["permission"].(map[string]any)
			if planPermission["edit"] != "deny" {
				t.Fatalf("plan permission config = %#v", planPermission)
			}
		}
	}
	if !found {
		t.Fatalf("env = %#v, want OPENCODE_CONFIG_CONTENT", env)
	}
}

func TestOpenCodeACPEnvMergesUserConfigBeforeApplyingAuthoritativePermissions(t *testing.T) {
	t.Parallel()

	descriptor, ok := providerregistry.Find(ProviderOpenCode)
	if !ok {
		t.Fatal("opencode provider descriptor is missing")
	}
	session := standardTestSession(ProviderOpenCode)
	session.Settings = &SessionSettings{Model: "openai/gpt-5"}
	base := `{"theme":"system","model":"user/model","permission":{"bash":"allow"},"agent":{"plan":{"temperature":0.2,"permission":{"bash":"ask"}}}}`
	env, err := openCodeFinalEnv(
		descriptor.Runtime.StandardACP.SettingsEnvironment,
		session,
		`{"theme":"inherited"}`,
		[]string{"KEEP=1", `OPENCODE_PERMISSION={"bash":"allow"}`, "OPENCODE_CONFIG_CONTENT=" + base},
	)
	if err != nil {
		t.Fatalf("openCodeFinalEnv: %v", err)
	}
	if len(env) != 3 || env[0] != "KEEP=1" || env[1] != "OPENCODE_PERMISSION={}" || !strings.HasPrefix(env[2], "OPENCODE_CONFIG_CONTENT=") {
		t.Fatalf("env = %#v, want neutral permission override and one final OpenCode config entry", env)
	}
	var config map[string]any
	if err := json.Unmarshal([]byte(strings.TrimPrefix(env[2], "OPENCODE_CONFIG_CONTENT=")), &config); err != nil {
		t.Fatalf("decode final OpenCode config: %v", err)
	}
	if config["theme"] != "system" || config["model"] != "openai/gpt-5" {
		t.Fatalf("preserved/generated config = %#v", config)
	}
	permission, _ := config["permission"].(map[string]any)
	if permission["*"] != "ask" || permission["bash"] == "allow" {
		t.Fatalf("authoritative permission config = %#v", permission)
	}
	agents, _ := config["agent"].(map[string]any)
	plan, _ := agents["plan"].(map[string]any)
	planPermission, _ := plan["permission"].(map[string]any)
	if plan["temperature"] != 0.2 || planPermission["bash"] != "ask" || planPermission["edit"] != "deny" {
		t.Fatalf("merged plan config = %#v", plan)
	}
}

func TestOpenCodeACPEnvRejectsInvalidUserConfig(t *testing.T) {
	t.Parallel()

	descriptor, ok := providerregistry.Find(ProviderOpenCode)
	if !ok {
		t.Fatal("opencode provider descriptor is missing")
	}
	_, err := openCodeFinalEnv(
		descriptor.Runtime.StandardACP.SettingsEnvironment,
		standardTestSession(ProviderOpenCode),
		"",
		[]string{"OPENCODE_CONFIG_CONTENT={invalid"},
	)
	if err == nil || !strings.Contains(err.Error(), "decode OPENCODE_CONFIG_CONTENT") {
		t.Fatalf("invalid config error = %v", err)
	}
}

func TestOpenCodePermissionTiersResolveACPRequestsIndependentlyFromPlanMode(t *testing.T) {
	t.Parallel()

	adapter := newOpenCodeTestAdapter(nil)
	if got := adapter.config.automaticPermissionDecision("read-only"); got != "denied" {
		t.Fatalf("read-only decision = %q, want denied", got)
	}
	if got := adapter.config.automaticPermissionDecision("ask"); got != "" {
		t.Fatalf("ask decision = %q, want prompt", got)
	}
	if got := adapter.config.automaticPermissionDecision("full-access"); got != "approved" {
		t.Fatalf("full-access decision = %q, want approved", got)
	}
	if got := adapter.effectiveModeID(Session{PermissionModeID: "full-access", Settings: &SessionSettings{PlanMode: false}}); got != "build" {
		t.Fatalf("build workflow mode = %q, want build", got)
	}
	if got := adapter.effectiveModeID(Session{PermissionModeID: "read-only", Settings: &SessionSettings{PlanMode: true}}); got != "plan" {
		t.Fatalf("plan workflow mode = %q, want plan", got)
	}
}

func TestOpenCodeAskPermissionOptionsExcludeIrrevocableAlwaysAllow(t *testing.T) {
	t.Parallel()

	options := openCodePermissionOptions([]map[string]any{
		{"optionId": "once", "kind": "allow_once"},
		{"optionId": "always", "kind": "allow_always"},
		{"optionId": "reject", "kind": "reject_once"},
	})
	if len(options) != 2 || options[0]["optionId"] != "once" || options[1]["optionId"] != "reject" {
		t.Fatalf("permission options = %#v, want once/reject", options)
	}
}

func TestOpenCodeFullAccessSelectsOneShotApproval(t *testing.T) {
	t.Parallel()

	raw := json.RawMessage(`{"options":[{"optionId":"always","kind":"allow_always"},{"optionId":"once","kind":"allow_once"}]}`)
	optionID, ok := acpPermissionRequestDecisionOptionID(raw, "approved", openCodePermissionOptions)
	if !ok || optionID != "once" {
		t.Fatalf("automatic approval = %q/%t, want once/true", optionID, ok)
	}
}

func TestOpenCodeAutomaticPermissionTiersResolveWithoutPrompt(t *testing.T) {
	t.Parallel()

	for _, testCase := range []struct {
		name     string
		tier     string
		optionID string
	}{
		{name: "read-only denies", tier: "read-only", optionID: "reject"},
		{name: "full-access approves", tier: "full-access", optionID: "allow"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			transport := newStandardACPTransport("OpenCode", "opencode-session-automatic-permission")
			transport.conn.promptPermission = true
			adapter := newOpenCodeTestAdapter(transport)
			session := standardTestSession(ProviderOpenCode)
			session.PermissionModeID = testCase.tier
			if _, err := adapter.Start(context.Background(), session); err != nil {
				t.Fatalf("Start: %v", err)
			}
			session.ProviderSessionID = "opencode-session-automatic-permission"

			execDone := make(chan error, 1)
			go func() {
				_, err := adapter.Exec(context.Background(), session, textPrompt("run the build"), "", "turn-1", nil, nil)
				execDone <- err
			}()
			select {
			case err := <-execDone:
				if err != nil {
					t.Fatalf("Exec: %v", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatalf("Exec did not finish for %s", testCase.tier)
			}
			if got := transport.conn.permissionOptionID(); got != testCase.optionID {
				t.Fatalf("permission option id = %q, want %q", got, testCase.optionID)
			}
		})
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

func TestOpenCodePermissionChangeDoesNotChangeACPWorkflowMode(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-permission")
	adapter := newOpenCodeTestAdapter(transport)
	session := standardTestSession(ProviderOpenCode)
	session.PermissionModeID = "ask"
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "build" {
		t.Fatalf("initial mode id = %q, want build", transport.conn.lastModeID())
	}

	transport.conn.setModeError = &acpError{Code: -32000, Message: "session/set_mode must not be called"}
	session.ProviderSessionID = "opencode-session-permission"
	session.PermissionModeID = "full-access"
	if err := adapter.ApplyPermissionMode(context.Background(), session); err != nil {
		t.Fatalf("ApplyPermissionMode called ACP session/set_mode: %v", err)
	}
	if got := adapter.automaticPermissionDecision(session.AgentSessionID); got != "approved" {
		t.Fatalf("live permission decision = %q, want approved", got)
	}
	if transport.conn.lastModeID() != "build" {
		t.Fatalf("workflow mode changed to %q, want build", transport.conn.lastModeID())
	}
}

func TestOpenCodeApplySessionSettingsSendsLiveModelAndEffortConfigOptions(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-1")
	transport.conn.configOptions = []map[string]any{
		{
			"id": "model",
			"options": []any{
				map[string]any{"name": "GPT-5.3 Codex Spark", "value": "openai/gpt-5.3-codex-spark"},
			},
		},
		{
			"id": "effort",
			"options": []any{
				map[string]any{"name": "High", "value": "high"},
			},
		},
	}
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

func TestOpenCodeApplySessionSettingsRejectsUnadvertisedEffortBeforeACPCall(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-big-pickle-session")
	transport.conn.configOptions = []map[string]any{{
		"id": "model",
		"options": []any{
			map[string]any{"name": "Big Pickle", "value": "opencode/big-pickle"},
		},
	}}
	adapter := newOpenCodeTestAdapter(transport)
	session := standardTestSession(ProviderOpenCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		ReasoningEffort: stringPtr("high"),
	})
	if err == nil || !strings.Contains(err.Error(), `effort "high" is not advertised`) {
		t.Fatalf("ApplySessionSettings error = %v", err)
	}
	if calls := transport.conn.setConfigOptionCalls(); len(calls) != 0 {
		t.Fatalf("config option calls = %#v, want none", calls)
	}
}
