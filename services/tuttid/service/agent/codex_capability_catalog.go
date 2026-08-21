package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
)

const codexAppServerCapabilityListTimeout = 8 * time.Second

type appServerCatalogRequestSet string

const (
	appServerCatalogRequestSetCodex      appServerCatalogRequestSet = "codex"
	appServerCatalogRequestSetSkillsOnly appServerCatalogRequestSet = "skills_only"
)

type CodexCLICapabilityLister struct {
	Command          string
	Args             []string
	Timeout          time.Duration
	RequestSet       appServerCatalogRequestSet
	Environ          func() []string
	HomeDir          func() (string, error)
	IsExecutableFile func(string) bool
	LookPath         func(string) (string, error)
}

type defaultComposerCapabilityLister struct{}

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
	lister, ok, err := composerCapabilityCatalogLister(composerProfileFor(provider))
	if err != nil {
		return fallback, []string{err.Error()}
	}
	if !ok {
		return fallback, nil
	}
	options, err := lister.List(ctx, cwd)
	if err != nil {
		return fallback, []string{err.Error()}
	}
	return mergeCodexComposerCapabilityOptions(fallback, options), nil
}

func mergeCodexComposerCapabilityOptions(
	fallback []ComposerCapabilityOption,
	native []ComposerCapabilityOption,
) []ComposerCapabilityOption {
	result := append([]ComposerCapabilityOption(nil), fallback...)
	sameSkillFile := newComposerSkillFileIdentityMatcher()

	for _, option := range native {
		replacedFallback := false
		for index := range result {
			if result[index].Kind == "skill" && option.Kind == "skill" && sameSkillFile(result[index].Path, option.Path) {
				result[index] = option
				replacedFallback = true
				break
			}
		}
		if !replacedFallback {
			result = append(result, option)
		}
	}
	return dedupeComposerCapabilityOptions(result)
}

func newComposerSkillFileIdentityMatcher() func(string, string) bool {
	fileInfoByPath := make(map[string]os.FileInfo)
	missingFileInfo := make(map[string]struct{})
	fileInfo := func(path string) (os.FileInfo, bool) {
		path = strings.TrimSpace(path)
		if path == "" {
			return nil, false
		}
		if info, ok := fileInfoByPath[path]; ok {
			return info, true
		}
		if _, ok := missingFileInfo[path]; ok {
			return nil, false
		}
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			missingFileInfo[path] = struct{}{}
			return nil, false
		}
		fileInfoByPath[path] = info
		return info, true
	}
	return func(leftPath string, rightPath string) bool {
		leftInfo, leftOK := fileInfo(leftPath)
		rightInfo, rightOK := fileInfo(rightPath)
		return leftOK && rightOK && os.SameFile(leftInfo, rightInfo)
	}
}

func composerCapabilityCatalogLister(profile composerProfile) (CodexCLICapabilityLister, bool, error) {
	switch profile.CapabilityCatalogKind {
	case "":
		return CodexCLICapabilityLister{}, false, nil
	case providerregistry.CapabilityCatalogKindCodexAppServer, providerregistry.CapabilityCatalogKindAppServerSkills:
		command := append([]string(nil), profile.CapabilityCatalogCommand...)
		if len(command) == 0 || strings.TrimSpace(command[0]) == "" {
			return CodexCLICapabilityLister{}, false, fmt.Errorf("capability catalog command is required")
		}
		for index, argument := range command[1:] {
			if strings.TrimSpace(argument) == "" {
				return CodexCLICapabilityLister{}, false, fmt.Errorf("capability catalog command argument %d is empty", index+1)
			}
		}
		requestSet := appServerCatalogRequestSetCodex
		if profile.CapabilityCatalogKind == providerregistry.CapabilityCatalogKindAppServerSkills {
			requestSet = appServerCatalogRequestSetSkillsOnly
		}
		return CodexCLICapabilityLister{
			Command:    command[0],
			Args:       command[1:],
			RequestSet: requestSet,
		}, true, nil
	default:
		return CodexCLICapabilityLister{}, false, fmt.Errorf("unsupported capability catalog kind %q", profile.CapabilityCatalogKind)
	}
}

