package runtimeprep

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	codexRuntimeBootstrapVersionTimeout = 5 * time.Second
	codexPluginListTimeout              = 10 * time.Second
	codexPluginAddTimeout               = 30 * time.Second
	codexPluginSyncTimeout              = 90 * time.Second
	codexPluginLockStaleAfter           = 2 * time.Minute
)

const (
	codexPreparedCLIVersionEnv   = "TUTTI_CODEX_PREPARED_CLI_VERSION"
	codexModelsCacheStrategyEnv  = "TUTTI_CODEX_MODELS_CACHE_STRATEGY"
	codexModelsCacheReasonEnv    = "TUTTI_CODEX_MODELS_CACHE_REASON"
	codexModelsCacheMigrationEnv = "TUTTI_CODEX_MODELS_CACHE_MIGRATION"
	codexPluginCacheStrategyEnv  = "TUTTI_CODEX_PLUGIN_CACHE_STRATEGY"
	codexPluginCacheReasonEnv    = "TUTTI_CODEX_PLUGIN_CACHE_REASON"
	codexPluginCachePopulatedEnv = "TUTTI_CODEX_PLUGIN_CACHE_POPULATED"
	codexPluginSyncStatusEnv     = "TUTTI_CODEX_PLUGIN_SYNC_STATUS"
	codexPluginSyncDiscoveredEnv = "TUTTI_CODEX_PLUGIN_SYNC_DISCOVERED"
	codexPluginSyncInstalledEnv  = "TUTTI_CODEX_PLUGIN_SYNC_INSTALLED"
	codexPluginSyncFailedEnv     = "TUTTI_CODEX_PLUGIN_SYNC_FAILED"
	codexPluginSyncDurationMSEnv = "TUTTI_CODEX_PLUGIN_SYNC_DURATION_MS"
	codexPluginSyncReasonEnv     = "TUTTI_CODEX_PLUGIN_SYNC_REASON"
)

// CodexCLICommand is the exact host-resolved Codex command prefix and
// environment used by the app-server launch.
type CodexCLICommand struct {
	Command []string
	Env     []string
}

// CodexCLIResolver lets the host provide the same managed CLI identity used by
// its app-server command resolver without importing daemon packages here.
type CodexCLIResolver func(context.Context) (CodexCLICommand, error)

type CodexPluginSyncOutcome struct {
	PluginID   string
	Status     string
	Reason     string
	DurationMS int64
}

type CodexPluginSyncStatus struct {
	Status     string
	Reason     string
	Discovered int
	Installed  int
	Failed     int
	DurationMS int64
	LockWaitMS int64
	Outcomes   []CodexPluginSyncOutcome
}

type CodexRuntimeBootstrapInput struct {
	CodexHome  string
	ResolveCLI CodexCLIResolver
}

type CodexRuntimeBootstrapStatus struct {
	CLIVersion string
	Models     CodexModelsCacheStatus
	Plugins    CodexPluginCacheStatus
	PluginSync CodexPluginSyncStatus
}

func (s CodexRuntimeBootstrapStatus) Env() []string {
	return []string{
		codexPreparedCLIVersionEnv + "=" + s.CLIVersion,
		codexModelsCacheStrategyEnv + "=" + s.Models.Strategy,
		codexModelsCacheReasonEnv + "=" + s.Models.Reason,
		codexModelsCacheMigrationEnv + "=" + s.Models.Migration,
		codexPluginCacheStrategyEnv + "=" + s.Plugins.Strategy,
		codexPluginCacheReasonEnv + "=" + s.Plugins.Reason,
		codexPluginCachePopulatedEnv + "=" + strconv.FormatBool(s.Plugins.Populated),
		codexPluginSyncStatusEnv + "=" + s.PluginSync.Status,
		codexPluginSyncDiscoveredEnv + "=" + strconv.Itoa(s.PluginSync.Discovered),
		codexPluginSyncInstalledEnv + "=" + strconv.Itoa(s.PluginSync.Installed),
		codexPluginSyncFailedEnv + "=" + strconv.Itoa(s.PluginSync.Failed),
		codexPluginSyncDurationMSEnv + "=" + strconv.FormatInt(s.PluginSync.DurationMS, 10),
		codexPluginSyncReasonEnv + "=" + s.PluginSync.Reason,
	}
}

