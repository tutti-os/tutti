package agent

import (
	"bufio"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const (
	composerSkillSourceProject       = "project"
	composerSkillSourcePersonal      = "personal"
	composerSkillSourcePlugin        = "plugin"
	composerSkillSourceSystem        = "system"
	composerSkillSourceTuttiInjected = "tutti-injected"
)

var hiddenTuttiProviderSkills = map[string]struct{}{
	"tutti-cli":     {},
	"issue-manager": {},
	"workspace-app": {},
}

func discoverComposerSkillOptions(provider string, cwd string, env []string) []ComposerSkillOption {
	roots, triggerFor := composerSkillDiscoveryPlan(provider, cwd, env)
	if triggerFor == nil {
		return nil
	}
	return discoverComposerSkillOptionsFromRoots(roots, triggerFor)
}

func (s *Service) discoverComposerSkillOptions(provider string, cwd string, env []string) []ComposerSkillOption {
	roots, triggerFor := composerSkillDiscoveryPlan(provider, cwd, env)
	if triggerFor == nil {
		return nil
	}
	cache := s.skillOptionsCache
	if cache == nil {
		return discoverComposerSkillOptionsFromRoots(roots, triggerFor)
	}
	key := composerSkillOptionsCacheKey(provider, roots)
	if cached, ok := cache.get(key); ok {
		return cloneComposerSkillOptions(cached)
	}
	options := discoverComposerSkillOptionsFromRoots(roots, triggerFor)
	cache.set(key, options)
	return cloneComposerSkillOptions(options)
}

func (s *Service) discoverComposerSkillOptionsForLaunch(
	ctx context.Context,
	provider string,
	cwd string,
	env []string,
	providerTargetRef map[string]any,
) []ComposerSkillOption {
	if providerTargetRefKind(providerTargetRef) != "agent_extension" {
		return s.discoverComposerSkillOptions(provider, cwd, env)
	}
	resolver := s.ExtensionComposerProfiles
	installationID := strings.TrimSpace(stringFromAny(providerTargetRef["extensionInstallationId"]))
	if resolver == nil || installationID == "" {
		return nil
	}
	profile, err := resolver.ResolveExtensionComposerProfile(ctx, installationID)
	if err != nil || profile.Skills == nil {
		return nil
	}
	roots := extensionComposerSkillRoots(cwd, profile.Skills.Roots)
	triggerFor := extensionSkillTrigger(profile.Skills.TriggerPrefix)
	if triggerFor == nil {
		return nil
	}
	options := discoverComposerSkillOptionsFromRoots(roots, triggerFor)
	for index := range options {
		options[index].Invocation = strings.TrimSpace(profile.Skills.Invocation)
	}
	return options
}

func extensionComposerSkillRoots(cwd string, declarations []ExtensionComposerSkillRoot) []composerSkillRoot {
	roots := make([]composerSkillRoot, 0, len(declarations))
	for _, declaration := range declarations {
		relativePath := filepath.Clean(strings.TrimSpace(declaration.Path))
		if relativePath == "." || filepath.IsAbs(relativePath) || relativePath == ".." || strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) {
			continue
		}
		switch strings.TrimSpace(declaration.Scope) {
		case "workspace":
			roots = append(roots, ancestorDeclaredSkillRoots(cwd, relativePath)...)
		case "user":
			if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
				roots = append(roots, composerSkillRoot{
					path:       filepath.Join(home, relativePath),
					sourceKind: composerSkillSourcePersonal,
				})
			}
		}
	}
	return roots
}

