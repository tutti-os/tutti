package runtimeprep

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestEnsureRTKInstructionsReferenceFirst(t *testing.T) {
	instructionsPath := filepath.Join(t.TempDir(), "AGENTS.md")
	if err := os.WriteFile(instructionsPath, []byte("user instructions\n\nmanaged instructions\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	rtkPath := filepath.Join(t.TempDir(), "rtk", "RTK.md")
	input := PrepareInput{RTKSaverMode: true, rtkInstructionsPath: rtkPath}
	for range 2 {
		if err := ensureRTKInstructionsReferenceFirst(instructionsPath, input); err != nil {
			t.Fatal(err)
		}
	}
	content, err := os.ReadFile(instructionsPath)
	if err != nil {
		t.Fatal(err)
	}
	reference := "@" + rtkPath
	if !strings.HasPrefix(string(content), reference+"\n\n") {
		t.Fatalf("AGENTS.md = %q, want RTK reference first", content)
	}
	if got := strings.Count(string(content), reference); got != 1 {
		t.Fatalf("AGENTS.md contains RTK reference %d times, want 1: %q", got, content)
	}
}

func TestEnsureRTKInstructionsReferenceFirstPreservesWindowsPath(t *testing.T) {
	instructionsPath := filepath.Join(t.TempDir(), "AGENTS.md")
	if err := os.WriteFile(instructionsPath, []byte("instructions\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	input := PrepareInput{
		RTKSaverMode:        true,
		rtkInstructionsPath: `C:\Users\Test User\AppData\Local\Tutti\agent\runs\session-1\rtk\RTK.md`,
	}
	if err := ensureRTKInstructionsReferenceFirst(instructionsPath, input); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(instructionsPath)
	if err != nil {
		t.Fatal(err)
	}
	want := `@C:\Users\Test User\AppData\Local\Tutti\agent\runs\session-1\rtk\RTK.md`
	if !strings.HasPrefix(string(content), want+"\r\n\r\n") {
		t.Fatalf("AGENTS.md = %q, want Windows RTK reference %q first", content, want)
	}
}

func TestEnsureRTKInstructionsReferenceFirstNoopWhenDisabled(t *testing.T) {
	instructionsPath := filepath.Join(t.TempDir(), "AGENTS.md")
	const original = "instructions\n"
	if err := os.WriteFile(instructionsPath, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ensureRTKInstructionsReferenceFirst(instructionsPath, PrepareInput{}); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(instructionsPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != original {
		t.Fatalf("AGENTS.md = %q, want unchanged %q", content, original)
	}
}

func TestRTKInlinePolicyPrecedesTuttiRuntime(t *testing.T) {
	policy, err := tuttiCLIPolicy(testInputWithCommands(t, PrepareInput{
		AgentSessionID: "session-1",
		Provider:       "extension-provider",
		RTKSaverMode:   true,
	}))
	if err != nil {
		t.Fatal(err)
	}
	rtkIndex := strings.Index(policy, "# RTK - Rust Token Killer")
	runtimeIndex := strings.Index(policy, "# Tutti Runtime")
	if rtkIndex < 0 || runtimeIndex < 0 || rtkIndex > runtimeIndex {
		t.Fatalf("policy must put RTK before Tutti runtime: %s", policy)
	}
}

func TestRTKProviderNativeRewritersAreSessionScoped(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake RTK fixture is a POSIX script")
	}
	setTestHome(t, t.TempDir())
	sourceRTK := filepath.Join(t.TempDir(), rtkExecutableName())
	writeSidecarTestFile(t, sourceRTK, "#!/bin/sh\nexit 0\n")
	if err := os.Chmod(sourceRTK, 0o700); err != nil {
		t.Fatal(err)
	}

	prepare := func(t *testing.T, provider string) PreparedRuntime {
		t.Helper()
		preparer := newTestPreparer(t.TempDir())
		preparer.RTKExecutableResolver = func(context.Context) (string, error) { return sourceRTK, nil }
		prepared, err := preparer.Prepare(t.Context(), PrepareInput{
			WorkspaceID:    "workspace-1",
			AgentSessionID: "session-1",
			AgentTargetID:  "local:" + provider,
			Provider:       provider,
			Cwd:            t.TempDir(),
			RTKSaverMode:   true,
		})
		if err != nil {
			t.Fatalf("Prepare(%s) error = %v", provider, err)
		}
		return prepared
	}

	t.Run("claude-code", func(t *testing.T) {
		prepared := prepare(t, "claude-code")
		hooks, err := os.ReadFile(filepath.Join(envValue(prepared.Env, claudePluginDirEnv), "hooks", "hooks.json"))
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{`"PreToolUse"`, `"matcher": "Bash"`, `"command": "rtk hook claude"`} {
			if !strings.Contains(string(hooks), want) {
				t.Fatalf("Claude hooks = %q, want %q", hooks, want)
			}
		}
	})

	t.Run("cursor", func(t *testing.T) {
		prepared := prepare(t, "cursor")
		hooks, err := os.ReadFile(filepath.Join(envValue(prepared.Env, cursorPluginDirEnv), "hooks", "hooks.json"))
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{`"preToolUse"`, `"matcher": "Shell"`, `"command": "rtk hook cursor"`} {
			if !strings.Contains(string(hooks), want) {
				t.Fatalf("Cursor hooks = %q, want %q", hooks, want)
			}
		}
	})

	t.Run("opencode", func(t *testing.T) {
		prepared := prepare(t, "opencode")
		plugin, err := os.ReadFile(filepath.Join(envValue(prepared.Env, "OPENCODE_CONFIG_DIR"), "plugins", "rtk.ts"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(plugin), `"tool.execute.before"`) || !strings.Contains(string(plugin), "rtk rewrite") {
			t.Fatalf("OpenCode RTK plugin = %q", plugin)
		}
	})
}

func TestHermesRTKPluginIsSessionScoped(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake RTK fixture is a POSIX script")
	}
	globalHome := t.TempDir()
	t.Setenv("HERMES_HOME", globalHome)
	if err := os.WriteFile(filepath.Join(globalHome, "config.yaml"), []byte("model: test\nplugins:\n  enabled:\n    - existing\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sourceRTK := filepath.Join(t.TempDir(), rtkExecutableName())
	writeSidecarTestFile(t, sourceRTK, "#!/bin/sh\nexit 0\n")
	if err := os.Chmod(sourceRTK, 0o700); err != nil {
		t.Fatal(err)
	}
	preparer := newTestPreparer(t.TempDir())
	preparer.RTKExecutableResolver = func(context.Context) (string, error) { return sourceRTK, nil }
	prepared, err := preparer.Prepare(t.Context(), PrepareInput{
		WorkspaceID:          "workspace-1",
		AgentSessionID:       "session-1",
		AgentTargetID:        "extension:hermes",
		Provider:             "acp:hermes",
		Cwd:                  t.TempDir(),
		RTKSaverMode:         true,
		ExtensionRuntimePrep: hermesRuntimePrep(),
	})
	if err != nil {
		t.Fatal(err)
	}
	hermesHome := envValue(prepared.Env, "HERMES_HOME")
	for _, path := range []string{
		filepath.Join(hermesHome, "plugins", "rtk-rewrite", "__init__.py"),
		filepath.Join(hermesHome, "plugins", "rtk-rewrite", "plugin.yaml"),
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("Hermes RTK plugin file %s: %v", path, err)
		}
	}
	config, err := os.ReadFile(filepath.Join(hermesHome, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"existing", "rtk-rewrite"} {
		if !strings.Contains(string(config), want) {
			t.Fatalf("Hermes config = %q, want %q", config, want)
		}
	}
}

func TestKimiRTKPluginIsSessionScoped(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake RTK fixture is a POSIX script")
	}
	globalHome := t.TempDir()
	t.Setenv(kimiCodeHomeEnv, globalHome)
	if err := os.WriteFile(filepath.Join(globalHome, "config.toml"), []byte("default_model = \"test\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(globalHome, "plugins"), 0o700); err != nil {
		t.Fatal(err)
	}
	existingRoot := filepath.Join(globalHome, "plugins", "existing")
	if err := os.MkdirAll(existingRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	existing := `{"version":1,"plugins":[{"id":"existing","root":"` + existingRoot + `","source":"local-path","enabled":true,"installedAt":"2026-01-01T00:00:00Z"}]}`
	if err := os.WriteFile(filepath.Join(globalHome, "plugins", "installed.json"), []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}

	sourceRTK := filepath.Join(t.TempDir(), rtkExecutableName())
	writeSidecarTestFile(t, sourceRTK, "#!/bin/sh\nexit 0\n")
	if err := os.Chmod(sourceRTK, 0o700); err != nil {
		t.Fatal(err)
	}
	preparer := newTestPreparer(t.TempDir())
	preparer.RTKExecutableResolver = func(context.Context) (string, error) { return sourceRTK, nil }
	prepared, err := preparer.Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "extension:kimi-code",
		Provider:       "acp:kimi-code",
		Cwd:            t.TempDir(),
		RTKSaverMode:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	kimiHome := envValue(prepared.Env, kimiCodeHomeEnv)
	manifest, err := os.ReadFile(filepath.Join(kimiHome, "plugins", "managed", "tutti-rtk", "kimi.plugin.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(manifest), "systemPrompt") || !strings.Contains(string(manifest), "MUST invoke it through RTK") {
		t.Fatalf("Kimi RTK plugin manifest = %q", manifest)
	}
	installed, err := os.ReadFile(filepath.Join(kimiHome, "plugins", "installed.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"id": "existing"`, `"id": "tutti-rtk"`} {
		if !strings.Contains(string(installed), want) {
			t.Fatalf("Kimi installed plugins = %q, want %q", installed, want)
		}
	}
	if _, err := os.Stat(filepath.Join(kimiHome, "config.toml")); err != nil {
		t.Fatalf("Kimi session config: %v", err)
	}
}
