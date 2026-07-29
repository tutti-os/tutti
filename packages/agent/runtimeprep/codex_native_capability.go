package runtimeprep

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/mod/semver"
)

// Codex native bundled plugin IDs that Tutti authenticates end-to-end.
const (
	CodexNativePluginBrowser      = "browser@openai-bundled"
	CodexNativePluginComputerUse  = "computer-use@openai-bundled"
	CodexNativePluginSites        = "sites@openai-bundled"
	CodexNativeCapabilityBrowser  = "browser"
	CodexNativeCapabilityComputer = "computer"
	CodexNativeCapabilitySites    = "sites"
)

// NativeCapabilityState is the session-scoped readiness of one Codex native
// capability before backend selection. It is derived from the session
// CODEX_HOME, never from the user's global ~/.codex alone.
type NativeCapabilityState string

const (
	NativeCapabilityReady              NativeCapabilityState = "ready"
	NativeCapabilityNotInstalled       NativeCapabilityState = "not_installed"
	NativeCapabilityDisabled           NativeCapabilityState = "disabled"
	NativeCapabilityDependencyMissing  NativeCapabilityState = "dependency_missing"
	NativeCapabilityPermissionRequired NativeCapabilityState = "permission_required"
	NativeCapabilityHostUnsupported    NativeCapabilityState = "host_unsupported"
	NativeCapabilityRuntimeUnhealthy   NativeCapabilityState = "runtime_unhealthy"
)

// ResolvedCapabilityBackend is the active delivery path for one capability.
// Browser and Computer admit Tutti daemon fallback; Sites does not.
type ResolvedCapabilityBackend string

const (
	CapabilityBackendCodexNative ResolvedCapabilityBackend = "codex-native"
	CapabilityBackendTuttiDaemon ResolvedCapabilityBackend = "tutti-daemon"
	CapabilityBackendUnavailable ResolvedCapabilityBackend = "unavailable"
)

// CapabilityBackendPreference controls Native-first selection.
// Empty values mean auto.
type CapabilityBackendPreference string

const (
	CapabilityBackendPreferenceAuto   CapabilityBackendPreference = "auto"
	CapabilityBackendPreferenceNative CapabilityBackendPreference = "native"
	CapabilityBackendPreferenceTutti  CapabilityBackendPreference = "tutti"
)

// CodexNativeCapabilityEvidence is the filesystem/config snapshot taken from a
// session CODEX_HOME after preparation.
type CodexNativeCapabilityEvidence struct {
	PluginID         string
	Capability       string
	Installed        bool
	Enabled          bool
	InstallPath      string
	MCPEnabled       *bool
	MCPCommand       string
	MCPAbsolute      bool
	DependencyNotes  []string
	HostUnsupported  bool
	PermissionNeeded bool
	RuntimeUnhealthy bool
	TuttiFallbackOK  bool
}

// NativeCapabilityPlanEntry is one resolved capability for a session.
type NativeCapabilityPlanEntry struct {
	Capability string
	PluginID   string
	State      NativeCapabilityState
	Backend    ResolvedCapabilityBackend
	Reason     string
	PluginPath string
	Explicit   bool
}

// NativeCapabilityPlan is the session-scoped Native-first routing table.
type NativeCapabilityPlan struct {
	CodexHome string
	Entries   []NativeCapabilityPlanEntry
}

// NativeCapabilityResolveInput is preference + Tutti availability for resolve.
type NativeCapabilityResolveInput struct {
	BrowserPreference  CapabilityBackendPreference
	ComputerPreference CapabilityBackendPreference
	SitesPreference    CapabilityBackendPreference
	TuttiBrowserOK     bool
	TuttiComputerOK    bool
}

func (p NativeCapabilityPlan) Entry(capability string) (NativeCapabilityPlanEntry, bool) {
	capability = strings.TrimSpace(capability)
	for _, entry := range p.Entries {
		if entry.Capability == capability {
			return entry, true
		}
	}
	return NativeCapabilityPlanEntry{}, false
}

func (p NativeCapabilityPlan) Backend(capability string) ResolvedCapabilityBackend {
	entry, ok := p.Entry(capability)
	if !ok {
		return CapabilityBackendUnavailable
	}
	return entry.Backend
}

