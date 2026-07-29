package runtimeprep

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	codexNativeBrowserMCPName        = "node_repl"
	codexNativeBrowserClientRel      = "scripts/browser-client.mjs"
	codexNativeBrowserTrustedSHAEnv  = "NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S"
	codexNativeBrowserBackendsEnv    = "BROWSER_USE_AVAILABLE_BACKENDS"
	codexNativeBrowserTrustedPathEnv = "NODE_REPL_TRUSTED_CODE_PATHS"
)

// CodexNativeBrowserPrepareResult reports session-scoped Browser native prep.
type CodexNativeBrowserPrepareResult struct {
	Prepared        bool
	PluginPath      string
	BrowserClient   string
	NodeReplCommand string
	Backends        []string
	HostUnsupported bool
	Reason          string
}

// prepareCodexNativeBrowser validates Browser plugin + Node REPL dependencies
// and rewrites session-scoped node_repl env to the session CODEX_HOME. It never
// edits ~/.codex. iab-only backends are marked host-unsupported because Tutti
// has no ChatGPT in-app browser bridge.
func prepareCodexNativeBrowser(codexHome string) (CodexNativeBrowserPrepareResult, error) {
	codexHome = strings.TrimSpace(codexHome)
	result := CodexNativeBrowserPrepareResult{}
	if codexHome == "" {
		return result, fmt.Errorf("codex home is required")
	}

	pluginPath, ok := locateCodexPluginPackage(codexHome, CodexNativePluginBrowser)
	if !ok {
		result.Reason = "browser plugin package is not installed in session CODEX_HOME"
		return result, nil
	}
	result.PluginPath = pluginPath

	browserClient := filepath.Join(pluginPath, filepath.FromSlash(codexNativeBrowserClientRel))
	if info, err := os.Stat(browserClient); err != nil || info.IsDir() {
		result.Reason = "browser plugin is missing scripts/browser-client.mjs"
		return result, nil
	}
	result.BrowserClient = browserClient

	configPath := filepath.Join(codexHome, "config.toml")
	contentBytes, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return result, fmt.Errorf("read session codex config: %w", err)
	}
	content := string(contentBytes)
	servers := parseCodexMCPServerSections(content)
	nodeRepl, ok := servers[codexNativeBrowserMCPName]
	if !ok || strings.TrimSpace(nodeRepl.Command) == "" {
		result.Reason = "node_repl MCP server is missing from session config"
		return result, nil
	}
	command := strings.TrimSpace(nodeRepl.Command)
	if !filepath.IsAbs(command) {
		result.Reason = "node_repl command must be an absolute path"
		return result, nil
	}
	if info, err := os.Stat(command); err != nil || info.IsDir() {
		result.Reason = "node_repl command is not executable on this host"
		return result, nil
	}
	result.NodeReplCommand = command

	backends := browserUseAvailableBackends(content, nodeRepl.Env)
	result.Backends = append([]string(nil), backends...)
	if !browserBackendsIncludeChrome(backends) {
		result.HostUnsupported = true
		result.Reason = "browser backends are iab-only; Tutti has no in-app browser host bridge"
		return result, nil
	}

	env := map[string]string{}
	for key, value := range nodeRepl.Env {
		env[key] = value
	}
	env["CODEX_HOME"] = codexHome
	env[codexNativeBrowserBackendsEnv] = joinUniqueCSV(append(backends, "chrome"))
	trustedPaths := splitCSV(env[codexNativeBrowserTrustedPathEnv])
	trustedPaths = appendUniqueStrings(trustedPaths, codexHome, pluginPath, filepath.Dir(browserClient))
	env[codexNativeBrowserTrustedPathEnv] = strings.Join(trustedPaths, string(os.PathListSeparator))

	next, changed := codexConfigWithNativeBrowserNodeRepl(content, command, env, true)
	featureNext, featureChanged := codexConfigWithFeatureFlag(next, "js_repl", true)
	next = featureNext
	changed = changed || featureChanged
	pluginNext, pluginChanged := codexConfigWithPluginEnabled(next, CodexNativePluginBrowser, true)
	next = pluginNext
	changed = changed || pluginChanged
	if changed {
		if err := os.WriteFile(configPath, []byte(next), 0o600); err != nil {
			return result, fmt.Errorf("write session browser native config: %w", err)
		}
	}
	result.Prepared = true
	result.Reason = "session-scoped browser native dependencies prepared"
	return result, nil
}

