package runtimeprep

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	codexNativeComputerMCPName     = "computer-use"
	codexNativeComputerClientRel   = "computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
	codexNativeComputerLauncherRel = "bin/computer-use-client-launcher"
)

type codexPluginMCPServerSpec struct {
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Cwd     string            `json:"cwd"`
	EnvVars []string          `json:"env_vars"`
	Env     map[string]string `json:"env"`
}

type codexPluginMCPManifest struct {
	MCPServers map[string]codexPluginMCPServerSpec `json:"mcpServers"`
}

// CodexNativeComputerPrepareResult reports session-scoped Computer Use MCP prep.
type CodexNativeComputerPrepareResult struct {
	Prepared     bool
	Authorized   bool
	LauncherPath string
	ClientPath   string
	PluginPath   string
	Reason       string
}

// prepareCodexNativeComputerUse materializes a session-scoped Computer Use MCP
// entry from the installed plugin's .mcp.json. It never mutates ~/.codex.
//
// Enabling a previously disabled MCP requires explicit authorization. Fixing a
// relative command to an absolute verified path for an already-enabled server
// is allowed without extra consent.
func prepareCodexNativeComputerUse(codexHome string, authorized bool) (CodexNativeComputerPrepareResult, error) {
	codexHome = strings.TrimSpace(codexHome)
	result := CodexNativeComputerPrepareResult{Authorized: authorized}
	if codexHome == "" {
		return result, fmt.Errorf("codex home is required")
	}
	if err := exposeUserCodexComputerUseRuntime(codexHome); err != nil {
		return result, err
	}

	pluginPath, ok := locateCodexPluginPackage(codexHome, CodexNativePluginComputerUse)
	if !ok {
		result.Reason = "computer-use plugin package is not installed in session CODEX_HOME"
		return result, nil
	}
	result.PluginPath = pluginPath

	manifest, err := readCodexPluginMCPManifest(pluginPath)
	if err != nil {
		result.Reason = err.Error()
		return result, nil
	}
	spec, ok := manifest.MCPServers[codexNativeComputerMCPName]
	if !ok {
		result.Reason = "computer-use plugin .mcp.json does not define computer-use server"
		return result, nil
	}

	launcherPath, err := resolveCodexPluginMCPCommand(pluginPath, spec)
	if err != nil {
		result.Reason = err.Error()
		return result, nil
	}
	result.LauncherPath = launcherPath

	clientPath := filepath.Join(codexHome, filepath.FromSlash(codexNativeComputerClientRel))
	if info, err := os.Stat(clientPath); err != nil || info.IsDir() {
		result.Reason = "Codex Computer Use client binary is missing under session CODEX_HOME"
		result.ClientPath = clientPath
		return result, nil
	}
	if info, err := os.Stat(launcherPath); err != nil || info.IsDir() {
		result.Reason = "computer-use launcher is missing"
		return result, nil
	}
	result.ClientPath = clientPath

	configPath := filepath.Join(codexHome, "config.toml")
	contentBytes, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return result, fmt.Errorf("read session codex config: %w", err)
	}
	content := string(contentBytes)
	servers := parseCodexMCPServerSections(content)
	existing, hasExisting := servers[codexNativeComputerMCPName]
	alreadyEnabled := hasExisting && existing.Enabled

	if !alreadyEnabled && !authorized {
		result.Reason = "computer-use MCP enablement requires explicit user authorization"
		return result, nil
	}

	env := map[string]string{"CODEX_HOME": codexHome}
	for _, key := range spec.EnvVars {
		key = strings.TrimSpace(key)
		if key == "" || key == "CODEX_HOME" {
			continue
		}
		if value, ok := os.LookupEnv(key); ok {
			env[key] = value
		}
	}
	for key, value := range spec.Env {
		env[strings.TrimSpace(key)] = value
	}

	next, changed := codexConfigWithNativeComputerUseMCP(content, launcherPath, spec.Args, env, true)
	pluginNext, pluginChanged := codexConfigWithPluginEnabled(next, CodexNativePluginComputerUse, true)
	next = pluginNext
	changed = changed || pluginChanged
	if changed {
		if err := os.WriteFile(configPath, []byte(next), 0o600); err != nil {
			return result, fmt.Errorf("write session computer-use MCP config: %w", err)
		}
	}
	result.Prepared = true
	result.Reason = "session-scoped computer-use MCP prepared with absolute launcher"
	return result, nil
}

