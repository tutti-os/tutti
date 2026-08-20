package runtimeprep

import (
	"bytes"
	"embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/template"
	"unicode"
	"unicode/utf8"
)

const tuttiSkillName = "tutti-cli"
const issueManagerSkillName = "issue-manager"
const workspaceAppSkillName = "workspace-app"
const referenceSkillName = "reference"
const browserUseSkillName = "browser-use"
const computerUseSkillName = "computer-use"
const tuttiHandoffSkillName = "tutti-handoff"
const commandGuideReferencePath = "command-guide.md"
const tuttiModelAllocationSkillName = "tutti-model-allocation"
const tuttiModelAllocationReferencePath = "references/model-tiers.md"
const connectorRoutingIndexMaxRunes = 640

//go:embed skill_templates/*.md policy_templates/*.md
var providerSkillTemplates embed.FS

type providerSkillSpec struct {
	baseName string
	files    map[string]string
	skillID  string
}

func tuttiCLISkill(input PrepareInput) (string, error) {
	return renderProviderSkillTemplate("skill_templates/tutti-cli.md", input, nil)
}

func tuttiHandoffSkill(input PrepareInput) (string, error) {
	return renderProviderSkillTemplate("skill_templates/tutti-handoff.md", input, nil)
}

func tuttiModelAllocationSkill(input PrepareInput) (string, error) {
	return renderProviderSkillTemplate("skill_templates/tutti-model-allocation.md", input, nil)
}

func tuttiModelAllocationReference(input PrepareInput) (string, error) {
	return renderProviderSkillTemplate("skill_templates/tutti-model-allocation-model-tiers.md", input, nil)
}

func issueManagerSkill(input PrepareInput) (string, error) {
	return renderProviderSkillTemplate("skill_templates/issue-manager.md", input, nil)
}

func workspaceAppSkill(input PrepareInput) (string, error) {
	return renderProviderSkillTemplate("skill_templates/workspace-app.md", input, nil)
}

func referenceSkill(input PrepareInput) (string, error) {
	return renderProviderSkillTemplate("skill_templates/reference.md", input, nil)
}

func browserUseSkill(input PrepareInput) (string, error) {
	return renderProviderSkillTemplate("skill_templates/browser-use.md", input, nil)
}

func computerUseSkill(input PrepareInput) (string, error) {
	return renderProviderSkillTemplate("skill_templates/computer-use.md", input, nil)
}

type runtimeTemplateData struct {
	PrepareInput
	HostFacts              HostFacts
	CommandFamilies        []string
	OutputModes            []string
	ProfileIntro           string
	ProfileTitle           string
	ConnectorRoutingIndex  string
	EnabledConnectorsIndex string
}

func renderProviderSkillTemplate(path string, input PrepareInput, replacements map[string]string) (string, error) {
	content, err := providerSkillTemplates.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read provider skill template %s: %w", path, err)
	}
	return renderRuntimeTemplate(path, string(content), input, replacements)
}

func renderPolicyTemplate(path string, input PrepareInput) (string, error) {
	rendered, err := renderProviderSkillTemplate(path, input, nil)
	return strings.TrimSpace(rendered), err
}

func renderRuntimeTemplate(name string, content string, input PrepareInput, replacements map[string]string) (string, error) {
	funcs := template.FuncMap{
		"args":        commandTemplateArguments,
		"command":     templateCommand(input),
		"has":         templateHas(input),
		"hasAll":      templateHasAll(input),
		"hasFamily":   templateHasFamily(input),
		"hasInput":    templateHasInput(input),
		"inputValues": templateInputValues(input),
		"path":        templateCommandPath(input),
	}
	for placeholder, replacement := range replacements {
		name := strings.TrimSuffix(strings.TrimPrefix(placeholder, "{{"), "}}")
		value := replacement
		funcs[name] = func() string { return value }
	}
	parsed, err := template.New(name).Option("missingkey=error").Funcs(funcs).Parse(content)
	if err != nil {
		return "", fmt.Errorf("parse runtime template %s: %w", name, err)
	}
	resolver := input.commandCapabilities
	data := runtimeTemplateData{
		PrepareInput:           input,
		HostFacts:              resolvedHostFacts(input),
		ProfileIntro:           resolvedProfileIntro(input),
		ProfileTitle:           resolvedProfileTitle(input),
		ConnectorRoutingIndex:  connectorRoutingIndex(input.ConnectorRoutingHints),
		EnabledConnectorsIndex: enabledConnectorsIndex(input.EnabledConnectors),
	}
	data.CLICommand = normalizeCLICommandName(input.CLICommand)
	if resolver != nil {
		data.CommandFamilies = resolver.Families()
		data.OutputModes = resolver.OutputModes()
	}
	var rendered bytes.Buffer
	if err := parsed.Execute(&rendered, data); err != nil {
		return "", fmt.Errorf("render runtime template %s: %w", name, err)
	}
	return rendered.String(), nil
}

