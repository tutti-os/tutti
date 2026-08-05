//go:build windows

package agentruntime

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func replaceSystemSkillRootWithStableTarget(systemRoot string, target string) error {
	if err := replaceSystemSkillRootWithSymlink(systemRoot, target); err == nil {
		return nil
	} else {
		symlinkErr := err
		if err := replaceSystemSkillRootWithDirectoryJunction(systemRoot, target); err == nil {
			return nil
		} else {
			junctionErr := err
			if err := replaceSystemSkillRootWithDirectoryCopy(systemRoot, target); err == nil {
				return nil
			} else {
				return errors.Join(
					fmt.Errorf("stable system skill symlink unavailable: %w", symlinkErr),
					fmt.Errorf("stable system skill junction unavailable: %w", junctionErr),
					fmt.Errorf("stable system skill directory copy failed: %w", err),
				)
			}
		}
	}
}

func replaceSystemSkillRootWithDirectoryJunction(systemRoot string, target string) error {
	parent := filepath.Dir(systemRoot)
	staging, err := os.MkdirTemp(parent, ".system-stabilize-")
	if err != nil {
		return fmt.Errorf("create system skill junction staging directory: %w", err)
	}
	removeStaging := true
	defer func() {
		if removeStaging {
			_ = os.RemoveAll(staging)
		}
	}()
	replacement := filepath.Join(staging, "replacement")
	backup := filepath.Join(staging, "original")
	if err := createDirectoryJunction(target, replacement); err != nil {
		return err
	}
	if err := os.Rename(systemRoot, backup); err != nil {
		return fmt.Errorf("stage provider system skills for junction replacement: %w", err)
	}
	if err := os.Rename(replacement, systemRoot); err != nil {
		restoreErr := os.Rename(backup, systemRoot)
		if restoreErr != nil {
			removeStaging = false
			return errors.Join(
				fmt.Errorf("activate stable system skill junction: %w", err),
				fmt.Errorf("restore original system skills; backup preserved at %s: %w", backup, restoreErr),
			)
		}
		return fmt.Errorf("activate stable system skill junction: %w", err)
	}
	return nil
}

func createDirectoryJunction(target string, link string) error {
	command := fmt.Sprintf("mklink /J %s %s", quoteCmdPath(link), quoteCmdPath(target))
	output, err := exec.Command(windowsCommandInterpreter(), "/D", "/S", "/C", command).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message != "" {
			return fmt.Errorf("mklink /J failed: %w: %s", err, message)
		}
		return fmt.Errorf("mklink /J failed: %w", err)
	}
	return nil
}

func quoteCmdPath(path string) string {
	return `"` + strings.ReplaceAll(path, `"`, `\"`) + `"`
}