func (s CodexRuntimeBootstrapStatus) TraceFields() map[string]any {
	return map[string]any{
		"cli_version":                 s.CLIVersion,
		"models_cache_strategy":       s.Models.Strategy,
		"models_cache_reason":         s.Models.Reason,
		"models_cache_migration":      s.Models.Migration,
		"models_cache_client_version": s.Models.CacheClientVersion,
		"plugin_cache_strategy":       s.Plugins.Strategy,
		"plugin_cache_reason":         s.Plugins.Reason,
		"plugin_cache_populated":      s.Plugins.Populated,
		"plugin_sync_status":          s.PluginSync.Status,
		"plugin_sync_reason":          s.PluginSync.Reason,
		"plugin_sync_discovered":      s.PluginSync.Discovered,
		"plugin_sync_installed":       s.PluginSync.Installed,
		"plugin_sync_failed":          s.PluginSync.Failed,
		"plugin_sync_duration_ms":     s.PluginSync.DurationMS,
		"plugin_sync_lock_wait_ms":    s.PluginSync.LockWaitMS,
	}
}

// CodexRuntimeBootstrapTraceFieldsFromEnv reconstructs the non-sensitive
// preparation summary carried into the app-server launch environment.
func CodexRuntimeBootstrapTraceFieldsFromEnv(env []string) map[string]any {
	value := func(key string) string {
		prefix := key + "="
		for index := len(env) - 1; index >= 0; index-- {
			if strings.HasPrefix(env[index], prefix) {
				return strings.TrimSpace(strings.TrimPrefix(env[index], prefix))
			}
		}
		return ""
	}
	intValue := func(key string) int64 {
		parsed, _ := strconv.ParseInt(value(key), 10, 64)
		return parsed
	}
	boolValue := func(key string) bool {
		parsed, _ := strconv.ParseBool(value(key))
		return parsed
	}
	return map[string]any{
		"prepared_cli_version":            value(codexPreparedCLIVersionEnv),
		"prepared_models_cache_strategy":  value(codexModelsCacheStrategyEnv),
		"prepared_models_cache_reason":    value(codexModelsCacheReasonEnv),
		"prepared_models_cache_migration": value(codexModelsCacheMigrationEnv),
		"prepared_plugin_cache_strategy":  value(codexPluginCacheStrategyEnv),
		"prepared_plugin_cache_reason":    value(codexPluginCacheReasonEnv),
		"prepared_plugin_cache_populated": boolValue(codexPluginCachePopulatedEnv),
		"plugin_sync_status":              value(codexPluginSyncStatusEnv),
		"plugin_sync_reason":              value(codexPluginSyncReasonEnv),
		"plugin_sync_discovered":          intValue(codexPluginSyncDiscoveredEnv),
		"plugin_sync_installed":           intValue(codexPluginSyncInstalledEnv),
		"plugin_sync_failed":              intValue(codexPluginSyncFailedEnv),
		"plugin_sync_duration_ms":         intValue(codexPluginSyncDurationMSEnv),
	}
}

// PrepareCodexRuntimeForLaunch is fail-open for plugin synchronization: cache
// selection and every failure are reported, but a marketplace outage never
// prevents a plain Codex session from starting.
func PrepareCodexRuntimeForLaunch(
	ctx context.Context,
	input CodexRuntimeBootstrapInput,
) CodexRuntimeBootstrapStatus {
	status := CodexRuntimeBootstrapStatus{}
	command, err := resolveCodexCLI(ctx, input.ResolveCLI)
	if err != nil {
		status.Models = PrepareCodexModelsCacheForLaunch(input.CodexHome, "")
		status.Plugins = PrepareCodexPluginCacheForLaunch(input.CodexHome, "")
		status.PluginSync = CodexPluginSyncStatus{
			Status: "skipped",
			Reason: "cli_unavailable",
		}
		return status
	}
	status.CLIVersion = probeCodexCLIVersion(ctx, command)
	status.Models = PrepareCodexModelsCacheForLaunch(input.CodexHome, status.CLIVersion)
	status.Plugins = PrepareCodexPluginCacheForLaunch(input.CodexHome, status.CLIVersion)
	status.PluginSync = syncCodexPlugins(ctx, input.CodexHome, command)
	status.Plugins.Populated = codexDirectoryPopulated(filepath.Join(input.CodexHome, "plugins", "cache"))
	return status
}

func resolveCodexCLI(ctx context.Context, resolver CodexCLIResolver) (CodexCLICommand, error) {
	if resolver == nil {
		return CodexCLICommand{}, errors.New("codex CLI resolver is unavailable")
	}
	command, err := resolver(ctx)
	if err != nil {
		return CodexCLICommand{}, err
	}
	command.Command = codexCLICommandPrefix(command.Command)
	if len(command.Command) == 0 || strings.TrimSpace(command.Command[0]) == "" {
		return CodexCLICommand{}, errors.New("codex CLI command is unavailable")
	}
	return command, nil
}

