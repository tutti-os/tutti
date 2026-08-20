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
	home := t.TempDir()
	setTestHome(t, home)
	stateDir := t.TempDir()
	cwd := t.TempDir()
	preparer := newTestPreparer(stateDir)
	prepareInput := PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:opencode",
		Provider:       "opencode",
		Cwd:            cwd,
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
	}
	result, err := preparer.Prepare(context.Background(), prepareInput)
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}

	configDir := envValue(result.Env, "OPENCODE_CONFIG_DIR")
	if configDir == "" {
		t.Fatalf("OPENCODE_CONFIG_DIR missing from env: %#v", result.Env)
	}
	if _, err := os.Stat(filepath.Join(cwd, ".opencode")); !os.IsNotExist(err) {
		t.Fatalf("OpenCode preparation must not write the workspace .opencode directory: %v", err)
	}
	configPath := filepath.Join(configDir, "opencode.json")
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
	bundle, err := preparer.RenderSkillBundle(context.Background(), prepareInput)
	if err != nil {
		t.Fatalf("RenderSkillBundle() error = %v", err)
	}
	assertOpenCodeTuttiRuntime(t, configDir, len(bundle.Skills))

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
	if err := preparer.Cleanup(context.Background(), CleanupInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "opencode",
	}); err != nil {
		t.Fatalf("Cleanup() error = %v", err)
	}
	if _, err := os.Stat(configDir); !os.IsNotExist(err) {
		t.Fatalf("OpenCode session config directory should be removed during cleanup: %v", err)
	}
}

func TestOpenCodePreparerInjectsTuttiRuntimeWithoutOpenAIPlan(t *testing.T) {
	endpoints := []*ModelEndpointConfig{
		nil,
		{Protocol: "anthropic", BaseURL: "https://relay.example", APIKey: "sk-secret"},
	}
	for index, endpoint := range endpoints {
		home := t.TempDir()
		setTestHome(t, home)
		stateDir := t.TempDir()
		cwd := t.TempDir()
		preparer := newTestPreparer(stateDir)
		prepareInput := PrepareInput{
			WorkspaceID:    "workspace-1",
			AgentSessionID: []string{"session-1", "session-2"}[index],
			AgentTargetID:  "local:opencode",
			Provider:       "opencode",
			Cwd:            cwd,
			ModelEndpoint:  endpoint,
		}
		result, err := preparer.Prepare(context.Background(), prepareInput)
		if err != nil {
			t.Fatalf("Prepare() error = %v", err)
		}
		configDir := envValue(result.Env, "OPENCODE_CONFIG_DIR")
		if configDir == "" {
			t.Fatalf("Prepare() env = %v; want OPENCODE_CONFIG_DIR for endpoint %#v", result.Env, endpoint)
		}
		if envValue(result.Env, "OPENCODE_CONFIG") != "" || envValue(result.Env, ModelPlanAPIKeyEnv) != "" {
			t.Fatalf("Prepare() env = %v; want no model-plan config for endpoint %#v", result.Env, endpoint)
		}
		bundle, err := preparer.RenderSkillBundle(context.Background(), prepareInput)
		if err != nil {
			t.Fatalf("RenderSkillBundle() error = %v", err)
		}
		assertOpenCodeTuttiRuntime(t, configDir, len(bundle.Skills))
		if _, err := os.Stat(filepath.Join(configDir, "opencode.json")); !os.IsNotExist(err) {
			t.Fatalf("session opencode config should not exist, stat err = %v", err)
		}
	}
}

func assertOpenCodeTuttiRuntime(t *testing.T, configDir string, expectedSkillCount int) {
	t.Helper()
	instructions, err := os.ReadFile(filepath.Join(configDir, "AGENTS.md"))
	if err != nil {
		t.Fatalf("read OpenCode runtime instructions: %v", err)
	}
	if !strings.Contains(string(instructions), "Agent handoff decisions belong to `$tutti-handoff`") ||
		!strings.Contains(string(instructions), "`mention://agent-target/<targetId>?workspaceId=...`") ||
		!strings.Contains(string(instructions), "`mention://workspace-reference/<id>?source=...&workspaceId=...`") {
		t.Fatalf("OpenCode runtime instructions do not contain Tutti mention routing: %s", instructions)
	}
	entries, err := os.ReadDir(filepath.Join(configDir, "skills"))
	if err != nil {
		t.Fatalf("read OpenCode Tutti skills: %v", err)
	}
	if len(entries) != expectedSkillCount {
		t.Fatalf("OpenCode Tutti Skill count = %d, want resolved bundle count %d", len(entries), expectedSkillCount)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(configDir, "skills", entry.Name(), "SKILL.md")); err != nil {
			t.Fatalf("OpenCode materialized Skill %q missing SKILL.md: %v", entry.Name(), err)
		}
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