func ancestorDeclaredSkillRoots(cwd string, relativePath string) []composerSkillRoot {
	current := strings.TrimSpace(cwd)
	if current == "" {
		return nil
	}
	current, err := filepath.Abs(current)
	if err != nil {
		return nil
	}
	roots := make([]composerSkillRoot, 0)
	for {
		roots = append(roots, composerSkillRoot{
			path:       filepath.Join(current, relativePath),
			sourceKind: composerSkillSourceProject,
		})
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	return roots
}

func extensionSkillTrigger(prefix string) skillTriggerFunc {
	prefix = strings.TrimSpace(prefix)
	if prefix != "/" && prefix != "$" {
		return nil
	}
	return func(_ composerSkillRoot, name string) string {
		name = strings.TrimSpace(name)
		if name == "" {
			return ""
		}
		return prefix + name
	}
}

func composerSkillDiscoveryPlan(provider string, cwd string, env []string) ([]composerSkillRoot, skillTriggerFunc) {
	profile := composerProfileFor(provider)
	triggerFor := providerComposerSkillTrigger(provider)
	if triggerFor == nil {
		return nil, nil
	}
	switch providerregistry.SkillKind(profile.SkillKind) {
	case providerregistry.SkillKindCodex:
		return codexComposerSkillRoots(cwd, env), triggerFor
	case providerregistry.SkillKindClaudeCode:
		return claudeCodeComposerSkillRoots(cwd, env), triggerFor
	case providerregistry.SkillKindCursor:
		return cursorComposerSkillRoots(cwd, env), triggerFor
	case providerregistry.SkillKindOpenCode:
		return openCodeComposerSkillRoots(cwd, env, profile.SkillConfigDirSuffix), triggerFor
	default:
		return nil, nil
	}
}

func providerComposerSkillTrigger(provider string) skillTriggerFunc {
	if _, ok := providerregistry.Find(provider); !ok {
		return nil
	}
	return func(root composerSkillRoot, name string) string {
		projection, ok := providerregistry.ProjectComposerSkill(provider, name, root.pluginName)
		if !ok {
			return ""
		}
		return projection.Trigger
	}
}

func codexComposerSkillRoots(cwd string, env []string) []composerSkillRoot {
	roots := make([]composerSkillRoot, 0)
	roots = append(roots, ancestorSkillRoots(cwd, ".codex", "skills", composerSkillSourceProject)...)
	if userHome, err := os.UserHomeDir(); err == nil && strings.TrimSpace(userHome) != "" {
		roots = append(roots, composerSkillRoot{
			path:       filepath.Join(userHome, ".agents", "skills"),
			sourceKind: composerSkillSourcePersonal,
		})
		roots = append(roots, composerSkillRoot{
			path:       filepath.Join(userHome, ".codex", "skills"),
			sourceKind: composerSkillSourcePersonal,
		})
	}
	if codexHome := envValue(env, "CODEX_HOME"); codexHome != "" {
		roots = append(roots, composerSkillRoot{
			path:       filepath.Join(codexHome, "skills", ".system"),
			sourceKind: composerSkillSourceSystem,
		})
		roots = append(roots, composerSkillRoot{
			path:       filepath.Join(codexHome, "skills"),
			sourceKind: composerSkillSourceTuttiInjected,
		})
	}
	return roots
}

func claudeCodeComposerSkillRoots(cwd string, env []string) []composerSkillRoot {
	roots := make([]composerSkillRoot, 0)
	roots = append(roots, ancestorSkillRoots(cwd, ".claude", "skills", composerSkillSourceProject)...)
	if userHome, err := os.UserHomeDir(); err == nil && strings.TrimSpace(userHome) != "" {
		roots = append(roots, composerSkillRoot{
			path:       filepath.Join(userHome, ".claude", "skills"),
			sourceKind: composerSkillSourcePersonal,
		})
	}
	if pluginDir := envValue(env, "TUTTI_CLAUDE_PLUGIN_DIR"); pluginDir != "" {
		roots = append(roots, composerSkillRoot{
			path:       filepath.Join(pluginDir, "skills"),
			sourceKind: composerSkillSourcePlugin,
			pluginName: claudePluginName(pluginDir),
		})
	}
	return roots
}

func cursorComposerSkillRoots(cwd string, env []string) []composerSkillRoot {
	roots := make([]composerSkillRoot, 0)
	roots = append(roots, ancestorSkillRoots(cwd, ".cursor", "skills", composerSkillSourceProject)...)
	if userHome, err := os.UserHomeDir(); err == nil && strings.TrimSpace(userHome) != "" {
		roots = append(roots, composerSkillRoot{
			path:       filepath.Join(userHome, ".cursor", "skills"),
			sourceKind: composerSkillSourcePersonal,
		})
	}
	if pluginDir := envValue(env, "TUTTI_CURSOR_PLUGIN_DIR"); pluginDir != "" {
		roots = append(roots, composerSkillRoot{
			path:       filepath.Join(pluginDir, "skills"),
			sourceKind: composerSkillSourcePlugin,
			pluginName: claudePluginName(pluginDir),
		})
	}
	return roots
}

func openCodeComposerSkillRoots(cwd string, env []string, configDirSuffix string) []composerSkillRoot {
	roots := make([]composerSkillRoot, 0)
	roots = append(roots, ancestorSkillRoots(cwd, ".opencode", "skills", composerSkillSourceProject)...)
	roots = append(roots, ancestorSkillRoots(cwd, ".claude", "skills", composerSkillSourceProject)...)
	roots = append(roots, ancestorSkillRoots(cwd, ".agents", "skills", composerSkillSourceProject)...)
	if userHome, err := os.UserHomeDir(); err == nil && strings.TrimSpace(userHome) != "" {
		roots = append(roots, composerSkillRoot{
			path:       filepath.Join(userHome, ".config", "opencode", "skills"),
			sourceKind: composerSkillSourcePersonal,
		})
		roots = append(roots, composerSkillRoot{
			path:       filepath.Join(userHome, ".claude", "skills"),
			sourceKind: composerSkillSourcePersonal,
		})
		roots = append(roots, composerSkillRoot{
			path:       filepath.Join(userHome, ".agents", "skills"),
			sourceKind: composerSkillSourcePersonal,
		})
	}
	if configDir := openCodeConfigDir(env, configDirSuffix); configDir != "" {
		roots = append(roots, composerSkillRoot{
			path:       filepath.Join(configDir, "skills"),
			sourceKind: composerSkillSourcePersonal,
		})
	}
	return roots
}

func openCodeConfigDir(env []string, configDirSuffix string) string {
	configDir := envValue(env, "OPENCODE_CONFIG_DIR")
	if configDir == "" {
		return ""
	}
	configDirSuffix = strings.TrimSpace(configDirSuffix)
	if configDirSuffix != "" && filepath.Base(filepath.Clean(configDir)) != configDirSuffix {
		configDir = filepath.Join(configDir, configDirSuffix)
	}
	return configDir
}

type composerSkillRoot struct {
	path       string
	sourceKind string
	pluginName string
}

type skillTriggerFunc func(composerSkillRoot, string) string

type composerSkillOptionsCache struct {
	mu      sync.Mutex
	entries map[string][]ComposerSkillOption
}

func newComposerSkillOptionsCache() *composerSkillOptionsCache {
	return &composerSkillOptionsCache{
		entries: make(map[string][]ComposerSkillOption),
	}
}

func (c *composerSkillOptionsCache) get(key string) ([]ComposerSkillOption, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	options, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	return cloneComposerSkillOptions(options), true
}

func (c *composerSkillOptionsCache) set(key string, options []ComposerSkillOption) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = cloneComposerSkillOptions(options)
}

