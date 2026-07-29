package runtimeprep

import (
	"os"
	"path/filepath"
	"strings"
)

const (
	codexPluginCachesDir          = "plugin-caches"
	codexPluginCacheStrategyShare = "versioned_shared"
)

// CodexPluginCacheStatus describes the plugin package cache selected for one
// run-scoped CODEX_HOME. It intentionally contains no filesystem paths.
type CodexPluginCacheStatus struct {
	CLIVersion string
	Strategy   string
	Reason     string
	Populated  bool
}

// PrepareCodexPluginCacheForLaunch shares plugin packages only between runs
// using the exact same Codex CLI version. User-owned plugin data stays shared,
// while .plugin-appserver remains run-local generated state.
func PrepareCodexPluginCacheForLaunch(codexHome, cliVersion string) CodexPluginCacheStatus {
	userHome, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(userHome) == "" {
		return prepareCodexPluginCacheForLaunch(codexHome, "", cliVersion)
	}
	return prepareCodexPluginCacheForLaunch(codexHome, filepath.Join(userHome, ".codex"), cliVersion)
}

func prepareCodexPluginCacheForLaunch(codexHome, userCodexHome, cliVersion string) CodexPluginCacheStatus {
	cliVersion = strings.TrimSpace(cliVersion)
	status := CodexPluginCacheStatus{
		CLIVersion: cliVersion,
		Strategy:   "session_local",
	}
	target := filepath.Join(codexHome, "plugins", "cache")
	removeLegacyCodexPluginAppServerLink(codexHome, userCodexHome)

	if cliVersion == "" || strings.TrimSpace(userCodexHome) == "" {
		removeManagedCodexPluginCacheLink(target, userCodexHome)
		if err := os.MkdirAll(target, 0o700); err != nil {
			status.Reason = "session_cache_directory_unavailable"
		} else if cliVersion == "" {
			status.Reason = "cli_version_unknown"
		} else {
			status.Reason = "user_home_unavailable"
		}
		status.Populated = codexDirectoryPopulated(target)
		return status
	}

	sharedCache := filepath.Join(
		userCodexHome,
		codexPluginCachesDir,
		safeCodexCacheVersion(cliVersion),
		"cache",
	)
	if keep, strategy := preserveExistingCodexPluginCache(target, userCodexHome, sharedCache); keep {
		status.Strategy = strategy
		status.Reason = "existing_run_cache"
		status.Populated = codexDirectoryPopulated(target)
		return status
	}
	if err := os.MkdirAll(sharedCache, 0o700); err != nil {
		status.Reason = "versioned_cache_directory_unavailable"
		return status
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		status.Reason = "run_cache_parent_unavailable"
		return status
	}
	if err := os.Symlink(sharedCache, target); err != nil {
		status.Reason = "versioned_cache_link_unavailable"
		status.Populated = codexDirectoryPopulated(target)
		return status
	}
	status.Strategy = codexPluginCacheStrategyShare
	status.Populated = codexDirectoryPopulated(sharedCache)
	return status
}

func preserveExistingCodexPluginCache(target, userCodexHome, sharedCache string) (bool, string) {
	info, err := os.Lstat(target)
	if os.IsNotExist(err) {
		return false, ""
	}
	if err != nil {
		return true, "session_local_existing"
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return true, "session_local_existing"
	}
	linked, err := os.Readlink(target)
	if err != nil {
		return true, "session_local_existing"
	}
	if linked == sharedCache {
		return true, codexPluginCacheStrategyShare
	}
	if isManagedCodexPluginCachePath(linked, userCodexHome) {
		if os.Remove(target) == nil {
			return false, ""
		}
	}
	return true, "session_local_existing"
}

func removeManagedCodexPluginCacheLink(target, userCodexHome string) {
	info, err := os.Lstat(target)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return
	}
	linked, err := os.Readlink(target)
	if err == nil && isManagedCodexPluginCachePath(linked, userCodexHome) {
		_ = os.Remove(target)
	}
}

func isManagedCodexPluginCachePath(path, userCodexHome string) bool {
	path = filepath.Clean(strings.TrimSpace(path))
	userCodexHome = filepath.Clean(strings.TrimSpace(userCodexHome))
	if path == "." || userCodexHome == "." {
		return false
	}
	legacy := filepath.Join(userCodexHome, "plugins", "cache")
	versioned := filepath.Join(userCodexHome, codexPluginCachesDir)
	if path == legacy {
		return true
	}
	rel, err := filepath.Rel(versioned, path)
	return err == nil && rel != "." && rel != ".." &&
		!strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func removeLegacyCodexPluginAppServerLink(codexHome, userCodexHome string) {
	if strings.TrimSpace(userCodexHome) == "" {
		return
	}
	target := filepath.Join(codexHome, "plugins", ".plugin-appserver")
	info, err := os.Lstat(target)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return
	}
	linked, err := os.Readlink(target)
	if err == nil && linked == filepath.Join(userCodexHome, "plugins", ".plugin-appserver") {
		_ = os.Remove(target)
	}
}

func codexDirectoryPopulated(path string) bool {
	entries, err := os.ReadDir(path)
	return err == nil && len(entries) > 0
}

// locateCodexPluginPackageInCache checks whether a plugin package has a
// complete install marker in the run's selected cache. It intentionally knows
// nothing about capability selection or plugin contents.
func locateCodexPluginPackageInCache(codexHome, pluginID string) (string, bool) {
	name, marketplace := splitCodexPluginPackageID(pluginID)
	if name == "" || marketplace == "" {
		return "", false
	}
	cacheRoot := filepath.Join(codexHome, "plugins", "cache", marketplace, name)
	entries, err := os.ReadDir(cacheRoot)
	if err != nil {
		return "", false
	}
	var latest string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		candidate := filepath.Join(cacheRoot, entry.Name())
		if _, err := os.Stat(filepath.Join(candidate, ".codex-plugin", "plugin.json")); err != nil {
			continue
		}
		if latest == "" || entry.Name() > filepath.Base(latest) {
			latest = candidate
		}
	}
	if latest == "" {
		return "", false
	}
	return latest, true
}

func splitCodexPluginPackageID(pluginID string) (name, marketplace string) {
	parts := strings.SplitN(strings.TrimSpace(pluginID), "@", 2)
	if len(parts) != 2 {
		return strings.TrimSpace(pluginID), ""
	}
	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
}