// ConnectorRoutingIndex renders the bounded connector alias index. Session
// preparation templates and turn-level routing updates share this projection
// so both surfaces stay byte-identical for the same routing hints.
func ConnectorRoutingIndex(hints []ConnectorRoutingHint) string {
	return connectorRoutingIndex(hints)
}

func enabledConnectorsIndex(keys []string) string {
	if len(keys) == 0 {
		return "none"
	}
	unique := make([]string, 0, len(keys))
	seen := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, key)
	}
	if len(unique) == 0 {
		return "none"
	}
	sort.Strings(unique)
	return strings.Join(unique, ", ")
}

func connectorRoutingIndex(hints []ConnectorRoutingHint) string {
	if len(hints) == 0 {
		return ""
	}
	ordered := append([]ConnectorRoutingHint(nil), hints...)
	sort.SliceStable(ordered, func(left, right int) bool {
		return strings.TrimSpace(ordered[left].ConnectorKey) < strings.TrimSpace(ordered[right].ConnectorKey)
	})
	segments := make([]string, 0, len(ordered))
	seenConnectors := make(map[string]struct{}, len(ordered))
	for _, hint := range ordered {
		key := strings.TrimSpace(hint.ConnectorKey)
		if key == "" || !safeConnectorRoutingPromptValue(key) {
			continue
		}
		if _, duplicate := seenConnectors[key]; duplicate {
			continue
		}
		seenConnectors[key] = struct{}{}
		seen := map[string]struct{}{strings.ToLower(key): {}}
		values := make([]string, 0, len(hint.Aliases)+1)
		for _, value := range append([]string{hint.DisplayName}, hint.Aliases...) {
			value = strings.TrimSpace(value)
			folded := strings.ToLower(value)
			if value == "" || !safeConnectorRoutingPromptValue(value) {
				continue
			}
			if _, duplicate := seen[folded]; duplicate {
				continue
			}
			seen[folded] = struct{}{}
			values = append(values, value)
		}
		candidate := strings.Join(append(append([]string(nil), segments...), key), ";")
		if utf8.RuneCountInString(candidate) > connectorRoutingIndexMaxRunes {
			break
		}
		segments = append(segments, key)
		accepted := make([]string, 0, len(values))
		for _, value := range values {
			candidateValues := append(append([]string(nil), accepted...), value)
			candidateSegment := key + "=" + strings.Join(candidateValues, "|")
			candidate = strings.Join(append(append([]string(nil), segments[:len(segments)-1]...), candidateSegment), ";")
			if utf8.RuneCountInString(candidate) > connectorRoutingIndexMaxRunes {
				break
			}
			accepted = candidateValues
			segments[len(segments)-1] = candidateSegment
		}
	}
	if len(segments) == 0 {
		return ""
	}
	return strings.Join(segments, ";")
}

func safeConnectorRoutingPromptValue(value string) bool {
	if len([]rune(value)) > 128 {
		return false
	}
	for _, character := range value {
		if unicode.IsLetter(character) || unicode.IsNumber(character) || unicode.IsMark(character) || character == ' ' ||
			strings.ContainsRune("-_.+&/()", character) {
			continue
		}
		return false
	}
	return true
}

func templateCommand(input PrepareInput) func(string, ...commandArguments) (string, error) {
	return func(id string, args ...commandArguments) (string, error) {
		if input.commandCapabilities == nil {
			return "", fmt.Errorf("agent command %q cannot be rendered without a command snapshot", id)
		}
		return input.commandCapabilities.Command(id, args...)
	}
}

func templateCommandPath(input PrepareInput) func(string) (string, error) {
	return func(id string) (string, error) {
		if input.commandCapabilities == nil {
			return "", fmt.Errorf("agent command %q cannot be rendered without a command snapshot", id)
		}
		return input.commandCapabilities.Path(id)
	}
}

