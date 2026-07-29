package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
)

const codexAppServerCapabilityListTimeout = 8 * time.Second

type CodexCLICapabilityLister struct {
	Command          string
	Args             []string
	Timeout          time.Duration
	Environ          func() []string
	HomeDir          func() (string, error)
	IsExecutableFile func(string) bool
	LookPath         func(string) (string, error)
}

type defaultComposerCapabilityLister struct{}

type codexCapabilityListResult struct {
	Options []ComposerCapabilityOption
	Errors  []string
}

func (defaultComposerCapabilityLister) ListComposerCapabilityOptions(
	ctx context.Context,
	provider string,
	cwd string,
	fallbackSkills []ComposerSkillOption,
) ([]ComposerCapabilityOption, []string) {
	return discoverComposerCapabilityOptions(ctx, provider, cwd, fallbackSkills)
}

func (s *Service) composerCapabilityLister() ComposerCapabilityLister {
	if s.CapabilityLister != nil {
		return s.CapabilityLister
	}
	return defaultComposerCapabilityLister{}
}

func discoverComposerCapabilityOptions(
	ctx context.Context,
	provider string,
	cwd string,
	fallbackSkills []ComposerSkillOption,
) ([]ComposerCapabilityOption, []string) {
	fallback := composerCapabilityCatalogFromSkills(provider, fallbackSkills)
	profile := composerProfileFor(provider)
	lister, ok, err := composerCapabilityCatalogLister(profile)
	if err != nil {
		return fallback, []string{err.Error()}
	}
	if !ok {
		return fallback, nil
	}
	result, err := lister.List(ctx, cwd)
	if err != nil {
		errors := append([]string{err.Error()}, result.Errors...)
		if profile.CapabilityCatalogKind == providerregistry.CapabilityCatalogKindCodexAppServer {
			// Codex Composer intentionally exposes only the native plugin surface.
			// Skills remain available to the runtime through ComposerOptions.Skills,
			// but must not become a fallback $ palette on discovery failure.
			return []ComposerCapabilityOption{}, errors
		}
		return fallback, errors
	}
	if profile.CapabilityCatalogKind == providerregistry.CapabilityCatalogKindCodexAppServer {
		return codexNativeComposerPluginOptions(result.Options), append([]string(nil), result.Errors...)
	}
	return mergeComposerCapabilityOptions(fallback, result.Options), append([]string(nil), result.Errors...)
}

func composerCapabilityCatalogLister(profile composerProfile) (CodexCLICapabilityLister, bool, error) {
	switch profile.CapabilityCatalogKind {
	case "":
		return CodexCLICapabilityLister{}, false, nil
	case providerregistry.CapabilityCatalogKindCodexAppServer:
		command := append([]string(nil), profile.CapabilityCatalogCommand...)
		if len(command) == 0 || strings.TrimSpace(command[0]) == "" {
			return CodexCLICapabilityLister{}, false, fmt.Errorf("capability catalog command is required")
		}
		for index, argument := range command[1:] {
			if strings.TrimSpace(argument) == "" {
				return CodexCLICapabilityLister{}, false, fmt.Errorf("capability catalog command argument %d is empty", index+1)
			}
		}
		return CodexCLICapabilityLister{
			Command: command[0],
			Args:    command[1:],
		}, true, nil
	default:
		return CodexCLICapabilityLister{}, false, fmt.Errorf("unsupported capability catalog kind %q", profile.CapabilityCatalogKind)
	}
}

func (l CodexCLICapabilityLister) List(ctx context.Context, cwd string) (codexCapabilityListResult, error) {
	timeout := l.Timeout
	if timeout <= 0 {
		timeout = codexAppServerCapabilityListTimeout
	}

	command := strings.TrimSpace(l.Command)
	if command == "" {
		return codexCapabilityListResult{}, fmt.Errorf("capability catalog command is required")
	}
	resolver := runtimecmd.Resolver{
		Environ:          l.Environ,
		HomeDir:          l.HomeDir,
		IsExecutableFile: l.IsExecutableFile,
		LookPath:         l.LookPath,
	}
	processEnv := resolver.Env(nil)
	command = resolver.Resolve(command, processEnv)
	args := append([]string{}, l.Args...)
	processCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	process, err := startCodexAppServerProcess(processCtx, command, args, processEnv)
	if err != nil {
		return codexCapabilityListResult{}, err
	}
	result, err := requestCodexCapabilityList(process.stdin, process.stdout, cwd)
	processErr := processCtx.Err()
	_ = process.stop(cancel)
	if err == nil {
		return result, nil
	}
	if processErr != nil {
		return result, fmt.Errorf("codex app-server capability discovery timed out: %w", processErr)
	}
	if stderr := strings.TrimSpace(process.stderr.String()); stderr != "" {
		return result, fmt.Errorf("%w: %s", err, stderr)
	}
	return result, err
}