func (l CodexCLICapabilityLister) List(ctx context.Context, cwd string) ([]ComposerCapabilityOption, error) {
	startedAt := time.Now()
	slog.Info("agent capability catalog fetch started",
		"event", "agent.capability_catalog.fetch_start",
		"provider", "codex",
		"request_set", l.RequestSet,
	)
	timeout := l.Timeout
	if timeout <= 0 {
		timeout = codexAppServerCapabilityListTimeout
	}

	command := strings.TrimSpace(l.Command)
	if command == "" {
		return nil, fmt.Errorf("capability catalog command is required")
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
		slog.Info("agent capability catalog fetch settled",
			"event", "agent.capability_catalog.fetch_settled",
			"provider", "codex",
			"request_set", l.RequestSet,
			"durationMs", time.Since(startedAt).Milliseconds(),
			"error", err,
		)
		return nil, err
	}
	slog.Info("agent capability catalog process launch",
		"event", "agent.capability_catalog.process_start",
		"provider", "codex",
		"command", command,
		"args", args,
	)
	requestStartedAt := time.Now()
	if err := writeAppServerCapabilityListRequests(process.stdin, cwd, l.RequestSet); err != nil {
		slog.Info("agent capability catalog request stage settled",
			"event", "agent.capability_catalog.stage_settled",
			"provider", "codex",
			"request_set", l.RequestSet,
			"stage", "request_dispatch",
			"durationMs", time.Since(requestStartedAt).Milliseconds(),
			"error", err,
		)
		processErr := processCtx.Err()
		_ = process.stop(cancel)
		if processErr != nil {
			return nil, fmt.Errorf("codex app-server capability discovery timed out: %w", processErr)
		}
		return nil, err
	}
	slog.Info("agent capability catalog request stage settled",
		"event", "agent.capability_catalog.stage_settled",
		"provider", "codex",
		"request_set", l.RequestSet,
		"stage", "request_dispatch",
		"durationMs", time.Since(requestStartedAt).Milliseconds(),
	)
	responseStartedAt := time.Now()
	options, err := readAppServerCapabilityListResponses(process.stdout, l.RequestSet)
	slog.Info("agent capability catalog response stage settled",
		"event", "agent.capability_catalog.stage_settled",
		"provider", "codex",
		"request_set", l.RequestSet,
		"stage", "capability_response",
		"durationMs", time.Since(responseStartedAt).Milliseconds(),
		"optionCount", len(options),
		"error", err,
	)
	processErr := processCtx.Err()
	_ = process.stop(cancel)
	settled := func(settledErr error) {
		slog.Info("agent capability catalog fetch settled",
			"event", "agent.capability_catalog.fetch_settled",
			"provider", "codex",
			"request_set", l.RequestSet,
			"durationMs", time.Since(startedAt).Milliseconds(),
			"optionCount", len(options),
			"error", settledErr,
		)
	}
	if err == nil {
		settled(nil)
		return options, nil
	}
	if processErr != nil {
		timeoutErr := fmt.Errorf("codex app-server capability discovery timed out: %w", processErr)
		settled(timeoutErr)
		return nil, timeoutErr
	}
	if stderr := strings.TrimSpace(process.stderr.String()); stderr != "" {
		stderrErr := fmt.Errorf("%w: %s", err, stderr)
		settled(stderrErr)
		return nil, stderrErr
	}
	settled(err)
	return nil, err
}

func writeAppServerCapabilityListRequests(
	stdin io.Writer,
	cwd string,
	requestSet appServerCatalogRequestSet,
) error {
	requests, _, err := appServerCatalogRequests(cwd, requestSet)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(stdin)
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
		return fmt.Errorf("write codex app-server initialize: %w", err)
	}
	if err := encoder.Encode(map[string]any{
		"method": "initialized",
		"params": map[string]any{},
	}); err != nil {
		return fmt.Errorf("write codex app-server initialized: %w", err)
	}
	for _, request := range requests {
		if err := encoder.Encode(request); err != nil {
			return fmt.Errorf("write codex app-server %s: %w", request["method"], err)
		}
	}
	return nil
}