func templateHas(input PrepareInput) func(string) bool {
	return func(id string) bool {
		return input.commandCapabilities != nil && input.commandCapabilities.Has(id)
	}
}

func templateHasAll(input PrepareInput) func(...string) bool {
	return func(ids ...string) bool {
		return input.commandCapabilities != nil && input.commandCapabilities.HasAll(ids...)
	}
}

func templateHasFamily(input PrepareInput) func(string) bool {
	return func(family string) bool {
		return input.commandCapabilities != nil && input.commandCapabilities.HasFamily(family)
	}
}

func templateHasInput(input PrepareInput) func(string, string) bool {
	return func(id string, name string) bool {
		return input.commandCapabilities != nil && input.commandCapabilities.HasInput(id, name)
	}
}

func templateInputValues(input PrepareInput) func(string, string) []string {
	return func(id string, name string) []string {
		if input.commandCapabilities == nil {
			return nil
		}
		return input.commandCapabilities.InputValues(id, name)
	}
}

func providerSkills(input PrepareInput) ([]providerSkillSpec, error) {
	if input.SkipSkills {
		return nil, nil
	}
	if input.resolved == nil {
		return nil, errors.New("provider skills require resolved runtime capabilities")
	}
	skills := make([]providerSkillSpec, 0, len(input.resolved.Skills))
	for _, skill := range input.resolved.Skills {
		if !skillSupportsProvider(skill, input.Provider) {
			continue
		}
		id := strings.TrimSpace(skill.ID)
		if id == "" {
			id = "tutti/" + strings.TrimSpace(skill.Name)
		}
		skills = append(skills, providerSkillSpec{
			baseName: strings.TrimSpace(skill.Name),
			files:    copySkillBundleFiles(skill.Files),
			skillID:  id,
		})
	}
	return skills, nil
}

func installProviderNativeSkills(root string, input PrepareInput) ([]string, error) {
	skills, err := providerSkills(input)
	if err != nil {
		return nil, err
	}
	return installProviderNativeSkillSpecs(root, skills)
}

func installProviderNativeSkillsStable(root string, input PrepareInput) ([]string, error) {
	skills, err := providerSkills(input)
	if err != nil {
		return nil, err
	}
	return installProviderNativeSkillSpecsStable(root, skills)
}

func installProviderNativeSkillsSessionScoped(root string, input PrepareInput) ([]string, error) {
	return installProviderNativeSkillsSessionScopedWithReservedRoots(root, nil, input)
}

func installProviderNativeSkillsSessionScopedWithReservedRoots(
	root string,
	reservedRoots []string,
	input PrepareInput,
) ([]string, error) {
	if input.SkipSkills {
		return nil, nil
	}
	skills, err := providerSkills(input)
	if err != nil {
		return nil, err
	}
	skillPaths, err := installProviderNativeSkillSpecsStableWithReservedRoots(root, reservedRoots, skills)
	if err != nil {
		return nil, err
	}
	if err := removeStaleManagedProviderSkills(root, skillPaths); err != nil {
		return nil, err
	}
	return skillPaths, nil
}

func renderProviderPromptContext(policy string, skillPaths []string) string {
	sections := make([]string, 0, 2)
	if policy = strings.TrimSpace(policy); policy != "" {
		sections = append(sections, policy)
	}
	var catalog strings.Builder
	for _, skillPath := range skillPaths {
		skillPath = filepath.Clean(strings.TrimSpace(skillPath))
		if skillPath == "." || skillPath == "" {
			continue
		}
		if catalog.Len() == 0 {
			catalog.WriteString("## Available Skills\n\n")
			catalog.WriteString("These session-injected Skills are available now. Their exact names and materialized files are authoritative:\n\n")
		}
		fmt.Fprintf(&catalog, "- `$%s`: `%s`\n", filepath.Base(skillPath), filepath.Join(skillPath, "SKILL.md"))
	}
	if catalog.Len() > 0 {
		sections = append(sections, strings.TrimSpace(catalog.String()))
	}
	return strings.Join(sections, "\n\n")
}

