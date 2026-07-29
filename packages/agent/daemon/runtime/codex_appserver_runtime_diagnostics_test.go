package agentruntime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/runtimeprep"
)

func TestResolveCodexCLIVersionUsesExactResolvedCommandPrefix(t *testing.T) {
	commandPath := filepath.Join(t.TempDir(), "managed-node")
	script := `#!/bin/sh
if [ "$1" = "/managed/codex.js" ] && [ "$2" = "--version" ]; then
  echo "codex-cli 0.145.0"
  exit 0
fi
exit 8
`
	if err := os.WriteFile(commandPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	version := resolveCodexCLIVersion(
		t.Context(),
		[]string{commandPath, "/managed/codex.js", "app-server"},
		nil,
	)
	if version != "0.145.0" {
		t.Fatalf("version = %q, want exact resolved wrapper version", version)
	}
}

func TestResolveCodexCLIVersionReprobesAfterResolvedCommandChanges(t *testing.T) {
	writeCLI := func(version string) string {
		t.Helper()
		path := filepath.Join(t.TempDir(), "codex")
		script := "#!/bin/sh\necho 'codex-cli " + version + "'\n"
		if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}
		return path
	}
	oldCLI := writeCLI("0.144.6")
	newCLI := writeCLI("0.145.0")

	if version := resolveCodexCLIVersion(
		t.Context(),
		[]string{oldCLI, "app-server"},
		nil,
	); version != "0.144.6" {
		t.Fatalf("old version = %q", version)
	}
	if version := resolveCodexCLIVersion(
		t.Context(),
		[]string{newCLI, "app-server"},
		nil,
	); version != "0.145.0" {
		t.Fatalf("new version = %q; adapter reused a stale probe", version)
	}
}

func TestCodexRuntimeDiagnosticsDetectsPostPrepareVersionChange(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userCodexHome := filepath.Join(home, ".codex")
	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userCodexHome, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	codexHome := t.TempDir()
	preparedModels := runtimeprep.PrepareCodexModelsCacheForLaunch(codexHome, "0.144.6")
	preparedPlugins := runtimeprep.PrepareCodexPluginCacheForLaunch(codexHome, "0.144.6")
	prepared := runtimeprep.CodexRuntimeBootstrapStatus{
		CLIVersion: "0.144.6",
		Models:     preparedModels,
		Plugins:    preparedPlugins,
		PluginSync: runtimeprep.CodexPluginSyncStatus{Status: "succeeded"},
	}
	env := append([]string{"CODEX_HOME=" + codexHome}, prepared.Env()...)

	fields := codexAppServerRuntimeDiagnostics(env, "0.145.0")
	if fields["cli_version_changed_after_prepare"] != true {
		t.Fatalf("fields = %#v", fields)
	}
	if fields["models_cache_strategy"] != "versioned_authority_shared" ||
		fields["plugin_cache_strategy"] != "versioned_shared" {
		t.Fatalf("cache fields = %#v", fields)
	}
	modelLink, err := os.Readlink(filepath.Join(codexHome, "models_cache.json"))
	if err != nil {
		t.Fatal(err)
	}
	pluginLink, err := os.Readlink(filepath.Join(codexHome, "plugins", "cache"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(modelLink, filepath.Join("model-caches", "0.145.0")) ||
		!strings.Contains(pluginLink, filepath.Join("plugin-caches", "0.145.0")) {
		t.Fatalf("launch-time links = model %q, plugin %q", modelLink, pluginLink)
	}
}
