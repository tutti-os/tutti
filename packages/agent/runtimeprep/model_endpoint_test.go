package runtimeprep

import (
	"strings"
	"testing"
)

func TestCodexConfigWithModelPlanEndpointRewritesProvider(t *testing.T) {
	t.Parallel()

	endpoint := &ModelEndpointConfig{
		PlanID:   "mp-1",
		PlanName: "Volc Coding Plan",
		Protocol: "openai",
		BaseURL:  "https://relay.example/v1",
		APIKey:   "sk-secret",
		Model:    "seed-code",
	}
	content := "model = \"gpt-5\"\nmodel_provider = \"openai\"\n\n[tutti]\nconversationDetailMode = \"standard\"\n"
	next, changed := codexConfigWithModelPlanEndpoint(content, endpoint)
	if !changed {
		t.Fatalf("codexConfigWithModelPlanEndpoint() changed = false")
	}
	if !strings.Contains(next, "model_provider = \"tutti-model-plan\"") {
		t.Fatalf("model_provider not pinned:\n%s", next)
	}
	if strings.Contains(next, "model_provider = \"openai\"") {
		t.Fatalf("stale model_provider remains:\n%s", next)
	}
	if !strings.Contains(next, "model = \"seed-code\"") || strings.Contains(next, "model = \"gpt-5\"") {
		t.Fatalf("model not replaced:\n%s", next)
	}
	if !strings.Contains(next, "[model_providers.tutti-model-plan]") {
		t.Fatalf("provider table missing:\n%s", next)
	}
	if !strings.Contains(next, "env_key = \"TUTTI_MODEL_PLAN_API_KEY\"") {
		t.Fatalf("env_key missing:\n%s", next)
	}
	if !strings.Contains(next, "wire_api = \"responses\"") || strings.Contains(next, "wire_api = \"chat\"") {
		t.Fatalf("Codex model plan provider must use the Responses API:\n%s", next)
	}
	if strings.Contains(next, "sk-secret") {
		t.Fatalf("credential leaked into config:\n%s", next)
	}

	// Anthropic-protocol plans must not rewrite Codex config.
	if _, changed := codexConfigWithModelPlanEndpoint(content, &ModelEndpointConfig{Protocol: "anthropic", BaseURL: "https://x", APIKey: "k"}); changed {
		t.Fatalf("anthropic endpoint should not change codex config")
	}
}

func TestCodexConfigWithModelPlanEndpointUsesOpenRouterFunctionToolsOnly(t *testing.T) {
	t.Parallel()

	endpoint := &ModelEndpointConfig{
		PlanID:   "mp-openrouter",
		PlanName: "OpenRouter DeepSeek",
		Protocol: "openai",
		BaseURL:  "https://openrouter.ai/api/v1",
		APIKey:   "sk-or-secret",
		Model:    "deepseek/deepseek-v4-pro",
	}
	content := strings.Join([]string{
		`model = "gpt-5"`,
		`web_search = "live"`,
		``,
		`[mcp_servers]`,
		`__tutti_managed_node_repl = true`,
		``,
		`[mcp_servers."node.repl"]`,
		`command = "node"`,
		``,
		`[mcp_servers."node.repl".env]`,
		`MODE = "computer-use"`,
		``,
		`[features]`,
		`apps = true`,
		`current_time_reminder = true`,
		`image_generation = true`,
		`imagegenext = true`,
		`memories = true`,
		`multi_agent = true`,
		`multi_agent_v2 = true`,
		`plugins = true`,
		`standalone_web_search = true`,
		`tool_suggest = true`,
		`js_repl = false`,
		``,
		`[orchestrator.mcp]`,
		`enabled = true`,
		``,
		`[orchestrator.skills]`,
		`enabled = true`,
		``,
		`[projects."/tmp/work"]`,
		`trust_level = "trusted"`,
	}, "\n")

	next, changed := codexConfigWithModelPlanEndpoint(content, endpoint)
	if !changed {
		t.Fatalf("codexConfigWithModelPlanEndpoint() changed = false")
	}
	if strings.Contains(next, "[mcp_servers") || strings.Contains(next, "computer-use") {
		t.Fatalf("OpenRouter config must not expose MCP namespace tools:\n%s", next)
	}
	if strings.Count(next, `web_search = "disabled"`) != 1 || strings.Contains(next, `web_search = "live"`) {
		t.Fatalf("OpenRouter config must disable hosted web search:\n%s", next)
	}
	for _, feature := range []string{
		"apps",
		"current_time_reminder",
		"image_generation",
		"imagegenext",
		"memories",
		"multi_agent",
		"multi_agent_v2",
		"plugins",
		"standalone_web_search",
		"tool_suggest",
	} {
		if strings.Count(next, feature+" = false") != 1 || strings.Contains(next, feature+" = true") {
			t.Fatalf("OpenRouter config must disable %s:\n%s", feature, next)
		}
	}
	for _, table := range []string{"orchestrator.mcp", "orchestrator.skills"} {
		marker := "[" + table + "]\nenabled = false"
		if strings.Count(next, marker) != 1 {
			t.Fatalf("OpenRouter config must disable %s:\n%s", table, next)
		}
	}
	if !strings.Contains(next, "js_repl = false") ||
		!strings.Contains(next, `[projects."/tmp/work"]`) ||
		!strings.Contains(next, `trust_level = "trusted"`) {
		t.Fatalf("unrelated config was not preserved:\n%s", next)
	}
	if !strings.Contains(next, `wire_api = "responses"`) {
		t.Fatalf("OpenRouter model plan must still use Responses API:\n%s", next)
	}

	second, changed := codexConfigWithModelPlanEndpoint(next, endpoint)
	if changed || second != next {
		t.Fatalf("OpenRouter compatibility rewrite must be idempotent:\nfirst:\n%s\nsecond:\n%s", next, second)
	}
}