func renderProviderSkillBundle(input PrepareInput) (SkillBundle, error) {
	skills, err := providerSkills(input)
	if err != nil {
		return SkillBundle{}, err
	}
	records := make([]SkillMaterializationRecord, 0, len(skills))
	for _, skill := range skills {
		records = append(records, providerSkillSpecRecord(skill))
	}
	prompt, err := recommendedSystemPrompt(input)
	if err != nil {
		return SkillBundle{}, err
	}
	return SkillBundle{
		SchemaVersion:           2,
		AgentTargetID:           strings.TrimSpace(input.AgentTargetID),
		Provider:                strings.TrimSpace(input.Provider),
		AgentSessionID:          strings.TrimSpace(input.AgentSessionID),
		CLICommand:              normalizeCLICommandName(input.CLICommand),
		RecommendedSystemPrompt: prompt,
		Skills:                  records,
	}, nil
}

func recommendedSystemPrompt(input PrepareInput) (*RecommendedSystemPrompt, error) {
	rendered, err := tuttiSkillBundleRecommendedPolicy(input)
	if err != nil {
		return nil, err
	}
	content := strings.TrimSpace(rendered)
	if content == "" {
		return nil, nil
	}
	return &RecommendedSystemPrompt{
		Format:  "text/markdown",
		Content: content,
	}, nil
}

func providerSkillSpecRecord(spec providerSkillSpec) SkillMaterializationRecord {
	files := make([]SkillMaterializationFile, 0, len(spec.files))
	paths := make([]string, 0, len(spec.files))
	for path := range spec.files {
		if path == "SKILL.md" {
			continue
		}
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		files = append(files, SkillMaterializationFile{
			Content: spec.files[path],
			Path:    path,
		})
	}
	skillID := strings.TrimSpace(spec.skillID)
	if skillID == "" {
		skillID = "tutti/" + spec.baseName
	}
	return SkillMaterializationRecord{
		Content:      spec.files["SKILL.md"],
		Files:        files,
		SkillID:      skillID,
		Slug:         spec.baseName,
		DeliveryMode: "materialized-files",
	}
}

func installProviderNativeSkillSpecs(root string, skills []providerSkillSpec) ([]string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, fmt.Errorf("provider skill root is required")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("create provider skill root: %w", err)
	}
	skillPaths := make([]string, 0, len(skills))
	for _, spec := range skills {
		skillName, err := allocateSkillName(root, spec.baseName)
		if err != nil {
			return nil, err
		}
		skillPath := filepath.Join(root, skillName)
		if err := installProviderSkillFiles(skillPath, spec); err != nil {
			return nil, err
		}
		skillPaths = append(skillPaths, skillPath)
	}
	return skillPaths, nil
}

func installProviderNativeSkillSpecsStable(root string, skills []providerSkillSpec) ([]string, error) {
	return installProviderNativeSkillSpecsStableWithReservedRoots(root, nil, skills)
}

func installProviderNativeSkillSpecsStableWithReservedRoots(
	root string,
	reservedRoots []string,
	skills []providerSkillSpec,
) ([]string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, fmt.Errorf("provider skill root is required")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("create provider skill root: %w", err)
	}
	skillPaths := make([]string, 0, len(skills))
	for _, spec := range skills {
		skillName, err := stableManagedSkillName(root, reservedRoots, spec.baseName)
		if err != nil {
			return nil, err
		}
		skillPath := filepath.Join(root, skillName)
		if err := os.RemoveAll(skillPath); err != nil {
			return nil, fmt.Errorf("replace tutti provider skill: %w", err)
		}
		if err := installProviderSkillFiles(skillPath, spec); err != nil {
			return nil, err
		}
		skillPaths = append(skillPaths, skillPath)
	}
	return skillPaths, nil
}

func removeStaleManagedProviderSkills(root string, currentPaths []string) error {
	keep := make(map[string]struct{}, len(currentPaths))
	for _, skillPath := range currentPaths {
		keep[filepath.Clean(skillPath)] = struct{}{}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("read session provider skill root: %w", err)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(root, entry.Name())
		if _, current := keep[filepath.Clean(path)]; current || !providerSkillDirectoryLooksManaged(path) {
			continue
		}
		if err := os.RemoveAll(path); err != nil {
			return fmt.Errorf("remove stale tutti provider skill: %w", err)
		}
	}
	return nil
}