func appServerCatalogRequests(
	cwd string,
	requestSet appServerCatalogRequestSet,
) ([]map[string]any, map[string]string, error) {
	if requestSet == "" {
		requestSet = appServerCatalogRequestSetCodex
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
	}
	pending := map[string]string{
		"2": "skills/list",
	}
	switch requestSet {
	case appServerCatalogRequestSetSkillsOnly:
		return requests, pending, nil
	case appServerCatalogRequestSetCodex:
	default:
		return nil, nil, fmt.Errorf("unsupported app-server catalog request set %q", requestSet)
	}
	requests = append(requests,
		map[string]any{
			"id":     "3",
			"method": "app/list",
			"params": map[string]any{
				"limit":        200,
				"forceRefetch": false,
			},
		},
		map[string]any{
			"id":     "4",
			"method": "plugin/list",
			"params": map[string]any{
				"limit": 200,
			},
		},
		map[string]any{
			"id":     "5",
			"method": "mcpServerStatus/list",
			"params": map[string]any{
				"limit":  200,
				"detail": "toolsAndAuthOnly",
			},
		},
	)
	pending["3"] = "app/list"
	pending["4"] = "plugin/list"
	pending["5"] = "mcpServerStatus/list"
	return requests, pending, nil
}

func readAppServerCapabilityListResponses(
	stdout io.Reader,
	requestSet appServerCatalogRequestSet,
) ([]ComposerCapabilityOption, error) {
	_, pendingMethods, err := appServerCatalogRequests("", requestSet)
	if err != nil {
		return nil, err
	}
	pending := make(map[string]struct{}, len(pendingMethods))
	for id := range pendingMethods {
		pending[id] = struct{}{}
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), codexModelListMaxLineBytes)
	options := make([]ComposerCapabilityOption, 0)
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
		if _, ok := pending[id]; !ok {
			continue
		}
		delete(pending, id)
		if rawError, ok := payload["error"]; ok && string(rawError) != "null" {
			if len(pending) == 0 {
				return dedupeComposerCapabilityOptions(options), nil
			}
			continue
		}
		switch id {
		case "2":
			options = append(options, parseCodexSkillCapabilities(payload["result"])...)
		case "3":
			options = append(options, parseCodexAppCapabilities(payload["result"])...)
		case "4":
			options = append(options, parseCodexPluginCapabilities(payload["result"])...)
		case "5":
			options = append(options, parseCodexMCPCapabilities(payload["result"])...)
		}
		if len(pending) == 0 {
			return dedupeComposerCapabilityOptions(options), nil
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read codex app-server stdout: %w", err)
	}
	if len(options) > 0 {
		return dedupeComposerCapabilityOptions(options), nil
	}
	return nil, fmt.Errorf("codex app-server exited before capability responses")
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

func parseCodexPluginCapabilities(raw json.RawMessage) []ComposerCapabilityOption {
	var result struct {
		Data []map[string]any `json:"data"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return nil
	}
	options := make([]ComposerCapabilityOption, 0, len(result.Data))
	for _, plugin := range result.Data {
		name := firstNonEmptyString(codexTextValue(plugin, "name"), codexTextValue(plugin, "id"), codexTextValue(plugin, "pluginName"))
		if name == "" {
			continue
		}
		label := firstNonEmptyString(codexTextValue(plugin, "displayName"), codexTextValue(plugin, "title"), name)
		options = append(options, ComposerCapabilityOption{
			ID:          "plugin:" + name,
			Kind:        "plugin",
			Name:        name,
			Label:       label,
			Description: codexTextValue(plugin, "description"),
			Status:      "available",
			Source:      codexPluginSource(plugin),
			PluginName:  name,
			Invocation:  "none",
		})
	}
	return options
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
