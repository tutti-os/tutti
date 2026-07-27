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
	if strings.Contains(next, "sk-secret") {
		t.Fatalf("credential leaked into config:\n%s", next)
	}

	// Anthropic-protocol plans must not rewrite Codex config.
	if _, changed := codexConfigWithModelPlanEndpoint(content, &ModelEndpointConfig{Protocol: "anthropic", BaseURL: "https://x", APIKey: "k"}); changed {
		t.Fatalf("anthropic endpoint should not change codex config")
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
	if !strings.Contains(joined, "ANTHROPIC_AUTH_TOKEN=sk-relay") || !strings.HasSuffix(joined, "ANTHROPIC_API_KEY=") {
		t.Fatalf("relay should use bearer auth token: %v", relay)
	}

	official := modelEndpointClaudeEnv(&ModelEndpointConfig{
		Protocol: "anthropic",
		BaseURL:  "https://api.anthropic.com/v1",
		APIKey:   "sk-ant",
	})
	joined = strings.Join(official, "\n")
	if !strings.Contains(joined, "ANTHROPIC_API_KEY=sk-ant") || !strings.HasSuffix(joined, "ANTHROPIC_AUTH_TOKEN=") {
		t.Fatalf("official endpoint should use api key: %v", official)
	}
	if !strings.Contains(joined, "ANTHROPIC_BASE_URL=https://api.anthropic.com") {
		t.Fatalf("official base url should drop /v1 suffix: %v", official)
	}

	kimiCoding := modelEndpointClaudeEnv(&ModelEndpointConfig{
		Protocol: "anthropic",
		BaseURL:  "https://api.kimi.com/coding/",
		APIKey:   "sk-kimi",
	})
	joined = strings.Join(kimiCoding, "\n")
	if !strings.Contains(joined, "ANTHROPIC_API_KEY=sk-kimi") || !strings.HasSuffix(joined, "ANTHROPIC_AUTH_TOKEN=") {
		t.Fatalf("Kimi Coding should use api key auth: %v", kimiCoding)
	}
	if !strings.Contains(joined, "ANTHROPIC_BASE_URL=https://api.kimi.com/coding/") {
		t.Fatalf("Kimi Coding base url should be preserved: %v", kimiCoding)
	}

	if env := modelEndpointClaudeEnv(&ModelEndpointConfig{Protocol: "openai", BaseURL: "https://x", APIKey: "k"}); env != nil {
		t.Fatalf("openai endpoint should not produce claude env: %v", env)
	}
	if env := modelEndpointClaudeEnv(nil); env != nil {
		t.Fatalf("nil endpoint should not produce claude env: %v", env)
	}
}