func exposeUserCodexComputerUseRuntime(codexHome string) error {
	userHome, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(userHome) == "" {
		return nil
	}
	userCodexHome := filepath.Join(userHome, ".codex")
	source := filepath.Join(userCodexHome, "computer-use")
	if _, err := os.Stat(source); err != nil {
		return nil
	}
	target := filepath.Join(codexHome, "computer-use")
	if _, err := os.Lstat(target); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return fmt.Errorf("create session computer-use parent: %w", err)
	}
	if err := os.Symlink(source, target); err != nil {
		return fmt.Errorf("expose session computer-use runtime: %w", err)
	}
	return nil
}

func readCodexPluginMCPManifest(pluginPath string) (codexPluginMCPManifest, error) {
	manifestPath := filepath.Join(pluginPath, ".mcp.json")
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return codexPluginMCPManifest{}, fmt.Errorf("read plugin mcp manifest: %w", err)
	}
	var manifest codexPluginMCPManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return codexPluginMCPManifest{}, fmt.Errorf("parse plugin mcp manifest: %w", err)
	}
	if len(manifest.MCPServers) == 0 {
		return codexPluginMCPManifest{}, fmt.Errorf("plugin mcp manifest has no servers")
	}
	return manifest, nil
}

func resolveCodexPluginMCPCommand(pluginPath string, spec codexPluginMCPServerSpec) (string, error) {
	command := strings.TrimSpace(spec.Command)
	if command == "" {
		return "", fmt.Errorf("plugin mcp command is empty")
	}
	cwd := strings.TrimSpace(spec.Cwd)
	if cwd == "" || cwd == "." {
		cwd = pluginPath
	} else if !filepath.IsAbs(cwd) {
		cwd = filepath.Join(pluginPath, cwd)
	}
	if filepath.IsAbs(command) {
		return filepath.Clean(command), nil
	}
	return filepath.Clean(filepath.Join(cwd, command)), nil
}

func locateCodexPluginPackage(codexHome, pluginID string) (string, bool) {
	if path, ok := locateCodexPluginInstall(codexHome, pluginID); ok {
		return path, true
	}
	name, marketplace := splitCodexPluginID(pluginID)
	if name == "" {
		return "", false
	}
	configPath := filepath.Join(codexHome, "config.toml")
	content, err := os.ReadFile(configPath)
	if err != nil {
		return "", false
	}
	sources := parseCodexMarketplaceSources(string(content))
	if marketplace != "" {
		if root, ok := sources[marketplace]; ok {
			candidate := filepath.Join(root, "plugins", name)
			if pluginPackageReady(candidate) {
				return candidate, true
			}
		}
	}
	for _, root := range sources {
		candidate := filepath.Join(root, "plugins", name)
		if pluginPackageReady(candidate) {
			return candidate, true
		}
	}
	return "", false
}

func pluginPackageReady(path string) bool {
	if _, err := os.Stat(filepath.Join(path, ".codex-plugin", "plugin.json")); err != nil {
		return false
	}
	return true
}

func parseCodexMarketplaceSources(content string) map[string]string {
	result := map[string]string{}
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	current := ""
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			section := strings.TrimSpace(trimmed[1 : len(trimmed)-1])
			current = ""
			if strings.HasPrefix(section, "marketplaces.") {
				current = strings.TrimPrefix(section, "marketplaces.")
			}
			continue
		}
		if current == "" {
			continue
		}
		if key, value, ok := parseCodexConfigStringAssignment(trimmed); ok && key == "source" {
			result[current] = value
		}
	}
	return result
}

