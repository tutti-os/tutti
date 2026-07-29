package agentruntime

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/runtimeprep"
)

// codexAppServerRuntimeDiagnostics revalidates version-scoped cache selection
// against the exact command that will be spawned and returns only
// non-sensitive startup trace fields.
func codexAppServerRuntimeDiagnostics(env []string, cliVersion string) map[string]any {
	fields := runtimeprep.CodexRuntimeBootstrapTraceFieldsFromEnv(env)
	fields["cli_version"] = strings.TrimSpace(cliVersion)
	preparedVersion, _ := fields["prepared_cli_version"].(string)
	fields["cli_version_changed_after_prepare"] =
		preparedVersion != "" && preparedVersion != strings.TrimSpace(cliVersion)

	codexHome := envValueLast(env, "CODEX_HOME")
	if codexHome == "" {
		fields["models_cache_strategy"] = "not_applicable"
		fields["plugin_cache_strategy"] = "not_applicable"
		return fields
	}
	models := runtimeprep.PrepareCodexModelsCacheForLaunch(codexHome, cliVersion)
	plugins := runtimeprep.PrepareCodexPluginCacheForLaunch(codexHome, cliVersion)
	fields["models_cache_strategy"] = models.Strategy
	fields["models_cache_reason"] = models.Reason
	fields["models_cache_migration"] = models.Migration
	fields["models_cache_client_version"] = models.CacheClientVersion
	fields["plugin_cache_strategy"] = plugins.Strategy
	fields["plugin_cache_reason"] = plugins.Reason
	fields["plugin_cache_populated"] = plugins.Populated
	fields["plugin_data_present"] = codexRuntimePathExists(filepath.Join(codexHome, "plugins", "data"))
	fields["plugin_appserver_present"] = codexRuntimePathExists(
		filepath.Join(codexHome, "plugins", ".plugin-appserver"),
	)
	return fields
}

func codexRuntimePathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
