package runtimeprep

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestRealCodexRuntimeBootstrapCrossVersion exercises the cold/warm plugin
// bootstrap and cache selection with two locally available Codex CLI binaries.
// It uses an isolated HOME and never mutates the user's real ~/.codex caches.
func TestRealCodexRuntimeBootstrapCrossVersion(t *testing.T) {
	if os.Getenv("TUTTI_REAL_CODEX_RUNTIME_BOOTSTRAP") != "1" {
		t.Skip("set TUTTI_REAL_CODEX_RUNTIME_BOOTSTRAP=1 to run the real Codex bootstrap smoke")
	}
	oldBinary := strings.TrimSpace(os.Getenv("TUTTI_REAL_CODEX_OLD_BIN"))
	newBinary := strings.TrimSpace(os.Getenv("TUTTI_REAL_CODEX_NEW_BIN"))
	if oldBinary == "" || newBinary == "" {
		t.Fatal("TUTTI_REAL_CODEX_OLD_BIN and TUTTI_REAL_CODEX_NEW_BIN are required")
	}

	realHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	realConfig := filepath.Join(realHome, ".codex", "config.toml")
	config, err := os.ReadFile(realConfig)
	if err != nil {
		t.Fatalf("read real Codex config: %v", err)
	}

	isolatedHome := t.TempDir()
	t.Setenv("HOME", isolatedHome)
	userCodexHome := filepath.Join(isolatedHome, ".codex")
	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userCodexHome, "config.toml"), config, 0o600); err != nil {
		t.Fatal(err)
	}

	type runResult struct {
		name       string
		version    string
		status     CodexRuntimeBootstrapStatus
		modelLink  string
		pluginLink string
		elapsed    time.Duration
	}
	run := func(name, binary, wantVersion string) runResult {
		t.Helper()
		codexHome := preparedCodexBootstrapHome(t, userCodexHome)
		started := time.Now()
		ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
		defer cancel()
		status := PrepareCodexRuntimeForLaunch(ctx, CodexRuntimeBootstrapInput{
			CodexHome: codexHome,
			ResolveCLI: func(context.Context) (CodexCLICommand, error) {
				return CodexCLICommand{Command: []string{binary, "app-server"}}, nil
			},
		})
		if status.CLIVersion != wantVersion {
			t.Fatalf("%s CLI version = %q, want %q", name, status.CLIVersion, wantVersion)
		}
		if status.Models.Strategy != codexModelsCacheStrategyShared {
			t.Fatalf("%s models cache = %#v", name, status.Models)
		}
		if status.Plugins.Strategy != codexPluginCacheStrategyShare {
			t.Fatalf("%s plugin cache = %#v", name, status.Plugins)
		}
		if status.PluginSync.Status != "succeeded" {
			t.Fatalf("%s plugin sync = %#v", name, status.PluginSync)
		}
		modelLink, err := os.Readlink(filepath.Join(codexHome, "models_cache.json"))
		if err != nil {
			t.Fatalf("%s read model cache link: %v", name, err)
		}
		pluginLink, err := os.Readlink(filepath.Join(codexHome, "plugins", "cache"))
		if err != nil {
			t.Fatalf("%s read plugin cache link: %v", name, err)
		}
		return runResult{
			name:       name,
			version:    status.CLIVersion,
			status:     status,
			modelLink:  modelLink,
			pluginLink: pluginLink,
			elapsed:    time.Since(started),
		}
	}

	oldCold := run("old-cold", oldBinary, "0.144.6")
	oldWarm := run("old-warm", oldBinary, "0.144.6")
	newCold := run("new-cold", newBinary, "0.145.0")
	oldAfterNew := run("old-after-new", oldBinary, "0.144.6")

	if oldCold.status.PluginSync.Installed == 0 {
		t.Fatalf("old cold run installed no plugins: %#v", oldCold.status.PluginSync)
	}
	if oldWarm.status.PluginSync.Installed != 0 {
		t.Fatalf("old warm run reinstalled plugins: %#v", oldWarm.status.PluginSync)
	}
	if newCold.status.PluginSync.Installed == 0 {
		t.Fatalf("new cold run installed no plugins: %#v", newCold.status.PluginSync)
	}
	if oldAfterNew.status.PluginSync.Installed != 0 {
		t.Fatalf("old run after new reinstalled plugins: %#v", oldAfterNew.status.PluginSync)
	}
	if oldCold.modelLink != oldWarm.modelLink ||
		oldCold.pluginLink != oldWarm.pluginLink ||
		oldCold.modelLink != oldAfterNew.modelLink ||
		oldCold.pluginLink != oldAfterNew.pluginLink {
		t.Fatal("same CLI version did not reuse its versioned caches")
	}
	if oldCold.modelLink == newCold.modelLink || oldCold.pluginLink == newCold.pluginLink {
		t.Fatal("different CLI versions shared a model or plugin cache")
	}

	for _, result := range []runResult{oldCold, oldWarm, newCold, oldAfterNew} {
		t.Logf(
			"%s version=%s elapsed=%s plugin_status=%s discovered=%d installed=%d failed=%d",
			result.name,
			result.version,
			result.elapsed.Round(time.Millisecond),
			result.status.PluginSync.Status,
			result.status.PluginSync.Discovered,
			result.status.PluginSync.Installed,
			result.status.PluginSync.Failed,
		)
	}
}