func browserBackendsIncludeChrome(backends []string) bool {
	for _, backend := range backends {
		if strings.EqualFold(strings.TrimSpace(backend), "chrome") {
			return true
		}
	}
	return false
}

func codexConfigWithNativeBrowserNodeRepl(
	content string,
	command string,
	env map[string]string,
	enabled bool,
) (string, bool) {
	section := "[mcp_servers." + codexNativeBrowserMCPName + "]"
	envSection := "[mcp_servers." + codexNativeBrowserMCPName + ".env]"
	startupTimeout := codexConfigSectionStringValue(content, section, "startup_timeout_sec")
	if startupTimeout == "" {
		startupTimeout = "120"
	}
	body := []string{
		section,
		"command = " + strconv.Quote(command),
		"args = []",
		"enabled = " + strconv.FormatBool(enabled),
		"startup_timeout_sec = " + startupTimeout,
		"",
		envSection,
	}
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		body = append(body, key+" = "+strconv.Quote(env[key]))
	}
	block := strings.Join(body, "\n") + "\n"
	without, _ := removeCodexConfigSections(content, section, envSection)
	next := strings.TrimRight(without, "\r\n")
	if next == "" {
		next = block
	} else {
		next = next + "\n\n" + block
	}
	if strings.TrimSpace(content) == strings.TrimSpace(next) {
		return content, false
	}
	return next, true
}

func codexConfigSectionStringValue(content, sectionHeader, key string) string {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	inSection := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			inSection = trimmed == strings.TrimSpace(sectionHeader)
			continue
		}
		if !inSection {
			continue
		}
		if parsedKey, value, ok := parseCodexConfigStringAssignment(trimmed); ok && parsedKey == key {
			return value
		}
		if parsedKey, value, ok := parseCodexConfigBoolAssignment(trimmed); ok && parsedKey == key {
			return strconv.FormatBool(value)
		}
		// Bare numbers such as startup_timeout_sec = 120.
		parts := strings.SplitN(trimmed, "=", 2)
		if len(parts) == 2 && strings.TrimSpace(parts[0]) == key {
			return strings.TrimSpace(parts[1])
		}
	}
	return ""
}

func codexConfigWithFeatureFlag(content, key string, enabled bool) (string, bool) {
	key = strings.TrimSpace(key)
	if key == "" {
		return content, false
	}
	line := key + " = " + strconv.FormatBool(enabled)
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	for sectionStart, existing := range lines {
		if strings.TrimSpace(existing) != "[features]" {
			continue
		}
		sectionEnd := len(lines)
		for index := sectionStart + 1; index < len(lines); index++ {
			trimmed := strings.TrimSpace(lines[index])
			if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
				sectionEnd = index
				break
			}
		}
		for index := sectionStart + 1; index < sectionEnd; index++ {
			trimmed := strings.TrimSpace(lines[index])
			if keyName, _, ok := parseCodexConfigBoolAssignment(trimmed); ok && keyName == key {
				if trimmed == line {
					return content, false
				}
				nextLines := append([]string{}, lines...)
				nextLines[index] = line
				return strings.Join(nextLines, "\n"), true
			}
		}
		nextLines := make([]string, 0, len(lines)+1)
		nextLines = append(nextLines, lines[:sectionEnd]...)
		nextLines = append(nextLines, line)
		nextLines = append(nextLines, lines[sectionEnd:]...)
		return strings.Join(nextLines, "\n"), true
	}
	block := "[features]\n" + line + "\n"
	if strings.TrimSpace(content) == "" {
		return block, true
	}
	return strings.TrimRight(content, "\r\n") + "\n\n" + block, true
}

func splitCSV(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	separator := string(os.PathListSeparator)
	parts := strings.Split(raw, separator)
	if len(parts) == 1 && strings.Contains(raw, ",") && !strings.Contains(raw, separator) {
		parts = strings.Split(raw, ",")
	}
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			result = append(result, part)
		}
	}
	return result
}

func joinUniqueCSV(values []string) string {
	return strings.Join(appendUniqueStrings(nil, values...), ",")
}

func appendUniqueStrings(dst []string, values ...string) []string {
	seen := map[string]struct{}{}
	for _, value := range dst {
		seen[value] = struct{}{}
	}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		dst = append(dst, value)
	}
	return dst
}