func composerSkillOptionsCacheKey(provider string, roots []composerSkillRoot) string {
	var builder strings.Builder
	builder.WriteString(agentprovider.Normalize(provider))
	for _, root := range roots {
		builder.WriteByte('\n')
		builder.WriteString(root.path)
		builder.WriteByte('|')
		builder.WriteString(root.sourceKind)
		builder.WriteByte('|')
		builder.WriteString(root.pluginName)
		writeFileSignature(&builder, root.path)
		entries, err := os.ReadDir(root.path)
		if err != nil {
			builder.WriteString("|missing")
			continue
		}
		for _, entry := range entries {
			name := strings.TrimSpace(entry.Name())
			if name == "" || strings.HasPrefix(name, ".") {
				continue
			}
			sourcePath := filepath.Join(root.path, name)
			sourceInfo, err := os.Stat(sourcePath)
			if err != nil || !sourceInfo.IsDir() {
				continue
			}
			builder.WriteByte('\n')
			builder.WriteString(filepath.Join(sourcePath, "SKILL.md"))
			writeFileSignature(&builder, filepath.Join(sourcePath, "SKILL.md"))
		}
	}
	return builder.String()
}

func writeFileSignature(builder *strings.Builder, path string) {
	info, err := os.Stat(path)
	if err != nil {
		builder.WriteString("|missing")
		return
	}
	builder.WriteByte('|')
	builder.WriteString(strconv.FormatInt(info.Size(), 10))
	builder.WriteByte('|')
	builder.WriteString(strconv.FormatInt(info.ModTime().UnixNano(), 10))
	builder.WriteByte('|')
	if info.IsDir() {
		builder.WriteString("dir")
	} else {
		builder.WriteString("file")
	}
}

