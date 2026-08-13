package runtimeprep

import (
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

func promoteSessionCreatedCodexSkills(runsRoot string, currentSessionID string) error {
	userHome, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(userHome) == "" {
		return nil
	}
	destinationRoot := filepath.Join(userHome, ".codex", "skills")
	runs, err := os.ReadDir(runsRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read codex session runs: %w", err)
	}
	for _, run := range runs {
		if !run.IsDir() || run.Name() == safePathSegment(currentSessionID) {
			continue
		}
		sourceRoot := filepath.Join(runsRoot, run.Name(), "codex-home", "skills")
		entries, readErr := os.ReadDir(sourceRoot)
		if readErr != nil {
			continue
		}
		for _, entry := range entries {
			name := strings.TrimSpace(entry.Name())
			if name == "" || strings.HasPrefix(name, ".") {
				continue
			}
			source := filepath.Join(sourceRoot, name)
			info, statErr := os.Lstat(source)
			if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				continue
			}
			if _, markerErr := os.Stat(filepath.Join(source, ".tutti-managed-skill")); markerErr == nil {
				continue
			}
			if !hasDelimitedSkillFrontmatter(filepath.Join(source, "SKILL.md")) {
				continue
			}
			destination := filepath.Join(destinationRoot, name)
			if _, destinationErr := os.Lstat(destination); destinationErr == nil {
				continue
			} else if !os.IsNotExist(destinationErr) {
				return fmt.Errorf("inspect promoted codex skill %s: %w", name, destinationErr)
			}
			if err := copyCodexPersonalSkillAtomic(source, destination); err != nil {
				slog.Warn("session-created codex skill promotion skipped", "skillName", name, "error", err)
			}
		}
	}
	return nil
}

func copyCodexPersonalSkillAtomic(source string, destination string) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	temporary, err := os.MkdirTemp(filepath.Dir(destination), ".tutti-skill-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	if err := filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(temporary, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("unsupported skill entry: %s", path)
		}
		return copyFile(path, target, 0o600)
	}); err != nil {
		return err
	}
	return os.Rename(temporary, destination)
}
