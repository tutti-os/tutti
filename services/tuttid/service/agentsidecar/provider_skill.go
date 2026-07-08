package agentsidecar

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const tuttiSkillName = "tutti-cli"
const issueManagerSkillName = "issue-manager"
const workspaceAppSkillName = "workspace-app"
const referenceSkillName = "reference"
const browserUseSkillName = "browser-use"
const computerUseSkillName = "computer-use"
const commandGuideReferencePath = "command-guide.md"

//go:embed skill_templates/*.md policy_templates/*.md
var providerSkillTemplates embed.FS

type providerSkillSpec struct {
	baseName string
	files    map[string]string
}

func tuttiCLISkill(input PrepareInput) string {
	return renderProviderSkillTemplate(
		"skill_templates/tutti-cli.md",
		map[string]string{
			"{{COMMAND_SUMMARY}}":  commandGuideSummary(input),
			"{{CLI_COMMAND}}":      normalizeCLICommandName(input.CLICommand),
			"{{AGENT_TARGET_ID}}":  strings.TrimSpace(input.AgentTargetID),
			"{{AGENT_PROVIDER}}":   strings.TrimSpace(input.Provider),
			"{{AGENT_SESSION_ID}}": strings.TrimSpace(input.AgentSessionID),
		},
	)
}

func issueManagerSkill(input PrepareInput) string {
	return renderProviderSkillTemplate(
		"skill_templates/issue-manager.md",
		map[string]string{
			"{{AGENT_TARGET_ID}}":  strings.TrimSpace(input.AgentTargetID),
			"{{AGENT_PROVIDER}}":   strings.TrimSpace(input.Provider),
			"{{AGENT_SESSION_ID}}": strings.TrimSpace(input.AgentSessionID),
		},
	)
}

func workspaceAppSkill(input PrepareInput) string {
	return renderProviderSkillTemplate(
		"skill_templates/workspace-app.md",
		map[string]string{
			"{{CLI_COMMAND}}": normalizeCLICommandName(input.CLICommand),
		},
	)
}

func referenceSkill(input PrepareInput) string {
	return renderProviderSkillTemplate(
		"skill_templates/reference.md",
		map[string]string{
			"{{CLI_COMMAND}}": normalizeCLICommandName(input.CLICommand),
		},
	)
}

func browserUseSkill(input PrepareInput) string {
	return renderProviderSkillTemplate(
		"skill_templates/browser-use.md",
		map[string]string{
			"{{CLI_COMMAND}}": normalizeCLICommandName(input.CLICommand),
		},
	)
}

func computerUseSkill(input PrepareInput) string {
	return renderProviderSkillTemplate(
		"skill_templates/computer-use.md",
		map[string]string{
			"{{CLI_COMMAND}}": normalizeCLICommandName(input.CLICommand),
		},
	)
}

func renderProviderSkillTemplate(path string, replacements map[string]string) string {
	content, err := providerSkillTemplates.ReadFile(path)
	if err != nil {
		panic(fmt.Sprintf("read provider skill template %s: %v", path, err))
	}
	rendered := string(content)
	if len(replacements) == 0 {
		return rendered
	}
	parts := make([]string, 0, len(replacements)*2)
	for placeholder, value := range replacements {
		parts = append(parts, placeholder, value)
	}
	return strings.NewReplacer(parts...).Replace(rendered)
}

func providerSkills(input PrepareInput) []providerSkillSpec {
	skills := []providerSkillSpec{
		{
			baseName: tuttiSkillName,
			files: map[string]string{
				"SKILL.md":                tuttiCLISkill(input),
				commandGuideReferencePath: commandGuideReference(input),
			},
		},
		{
			baseName: issueManagerSkillName,
			files:    map[string]string{"SKILL.md": issueManagerSkill(input)},
		},
		{
			baseName: workspaceAppSkillName,
			files:    map[string]string{"SKILL.md": workspaceAppSkill(input)},
		},
		{
			baseName: referenceSkillName,
			files:    map[string]string{"SKILL.md": referenceSkill(input)},
		},
	}
	// Browser use is a daemon-owned `tutti browser` CLI; inject its skill only
	// when enabled for this session (capability gate).
	if input.BrowserUse && BrowserUseDefaultEnabled() {
		skills = append(skills, providerSkillSpec{
			baseName: browserUseSkillName,
			files:    map[string]string{"SKILL.md": browserUseSkill(input)},
		})
	}
	// Computer use is a daemon-owned `tutti computer` CLI; inject its skill only
	// when enabled and locally runnable for this session (capability gate).
	if input.ComputerUse && ComputerUseAvailable() {
		skills = append(skills, providerSkillSpec{
			baseName: computerUseSkillName,
			files:    map[string]string{"SKILL.md": computerUseSkill(input)},
		})
	}
	for _, extra := range input.ExtraSkills {
		skills = append(skills, providerSkillSpec{
			baseName: extra.Name,
			files:    copySkillBundleFiles(extra.Files),
		})
	}
	return skills
}

func installProviderNativeSkills(root string, input PrepareInput) ([]string, error) {
	return installProviderNativeSkillSpecs(root, providerSkills(input))
}

func renderProviderSkillBundle(input PrepareInput) SkillBundle {
	skills := providerSkills(input)
	records := make([]SkillMaterializationRecord, 0, len(skills))
	for _, skill := range skills {
		records = append(records, providerSkillSpecRecord(skill))
	}
	return SkillBundle{
		SchemaVersion:           1,
		Provider:                strings.TrimSpace(input.Provider),
		AgentSessionID:          strings.TrimSpace(input.AgentSessionID),
		CLICommand:              normalizeCLICommandName(input.CLICommand),
		RecommendedSystemPrompt: recommendedSystemPrompt(input),
		Skills:                  records,
	}
}

func recommendedSystemPrompt(input PrepareInput) *RecommendedSystemPrompt {
	content := strings.TrimSpace(tuttiSkillBundleRecommendedPolicy(input))
	if content == "" {
		return nil
	}
	return &RecommendedSystemPrompt{
		Format:  "text/markdown",
		Content: content,
	}
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
	return SkillMaterializationRecord{
		Content:      spec.files["SKILL.md"],
		Files:        files,
		SkillID:      "tutti/" + spec.baseName,
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
	case "gemini":
		return filepath.Join(cwd, ".gemini", "skills")
	case "openclaw":
		return filepath.Join(cwd, ".openclaw", "skills")
	case "nexight":
		return filepath.Join(cwd, ".nexight", "skills")
	case "hermes":
		return filepath.Join(cwd, ".agent_context", "skills")
	default:
		return ""
	}
}