func TestCodexConfigWithModelPlanEndpointKeepsNamespaceSourcesForOtherProviders(t *testing.T) {
	t.Parallel()

	content := strings.Join([]string{
		`[mcp_servers.example]`,
		`command = "example"`,
		``,
		`[features]`,
		`multi_agent = true`,
		`apps = true`,
		`plugins = true`,
	}, "\n")
	next, _ := codexConfigWithModelPlanEndpoint(content, &ModelEndpointConfig{
		Protocol: "openai",
		BaseURL:  "https://api.openai.com/v1",
		APIKey:   "sk-official",
		Model:    "gpt-5.4",
	})
	if !strings.Contains(next, "[mcp_servers.example]") ||
		!strings.Contains(next, "multi_agent = true") ||
		!strings.Contains(next, "apps = true") ||
		!strings.Contains(next, "plugins = true") {
		t.Fatalf("non-OpenRouter model plans must keep namespace sources:\n%s", next)
	}
}

func TestModelEndpointClaudeEnvSelectsAuthShape(t *testing.T) {
	t.Parallel()

	relay := modelEndpointClaudeEnv(&ModelEndpointConfig{
		Protocol: "anthropic",
		BaseURL:  "https://relay.example/api/anthropic",
		APIKey:   "sk-relay",
	})
	joined := strings.Join(relay, "\n")
	if !strings.Contains(joined, "ANTHROPIC_BASE_URL=https://relay.example/api/anthropic") {
		t.Fatalf("relay env = %v", relay)
	}
	if !strings.Contains(joined, "ANTHROPIC_AUTH_TOKEN=sk-relay") || strings.Contains(joined, "ANTHROPIC_API_KEY=") {
		t.Fatalf("relay should use bearer auth token: %v", relay)
	}

	official := modelEndpointClaudeEnv(&ModelEndpointConfig{
		Protocol: "anthropic",
		BaseURL:  "https://api.anthropic.com/v1",
		APIKey:   "sk-ant",
	})
	joined = strings.Join(official, "\n")
	if !strings.Contains(joined, "ANTHROPIC_API_KEY=sk-ant") || strings.Contains(joined, "ANTHROPIC_AUTH_TOKEN=") {
		t.Fatalf("official endpoint should use api key: %v", official)
	}
	if !strings.Contains(joined, "ANTHROPIC_BASE_URL=https://api.anthropic.com") {
		t.Fatalf("official base url should drop /v1 suffix: %v", official)
	}

	if env := modelEndpointClaudeEnv(&ModelEndpointConfig{Protocol: "openai", BaseURL: "https://x", APIKey: "k"}); env != nil {
		t.Fatalf("openai endpoint should not produce claude env: %v", env)
	}
	if env := modelEndpointClaudeEnv(nil); env != nil {
		t.Fatalf("nil endpoint should not produce claude env: %v", env)
	}
}