func cloneComposerSkillOptions(options []ComposerSkillOption) []ComposerSkillOption {
	if len(options) == 0 {
		return nil
	}
	return append([]ComposerSkillOption(nil), options...)
}

func discoverComposerSkillOptionsFromRoots(
	roots []composerSkillRoot,
	triggerFor skillTriggerFunc,
) []ComposerSkillOption {
	return discoverProviderSkillRoots(roots, triggerFor)
}

func discoverProviderSkillRoots(
	roots []composerSkillRoot,
	triggerFor skillTriggerFunc,
) []ComposerSkillOption {
	options := make([]ComposerSkillOption, 0)
	seen := map[string]struct{}{}
	for _, root := range roots {
		for _, option := range discoverProviderSkillRoot(root, triggerFor) {
			key := option.Trigger
			if key == "" {
				key = option.Name
			}
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			options = append(options, option)
		}
	}
	sort.SliceStable(options, func(left, right int) bool {
		if options[left].SourceKind != options[right].SourceKind {
			return skillSourceRank(options[left].SourceKind) < skillSourceRank(options[right].SourceKind)
		}
		return options[left].Name < options[right].Name
	})
	return options
}

func discoverProviderSkillRoot(
	root composerSkillRoot,
	triggerFor skillTriggerFunc,
) []ComposerSkillOption {
	entries, err := os.ReadDir(root.path)
	if err != nil {
		return nil
	}
	options := make([]ComposerSkillOption, 0, len(entries))
	for _, entry := range entries {
		name := strings.TrimSpace(entry.Name())
		if name == "" {
			continue
		}
		if strings.HasPrefix(name, ".") {
			continue
		}
		sourcePath := filepath.Join(root.path, name)
		sourceInfo, err := os.Stat(sourcePath)
		if err != nil || !sourceInfo.IsDir() {
			continue
		}
		if shouldHideComposerSkill(root, name) {
			continue
		}
		skillPath := filepath.Join(sourcePath, "SKILL.md")
		info, err := os.Stat(skillPath)
		if err != nil || info.IsDir() {
			continue
		}
		metadata, ok, shouldWarn := readSkillMetadataForDiscovery(skillPath)
		if !ok {
			if shouldWarn {
				slog.Warn(
					"composer skill skipped; invalid frontmatter",
					"error_code", "skill_frontmatter_invalid",
					"skillName", name,
					"skillPath", skillPath,
					"sourceKind", root.sourceKind,
					"reason", "missing_delimited_yaml_frontmatter",
				)
			}
			continue
		}
		if metadata.name != "" {
			name = metadata.name
		}
		if shouldHideComposerSkill(root, name) {
			continue
		}
		trigger := strings.TrimSpace(triggerFor(root, name))
		if trigger == "" {
			continue
		}
		options = append(options, ComposerSkillOption{
			Name:        name,
			Trigger:     trigger,
			SourceKind:  root.sourceKind,
			Description: metadata.description,
			PluginName:  root.pluginName,
			Path:        skillPath,
		})
	}
	return options
}

