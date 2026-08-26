package runtimeprep

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func prepareClaudePersonalSkillDirectory(runtimeRoot string, personalSkillRoot string) (string, error) {
	personalSkillRoot = filepath.Clean(strings.TrimSpace(personalSkillRoot))
	if personalSkillRoot == "." {
		return "", nil
	}
	if !filepath.IsAbs(personalSkillRoot) || personalSkillRoot == string(filepath.Separator) {
		return "", fmt.Errorf("claude personal skill root must be an absolute non-root path")
	}
	personalInfo, err := os.Lstat(personalSkillRoot)
	if err != nil {
		return "", fmt.Errorf("inspect Claude personal skill root: %w", err)
	}
	if personalInfo.Mode()&os.ModeSymlink != 0 || !personalInfo.IsDir() {
		return "", fmt.Errorf("claude personal skill root must be a real directory: %s", personalSkillRoot)
	}

	additionalDirectory := filepath.Join(runtimeRoot, "claude-personal-skills")
	claudeDirectory := filepath.Join(additionalDirectory, ".claude")
	if err := os.MkdirAll(claudeDirectory, 0o700); err != nil {
		return "", fmt.Errorf("create Claude personal skill projection: %w", err)
	}
	target := filepath.Join(claudeDirectory, "skills")
	if targetInfo, err := os.Stat(target); err == nil {
		if os.SameFile(targetInfo, personalInfo) {
			return additionalDirectory, nil
		}
		return "", fmt.Errorf("claude personal skill projection targets a different directory: %s", target)
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("inspect Claude personal skill projection: %w", err)
	}
	if err := exposeCodexSharedDirectory(personalSkillRoot, target); err != nil {
		return "", fmt.Errorf("expose Claude personal skill root: %w", err)
	}
	return additionalDirectory, nil
}
