package runtimeprep

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestTuttiAgentPreparerUsesExplicitAuthSourceAndInstallsSkills(t *testing.T) {
	userHome := t.TempDir()
	setTestHome(t, userHome)
	defaultAuthDir := filepath.Join(userHome, ".tutti-agent")
	if err := os.MkdirAll(defaultAuthDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(defaultAuthDir, "config.toml"), []byte("model = \"must-not-be-copied\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	runtimeRoot := t.TempDir()
	authSource := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(authSource, []byte(`{"token":"explicit"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	preparer := TuttiAgentPreparer{
		ResolveAuthSource: func(context.Context, PrepareInput) (string, error) {
			return authSource, nil
		},
	}
	store := LocalStore{StateDir: t.TempDir()}
	result, err := preparer.Prepare(context.Background(), ProviderPrepareInput{
		PrepareInput: testResolvedInput(t, PrepareInput{
			AgentSessionID: "session-1",
			AgentTargetID:  "local:tutti-agent",
			Provider:       "tutti-agent",
			CLICommand:     "tutti",
		}),
		RuntimeRoot: runtimeRoot,
		Store:       store,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}

	home := filepath.Join(runtimeRoot, "tutti-agent-home")
	authPath := filepath.Join(home, "auth.json")
	if runtime.GOOS == "windows" {
		content, err := os.ReadFile(authPath)
		if err != nil {
			t.Fatalf("read materialized auth: %v", err)
		}
		if string(content) != `{"token":"explicit"}` {
			t.Fatalf("materialized auth = %q", content)
		}
	} else {
		linked, err := os.Readlink(authPath)
		if err != nil {
			t.Fatalf("read auth symlink: %v", err)
		}
		if linked != authSource {
			t.Fatalf("auth symlink = %q, want %q", linked, authSource)
		}
	}
	if _, err := os.Stat(filepath.Join(home, "skills", "tutti-cli", "SKILL.md")); err != nil {
		t.Fatalf("native tutti-cli skill missing: %v", err)
	}
	config, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(config), "must-not-be-copied") {
		t.Fatal("explicit auth source unexpectedly imported the VM user's config")
	}
	for _, unexpected := range []string{`model_provider =`, `model = "gpt-5.4"`, `[model_providers.tutti-llm]`} {
		if strings.Contains(string(config), unexpected) {
			t.Fatalf("managed config unexpectedly pinned %q: %s", unexpected, config)
		}
	}
	if runtime.GOOS == "windows" && !containsConfigBlock(string(config), "[windows]\nsandbox = \"unelevated\"") {
		t.Fatalf("Tutti Agent session config missing Windows sandbox fallback: %s", config)
	}
	if len(result.Env) == 0 || result.Env[0] != "TUTTI_AGENT_HOME="+home {
		t.Fatalf("Prepare() env = %#v", result.Env)
	}
}

func TestTuttiAgentPreparerReconcilesNativeSkillsAcrossRepeatedPrepare(t *testing.T) {
	userHome := t.TempDir()
	setTestHome(t, userHome)
	preparer := TuttiAgentPreparer{}
	input := ProviderPrepareInput{
		PrepareInput: testResolvedInput(t, PrepareInput{
			AgentSessionID: "session-1",
			AgentTargetID:  "local:tutti-agent",
			Provider:       "tutti-agent",
			CLICommand:     "tutti",
		}),
		RuntimeRoot: t.TempDir(),
		Store:       LocalStore{StateDir: t.TempDir()},
	}
	if _, err := preparer.Prepare(t.Context(), input); err != nil {
		t.Fatalf("first Prepare() error = %v", err)
	}
	if _, err := preparer.Prepare(t.Context(), input); err != nil {
		t.Fatalf("second Prepare() error = %v", err)
	}

	skillRoot := filepath.Join(input.RuntimeRoot, "tutti-agent-home", "skills")
	if _, err := os.Stat(filepath.Join(skillRoot, "tutti-cli", "SKILL.md")); err != nil {
		t.Fatalf("stable tutti-cli skill missing after repeated Prepare(): %v", err)
	}
	if _, err := os.Stat(filepath.Join(skillRoot, "tutti-cli-tutti")); !os.IsNotExist(err) {
		t.Fatalf("repeated Prepare() created a suffixed tutti-cli skill, err = %v", err)
	}
}

func TestTuttiAgentPreparerSkipsSkillsForModelProbe(t *testing.T) {
	input := ProviderPrepareInput{
		PrepareInput: testResolvedInput(t, PrepareInput{
			AgentSessionID: "model-probe-1",
			AgentTargetID:  "local:tutti-agent",
			Provider:       "tutti-agent",
			CLICommand:     "tutti",
			SkipSkills:     true,
		}),
		RuntimeRoot: t.TempDir(),
		Store:       LocalStore{StateDir: t.TempDir()},
	}
	result, err := (TuttiAgentPreparer{}).Prepare(t.Context(), input)
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	home := filepath.Join(input.RuntimeRoot, "tutti-agent-home")
	if _, err := os.Stat(filepath.Join(home, "skills")); !os.IsNotExist(err) {
		t.Fatalf("model-only Prepare() created a Skill root, err = %v", err)
	}
	for _, env := range result.Env {
		if strings.HasPrefix(env, "TUTTI_AGENT_EXTRA_SKILL_ROOTS_JSON=") || strings.HasPrefix(env, "TUTTI_AGENT_STABLE_SYSTEM_SKILLS_ROOT=") {
			t.Fatalf("model-only Prepare() exposed Skill env %q", env)
		}
	}
}

func TestTuttiAgentPreparerRejectsRelativeAuthSource(t *testing.T) {
	preparer := TuttiAgentPreparer{
		ResolveAuthSource: func(context.Context, PrepareInput) (string, error) {
			return "relative/auth.json", nil
		},
	}
	_, err := preparer.Prepare(context.Background(), ProviderPrepareInput{
		PrepareInput: testResolvedInput(t, PrepareInput{Provider: "tutti-agent"}),
		RuntimeRoot:  t.TempDir(),
		Store:        LocalStore{StateDir: t.TempDir()},
	})
	if err == nil {
		t.Fatal("Prepare() error = nil, want relative auth source rejection")
	}
}

func TestTuttiAgentPreparerDoesNotFallbackWhenExplicitAuthSourceIsEmpty(t *testing.T) {
	userHome := t.TempDir()
	setTestHome(t, userHome)
	defaultHome := filepath.Join(userHome, ".tutti-agent")
	if err := os.MkdirAll(defaultHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(defaultHome, "auth.json"), []byte(`{"old":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(defaultHome, "config.toml"), []byte("model = \"old\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	runtimeRoot := t.TempDir()
	preparer := TuttiAgentPreparer{ResolveAuthSource: func(context.Context, PrepareInput) (string, error) { return "", nil }}
	_, err := preparer.Prepare(context.Background(), ProviderPrepareInput{
		PrepareInput: testResolvedInput(t, PrepareInput{Provider: "tutti-agent"}),
		RuntimeRoot:  runtimeRoot,
		Store:        LocalStore{StateDir: t.TempDir()},
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	home := filepath.Join(runtimeRoot, "tutti-agent-home")
	if _, err := os.Lstat(filepath.Join(home, "auth.json")); !os.IsNotExist(err) {
		t.Fatalf("auth fallback exists, error = %v", err)
	}
	config, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(config), `model = "old"`) {
		t.Fatal("explicit empty auth source imported the VM user's config")
	}
}

func TestPrepareTuttiAgentHomeRemovesLegacyPinnedProvider(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, "config.toml")
	legacyConfig := strings.Join([]string{
		`model_provider = "tutti-llm"`,
		`model = "gpt-5.4"`,
		``,
		`[model_providers.tutti-llm]`,
		`name = "Tutti LLM"`,
		`base_url = "https://llm-api.tutti.sh/v1"`,
		`wire_api = "responses"`,
		``,
	}, "\n")
	if err := os.WriteFile(configPath, []byte(legacyConfig), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := PrepareTuttiAgentHome(home, testResolvedInput(t, PrepareInput{Provider: "tutti-agent"})); err != nil {
		t.Fatalf("PrepareTuttiAgentHome() error = %v", err)
	}

	config, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, removed := range []string{
		`model_provider = "tutti-llm"`,
		`model = "gpt-5.4"`,
		`[model_providers.tutti-llm]`,
	} {
		if strings.Contains(string(config), removed) {
			t.Fatalf("legacy pinned config still contains %q:\n%s", removed, config)
		}
	}
}

func TestPrepareTuttiAgentHomeWritesResponsesModelPlanEndpoint(t *testing.T) {
	home := t.TempDir()
	endpoint := &ModelEndpointConfig{
		PlanName: "Custom plan",
		Protocol: "openai",
		BaseURL:  "http://127.0.0.1:40000/v1",
		APIKey:   "temporary-session-token",
		WireAPI:  "responses",
		Model:    "model-a",
	}
	if err := PrepareTuttiAgentHome(home, testResolvedInput(t, PrepareInput{
		Provider:      "tutti-agent",
		ModelEndpoint: endpoint,
	})); err != nil {
		t.Fatalf("PrepareTuttiAgentHome() error = %v", err)
	}

	configBytes, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	config := string(configBytes)
	for _, expected := range []string{
		`model_provider = "tutti-model-plan"`,
		`model = "model-a"`,
		`[model_providers.tutti-model-plan]`,
		`name = "Custom plan"`,
		`base_url = "http://127.0.0.1:40000/v1"`,
		`env_key = "TUTTI_MODEL_PLAN_API_KEY"`,
		`wire_api = "responses"`,
	} {
		if !strings.Contains(config, expected) {
			t.Fatalf("config missing %q:\n%s", expected, config)
		}
	}
	if strings.Contains(config, endpoint.APIKey) {
		t.Fatalf("config contains the temporary credential:\n%s", config)
	}
}