// InspectCodexNativeCapabilityEvidence reads plugin enablement, install cache,
// and coarse MCP/dependency signals from a session CODEX_HOME.
func InspectCodexNativeCapabilityEvidence(codexHome string) ([]CodexNativeCapabilityEvidence, error) {
	codexHome = strings.TrimSpace(codexHome)
	if codexHome == "" {
		return nil, fmt.Errorf("codex home is required")
	}
	configPath := filepath.Join(codexHome, "config.toml")
	content, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("read session codex config: %w", err)
	}
	configText := string(content)
	plugins := parseCodexPluginEnablement(configText)
	mcpServers := parseCodexMCPServerSections(configText)

	specs := []struct {
		capability string
		pluginID   string
		tuttiOK    bool
	}{
		{CodexNativeCapabilityBrowser, CodexNativePluginBrowser, false},
		{CodexNativeCapabilityComputer, CodexNativePluginComputerUse, false},
		{CodexNativeCapabilitySites, CodexNativePluginSites, false},
	}

	evidence := make([]CodexNativeCapabilityEvidence, 0, len(specs))
	for _, spec := range specs {
		item := CodexNativeCapabilityEvidence{
			PluginID:   spec.pluginID,
			Capability: spec.capability,
		}
		if enabled, ok := plugins[spec.pluginID]; ok {
			item.Enabled = enabled
		}
		installPath, installed := locateCodexPluginPackage(codexHome, spec.pluginID)
		item.Installed = installed
		item.InstallPath = installPath
		switch spec.capability {
		case CodexNativeCapabilityBrowser:
			enrichBrowserNativeEvidence(&item, mcpServers, configText)
		case CodexNativeCapabilityComputer:
			enrichComputerNativeEvidence(&item, mcpServers)
		case CodexNativeCapabilitySites:
			enrichSitesNativeEvidence(&item)
		}
		evidence = append(evidence, item)
	}
	return evidence, nil
}

// ResolveNativeCapabilityPlan turns session evidence into a routing plan.
func ResolveNativeCapabilityPlan(
	codexHome string,
	evidence []CodexNativeCapabilityEvidence,
	input NativeCapabilityResolveInput,
) NativeCapabilityPlan {
	plan := NativeCapabilityPlan{
		CodexHome: strings.TrimSpace(codexHome),
		Entries:   make([]NativeCapabilityPlanEntry, 0, len(evidence)),
	}
	for _, item := range evidence {
		tuttiOK := false
		preference := CapabilityBackendPreferenceAuto
		switch item.Capability {
		case CodexNativeCapabilityBrowser:
			tuttiOK = input.TuttiBrowserOK
			preference = normalizeCapabilityBackendPreference(input.BrowserPreference)
		case CodexNativeCapabilityComputer:
			tuttiOK = input.TuttiComputerOK
			preference = normalizeCapabilityBackendPreference(input.ComputerPreference)
		case CodexNativeCapabilitySites:
			preference = normalizeCapabilityBackendPreference(input.SitesPreference)
			if preference == CapabilityBackendPreferenceTutti {
				// Sites has no Tutti fallback; treat as auto.
				preference = CapabilityBackendPreferenceAuto
			}
		}
		item.TuttiFallbackOK = tuttiOK && item.Capability != CodexNativeCapabilitySites
		state, reason := nativeCapabilityStateFromEvidence(item)
		backend, backendReason, explicit := resolveCapabilityBackend(state, preference, item)
		if backendReason != "" {
			reason = backendReason
		}
		plan.Entries = append(plan.Entries, NativeCapabilityPlanEntry{
			Capability: item.Capability,
			PluginID:   item.PluginID,
			State:      state,
			Backend:    backend,
			Reason:     reason,
			PluginPath: "plugin://" + item.PluginID,
			Explicit:   explicit,
		})
	}
	return plan
}

// BuildCodexNativeCapabilityPlan inspects a prepared session home and resolves
// Native-first backends for Browser, Computer Use, and Sites.
func BuildCodexNativeCapabilityPlan(
	codexHome string,
	input NativeCapabilityResolveInput,
) (NativeCapabilityPlan, error) {
	evidence, err := InspectCodexNativeCapabilityEvidence(codexHome)
	if err != nil {
		return NativeCapabilityPlan{}, err
	}
	return ResolveNativeCapabilityPlan(codexHome, evidence, input), nil
}