func codexCLICommandPrefix(command []string) []string {
	command = append([]string(nil), command...)
	if len(command) > 0 && strings.TrimSpace(command[len(command)-1]) == "app-server" {
		command = command[:len(command)-1]
	}
	return command
}

func probeCodexCLIVersion(ctx context.Context, command CodexCLICommand) string {
	probeCtx, cancel := context.WithTimeout(ctx, codexRuntimeBootstrapVersionTimeout)
	defer cancel()
	output, err := runCodexCLICommand(probeCtx, command, "", "--version")
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(output))
	if len(fields) == 0 {
		return ""
	}
	return strings.TrimSpace(fields[len(fields)-1])
}

type codexPluginListEntry struct {
	PluginID      string `json:"pluginId"`
	Installed     bool   `json:"installed"`
	Enabled       bool   `json:"enabled"`
	InstallPolicy string `json:"installPolicy"`
}

type codexPluginListEnvelope struct {
	Installed []codexPluginListEntry `json:"installed"`
	Available []codexPluginListEntry `json:"available"`
}

func syncCodexPlugins(ctx context.Context, codexHome string, command CodexCLICommand) CodexPluginSyncStatus {
	started := time.Now()
	status := CodexPluginSyncStatus{Status: "failed"}
	syncCtx, cancel := context.WithTimeout(ctx, codexPluginSyncTimeout)
	defer cancel()

	lockStarted := time.Now()
	release, err := acquireCodexPluginSyncLock(syncCtx, codexHome)
	status.LockWaitMS = time.Since(lockStarted).Milliseconds()
	if err != nil {
		status.Reason = "lock_unavailable"
		status.DurationMS = time.Since(started).Milliseconds()
		return status
	}
	defer release()

	listCtx, listCancel := context.WithTimeout(syncCtx, codexPluginListTimeout)
	output, err := runCodexCLICommand(
		listCtx,
		command,
		codexHome,
		"plugin",
		"list",
		"--available",
		"--json",
	)
	listCancel()
	if err != nil {
		status.Reason = commandFailureReason(err)
		status.DurationMS = time.Since(started).Milliseconds()
		return status
	}
	var envelope codexPluginListEnvelope
	if err := json.Unmarshal(output, &envelope); err != nil {
		status.Reason = "list_response_invalid"
		status.DurationMS = time.Since(started).Milliseconds()
		return status
	}

	plugins := mergeCodexPluginListEntries(envelope)
	for _, plugin := range plugins {
		if !plugin.Enabled || strings.EqualFold(strings.TrimSpace(plugin.InstallPolicy), "NOT_AVAILABLE") {
			continue
		}
		status.Discovered++
		// --available reports marketplace truth and may still mark an artifact
		// uninstalled when another run populated the shared version cache.
		if _, ready := locateCodexPluginPackageInCache(codexHome, plugin.PluginID); ready {
			continue
		}
		outcome := installCodexPlugin(syncCtx, codexHome, command, plugin.PluginID)
		status.Outcomes = append(status.Outcomes, outcome)
		if outcome.Status == "succeeded" {
			status.Installed++
		} else {
			status.Failed++
		}
	}
	status.DurationMS = time.Since(started).Milliseconds()
	switch {
	case status.Failed > 0 && status.Installed > 0:
		status.Status = "partial"
		status.Reason = "one_or_more_plugins_failed"
	case status.Failed > 0:
		status.Status = "failed"
		status.Reason = "plugin_install_failed"
	default:
		status.Status = "succeeded"
		status.Reason = ""
	}
	return status
}

func mergeCodexPluginListEntries(envelope codexPluginListEnvelope) []codexPluginListEntry {
	order := make([]string, 0, len(envelope.Installed)+len(envelope.Available))
	byID := make(map[string]codexPluginListEntry, cap(order))
	for _, plugin := range append(envelope.Installed, envelope.Available...) {
		id := strings.TrimSpace(plugin.PluginID)
		if id == "" {
			continue
		}
		if existing, ok := byID[id]; ok {
			plugin.Installed = plugin.Installed || existing.Installed
			plugin.Enabled = plugin.Enabled || existing.Enabled
		} else {
			order = append(order, id)
		}
		plugin.PluginID = id
		byID[id] = plugin
	}
	result := make([]codexPluginListEntry, 0, len(order))
	for _, id := range order {
		result = append(result, byID[id])
	}
	return result
}