func requestCodexCapabilityList(stdin io.Writer, stdout io.Reader, cwd string) (codexCapabilityListResult, error) {
	encoder := json.NewEncoder(stdin)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), codexModelListMaxLineBytes)
	if err := encoder.Encode(map[string]any{
		"id":     "1",
		"method": "initialize",
		"params": map[string]any{
			"clientInfo": map[string]string{
				"name":    "tuttid",
				"version": "0.1.0",
			},
			"capabilities": map[string]any{
				"experimentalApi": true,
			},
		},
	}); err != nil {
		return codexCapabilityListResult{}, fmt.Errorf("write codex app-server initialize: %w", err)
	}
	if err := readCodexInitializeResponse(scanner); err != nil {
		return codexCapabilityListResult{}, err
	}
	if err := encoder.Encode(map[string]any{
		"method": "initialized",
		"params": map[string]any{},
	}); err != nil {
		return codexCapabilityListResult{}, fmt.Errorf("write codex app-server initialized: %w", err)
	}
	cwds := []string{}
	if trimmedCwd := strings.TrimSpace(cwd); trimmedCwd != "" {
		cwds = append(cwds, trimmedCwd)
	}
	requests := []map[string]any{
		{
			"id":     "2",
			"method": "skills/list",
			"params": map[string]any{
				"cwds":        cwds,
				"forceReload": false,
			},
		},
		{
			"id":     "3",
			"method": "app/list",
			"params": map[string]any{
				"limit":        200,
				"forceRefetch": false,
			},
		},
		{
			"id":     "4",
			"method": "plugin/list",
			"params": map[string]any{
				"cwds": cwds,
			},
		},
		{
			"id":     "5",
			"method": "mcpServerStatus/list",
			"params": map[string]any{
				"limit":  200,
				"detail": "toolsAndAuthOnly",
			},
		},
	}
	for _, request := range requests {
		if err := encoder.Encode(request); err != nil {
			return codexCapabilityListResult{}, fmt.Errorf("write codex app-server %s: %w", request["method"], err)
		}
	}
	return readCodexCapabilityListResponses(scanner)
}

func readCodexCapabilityListResponses(scanner *bufio.Scanner) (codexCapabilityListResult, error) {
	pending := map[string]string{
		"2": "skills/list",
		"3": "app/list",
		"4": "plugin/list",
		"5": "mcpServerStatus/list",
	}
	result := codexCapabilityListResult{
		Options: make([]ComposerCapabilityOption, 0),
		Errors:  make([]string, 0),
	}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var payload map[string]json.RawMessage
		if json.Unmarshal([]byte(line), &payload) != nil {
			continue
		}
		id := codexRPCIDString(payload["id"])
		method, ok := pending[id]
		if !ok {
			continue
		}
		delete(pending, id)
		if rawError, ok := payload["error"]; ok && string(rawError) != "null" {
			result.Errors = append(result.Errors, fmt.Sprintf("%s failed: %s", method, extractCodexRPCError(rawError)))
			if len(pending) == 0 {
				return finalizeCodexCapabilityListResult(result)
			}
			continue
		}
		switch id {
		case "2":
			result.Options = append(result.Options, parseCodexSkillCapabilities(payload["result"])...)
		case "3":
			result.Options = append(result.Options, parseCodexAppCapabilities(payload["result"])...)
		case "4":
			plugins, pluginErrors := parseCodexPluginCapabilities(payload["result"])
			result.Options = append(result.Options, plugins...)
			result.Errors = append(result.Errors, pluginErrors...)
		case "5":
			result.Options = append(result.Options, parseCodexMCPCapabilities(payload["result"])...)
		}
		if len(pending) == 0 {
			return finalizeCodexCapabilityListResult(result)
		}
	}
	if err := scanner.Err(); err != nil {
		return result, fmt.Errorf("read codex app-server stdout: %w", err)
	}
	if len(result.Options) > 0 || len(result.Errors) > 0 {
		for _, method := range pending {
			result.Errors = append(result.Errors, fmt.Sprintf("%s response missing", method))
		}
		return finalizeCodexCapabilityListResult(result)
	}
	return result, fmt.Errorf("codex app-server exited before capability responses")
}

