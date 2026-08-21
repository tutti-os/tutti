package runtimeprep

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func exposePersonalCodexSkillRoot(targetRoot string, personalRoot string, sessionRoot string) error {
	personalRoot = filepath.Clean(strings.TrimSpace(personalRoot))
	if personalRoot == "." || !filepath.IsAbs(personalRoot) {
		return fmt.Errorf("codex personal skill root must be absolute")
	}
	if err := os.MkdirAll(personalRoot, 0o700); err != nil {
		return fmt.Errorf("create Codex personal skill root: %w", err)
	}
	if targetInfo, err := os.Stat(targetRoot); err == nil {
		personalInfo, personalErr := os.Stat(personalRoot)
		if personalErr == nil && os.SameFile(targetInfo, personalInfo) {
			return nil
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect Codex session skill root: %w", err)
	}
	if _, err := os.Lstat(targetRoot); err == nil {
		if _, sessionErr := os.Lstat(sessionRoot); sessionErr == nil {
			return fmt.Errorf("codex session and personal skill roots both already exist")
		} else if !os.IsNotExist(sessionErr) {
			return fmt.Errorf("inspect Codex managed skill root: %w", sessionErr)
		}
		if err := os.Rename(targetRoot, sessionRoot); err != nil {
			return fmt.Errorf("preserve existing Codex session skills: %w", err)
		}
	}
	if err := exposeCodexSharedDirectory(personalRoot, targetRoot); err != nil {
		if _, sessionErr := os.Lstat(sessionRoot); sessionErr == nil {
			_ = os.Rename(sessionRoot, targetRoot)
		}
		return fmt.Errorf("expose Codex personal skill root: %w", err)
	}
	return nil
}
