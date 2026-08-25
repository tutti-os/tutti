package runtimeprep

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

func exposeUserCodexSkillFolders(targetRoot, providerStateHome string, input PrepareInput) error {
	if strings.TrimSpace(providerStateHome) == "" {
		return nil
	}
	sourceRoot := filepath.Join(providerStateHome, "skills")
	entries, err := os.ReadDir(sourceRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read user codex skills: %w", err)
	}
	if err := os.MkdirAll(targetRoot, 0o755); err != nil {
		return fmt.Errorf("create codex skills directory: %w", err)
	}
	for _, entry := range entries {
		name := strings.TrimSpace(entry.Name())
		if name == "" || strings.HasPrefix(name, ".") {
			continue
		}
		if shouldSkipUserCodexSkillForTuttiBrowserUse(name, input) {
			continue
		}
		source := filepath.Join(sourceRoot, name)
		sourceInfo, err := os.Stat(source)
		if err != nil || !sourceInfo.IsDir() {
			continue
		}
		skillPath := filepath.Join(source, "SKILL.md")
		skillInfo, err := os.Stat(skillPath)
		if err != nil || skillInfo.IsDir() {
			continue
		}
		if !hasDelimitedSkillFrontmatter(skillPath) {
			slog.Warn(
				"user codex skill skipped; invalid frontmatter",
				"error_code", "skill_frontmatter_invalid",
				"skillName", name,
				"skillPath", skillPath,
				"reason", "missing_delimited_yaml_frontmatter",
			)
			continue
		}
		target := filepath.Join(targetRoot, name)
		if _, err := os.Lstat(target); err == nil {
			continue
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("inspect codex skill %s: %w", name, err)
		}
		if err := exposeCodexDirectory(source, target); err != nil {
			return fmt.Errorf("expose codex skill %s: %w", name, err)
		}
	}
	return nil
}

func hasDelimitedSkillFrontmatter(path string) bool {
	content, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	lines := strings.Split(string(content), "\n")
	if len(lines) == 0 || strings.TrimSpace(strings.TrimPrefix(lines[0], "\ufeff")) != "---" {
		return false
	}
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "---" {
			return true
		}
	}
	return false
}

func shouldSkipUserCodexSkillForTuttiBrowserUse(name string, input PrepareInput) bool {
	if !input.BrowserUse || !BrowserUseDefaultEnabled() {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(name), "browser")
}

func distinctCodexProviderSkillRoot(providerStateHome string, personalSkillRoot string) (string, error) {
	providerStateHome = strings.TrimSpace(providerStateHome)
	if providerStateHome == "" {
		return "", nil
	}
	providerSkillRoot := filepath.Join(providerStateHome, "skills")
	providerInfo, err := os.Stat(providerSkillRoot)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("inspect Codex provider skill root: %w", err)
	}
	if !providerInfo.IsDir() {
		return "", fmt.Errorf("codex provider skill root is not a directory: %s", providerSkillRoot)
	}
	personalInfo, err := os.Stat(filepath.Clean(strings.TrimSpace(personalSkillRoot)))
	if err == nil && os.SameFile(providerInfo, personalInfo) {
		return "", nil
	}
	if err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("inspect Codex personal skill root: %w", err)
	}
	return providerSkillRoot, nil
}