func finalizeCodexCapabilityListResult(result codexCapabilityListResult) (codexCapabilityListResult, error) {
	result.Options = dedupeComposerCapabilityOptions(result.Options)
	return result, nil
}

func codexRPCIDString(raw json.RawMessage) string {
	var stringID string
	if err := json.Unmarshal(raw, &stringID); err == nil {
		return stringID
	}
	var numberID int
	if err := json.Unmarshal(raw, &numberID); err == nil {
		return fmt.Sprintf("%d", numberID)
	}
	return ""
}

func parseCodexSkillCapabilities(raw json.RawMessage) []ComposerCapabilityOption {
	var result struct {
		Data []struct {
			Skills []map[string]any `json:"skills"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return nil
	}
	options := make([]ComposerCapabilityOption, 0)
	for _, group := range result.Data {
		for _, skill := range group.Skills {
			name := codexTextValue(skill, "name")
			if name == "" {
				continue
			}
			label := firstNonEmptyString(codexTextValue(codexNestedMap(skill, "interface"), "displayName"), name)
			description := firstNonEmptyString(
				codexTextValue(codexNestedMap(skill, "interface"), "shortDescription"),
				codexTextValue(skill, "description"),
			)
			status := "available"
			if enabled, ok := codexBoolValue(skill, "enabled"); ok && !enabled {
				status = "disabled"
			}
			path := codexTextValue(skill, "path")
			options = append(options, ComposerCapabilityOption{
				ID:          "skill:" + name,
				Kind:        "skill",
				Name:        name,
				Label:       label,
				Description: description,
				Status:      status,
				Trigger:     "$" + name,
				Path:        path,
				Invocation:  "promptItem",
			})
		}
	}
	return options
}

func parseCodexAppCapabilities(raw json.RawMessage) []ComposerCapabilityOption {
	var result struct {
		Data []map[string]any `json:"data"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return nil
	}
	options := make([]ComposerCapabilityOption, 0, len(result.Data))
	for _, app := range result.Data {
		id := codexTextValue(app, "id")
		name := firstNonEmptyString(codexTextValue(app, "name"), id)
		if id == "" || name == "" {
			continue
		}
		status := "available"
		if enabled, ok := codexBoolValue(app, "isEnabled"); ok && !enabled {
			status = "disabled"
		}
		if accessible, ok := codexBoolValue(app, "isAccessible"); ok && !accessible {
			status = "authRequired"
		}
		options = append(options, ComposerCapabilityOption{
			ID:          "connector:" + id,
			Kind:        "connector",
			Name:        id,
			Label:       name,
			Description: codexTextValue(app, "description"),
			Status:      status,
			Trigger:     "$" + id,
			Path:        "app://" + id,
			Invocation:  "promptItem",
		})
	}
	return options
}

func parseCodexPluginCapabilities(raw json.RawMessage) ([]ComposerCapabilityOption, []string) {
	var result struct {
		Marketplaces []struct {
			Name    string           `json:"name"`
			Plugins []map[string]any `json:"plugins"`
		} `json:"marketplaces"`
		MarketplaceLoadErrors []map[string]any `json:"marketplaceLoadErrors"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return nil, []string{"plugin/list response shape is invalid"}
	}
	errors := make([]string, 0, len(result.MarketplaceLoadErrors))
	for _, loadError := range result.MarketplaceLoadErrors {
		message := firstNonEmptyString(
			codexTextValue(loadError, "message"),
			codexTextValue(loadError, "marketplacePath"),
		)
		if message == "" {
			message = "marketplace load failed"
		}
		errors = append(errors, "plugin marketplace load failed: "+message)
	}
	options := make([]ComposerCapabilityOption, 0)
	for _, marketplace := range result.Marketplaces {
		marketplaceName := strings.TrimSpace(marketplace.Name)
		for _, plugin := range marketplace.Plugins {
			if !codexPluginRelevantToComposer(plugin, marketplaceName) {
				continue
			}
			option, ok := composerCapabilityOptionFromCodexPlugin(plugin, marketplaceName)
			if !ok {
				continue
			}
			options = append(options, option)
		}
	}
	return options, errors
}

func codexPluginRelevantToComposer(plugin map[string]any, marketplaceName string) bool {
	if codexNativeComposerPluginSemantic(codexPluginIdentifier(plugin, marketplaceName)) != "" {
		// Computer Use may be intentionally not installed until the user grants
		// explicit setup permission. Keep it visible as setupRequired.
		return true
	}
	installed, installedKnown := codexBoolValue(plugin, "installed")
	if !installedKnown || installed {
		return true
	}
	enabled, enabledKnown := codexBoolValue(plugin, "enabled")
	return enabledKnown && enabled
}

func codexPluginIdentifier(plugin map[string]any, marketplaceName string) string {
	shortName := firstNonEmptyString(
		codexTextValue(plugin, "name"),
		codexTextValue(plugin, "pluginName"),
	)
	return firstNonEmptyString(
		codexTextValue(plugin, "id"),
		codexPluginIDFromName(shortName, marketplaceName),
		shortName,
	)
}

func composerCapabilityOptionFromCodexPlugin(plugin map[string]any, marketplaceName string) (ComposerCapabilityOption, bool) {
	shortName := firstNonEmptyString(
		codexTextValue(plugin, "name"),
		codexTextValue(plugin, "pluginName"),
	)
	pluginID := codexPluginIdentifier(plugin, marketplaceName)
	if pluginID == "" {
		return ComposerCapabilityOption{}, false
	}
	if shortName == "" {
		shortName = pluginID
	}
	iface := codexNestedMap(plugin, "interface")
	label := firstNonEmptyString(
		codexTextValue(iface, "displayName"),
		codexTextValue(plugin, "displayName"),
		codexTextValue(plugin, "title"),
		shortName,
	)
	description := firstNonEmptyString(
		codexTextValue(iface, "shortDescription"),
		codexTextValue(iface, "longDescription"),
		codexTextValue(plugin, "description"),
	)
	status := codexPluginCapabilityStatus(plugin)
	path := "plugin://" + pluginID
	invocation := "none"
	trigger := ""
	if status == "available" {
		invocation = "promptItem"
		trigger = "$" + shortName
	}
	return ComposerCapabilityOption{
		ID:          "plugin:" + pluginID,
		Kind:        "plugin",
		Name:        shortName,
		Label:       label,
		Description: description,
		Status:      status,
		Source:      firstNonEmptyString(codexPluginSource(plugin), marketplaceName),
		PluginName:  shortName,
		Path:        path,
		Trigger:     trigger,
		Invocation:  invocation,
		Semantic:    codexNativeComposerPluginSemantic(pluginID),
	}, true
}

func codexNativeComposerPluginSemantic(pluginID string) string {
	switch strings.TrimSpace(pluginID) {
	case runtimeprep.CodexNativePluginSites:
		return "sites"
	case runtimeprep.CodexNativePluginBrowser:
		return "browserUse"
	case runtimeprep.CodexNativePluginComputerUse:
		return "computerUse"
	default:
		return ""
	}
}

// codexNativeComposerPluginOptions is the intentionally small Codex Composer
// projection. Discovery may inspect other skills, apps, MCP servers, and
// marketplace plugins, but only these native plugins are interactive `$`
// candidates in Tutti's Composer.
func codexNativeComposerPluginOptions(options []ComposerCapabilityOption) []ComposerCapabilityOption {
	bySemantic := make(map[string]ComposerCapabilityOption, len(options))
	for _, option := range options {
		if option.Kind != "plugin" {
			continue
		}
		semantic := strings.TrimSpace(option.Semantic)
		if semantic == "" {
			semantic = codexNativeComposerPluginSemantic(strings.TrimPrefix(option.ID, "plugin:"))
		}
		if semantic == "" {
			continue
		}
		option.Semantic = semantic
		bySemantic[semantic] = option
	}
	ordered := []string{"sites", "browserUse", "computerUse"}
	result := make([]ComposerCapabilityOption, 0, len(ordered))
	for _, semantic := range ordered {
		if option, ok := bySemantic[semantic]; ok {
			result = append(result, option)
		}
	}
	return result
}

func codexPluginIDFromName(name string, marketplaceName string) string {
	name = strings.TrimSpace(name)
	marketplaceName = strings.TrimSpace(marketplaceName)
	if name == "" {
		return ""
	}
	if strings.Contains(name, "@") || marketplaceName == "" {
		return name
	}
	return name + "@" + marketplaceName
}

func codexPluginCapabilityStatus(plugin map[string]any) string {
	availability := strings.ToUpper(codexTextValue(plugin, "availability"))
	if availability == "DISABLED_BY_ADMIN" {
		return "disabled"
	}
	installPolicy := strings.ToUpper(codexTextValue(plugin, "installPolicy"))
	if installPolicy == "NOT_AVAILABLE" {
		return "setupRequired"
	}
	if installed, ok := codexBoolValue(plugin, "installed"); ok && !installed {
		return "setupRequired"
	}
	if enabled, ok := codexBoolValue(plugin, "enabled"); ok && !enabled {
		return "disabled"
	}
	return "available"
}

func parseCodexMCPCapabilities(raw json.RawMessage) []ComposerCapabilityOption {
	var result struct {
		Data []map[string]any `json:"data"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return nil
	}
	options := make([]ComposerCapabilityOption, 0)
	for _, server := range result.Data {
		name := firstNonEmptyString(codexTextValue(server, "name"), codexTextValue(server, "serverName"))
		if name == "" {
			continue
		}
		status := normalizeCodexMCPStatus(codexTextValue(server, "status"))
		options = append(options, ComposerCapabilityOption{
			ID:         "mcpServer:" + name,
			Kind:       "mcpServer",
			Name:       name,
			Label:      name,
			Status:     status,
			ServerName: name,
			Invocation: "none",
		})
		for _, tool := range codexSliceOfMaps(server["tools"]) {
			toolName := firstNonEmptyString(codexTextValue(tool, "name"), codexTextValue(tool, "toolName"))
			if toolName == "" {
				continue
			}
			options = append(options, ComposerCapabilityOption{
				ID:          "mcpTool:" + name + "/" + toolName,
				Kind:        "mcpTool",
				Name:        toolName,
				Label:       toolName,
				Description: codexTextValue(tool, "description"),
				Status:      status,
				ServerName:  name,
				ToolName:    toolName,
				Invocation:  "none",
			})
		}
	}
	return options
}

func normalizeCodexMCPStatus(status string) string {
	normalized := strings.ToLower(strings.TrimSpace(status))
	switch {
	case strings.Contains(normalized, "auth"):
		return "authRequired"
	case strings.Contains(normalized, "fail"), strings.Contains(normalized, "error"), strings.Contains(normalized, "disabled"):
		return "setupRequired"
	default:
		return "available"
	}
}

func codexPluginSource(plugin map[string]any) string {
	source := codexNestedMap(plugin, "source")
	if source == nil {
		return codexTextValue(plugin, "source")
	}
	return firstNonEmptyString(codexTextValue(source, "type"), codexTextValue(source, "url"), codexTextValue(source, "path"))
}

func codexTextValue(values map[string]any, key string) string {
	if values == nil {
		return ""
	}
	value, ok := values[key]
	if !ok {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	default:
		return ""
	}
}

func codexBoolValue(values map[string]any, key string) (bool, bool) {
	if values == nil {
		return false, false
	}
	value, ok := values[key].(bool)
	return value, ok
}

func codexNestedMap(values map[string]any, key string) map[string]any {
	if values == nil {
		return nil
	}
	value, _ := values[key].(map[string]any)
	return value
}

func codexSliceOfMaps(value any) []map[string]any {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if record, ok := item.(map[string]any); ok {
			result = append(result, record)
		}
	}
	return result
}

func mergeComposerCapabilityOptions(left []ComposerCapabilityOption, right []ComposerCapabilityOption) []ComposerCapabilityOption {
	if len(left) == 0 {
		return dedupeComposerCapabilityOptions(right)
	}
	if len(right) == 0 {
		return dedupeComposerCapabilityOptions(left)
	}
	return dedupeComposerCapabilityOptions(append(append([]ComposerCapabilityOption{}, left...), right...))
}

func dedupeComposerCapabilityOptions(options []ComposerCapabilityOption) []ComposerCapabilityOption {
	if len(options) == 0 {
		return []ComposerCapabilityOption{}
	}
	seen := map[string]struct{}{}
	result := make([]ComposerCapabilityOption, 0, len(options))
	for _, option := range options {
		id := strings.TrimSpace(option.ID)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, option)
	}
	return result
}
