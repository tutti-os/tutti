package workspace

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

const tuttiAppRuntimeRootEnv = "TUTTI_APP_RUNTIME_ROOT"
const workspaceAppNodeRuntimePreloadProfile = managedruntime.NodeStaticProfile
const workspaceAppStandaloneRuntimeProfile = "standalone"
const removedWorkspaceRootCompatibilityEnvKey = "NEX" + "TOP_WORKSPACE_ROOT"

type AppRuntimeResolver = managedruntime.Resolver
type AppRuntimeProfilePreloader = managedruntime.ProfilePreloader
type AppRuntimeProfileResolver = managedruntime.ProfileResolver
type ResolvedAppRuntime = managedruntime.ResolvedRuntime
type DefaultManagedAppRuntimeResolver = managedruntime.DefaultResolver

// Provider entries are intentionally exact; do not replace them with credential
// or provider-prefix wildcards that could expose unrelated daemon secrets.
var workspaceAppInheritedEnvKeys = map[string]struct{}{
	"ALL_PROXY":               {},
	"ANTHROPIC_API_BASE_URL":  {},
	"ANTHROPIC_API_KEY":       {},
	"ANTHROPIC_AUTH_TOKEN":    {},
	"ANTHROPIC_BASE_URL":      {},
	"APPDATA":                 {},
	"CLAUDE_CONFIG_DIR":       {},
	"CODEX_HOME":              {},
	"COMMONPROGRAMFILES":      {},
	"COMMONPROGRAMFILES(X86)": {},
	"COMMONPROGRAMW6432":      {},
	"COMSPEC":                 {},
	"CURL_CA_BUNDLE":          {},
	"CURSOR_ACP_BIN":          {},
	"CURSOR_API_KEY":          {},
	"GIT_SSL_CAINFO":          {},
	"GIT_SSL_CAPATH":          {},
	"HOME":                    {},
	"HOMEDRIVE":               {},
	"HOMEPATH":                {},
	"HTTP_PROXY":              {},
	"HTTPS_PROXY":             {},
	"LANG":                    {},
	"LANGUAGE":                {},
	"LOCALAPPDATA":            {},
	"LOGNAME":                 {},
	"NODE_EXTRA_CA_CERTS":     {},
	"NO_PROXY":                {},
	"NPM_CONFIG_CAFILE":       {},
	"NUMBER_OF_PROCESSORS":    {},
	"OPENAI_API_BASE":         {},
	"OPENAI_API_BASE_URL":     {},
	"OPENAI_API_KEY":          {},
	"OPENAI_BASE_URL":         {},
	"OPENCODE_ACP_BIN":        {},
	"OPENCODE_CONFIG":         {},
	"OPENCODE_CONFIG_CONTENT": {},
	"OPENCODE_CONFIG_DIR":     {},
	"OPENCODE_PERMISSION":     {},
	"OS":                      {},
	"PATH":                    {},
	"PATHEXT":                 {},
	"PIP_CERT":                {},
	"PROCESSOR_ARCHITECTURE":  {},
	"PROCESSOR_ARCHITEW6432":  {},
	"PROCESSOR_IDENTIFIER":    {},
	"PROCESSOR_LEVEL":         {},
	"PROCESSOR_REVISION":      {},
	"PROGRAMDATA":             {},
	"PROGRAMFILES":            {},
	"PROGRAMFILES(X86)":       {},
	"PROGRAMW6432":            {},
	"REQUESTS_CA_BUNDLE":      {},
	"SHELL":                   {},
	"SSL_CERT_DIR":            {},
	"SSL_CERT_FILE":           {},
	"SYSTEMDRIVE":             {},
	"SYSTEMROOT":              {},
	"TEMP":                    {},
	"TMP":                     {},
	"TMPDIR":                  {},
	"TUTTI_AGENT_HOME":        {},
	"TZ":                      {},
	"USER":                    {},
	"USERNAME":                {},
	"USERPROFILE":             {},
	"WINDIR":                  {},
	"XDG_CACHE_HOME":          {},
	"XDG_CONFIG_HOME":         {},
	"XDG_DATA_HOME":           {},
	"XDG_RUNTIME_DIR":         {},
	"XDG_STATE_HOME":          {},
	"__CF_USER_TEXT_ENCODING": {},
}

func workspaceAppProcessEnv(overrides ...string) []string {
	env := make([]string, 0, len(workspaceAppInheritedEnvKeys)+len(overrides))
	for _, item := range os.Environ() {
		key, _, ok := strings.Cut(item, "=")
		if !ok {
			continue
		}
		normalizedKey := strings.ToUpper(key)
		_, inherited := workspaceAppInheritedEnvKeys[normalizedKey]
		if inherited || strings.HasPrefix(normalizedKey, "LC_") {
			env = append(env, item)
		}
	}
	env = runtimecmd.InjectSystemProxyEnv(env)
	for _, override := range overrides {
		key, _, ok := strings.Cut(override, "=")
		if !ok {
			continue
		}
		normalizedKey := strings.ToUpper(key)
		if normalizedKey == "TUTTI_WORKSPACE_ROOT" || normalizedKey == removedWorkspaceRootCompatibilityEnvKey {
			continue
		}
		next := env[:0]
		for _, item := range env {
			itemKey, _, ok := strings.Cut(item, "=")
			if ok && strings.EqualFold(itemKey, key) {
				continue
			}
			next = append(next, item)
		}
		env = append(next, override)
	}
	return env
}

func appRuntimeProfileForPackage(appPackage workspacebiz.AppPackage) string {
	return appRuntimeProfileForManifest(appPackage.Manifest)
}

func appRuntimeProfileForManifest(manifest workspacebiz.AppManifest) string {
	return strings.TrimSpace(manifest.Runtime.Profile)
}

func appRuntimeProfileIsStandalone(profile string) bool {
	return strings.TrimSpace(profile) == workspaceAppStandaloneRuntimeProfile
}

func appRuntimeEnvValue(env []string, key string) string {
	return managedruntime.EnvValue(env, key)
}

func envValue(env []string, key string) string {
	return managedruntime.EnvValue(env, key)
}

func pathEnvKey(env []string) string {
	for i := len(env) - 1; i >= 0; i-- {
		key, _, ok := strings.Cut(env[i], "=")
		if ok && strings.EqualFold(key, "PATH") {
			return key
		}
	}
	return "PATH"
}

func mergeAppPathDirs(dirs []string) []string {
	result := make([]string, 0, len(dirs))
	seen := map[string]struct{}{}
	for _, dir := range dirs {
		trimmed := strings.TrimSpace(dir)
		if trimmed == "" {
			continue
		}
		key := filepath.Clean(trimmed)
		if runtime.GOOS == "windows" {
			key = strings.ToLower(key)
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}