func ancestorSkillRoots(cwd string, parent string, child string, sourceKind string) []composerSkillRoot {
	current := strings.TrimSpace(cwd)
	if current == "" {
		return nil
	}
	abs, err := filepath.Abs(current)
	if err == nil {
		current = abs
	}
	info, err := os.Stat(current)
	if err == nil && !info.IsDir() {
		current = filepath.Dir(current)
	}
	roots := make([]composerSkillRoot, 0)
	for {
		roots = append(roots, composerSkillRoot{
			path:       filepath.Join(current, parent, child),
			sourceKind: sourceKind,
		})
		next := filepath.Dir(current)
		if next == current {
			break
		}
		current = next
	}
	return roots
}

type skillMetadata struct {
	name        string
	description string
}

type skillMetadataCacheEntry struct {
	size          int64
	modTimeUnixNS int64
	metadata      skillMetadata
	ok            bool
	warnedInvalid bool
}

var skillMetadataCache = struct {
	mu      sync.Mutex
	entries map[string]skillMetadataCacheEntry
}{
	entries: make(map[string]skillMetadataCacheEntry),
}

func readSkillMetadataForDiscovery(path string) (skillMetadata, bool, bool) {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return skillMetadata{}, false, false
	}
	size := info.Size()
	modTimeUnixNS := info.ModTime().UnixNano()
	skillMetadataCache.mu.Lock()
	if entry, ok := skillMetadataCache.entries[path]; ok &&
		entry.size == size &&
		entry.modTimeUnixNS == modTimeUnixNS {
		if entry.ok {
			metadata := entry.metadata
			skillMetadataCache.mu.Unlock()
			return metadata, true, false
		}
		if !entry.warnedInvalid {
			entry.warnedInvalid = true
			skillMetadataCache.entries[path] = entry
			skillMetadataCache.mu.Unlock()
			return skillMetadata{}, false, true
		}
		skillMetadataCache.mu.Unlock()
		return skillMetadata{}, false, false
	}
	skillMetadataCache.mu.Unlock()

	metadata, ok := readSkillMetadata(path)
	entry := skillMetadataCacheEntry{
		size:          size,
		modTimeUnixNS: modTimeUnixNS,
		metadata:      metadata,
		ok:            ok,
		warnedInvalid: !ok,
	}
	skillMetadataCache.mu.Lock()
	skillMetadataCache.entries[path] = entry
	skillMetadataCache.mu.Unlock()
	return metadata, ok, !ok
}

func readSkillMetadata(path string) (skillMetadata, bool) {
	file, err := os.Open(path)
	if err != nil {
		return skillMetadata{}, false
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	if !scanner.Scan() || strings.TrimSpace(strings.TrimPrefix(scanner.Text(), "\ufeff")) != "---" {
		return skillMetadata{}, false
	}
	lines := make([]string, 0)
	foundEnd := false
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "---" {
			foundEnd = true
			break
		}
		lines = append(lines, line)
	}
	if err := scanner.Err(); err != nil {
		return skillMetadata{}, false
	}
	if !foundEnd {
		return skillMetadata{}, false
	}

	metadata := skillMetadata{}
	for index := 0; index < len(lines); index++ {
		line := strings.TrimSpace(lines[index])
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		normalizedValue := strings.Trim(strings.TrimSpace(value), `"'`)
		switch strings.TrimSpace(key) {
		case "name":
			metadata.name = normalizedValue
		case "description":
			if isYAMLBlockScalar(normalizedValue) {
				description, nextIndex := readYAMLBlockScalar(lines, index+1, normalizedValue)
				metadata.description = description
				index = nextIndex - 1
			} else {
				metadata.description = normalizedValue
			}
		}
	}
	return metadata, true
}

func isYAMLBlockScalar(value string) bool {
	return strings.HasPrefix(value, ">") || strings.HasPrefix(value, "|")
}