func nativeCapabilityStateFromEvidence(item CodexNativeCapabilityEvidence) (NativeCapabilityState, string) {
	if item.RuntimeUnhealthy {
		return NativeCapabilityRuntimeUnhealthy, "native runtime probe reported unhealthy"
	}
	if item.HostUnsupported {
		return NativeCapabilityHostUnsupported, "required host bridge is unavailable in Tutti"
	}
	if item.PermissionNeeded {
		return NativeCapabilityPermissionRequired, "native capability requires explicit user permission"
	}
	if !item.Installed {
		return NativeCapabilityNotInstalled, "plugin is not installed in session CODEX_HOME"
	}
	if !item.Enabled {
		return NativeCapabilityDisabled, "plugin is disabled in session config.toml"
	}
	if len(item.DependencyNotes) > 0 {
		return NativeCapabilityDependencyMissing, strings.Join(item.DependencyNotes, "; ")
	}
	if item.MCPEnabled != nil && !*item.MCPEnabled {
		return NativeCapabilityDisabled, "required MCP server is disabled in session config"
	}
	if item.MCPCommand != "" && !item.MCPAbsolute {
		return NativeCapabilityDependencyMissing, "required MCP command is not an absolute verified path"
	}
	return NativeCapabilityReady, "native plugin is installed and enabled for this session"
}

func resolveCapabilityBackend(
	state NativeCapabilityState,
	preference CapabilityBackendPreference,
	item CodexNativeCapabilityEvidence,
) (ResolvedCapabilityBackend, string, bool) {
	preference = normalizeCapabilityBackendPreference(preference)

	switch preference {
	case CapabilityBackendPreferenceTutti:
		if item.TuttiFallbackOK {
			return CapabilityBackendTuttiDaemon, "explicit Tutti backend selected", true
		}
		return CapabilityBackendUnavailable, "explicit Tutti backend unavailable", true
	case CapabilityBackendPreferenceNative:
		if state == NativeCapabilityReady {
			return CapabilityBackendCodexNative, "explicit Codex native backend selected", true
		}
		return CapabilityBackendUnavailable, "explicit Codex native backend failed: " + string(state), true
	default:
		if state == NativeCapabilityReady {
			return CapabilityBackendCodexNative, "Codex native ready", false
		}
		if item.TuttiFallbackOK {
			return CapabilityBackendTuttiDaemon, "Codex native unavailable; using Tutti fallback (" + string(state) + ")", false
		}
		return CapabilityBackendUnavailable, "Codex native unavailable and no Tutti fallback (" + string(state) + ")", false
	}
}

func normalizeCapabilityBackendPreference(value CapabilityBackendPreference) CapabilityBackendPreference {
	switch CapabilityBackendPreference(strings.ToLower(strings.TrimSpace(string(value)))) {
	case CapabilityBackendPreferenceNative:
		return CapabilityBackendPreferenceNative
	case CapabilityBackendPreferenceTutti:
		return CapabilityBackendPreferenceTutti
	default:
		return CapabilityBackendPreferenceAuto
	}
}

func enrichBrowserNativeEvidence(
	item *CodexNativeCapabilityEvidence,
	mcpServers map[string]codexMCPServerEvidence,
	configText string,
) {
	nodeRepl, ok := mcpServers["node_repl"]
	if !ok || strings.TrimSpace(nodeRepl.Command) == "" {
		item.DependencyNotes = append(item.DependencyNotes, "node_repl MCP server is missing")
		return
	}
	item.MCPCommand = nodeRepl.Command
	item.MCPAbsolute = filepath.IsAbs(nodeRepl.Command)
	item.MCPEnabled = boolPtr(nodeRepl.Enabled)
	if !nodeRepl.Enabled {
		return
	}
	if !item.MCPAbsolute {
		return
	}
	if _, err := os.Stat(nodeRepl.Command); err != nil {
		item.DependencyNotes = append(item.DependencyNotes, "node_repl command is not executable on this host")
		return
	}
	backends := browserUseAvailableBackends(configText, nodeRepl.Env)
	if len(backends) == 0 {
		item.DependencyNotes = append(item.DependencyNotes, "BROWSER_USE_AVAILABLE_BACKENDS is empty")
		return
	}
	hasChrome := false
	hasOnlyIAB := true
	for _, backend := range backends {
		if backend == "chrome" {
			hasChrome = true
			hasOnlyIAB = false
		}
		if backend != "iab" {
			hasOnlyIAB = false
		}
	}
	if hasOnlyIAB && !hasChrome {
		// Tutti has no ChatGPT in-app browser bridge.
		item.HostUnsupported = true
	}
}

