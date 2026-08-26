package runtimeprep

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexPrepareExposesStableProviderAndPersonalSkillRoots(t *testing.T) {
	providerStateHome := filepath.Join(t.TempDir(), "codex-state")
	personalSkillRoot := filepath.Join(t.TempDir(), "personal-skills")
	writeSidecarTestFile(t, filepath.Join(providerStateHome, "skills", "provider-skill", "SKILL.md"), "---\nname: provider-skill\n---\nprovider\n")
	writeSidecarTestFile(t, filepath.Join(personalSkillRoot, "personal-skill", "SKILL.md"), "---\nname: personal-skill\n---\npersonal\n")

	preparer := newTestPreparer(t.TempDir())
	preparer.RegisterProvider(CodexPreparer{PersonalSkillRoot: personalSkillRoot})
	prepared, err := preparer.Prepare(t.Context(), PrepareInput{
		WorkspaceID:       "workspace-1",
		AgentSessionID:    "session-1",
		AgentTargetID:     "local:codex",
		Provider:          "codex",
		ProviderStateHome: providerStateHome,
		Cwd:               t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	runHome := envValue(prepared.Env, "CODEX_HOME")
	for _, path := range []string{
		filepath.Join(runHome, "skills", "personal-skill", "SKILL.md"),
		filepath.Join(providerStateHome, "skills", "provider-skill", "SKILL.md"),
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("prepared Skill %s is unavailable: %v", path, err)
		}
	}
	var extraRoots []string
	if err := json.Unmarshal([]byte(envValue(prepared.Env, tuttiAgentExtraSkillRootsEnv)), &extraRoots); err != nil {
		t.Fatalf("decode Codex extra skill roots: %v", err)
	}
	wantProviderRoot := filepath.Join(providerStateHome, "skills")
	foundProviderRoot := false
	for _, root := range extraRoots {
		foundProviderRoot = foundProviderRoot || root == wantProviderRoot
	}
	if !foundProviderRoot {
		t.Fatalf("Codex extra skill roots = %#v, want stable provider root %q", extraRoots, wantProviderRoot)
	}
	cacheTarget, err := os.Readlink(filepath.Join(runHome, "models_cache.json"))
	if err != nil {
		t.Fatalf("read run-scoped models cache link: %v", err)
	}
	if want := filepath.Join(providerStateHome, "models_cache.json"); cacheTarget != want {
		t.Fatalf("models cache link = %q, want %q", cacheTarget, want)
	}
}

func TestCodexPrepareUsesExplicitProviderStateHome(t *testing.T) {
	hostHome := t.TempDir()
	setTestHome(t, hostHome)
	providerStateHome := filepath.Join(t.TempDir(), "codex-state")
	if err := os.MkdirAll(providerStateHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(providerStateHome, "auth.json"), []byte("{\"token\":\"stable\"}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(providerStateHome, "config.toml"), []byte("model = \"stable-model\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeSidecarTestFile(t, filepath.Join(providerStateHome, "skills", "stable-skill", "SKILL.md"), "---\nname: stable-skill\n---\nstable\n")

	prepared, err := newTestPreparer(t.TempDir()).Prepare(t.Context(), PrepareInput{
		WorkspaceID:       "workspace-1",
		AgentSessionID:    "session-1",
		AgentTargetID:     "local:codex",
		Provider:          "codex",
		ProviderStateHome: providerStateHome,
		Cwd:               t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	runHome := envValue(prepared.Env, "CODEX_HOME")
	if runHome == "" {
		t.Fatalf("prepared env = %#v, want CODEX_HOME", prepared.Env)
	}
	auth, err := os.ReadFile(filepath.Join(runHome, "auth.json"))
	if err != nil || !strings.Contains(string(auth), "stable") {
		t.Fatalf("run auth = %q, err=%v", auth, err)
	}
	config, err := os.ReadFile(filepath.Join(runHome, "config.toml"))
	if err != nil || !strings.Contains(string(config), "stable-model") {
		t.Fatalf("run config = %q, err=%v", config, err)
	}
	if _, err := os.Stat(filepath.Join(runHome, "skills", "stable-skill", "SKILL.md")); err != nil {
		t.Fatalf("stable provider skill missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(hostHome, ".codex")); !os.IsNotExist(err) {
		t.Fatalf("legacy user HOME was consulted or materialized: %v", err)
	}
}

func TestCodexPrepareRejectsInvalidExplicitProviderStateHome(t *testing.T) {
	type invalidHomeTest struct {
		name     string
		home     string
		wantText string
	}
	tests := []invalidHomeTest{
		{name: "relative", home: "relative/codex", wantText: "absolute non-root path"},
		{name: "root", home: string(filepath.Separator), wantText: "absolute non-root path"},
		{name: "missing", home: filepath.Join(t.TempDir(), "missing"), wantText: "inspect Codex provider state home"},
	}
	symlinkHome := filepath.Join(t.TempDir(), "codex-symlink")
	if err := os.Symlink(t.TempDir(), symlinkHome); err == nil {
		tests = append(tests, invalidHomeTest{name: "symlink", home: symlinkHome, wantText: "must be a real directory"})
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := newTestPreparer(t.TempDir()).Prepare(t.Context(), PrepareInput{
				WorkspaceID:       "workspace-1",
				AgentSessionID:    "session-1",
				AgentTargetID:     "local:codex",
				Provider:          "codex",
				ProviderStateHome: tc.home,
				Cwd:               t.TempDir(),
			})
			if err == nil || !strings.Contains(err.Error(), tc.wantText) {
				t.Fatalf("Prepare() error = %v, want substring %q", err, tc.wantText)
			}
		})
	}
}

func TestCodexPrepareWithoutProviderStateHomePreservesNativeSymlink(t *testing.T) {
	hostHome := t.TempDir()
	nativeCodexHome := filepath.Join(t.TempDir(), "native-codex")
	if err := os.MkdirAll(nativeCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(nativeCodexHome, filepath.Join(hostHome, ".codex")); err != nil {
		t.Skipf("native Codex home symlink is unavailable: %v", err)
	}
	setTestHome(t, hostHome)
	if err := os.WriteFile(filepath.Join(nativeCodexHome, "config.toml"), []byte("model = \"native-model\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	prepared, err := newTestPreparer(t.TempDir()).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:codex",
		Provider:       "codex",
		Cwd:            t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(filepath.Join(envValue(prepared.Env, "CODEX_HOME"), "config.toml"))
	if err != nil || !strings.Contains(string(config), "native-model") {
		t.Fatalf("run config = %q, err=%v", config, err)
	}
}

func TestCodexPrepareWithoutProviderStateHomeToleratesUnavailableUserHome(t *testing.T) {
	t.Setenv("HOME", "")
	t.Setenv("USERPROFILE", "")
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		t.Skipf("platform still resolves a native user Home at %q", home)
	}

	prepared, err := newTestPreparer(t.TempDir()).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:codex",
		Provider:       "codex",
		Cwd:            t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Prepare() should preserve the legacy no-Home behavior: %v", err)
	}
	if envValue(prepared.Env, "CODEX_HOME") == "" {
		t.Fatalf("prepared env = %#v, want run-scoped CODEX_HOME", prepared.Env)
	}
}
