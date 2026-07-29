package runtimeprep

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	codexModelsCacheFileName       = "models_cache.json"
	codexModelsCacheVersionsDir    = "model-caches"
	codexModelsCacheStrategyShared = "versioned_authority_shared"
	codexModelsCacheAuthorityFile  = ".models_cache.authority.sha256"
)

var codexModelsCacheAuthorityMu sync.Mutex

// CodexModelsCacheStatus describes the cache selected immediately before a
// Codex process starts. It contains no filesystem paths or authority hashes.
type CodexModelsCacheStatus struct {
	CLIVersion         string
	CacheClientVersion string
	Strategy           string
	Migration          string
	Reason             string
}

// PrepareCodexModelsCacheForLaunch shares a writable model cache only when
// both the exact CLI version and the current config/auth/catalog authority
// match. Unknown CLI versions deliberately use a run-local cache.
func PrepareCodexModelsCacheForLaunch(codexHome, cliVersion string) CodexModelsCacheStatus {
	userHome, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(userHome) == "" {
		return CodexModelsCacheStatus{
			CLIVersion: strings.TrimSpace(cliVersion),
			Strategy:   "session_local",
			Reason:     "user_home_unavailable",
		}
	}
	return prepareCodexModelsCacheForLaunch(codexHome, filepath.Join(userHome, ".codex"), cliVersion)
}

func prepareCodexModelsCacheForLaunch(codexHome, userCodexHome, cliVersion string) CodexModelsCacheStatus {
	codexModelsCacheAuthorityMu.Lock()
	defer codexModelsCacheAuthorityMu.Unlock()

	cliVersion = strings.TrimSpace(cliVersion)
	status := CodexModelsCacheStatus{CLIVersion: cliVersion, Strategy: "session_local"}
	target := filepath.Join(codexHome, codexModelsCacheFileName)
	if cliVersion == "" {
		removeManagedCodexModelsCacheLink(target, userCodexHome)
		status.Reason = "cli_version_unknown"
		return status
	}
	authority, err := userCodexModelsCacheAuthority(userCodexHome)
	if err != nil || authority == "" {
		removeManagedCodexModelsCacheLink(target, userCodexHome)
		status.Reason = "cache_authority_unavailable"
		return status
	}

	cacheDirectory := filepath.Join(
		userCodexHome,
		codexModelsCacheVersionsDir,
		safeCodexCacheVersion(cliVersion),
		authority,
	)
	sharedCache := filepath.Join(cacheDirectory, codexModelsCacheFileName)
	if action, keepLocal := prepareExistingRunCodexModelsCache(
		target,
		userCodexHome,
		sharedCache,
		cliVersion,
	); keepLocal {
		status.Strategy = action
		status.Reason = "existing_run_cache"
		if action == codexModelsCacheStrategyShared {
			status.CacheClientVersion, _ = codexModelsCacheClientVersion(sharedCache)
		}
		return status
	}
	if err := os.MkdirAll(cacheDirectory, 0o700); err != nil {
		status.Reason = "versioned_cache_directory_unavailable"
		return status
	}

	if _, err := os.Lstat(sharedCache); err == nil {
		cacheVersion, valid := codexModelsCacheClientVersion(sharedCache)
		status.CacheClientVersion = cacheVersion
		if !valid || cacheVersion != cliVersion {
			status.Reason = "versioned_cache_incompatible"
			return status
		}
	} else if !os.IsNotExist(err) {
		status.Reason = "versioned_cache_unavailable"
		return status
	} else if cacheVersion, migrated := migrateCompatibleLegacyCodexModelsCache(
		userCodexHome,
		sharedCache,
		authority,
		cliVersion,
	); migrated {
		status.CacheClientVersion = cacheVersion
		status.Migration = "legacy_compatible_copy"
	}

	if err := os.Symlink(sharedCache, target); err != nil {
		if errors.Is(err, os.ErrExist) {
			status.Strategy = "session_local_existing"
			status.Reason = "existing_run_cache"
			return status
		}
		status.Reason = "versioned_cache_link_unavailable"
		return status
	}
	status.Strategy = codexModelsCacheStrategyShared
	return status
}

func prepareExistingRunCodexModelsCache(
	target string,
	userCodexHome string,
	sharedCache string,
	cliVersion string,
) (strategy string, keepLocal bool) {
	info, err := os.Lstat(target)
	if os.IsNotExist(err) {
		return "", false
	}
	if err != nil {
		return "session_local", true
	}
	if info.Mode()&os.ModeSymlink != 0 {
		linked, linkErr := os.Readlink(target)
		if linkErr != nil {
			return "session_local_existing", true
		}
		if linked == sharedCache {
			if version, exists := codexModelsCacheClientVersion(sharedCache); !exists || version == cliVersion {
				return codexModelsCacheStrategyShared, true
			}
		}
		if isManagedCodexModelsCachePath(linked, userCodexHome) {
			if os.Remove(target) == nil {
				return "", false
			}
		}
		return "session_local_existing", true
	}
	if !info.Mode().IsRegular() {
		return "session_local_existing", true
	}
	if version, exists := codexModelsCacheClientVersion(target); exists && version == cliVersion {
		return "session_local_existing", true
	}
	quarantine := target + ".incompatible-" + time.Now().UTC().Format("20060102T150405.000000000Z")
	if err := os.Rename(target, quarantine); err != nil {
		return "session_local_existing", true
	}
	return "", false
}