func enrichComputerNativeEvidence(
	item *CodexNativeCapabilityEvidence,
	mcpServers map[string]codexMCPServerEvidence,
) {
	server, ok := mcpServers["computer-use"]
	if !ok {
		if item.Installed {
			item.PermissionNeeded = true
			item.DependencyNotes = append(item.DependencyNotes, "computer-use MCP server is missing from session config")
		} else {
			item.DependencyNotes = append(item.DependencyNotes, "computer-use MCP server is missing from session config")
		}
		return
	}
	item.MCPCommand = server.Command
	item.MCPEnabled = boolPtr(server.Enabled)
	item.MCPAbsolute = filepath.IsAbs(server.Command) || (server.Cwd != "" && filepath.IsAbs(filepath.Join(server.Cwd, server.Command)))
	if !server.Enabled {
		item.PermissionNeeded = true
		return
	}
	if strings.TrimSpace(server.Command) == "" {
		item.DependencyNotes = append(item.DependencyNotes, "computer-use MCP command is empty")
		return
	}
	if !item.MCPAbsolute {
		item.DependencyNotes = append(item.DependencyNotes, "computer-use MCP command must be session-scoped absolute path")
	}
}

func enrichSitesNativeEvidence(item *CodexNativeCapabilityEvidence) {
	if !item.Installed || strings.TrimSpace(item.InstallPath) == "" {
		return
	}
	requiredSkills := []string{
		filepath.Join(item.InstallPath, "skills", "sites-building", "SKILL.md"),
		filepath.Join(item.InstallPath, "skills", "sites-hosting", "SKILL.md"),
	}
	for _, skillPath := range requiredSkills {
		if _, err := os.Stat(skillPath); err != nil {
			item.DependencyNotes = append(item.DependencyNotes, "missing skill file "+filepath.Base(filepath.Dir(skillPath)))
		}
	}
}

type codexMCPServerEvidence struct {
	Name    string
	Command string
	Cwd     string
	Enabled bool
	Env     map[string]string
}

func parseCodexPluginEnablement(content string) map[string]bool {
	result := map[string]bool{}
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	currentPlugin := ""
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			currentPlugin = ""
			section := strings.TrimSpace(trimmed[1 : len(trimmed)-1])
			if strings.HasPrefix(section, "plugins.") {
				name := strings.TrimPrefix(section, "plugins.")
				name = strings.Trim(name, `"'`)
				currentPlugin = name
				// Presence without enabled defaults to enabled in Codex configs
				// that only list the table; explicit enabled=false overrides.
				if _, ok := result[currentPlugin]; !ok {
					result[currentPlugin] = true
				}
			}
			continue
		}
		if currentPlugin == "" {
			continue
		}
		if key, value, ok := parseCodexConfigBoolAssignment(trimmed); ok && key == "enabled" {
			result[currentPlugin] = value
		}
	}
	return result
}

func parseCodexMCPServerSections(content string) map[string]codexMCPServerEvidence {
	result := map[string]codexMCPServerEvidence{}
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	current := ""
	inEnv := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			section := strings.TrimSpace(trimmed[1 : len(trimmed)-1])
			inEnv = false
			current = ""
			switch {
			case strings.HasPrefix(section, "mcp_servers.") && strings.HasSuffix(section, ".env"):
				name := strings.TrimSuffix(strings.TrimPrefix(section, "mcp_servers."), ".env")
				current = name
				inEnv = true
				entry := result[name]
				entry.Name = name
				if entry.Env == nil {
					entry.Env = map[string]string{}
				}
				if _, ok := result[name]; !ok {
					entry.Enabled = true
				}
				result[name] = entry
			case strings.HasPrefix(section, "mcp_servers."):
				name := strings.TrimPrefix(section, "mcp_servers.")
				current = name
				entry := result[name]
				entry.Name = name
				if entry.Env == nil {
					entry.Env = map[string]string{}
				}
				if _, ok := result[name]; !ok {
					entry.Enabled = true
				}
				result[name] = entry
			}
			continue
		}
		if current == "" {
			continue
		}
		entry := result[current]
		if inEnv {
			if key, value, ok := parseCodexConfigStringAssignment(trimmed); ok {
				entry.Env[key] = value
			}
			result[current] = entry
			continue
		}
		if key, value, ok := parseCodexConfigBoolAssignment(trimmed); ok && key == "enabled" {
			entry.Enabled = value
			result[current] = entry
			continue
		}
		if key, value, ok := parseCodexConfigStringAssignment(trimmed); ok {
			switch key {
			case "command":
				entry.Command = value
			case "cwd":
				entry.Cwd = value
			}
			result[current] = entry
		}
	}
	return result
}