func readYAMLBlockScalar(lines []string, start int, scalar string) (string, int) {
	values := make([]string, 0)
	index := start
	for ; index < len(lines); index++ {
		line := lines[index]
		if strings.TrimSpace(line) == "" {
			continue
		}
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			break
		}
		values = append(values, strings.TrimSpace(line))
	}
	if strings.HasPrefix(scalar, "|") {
		return strings.Join(values, "\n"), index
	}
	return strings.Join(values, " "), index
}

func shouldHideComposerSkill(root composerSkillRoot, name string) bool {
	if root.sourceKind == composerSkillSourceTuttiInjected {
		return true
	}
	if _, ok := hiddenTuttiProviderSkills[strings.TrimSpace(name)]; ok {
		return true
	}
	return false
}

func composerSkillOptionsRuntimeContext(options []ComposerSkillOption) []map[string]any {
	if len(options) == 0 {
		return []map[string]any{}
	}
	result := make([]map[string]any, 0, len(options))
	for _, option := range options {
		value := map[string]any{
			"name":       option.Name,
			"trigger":    option.Trigger,
			"sourceKind": option.SourceKind,
		}
		if option.Description != "" {
			value["description"] = option.Description
		}
		if option.PluginName != "" {
			value["pluginName"] = option.PluginName
		}
		if option.Path != "" {
			value["path"] = option.Path
		}
		if option.Invocation != "" {
			value["invocation"] = option.Invocation
		}
		result = append(result, value)
	}
	return result
}

func composerCapabilityCatalogFromSkills(provider string, skills []ComposerSkillOption) []ComposerCapabilityOption {
	if len(skills) == 0 {
		return []ComposerCapabilityOption{}
	}
	result := make([]ComposerCapabilityOption, 0, len(skills))
	for _, skill := range skills {
		name := strings.TrimSpace(skill.Name)
		trigger := strings.TrimSpace(skill.Trigger)
		if name == "" || trigger == "" {
			continue
		}
		invocation := strings.TrimSpace(skill.Invocation)
		if invocation == "" {
			invocation = strings.TrimSpace(composerProfileFor(provider).SkillInvocation)
		}
		if invocation == "" {
			invocation = "textTrigger"
		}
		result = append(result, ComposerCapabilityOption{
			ID:          "skill:" + name,
			Kind:        "skill",
			Name:        name,
			Label:       name,
			Description: strings.TrimSpace(skill.Description),
			Status:      "available",
			PluginName:  strings.TrimSpace(skill.PluginName),
			Trigger:     trigger,
			Path:        strings.TrimSpace(skill.Path),
			Invocation:  invocation,
		})
	}
	return result
}

func composerCapabilityOptionsRuntimeContext(options []ComposerCapabilityOption) []map[string]any {
	if len(options) == 0 {
		return []map[string]any{}
	}
	result := make([]map[string]any, 0, len(options))
	for _, option := range options {
		value := map[string]any{
			"id":         option.ID,
			"kind":       option.Kind,
			"name":       option.Name,
			"label":      option.Label,
			"status":     option.Status,
			"invocation": option.Invocation,
		}
		for key, text := range map[string]string{
			"description": option.Description,
			"source":      option.Source,
			"pluginName":  option.PluginName,
			"serverName":  option.ServerName,
			"toolName":    option.ToolName,
			"trigger":     option.Trigger,
			"path":        option.Path,
		} {
			if strings.TrimSpace(text) != "" {
				value[key] = strings.TrimSpace(text)
			}
		}
		result = append(result, value)
	}
	return result
}

func skillSourceRank(sourceKind string) int {
	switch sourceKind {
	case composerSkillSourceProject:
		return 0
	case composerSkillSourcePersonal:
		return 1
	case composerSkillSourcePlugin:
		return 2
	case composerSkillSourceSystem:
		return 3
	default:
		return 9
	}
}

func envValue(env []string, key string) string {
	prefix := key + "="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(entry, prefix))
		}
	}
	return ""
}

func claudePluginName(pluginDir string) string {
	pluginDir = strings.TrimSpace(pluginDir)
	if pluginDir == "" {
		return ""
	}
	return strings.TrimSpace(filepath.Base(pluginDir))
}