func installCodexPlugin(
	ctx context.Context,
	codexHome string,
	command CodexCLICommand,
	pluginID string,
) CodexPluginSyncOutcome {
	started := time.Now()
	outcome := CodexPluginSyncOutcome{PluginID: pluginID, Status: "failed"}
	installCtx, cancel := context.WithTimeout(ctx, codexPluginAddTimeout)
	defer cancel()
	if _, err := runCodexCLICommand(
		installCtx,
		command,
		codexHome,
		"plugin",
		"add",
		pluginID,
		"--json",
	); err != nil {
		outcome.Reason = commandFailureReason(err)
		outcome.DurationMS = time.Since(started).Milliseconds()
		return outcome
	}
	if _, ready := locateCodexPluginPackageInCache(codexHome, pluginID); !ready {
		outcome.Reason = "installed_package_missing"
		outcome.DurationMS = time.Since(started).Milliseconds()
		return outcome
	}
	outcome.Status = "succeeded"
	outcome.DurationMS = time.Since(started).Milliseconds()
	return outcome
}

func runCodexCLICommand(
	ctx context.Context,
	command CodexCLICommand,
	codexHome string,
	args ...string,
) ([]byte, error) {
	prefix := codexCLICommandPrefix(command.Command)
	if len(prefix) == 0 {
		return nil, errors.New("codex CLI command is unavailable")
	}
	env := mergedCodexProcessEnv(command.Env, codexHome)
	path, err := resolveCodexCLIExecutable(prefix[0], env)
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, path, append(prefix[1:], args...)...)
	cmd.Env = env
	return cmd.Output()
}

// resolveCodexCLIExecutable deliberately resolves bare commands against the
// exact environment passed to the child. exec.CommandContext otherwise calls
// LookPath against this process's environment before cmd.Env takes effect.
func resolveCodexCLIExecutable(command string, env []string) (string, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return "", errors.New("codex CLI command is unavailable")
	}
	if strings.ContainsAny(command, `/\\`) {
		return command, nil
	}
	for _, dir := range filepath.SplitList(codexEnvValue(env, "PATH")) {
		candidate := filepath.Join(dir, command)
		info, err := os.Stat(candidate)
		if err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("resolve codex CLI %q against launch PATH: executable not found", command)
}

func codexEnvValue(env []string, key string) string {
	for index := len(env) - 1; index >= 0; index-- {
		candidateKey, value, ok := strings.Cut(env[index], "=")
		if ok && strings.EqualFold(candidateKey, key) {
			return value
		}
	}
	return ""
}

func mergedCodexProcessEnv(overrides []string, codexHome string) []string {
	values := make(map[string]string)
	order := make([]string, 0, len(os.Environ())+len(overrides)+1)
	add := func(item string) {
		key, value, ok := strings.Cut(item, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return
		}
		if _, exists := values[key]; !exists {
			order = append(order, key)
		}
		values[key] = value
	}
	for _, item := range os.Environ() {
		add(item)
	}
	for _, item := range overrides {
		add(item)
	}
	if strings.TrimSpace(codexHome) != "" {
		add("CODEX_HOME=" + codexHome)
	}
	result := make([]string, 0, len(order))
	for _, key := range order {
		result = append(result, key+"="+values[key])
	}
	return result
}

func acquireCodexPluginSyncLock(ctx context.Context, codexHome string) (func(), error) {
	cachePath := filepath.Join(codexHome, "plugins", "cache")
	resolved, err := filepath.EvalSymlinks(cachePath)
	if err != nil {
		resolved = cachePath
	}
	lockPath := filepath.Join(filepath.Dir(resolved), ".tutti-plugin-sync.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		return nil, err
	}
	token := strconv.Itoa(os.Getpid()) + "-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	for {
		file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, writeErr := file.WriteString(token)
			closeErr := file.Close()
			if writeErr != nil || closeErr != nil {
				_ = os.Remove(lockPath)
				return nil, errors.Join(writeErr, closeErr)
			}
			return func() {
				content, readErr := os.ReadFile(lockPath)
				if readErr == nil && string(content) == token {
					_ = os.Remove(lockPath)
				}
			}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if info, statErr := os.Stat(lockPath); statErr == nil &&
			time.Since(info.ModTime()) > codexPluginLockStaleAfter {
			_ = os.Remove(lockPath)
			continue
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func commandFailureReason(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	default:
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return fmt.Sprintf("exit_code_%d", exitErr.ExitCode())
		}
		return "command_failed"
	}
}