func removeManagedCodexModelsCacheLink(target, userCodexHome string) {
	info, err := os.Lstat(target)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return
	}
	linked, err := os.Readlink(target)
	if err == nil && isManagedCodexModelsCachePath(linked, userCodexHome) {
		_ = os.Remove(target)
	}
}

func isManagedCodexModelsCachePath(path, userCodexHome string) bool {
	path = filepath.Clean(strings.TrimSpace(path))
	userCodexHome = filepath.Clean(strings.TrimSpace(userCodexHome))
	if path == "." || userCodexHome == "." {
		return false
	}
	if path == filepath.Join(userCodexHome, codexModelsCacheFileName) {
		return true
	}
	root := filepath.Join(userCodexHome, codexModelsCacheVersionsDir)
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != "." && rel != ".." &&
		!strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func codexModelsCacheClientVersion(path string) (string, bool) {
	content, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	var envelope struct {
		ClientVersion string `json:"client_version"`
	}
	if err := json.Unmarshal(content, &envelope); err != nil {
		return "", false
	}
	version := strings.TrimSpace(envelope.ClientVersion)
	return version, version != ""
}

func migrateCompatibleLegacyCodexModelsCache(
	userCodexHome string,
	target string,
	authority string,
	cliVersion string,
) (string, bool) {
	fence, err := os.ReadFile(filepath.Join(userCodexHome, codexModelsCacheAuthorityFile))
	if err != nil || strings.TrimSpace(string(fence)) != authority {
		return "", false
	}
	legacyCache := filepath.Join(userCodexHome, codexModelsCacheFileName)
	legacyVersion, exists := codexModelsCacheClientVersion(legacyCache)
	if !exists || legacyVersion != cliVersion {
		return "", false
	}
	created, err := copyFileExclusively(legacyCache, target)
	if err != nil || !created {
		return "", false
	}
	return legacyVersion, true
}

func copyFileExclusively(source, target string) (bool, error) {
	input, err := os.Open(source)
	if err != nil {
		return false, err
	}
	defer func() { _ = input.Close() }()
	temporary, err := os.CreateTemp(filepath.Dir(target), ".models-cache-*")
	if err != nil {
		return false, err
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if _, err := io.Copy(temporary, input); err != nil {
		_ = temporary.Close()
		return false, err
	}
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return false, err
	}
	if err := temporary.Close(); err != nil {
		return false, err
	}
	if err := os.Link(temporaryPath, target); err != nil {
		if errors.Is(err, os.ErrExist) {
			return false, nil
		}
		return false, fmt.Errorf("publish copied models cache: %w", err)
	}
	return true, nil
}

func safeCodexCacheVersion(version string) string {
	version = strings.TrimSpace(version)
	var builder strings.Builder
	for _, r := range version {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '.' || r == '-' || r == '_' {
			builder.WriteRune(r)
		} else {
			builder.WriteByte('_')
		}
	}
	clean := strings.Trim(builder.String(), "._-")
	if clean == "" {
		return "unknown"
	}
	if len(clean) > 80 {
		return clean[:80]
	}
	return clean
}

func userCodexModelsCacheAuthority(userCodexHome string) (string, error) {
	digest := sha256.New()
	configPath := filepath.Join(userCodexHome, "config.toml")
	config, err := hashCodexModelsCacheAuthorityFile(digest, "config", configPath)
	if err != nil {
		return "", err
	}
	if _, err := hashCodexModelsCacheAuthorityFile(
		digest,
		"auth",
		filepath.Join(userCodexHome, "auth.json"),
	); err != nil {
		return "", err
	}
	if catalogPath := codexConfigRelativeFilePath(config, userCodexHome, "model_catalog_json"); catalogPath != "" {
		if _, err := hashCodexModelsCacheAuthorityFile(digest, "model_catalog", catalogPath); err != nil {
			return "", err
		}
	}
	if instructionsPath := codexConfigRelativeFilePath(config, userCodexHome, "model_instructions_file"); instructionsPath != "" {
		if _, err := hashCodexModelsCacheAuthorityFile(digest, "model_instructions", instructionsPath); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func hashCodexModelsCacheAuthorityFile(digest io.Writer, label, path string) ([]byte, error) {
	content, err := os.ReadFile(path)
	switch {
	case err == nil:
		_, _ = io.WriteString(digest, label+"\x00present\x00")
		_, _ = digest.Write(content)
		_, _ = io.WriteString(digest, "\x00")
		return content, nil
	case os.IsNotExist(err):
		_, _ = io.WriteString(digest, label+"\x00missing\x00")
		return nil, nil
	default:
		return nil, fmt.Errorf("read codex models cache authority %s: %w", label, err)
	}
}

func codexConfigRelativeFilePath(config []byte, userCodexHome string, key string) string {
	lines := strings.Split(strings.ReplaceAll(string(config), "\r\n", "\n"), "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			return ""
		}
		value, ok := codexConfigStringAssignmentValue(trimmed, key)
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if value == "" {
			return ""
		}
		if filepath.IsAbs(value) {
			return filepath.Clean(value)
		}
		cleanRel := filepath.Clean(value)
		if cleanRel == "." || cleanRel == ".." ||
			strings.HasPrefix(cleanRel, ".."+string(filepath.Separator)) {
			return ""
		}
		return filepath.Join(userCodexHome, cleanRel)
	}
	return ""
}
