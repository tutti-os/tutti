package runtimeprep

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPrepareCodexRuntimeForLaunchSynchronizesEnabledPlugins(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userCodexHome := filepath.Join(home, ".codex")
	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userCodexHome, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	command := fakeCodexPluginCLI(t, "0.145.0", false)
	firstHome := preparedCodexBootstrapHome(t, userCodexHome)

	first := PrepareCodexRuntimeForLaunch(t.Context(), CodexRuntimeBootstrapInput{
		CodexHome: firstHome,
		ResolveCLI: func(context.Context) (CodexCLICommand, error) {
			return CodexCLICommand{Command: []string{command, "app-server"}}, nil
		},
	})
	if first.CLIVersion != "0.145.0" {
		t.Fatalf("CLI version = %q", first.CLIVersion)
	}
	if first.Models.Strategy != codexModelsCacheStrategyShared {
		t.Fatalf("models cache = %#v", first.Models)
	}
	if first.Plugins.Strategy != codexPluginCacheStrategyShare {
		t.Fatalf("plugin cache = %#v", first.Plugins)
	}
	if first.PluginSync.Status != "succeeded" || first.PluginSync.Installed != 2 ||
		first.PluginSync.Discovered != 2 || first.PluginSync.Failed != 0 {
		t.Fatalf("plugin sync = %#v", first.PluginSync)
	}
	for _, pluginID := range []string{"browser@openai-bundled", "sites@openai-bundled"} {
		if _, ok := locateCodexPluginPackageInCache(firstHome, pluginID); !ok {
			t.Fatalf("%s was not installed in versioned cache", pluginID)
		}
	}
	if _, ok := locateCodexPluginPackageInCache(firstHome, "computer-use@openai-bundled"); ok {
		t.Fatal("disabled computer-use plugin should not be installed")
	}

	secondHome := preparedCodexBootstrapHome(t, userCodexHome)
	second := PrepareCodexRuntimeForLaunch(t.Context(), CodexRuntimeBootstrapInput{
		CodexHome: secondHome,
		ResolveCLI: func(context.Context) (CodexCLICommand, error) {
			return CodexCLICommand{Command: []string{command, "app-server"}}, nil
		},
	})
	if second.PluginSync.Status != "succeeded" || second.PluginSync.Installed != 0 {
		t.Fatalf("warm plugin sync = %#v", second.PluginSync)
	}
	firstLink, err := os.Readlink(filepath.Join(firstHome, "plugins", "cache"))
	if err != nil {
		t.Fatal(err)
	}
	secondLink, err := os.Readlink(filepath.Join(secondHome, "plugins", "cache"))
	if err != nil {
		t.Fatal(err)
	}
	if firstLink != secondLink {
		t.Fatalf("same CLI version did not share plugin cache: %q != %q", firstLink, secondLink)
	}
}

func TestDefaultPreparerCarriesPluginBootstrapDiagnostics(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userCodexHome := filepath.Join(home, ".codex")
	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userCodexHome, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	command := fakeCodexPluginCLI(t, "0.145.0", false)
	preparer := newTestPreparer(t.TempDir())
	preparer.SetCodexCLIResolver(func(context.Context) (CodexCLICommand, error) {
		return CodexCLICommand{Command: []string{command, "app-server"}}, nil
	})
	prepared, err := preparer.Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:codex",
		Provider:       "codex",
		Cwd:            t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if envValue(prepared.Env, codexPluginSyncStatusEnv) != "succeeded" {
		t.Fatalf("prepared env = %#v", prepared.Env)
	}
	if envValue(prepared.Env, codexPreparedCLIVersionEnv) != "0.145.0" {
		t.Fatalf("prepared env = %#v", prepared.Env)
	}
}

func TestPrepareCodexRuntimeForLaunchSeparatesPluginCachesByCLIVersion(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userCodexHome := filepath.Join(home, ".codex")
	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userCodexHome, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	oldHome := preparedCodexBootstrapHome(t, userCodexHome)
	newHome := preparedCodexBootstrapHome(t, userCodexHome)
	oldCLI := fakeCodexPluginCLI(t, "0.144.6", false)
	newCLI := fakeCodexPluginCLI(t, "0.145.0", false)

	for _, input := range []struct {
		home    string
		command string
	}{
		{oldHome, oldCLI},
		{newHome, newCLI},
	} {
		status := PrepareCodexRuntimeForLaunch(t.Context(), CodexRuntimeBootstrapInput{
			CodexHome: input.home,
			ResolveCLI: func(context.Context) (CodexCLICommand, error) {
				return CodexCLICommand{Command: []string{input.command, "app-server"}}, nil
			},
		})
		if status.PluginSync.Status != "succeeded" {
			t.Fatalf("bootstrap %s = %#v", input.command, status)
		}
	}
	oldLink, err := os.Readlink(filepath.Join(oldHome, "plugins", "cache"))
	if err != nil {
		t.Fatal(err)
	}
	newLink, err := os.Readlink(filepath.Join(newHome, "plugins", "cache"))
	if err != nil {
		t.Fatal(err)
	}
	if oldLink == newLink {
		t.Fatalf("different CLI versions shared plugin cache %q", oldLink)
	}
	if !strings.Contains(oldLink, filepath.Join(codexPluginCachesDir, "0.144.6")) ||
		!strings.Contains(newLink, filepath.Join(codexPluginCachesDir, "0.145.0")) {
		t.Fatalf("versioned links = %q and %q", oldLink, newLink)
	}
}