func parseCodexConfigBoolAssignment(line string) (string, bool, bool) {
	parts := strings.SplitN(line, "=", 2)
	if len(parts) != 2 {
		return "", false, false
	}
	key := strings.TrimSpace(parts[0])
	raw := strings.TrimSpace(parts[1])
	switch strings.ToLower(raw) {
	case "true":
		return key, true, true
	case "false":
		return key, false, true
	default:
		return "", false, false
	}
}

func parseCodexConfigStringAssignment(line string) (string, string, bool) {
	parts := strings.SplitN(line, "=", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	key := strings.TrimSpace(parts[0])
	raw := strings.TrimSpace(parts[1])
	if strings.HasPrefix(raw, `"`) {
		value, _, _, ok := decodeCodexQuotedString(raw)
		if !ok {
			return "", "", false
		}
		return key, value, true
	}
	if strings.HasPrefix(raw, "[") {
		return "", "", false
	}
	return key, strings.Trim(raw, `"'`), true
}

func decodeCodexQuotedString(raw string) (string, int, bool, bool) {
	if !strings.HasPrefix(raw, `"`) {
		return "", 0, false, false
	}
	var builder strings.Builder
	escaped := false
	for index := 1; index < len(raw); index++ {
		ch := raw[index]
		if escaped {
			builder.WriteByte(ch)
			escaped = false
			continue
		}
		if ch == '\\' {
			escaped = true
			continue
		}
		if ch == '"' {
			return builder.String(), index, false, true
		}
		builder.WriteByte(ch)
	}
	return "", 0, true, false
}

func locateCodexPluginInstall(codexHome, pluginID string) (string, bool) {
	name, marketplace := splitCodexPluginID(pluginID)
	if name == "" || marketplace == "" {
		return "", false
	}
	cacheRoot := filepath.Join(codexHome, "plugins", "cache", marketplace, name)
	entries, err := os.ReadDir(cacheRoot)
	if err != nil {
		return "", false
	}
	var latest string
	var latestVersion string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		candidate := filepath.Join(cacheRoot, entry.Name())
		if _, err := os.Stat(filepath.Join(candidate, ".codex-plugin", "plugin.json")); err != nil {
			continue
		}
		if latest == "" || compareCodexPluginCacheVersions(entry.Name(), latestVersion) > 0 {
			latest = candidate
			latestVersion = entry.Name()
		}
	}
	if latest == "" {
		return "", false
	}
	return latest, true
}

func compareCodexPluginCacheVersions(left, right string) int {
	leftVersion, leftValid := normalizedCodexPluginCacheSemver(left)
	rightVersion, rightValid := normalizedCodexPluginCacheSemver(right)
	switch {
	case leftValid && rightValid:
		if comparison := semver.Compare(leftVersion, rightVersion); comparison != 0 {
			return comparison
		}
	case leftValid:
		return 1
	case rightValid:
		return -1
	}
	return strings.Compare(left, right)
}

func normalizedCodexPluginCacheSemver(version string) (string, bool) {
	version = strings.TrimSpace(version)
	if version == "" {
		return "", false
	}
	if !strings.HasPrefix(version, "v") {
		version = "v" + version
	}
	return version, semver.IsValid(version)
}

func splitCodexPluginID(pluginID string) (name, marketplace string) {
	pluginID = strings.TrimSpace(pluginID)
	parts := strings.SplitN(pluginID, "@", 2)
	if len(parts) != 2 {
		return pluginID, ""
	}
	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
}

func browserUseAvailableBackends(configText string, env map[string]string) []string {
	raw := ""
	if env != nil {
		raw = strings.TrimSpace(env["BROWSER_USE_AVAILABLE_BACKENDS"])
	}
	if raw == "" {
		raw = codexConfigTopLevelAssignment(configText, "BROWSER_USE_AVAILABLE_BACKENDS")
	}
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	backends := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.ToLower(strings.TrimSpace(part))
		if part != "" {
			backends = append(backends, part)
		}
	}
	return backends
}

func codexConfigTopLevelAssignment(content, key string) string {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			break
		}
		if parsedKey, value, ok := parseCodexConfigStringAssignment(trimmed); ok && parsedKey == key {
			return value
		}
	}
	return ""
}

func boolPtr(value bool) *bool {
	return &value
}