func stableManagedSkillName(root string, reservedRoots []string, baseName string) (string, error) {
	baseName = strings.TrimSpace(baseName)
	if baseName == "" {
		return "", fmt.Errorf("provider skill name is required")
	}
	candidates := []string{baseName, baseName + "-tutti"}
	for index := 2; index <= 99; index++ {
		candidates = append(candidates, fmt.Sprintf("%s-tutti-%d", baseName, index))
	}
	for _, candidate := range candidates {
		reserved := false
		for _, reservedRoot := range reservedRoots {
			if _, err := os.Stat(filepath.Join(reservedRoot, candidate)); err == nil {
				reserved = true
				break
			} else if !os.IsNotExist(err) {
				return "", fmt.Errorf("inspect reserved provider skill directory: %w", err)
			}
		}
		if reserved {
			continue
		}
		path := filepath.Join(root, candidate)
		info, err := os.Stat(path)
		if err == nil {
			if info.IsDir() && providerSkillDirectoryLooksManaged(path) {
				return candidate, nil
			}
			continue
		}
		if !os.IsNotExist(err) {
			return "", fmt.Errorf("inspect provider skill directory: %w", err)
		}
		return candidate, nil
	}
	return "", fmt.Errorf("allocate stable provider skill directory: exhausted names for %s", baseName)
}

func providerSkillDirectoryLooksManaged(path string) bool {
	if _, err := os.Stat(filepath.Join(path, ".tutti-managed-skill")); err == nil {
		return true
	}
	return false
}

func copySkillBundleFiles(files map[string]string) map[string]string {
	if len(files) == 0 {
		return nil
	}
	copy := make(map[string]string, len(files))
	for path, content := range files {
		copy[path] = content
	}
	return copy
}

func installProviderSkillFiles(skillPath string, spec providerSkillSpec) error {
	if err := os.MkdirAll(skillPath, 0o755); err != nil {
		return fmt.Errorf("create tutti provider skill directory: %w", err)
	}
	if _, ok := spec.files["SKILL.md"]; !ok {
		return fmt.Errorf("provider skill %s missing SKILL.md", spec.baseName)
	}
	for relativePath, content := range spec.files {
		cleanPath, err := cleanProviderSkillFilePath(relativePath)
		if err != nil {
			return err
		}
		targetPath := filepath.Join(skillPath, filepath.FromSlash(cleanPath))
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return fmt.Errorf("create tutti provider skill file directory: %w", err)
		}
		if err := os.WriteFile(targetPath, []byte(content), 0o644); err != nil {
			return fmt.Errorf("write tutti provider skill: %w", err)
		}
	}
	if err := os.WriteFile(filepath.Join(skillPath, ".tutti-managed-skill"), []byte(spec.skillID+"\n"), 0o644); err != nil {
		return fmt.Errorf("write tutti provider skill marker: %w", err)
	}
	return nil
}

func cleanProviderSkillFilePath(path string) (string, error) {
	trimmed := strings.TrimSpace(filepath.ToSlash(path))
	if trimmed == "" || strings.HasPrefix(trimmed, "/") {
		return "", fmt.Errorf("provider skill file path is invalid: %q", path)
	}
	cleaned := filepath.ToSlash(filepath.Clean(trimmed))
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("provider skill file path escapes skill directory: %q", path)
	}
	return cleaned, nil
}

func allocateSkillName(root string, baseName string) (string, error) {
	baseName = strings.TrimSpace(baseName)
	if baseName == "" {
		return "", fmt.Errorf("provider skill name is required")
	}
	candidates := []string{baseName, baseName + "-tutti"}
	for index := 2; index <= 99; index++ {
		candidates = append(candidates, fmt.Sprintf("%s-tutti-%d", baseName, index))
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(filepath.Join(root, candidate)); err == nil {
			continue
		} else if !os.IsNotExist(err) {
			return "", fmt.Errorf("inspect provider skill directory: %w", err)
		}
		return candidate, nil
	}
	return "", fmt.Errorf("allocate provider skill directory: exhausted names for %s", baseName)
}

func providerSkillRoot(cwd string, provider string) string {
	switch strings.TrimSpace(provider) {
	case "openclaw", "open-claw":
		return filepath.Join(cwd, ".openclaw", "skills")
	case "nexight", "tutti":
		return filepath.Join(cwd, ".nexight", "skills")
	case "hermes", "hermes-agent":
		return filepath.Join(cwd, ".agent_context", "skills")
	default:
		return ""
	}
}