func TestPrepareCodexRuntimeForLaunchPluginFailureIsDiagnosedAndNonFatal(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userCodexHome := filepath.Join(home, ".codex")
	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	codexHome := preparedCodexBootstrapHome(t, userCodexHome)
	command := fakeCodexPluginCLI(t, "0.145.0", true)

	status := PrepareCodexRuntimeForLaunch(t.Context(), CodexRuntimeBootstrapInput{
		CodexHome: codexHome,
		ResolveCLI: func(context.Context) (CodexCLICommand, error) {
			return CodexCLICommand{Command: []string{command, "app-server"}}, nil
		},
	})
	if status.PluginSync.Status != "failed" || status.PluginSync.Reason != "exit_code_7" {
		t.Fatalf("plugin sync = %#v", status.PluginSync)
	}
	if status.Models.Strategy != codexModelsCacheStrategyShared ||
		status.Plugins.Strategy != codexPluginCacheStrategyShare {
		t.Fatalf("cache setup should survive plugin failure: %#v", status)
	}
}

func TestCodexPluginSyncLockHonorsContext(t *testing.T) {
	codexHome := t.TempDir()
	if err := os.MkdirAll(filepath.Join(codexHome, "plugins", "cache"), 0o700); err != nil {
		t.Fatal(err)
	}
	release, err := acquireCodexPluginSyncLock(t.Context(), codexHome)
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Millisecond)
	defer cancel()
	if _, err := acquireCodexPluginSyncLock(ctx, codexHome); err == nil {
		t.Fatal("second lock acquisition should time out")
	}
}

func preparedCodexBootstrapHome(t *testing.T, userCodexHome string) string {
	t.Helper()
	codexHome := t.TempDir()
	if err := os.MkdirAll(filepath.Join(codexHome, "plugins"), 0o700); err != nil {
		t.Fatal(err)
	}
	if source := filepath.Join(userCodexHome, "config.toml"); source != "" {
		content, err := os.ReadFile(source)
		if err == nil {
			if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), content, 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	return codexHome
}

func fakeCodexPluginCLI(t *testing.T, version string, failList bool) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "codex")
	listBody := `printf '%s\n' '{"installed":[],"available":[{"pluginId":"browser@openai-bundled","installed":false,"enabled":true,"installPolicy":"AVAILABLE"},{"pluginId":"sites@openai-bundled","installed":false,"enabled":true,"installPolicy":"AVAILABLE"},{"pluginId":"computer-use@openai-bundled","installed":false,"enabled":false,"installPolicy":"AVAILABLE"}]}'`
	if failList {
		listBody = "exit 7"
	}
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli ` + version + `"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  ` + listBody + `
  exit $?
fi
if [ "$1" = "plugin" ] && [ "$2" = "add" ]; then
  plugin_id="$3"
  name="${plugin_id%@*}"
  marketplace="${plugin_id#*@}"
  target="$CODEX_HOME/plugins/cache/$marketplace/$name/1.0.0/.codex-plugin"
  mkdir -p "$target"
  printf '%s\n' '{}' > "$target/plugin.json"
  if [ "$name" = "sites" ]; then
    mkdir -p "$CODEX_HOME/plugins/cache/$marketplace/$name/1.0.0/skills/sites-building"
    mkdir -p "$CODEX_HOME/plugins/cache/$marketplace/$name/1.0.0/skills/sites-hosting"
    printf '%s\n' '# Sites building' > "$CODEX_HOME/plugins/cache/$marketplace/$name/1.0.0/skills/sites-building/SKILL.md"
    printf '%s\n' '# Sites hosting' > "$CODEX_HOME/plugins/cache/$marketplace/$name/1.0.0/skills/sites-hosting/SKILL.md"
    printf '%s\n' '{"apps":{"sites":{"displayName":"Sites"}}}' > "$CODEX_HOME/plugins/cache/$marketplace/$name/1.0.0/.app.json"
  fi
  printf '%s\n' '{"installed":true}'
  exit 0
fi
exit 9
`
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}
