package workspace

import (
	"path/filepath"
	"runtime"
	"strings"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

const tuttiAppRuntimeRootEnv = "TUTTI_APP_RUNTIME_ROOT"
const workspaceAppNodeRuntimePreloadProfile = managedruntime.NodeStaticProfile

type AppRuntimeResolver = managedruntime.Resolver
type AppRuntimeProfilePreloader = managedruntime.ProfilePreloader
type AppRuntimeProfileResolver = managedruntime.ProfileResolver
type ResolvedAppRuntime = managedruntime.ResolvedRuntime
type DefaultManagedAppRuntimeResolver = managedruntime.DefaultResolver

func workspaceAppProcessEnv(overrides ...string) []string {
	return managedruntime.ProcessEnv(overrides...)
}

func appRuntimeProfileForPackage(appPackage workspacebiz.AppPackage) string {
	return appRuntimeProfileForManifest(appPackage.Manifest)
}

func appRuntimeProfileForManifest(manifest workspacebiz.AppManifest) string {
	return strings.TrimSpace(manifest.Runtime.Profile)
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