func codexConfigWithPluginEnabled(content, pluginID string, enabled bool) (string, bool) {
	pluginID = strings.TrimSpace(pluginID)
	if pluginID == "" {
		return content, false
	}
	sectionName := `plugins.` + strconv.Quote(pluginID)
	line := "enabled = " + strconv.FormatBool(enabled)
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	for sectionStart, existing := range lines {
		trimmed := strings.TrimSpace(existing)
		if trimmed != "["+sectionName+"]" && trimmed != `[plugins."`+pluginID+`"]` {
			continue
		}
		sectionEnd := len(lines)
		for index := sectionStart + 1; index < len(lines); index++ {
			next := strings.TrimSpace(lines[index])
			if strings.HasPrefix(next, "[") && strings.HasSuffix(next, "]") {
				sectionEnd = index
				break
			}
		}
		for index := sectionStart + 1; index < sectionEnd; index++ {
			if key, _, ok := parseCodexConfigBoolAssignment(strings.TrimSpace(lines[index])); ok && key == "enabled" {
				if strings.TrimSpace(lines[index]) == line {
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
	block := "[" + sectionName + "]\n" + line + "\n"
	if strings.TrimSpace(content) == "" {
		return block, true
	}
	return strings.TrimRight(content, "\r\n") + "\n\n" + block, true
}

func codexConfigWithNativeComputerUseMCP(
	content string,
	command string,
	args []string,
	env map[string]string,
	enabled bool,
) (string, bool) {
	section := "[mcp_servers." + codexNativeComputerMCPName + "]"
	envSection := "[mcp_servers." + codexNativeComputerMCPName + ".env]"
	body := []string{
		section,
		"command = " + strconv.Quote(command),
		"args = " + formatCodexTOMLStringArray(args),
		`cwd = ""`,
		"enabled = " + strconv.FormatBool(enabled),
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

	without, removed := removeCodexConfigSections(content, section, envSection)
	next := strings.TrimRight(without, "\r\n")
	if next == "" {
		next = block
	} else {
		next = next + "\n\n" + block
	}
	if !removed && strings.Contains(content, section) && strings.TrimSpace(content) == strings.TrimSpace(next) {
		return content, false
	}
	if strings.TrimSpace(content) == strings.TrimSpace(next) {
		return content, false
	}
	return next, true
}

func removeCodexConfigSections(content string, sectionHeaders ...string) (string, bool) {
	wanted := map[string]struct{}{}
	for _, header := range sectionHeaders {
		wanted[strings.TrimSpace(header)] = struct{}{}
	}
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	next := make([]string, 0, len(lines))
	removed := false
	skipping := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			_, skipping = wanted[trimmed]
			if skipping {
				removed = true
				continue
			}
		}
		if skipping {
			continue
		}
		next = append(next, line)
	}
	return strings.Join(next, "\n"), removed
}

func formatCodexTOMLStringArray(values []string) string {
	if len(values) == 0 {
		return "[]"
	}
	parts := make([]string, 0, len(values))
	for _, value := range values {
		parts = append(parts, strconv.Quote(value))
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// VerifyCodexNativeComputerMCPStatus interprets mcpServerStatus/list payloads
// for the computer-use server. A healthy native path requires connected status
// and at least one tool.
func VerifyCodexNativeComputerMCPStatus(raw json.RawMessage) (ok bool, reason string) {
	var result struct {
		Data []map[string]any `json:"data"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return false, "mcpServerStatus/list response is invalid"
	}
	for _, server := range result.Data {
		name := firstNonEmptyText(
			codexConfigMapString(server, "name"),
			codexConfigMapString(server, "serverName"),
		)
		if name != codexNativeComputerMCPName {
			continue
		}
		status := strings.ToLower(codexConfigMapString(server, "status"))
		tools := codexConfigMapSlice(server["tools"])
		if strings.Contains(status, "fail") || strings.Contains(status, "error") || strings.Contains(status, "disable") {
			return false, "computer-use MCP status is " + status
		}
		if len(tools) == 0 {
			return false, "computer-use MCP reported no tools"
		}
		if status == "" || strings.Contains(status, "auth") {
			return false, "computer-use MCP is not connected"
		}
		return true, "computer-use MCP is connected with tools"
	}
	return false, "computer-use MCP server was not reported"
}

func codexConfigMapString(values map[string]any, key string) string {
	if values == nil {
		return ""
	}
	value, _ := values[key].(string)
	return strings.TrimSpace(value)
}

func codexConfigMapSlice(value any) []any {
	items, _ := value.([]any)
	return items
}
