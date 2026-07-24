package runtimeprep

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTuttiAgentPreparerUsesExplicitAuthSourceAndInstallsSkills(t *testing.T) {
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	defaultAuthDir := filepath.Join(userHome, ".tutti-agent")
	if err := os.MkdirAll(defaultAuthDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(defaultAuthDir, "config.toml"), []byte("model = \"must-not-be-copied\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	runtimeRoot := t.TempDir()
	authSource := filepath.Join(t.TempDir(), "auth.json")
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
	linked, err := os.Readlink(filepath.Join(home, "auth.json"))
	if err != nil {
		t.Fatalf("read auth symlink: %v", err)
	}
	if linked != authSource {
		t.Fatalf("auth symlink = %q, want %q", linked, authSource)
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
	if len(result.Env) == 0 || result.Env[0] != "TUTTI_AGENT_HOME="+home {
		t.Fatalf("Prepare() env = %#v", result.Env)
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
	t.Setenv("HOME", userHome)
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
