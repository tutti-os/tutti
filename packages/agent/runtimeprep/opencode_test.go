package runtimeprep

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenCodePreparerInjectsModelPlanConfig(t *testing.T) {
	t.Parallel()

	runtimeRoot := t.TempDir()
	manifest := NewManifest(ManifestInput{
		AgentSessionID: "session-1",
		Provider:       "opencode",
		Cwd:            runtimeRoot,
		RuntimeRoot:    runtimeRoot,
	})
	result, err := OpenCodePreparer{}.Prepare(context.Background(), ProviderPrepareInput{
		PrepareInput: PrepareInput{
			Provider: "opencode",
			Cwd:      runtimeRoot,
			ModelEndpoint: &ModelEndpointConfig{
				PlanName: "Volc Coding Plan",
				Protocol: "openai",
				BaseURL:  "https://relay.example/v1",
				APIKey:   "sk-secret",
				Model:    "tutti-model-plan/seed-code",
				Models: []ModelEndpointModel{
					{ID: "seed-code", Name: "Seed Code"},
					{ID: "kimi-k2.5", Name: "Kimi K2.5"},
				},
			},
		},
		RuntimeRoot: runtimeRoot,
		Manifest:    manifest,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}

	configPath := filepath.Join(runtimeRoot, "opencode", "opencode.json")
	envIndex := map[string]string{}
	for _, entry := range result.Env {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			t.Fatalf("malformed env entry %q", entry)
		}
		envIndex[key] = value
	}
	if envIndex["OPENCODE_CONFIG"] != configPath {
		t.Fatalf("OPENCODE_CONFIG = %q; want %q", envIndex["OPENCODE_CONFIG"], configPath)
	}
	if envIndex[ModelPlanAPIKeyEnv] != "sk-secret" {
		t.Fatalf("%s = %q; want the plan credential", ModelPlanAPIKeyEnv, envIndex[ModelPlanAPIKeyEnv])
	}

	content, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read session opencode config: %v", err)
	}
	if strings.Contains(string(content), "sk-secret") {
		t.Fatalf("credential leaked into config:\n%s", content)
	}

	var document struct {
		Model    string `json:"model"`
		Provider map[string]struct {
			NPM     string `json:"npm"`
			Name    string `json:"name"`
			Options struct {
				BaseURL string `json:"baseURL"`
				APIKey  string `json:"apiKey"`
			} `json:"options"`
			Models map[string]struct {
				Name string `json:"name"`
			} `json:"models"`
		} `json:"provider"`
	}
	if err := json.Unmarshal(content, &document); err != nil {
		t.Fatalf("parse session opencode config: %v\n%s", err, content)
	}
	if document.Model != "tutti-model-plan/seed-code" {
		t.Fatalf("model = %q; want namespaced plan default", document.Model)
	}
	provider, ok := document.Provider[ModelPlanProviderID]
	if !ok {
		t.Fatalf("provider block %q missing:\n%s", ModelPlanProviderID, content)
	}
	if provider.NPM != "@ai-sdk/openai-compatible" {
		t.Fatalf("provider npm = %q", provider.NPM)
	}
	if provider.Name != "Volc Coding Plan" {
		t.Fatalf("provider name = %q", provider.Name)
	}
	if provider.Options.BaseURL != "https://relay.example/v1" {
		t.Fatalf("provider baseURL = %q", provider.Options.BaseURL)
	}
	if provider.Options.APIKey != "{env:"+ModelPlanAPIKeyEnv+"}" {
		t.Fatalf("provider apiKey = %q; want env token reference", provider.Options.APIKey)
	}
	if len(provider.Models) != 2 {
		t.Fatalf("provider models = %#v; want both plan models", provider.Models)
	}
	if provider.Models["seed-code"].Name != "Seed Code" || provider.Models["kimi-k2.5"].Name != "Kimi K2.5" {
		t.Fatalf("provider models = %#v", provider.Models)
	}
}

func TestOpenCodePreparerSkipsWithoutOpenAIPlan(t *testing.T) {
	t.Parallel()

	runtimeRoot := t.TempDir()
	endpoints := []*ModelEndpointConfig{
		nil,
		{Protocol: "anthropic", BaseURL: "https://relay.example", APIKey: "sk-secret"},
	}
	for _, endpoint := range endpoints {
		result, err := OpenCodePreparer{}.Prepare(context.Background(), ProviderPrepareInput{
			PrepareInput: PrepareInput{Provider: "opencode", Cwd: runtimeRoot, ModelEndpoint: endpoint},
			RuntimeRoot:  runtimeRoot,
		})
		if err != nil {
			t.Fatalf("Prepare() error = %v", err)
		}
		if len(result.Env) != 0 {
			t.Fatalf("Prepare() env = %v; want none for endpoint %#v", result.Env, endpoint)
		}
	}
	if _, err := os.Stat(filepath.Join(runtimeRoot, "opencode", "opencode.json")); !os.IsNotExist(err) {
		t.Fatalf("session opencode config should not exist, stat err = %v", err)
	}
}

func TestOpenCodePlanModelValueRoundTrip(t *testing.T) {
	t.Parallel()

	if got := OpenCodePlanModelValue("seed-code"); got != ModelPlanProviderID+"/seed-code" {
		t.Fatalf("OpenCodePlanModelValue() = %q", got)
	}
	if got := OpenCodePlanModelValue(ModelPlanProviderID + "/seed-code"); got != ModelPlanProviderID+"/seed-code" {
		t.Fatalf("OpenCodePlanModelValue() double-prefixed: %q", got)
	}
	if got := OpenCodePlanModelValue(""); got != "" {
		t.Fatalf("OpenCodePlanModelValue(empty) = %q", got)
	}
	if got := OpenCodePlanModelID(ModelPlanProviderID + "/seed-code"); got != "seed-code" {
		t.Fatalf("OpenCodePlanModelID() = %q", got)
	}
	if got := OpenCodePlanModelID("seed-code"); got != "seed-code" {
		t.Fatalf("OpenCodePlanModelID(raw) = %q", got)
	}
}
