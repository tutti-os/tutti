//go:build windows

package runtimeprep

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Windows symlink creation requires SeCreateSymbolicLinkPrivilege (or
// Developer Mode). A directory junction does not require that privilege and
// keeps a session-scoped CODEX_HOME connected to the user's live plugin/skill
// state without copying potentially hundreds of megabytes on every turn.
// Copy remains the last-resort fallback for filesystems that do not support
// junctions.
func exposeCodexDirectory(source, target string) error {
	started := time.Now()
	if err := os.Symlink(source, target); err == nil {
		slog.Info("codex runtime directory exposed", "event", "agent.runtime_prep.codex_directory_exposed", "strategy", "symlink", "source", source, "target", target, "elapsedMs", time.Since(started).Milliseconds())
		return nil
	} else {
		symlinkErr := err
		if junctionErr := createCodexDirectoryJunction(source, target); junctionErr == nil {
			slog.Info("codex runtime directory exposed", "event", "agent.runtime_prep.codex_directory_exposed", "strategy", "junction", "source", source, "target", target, "elapsedMs", time.Since(started).Milliseconds())
			return nil
		} else {
			slog.Debug("codex runtime directory junction unavailable", "event", "agent.runtime_prep.codex_directory_junction_unavailable", "source", source, "target", target, "error", junctionErr)
			if copyErr := copyCodexDirectory(source, target); copyErr != nil {
				return fmt.Errorf("symlink failed: %v; junction failed: %v; copy failed: %w", symlinkErr, junctionErr, copyErr)
			}
			slog.Warn("codex runtime directory copied as fallback", "event", "agent.runtime_prep.codex_directory_copied", "source", source, "target", target, "elapsedMs", time.Since(started).Milliseconds())
			return nil
		}
	}
}

// A writable personal Skill root must remain the same filesystem object across
// sessions. Unlike read-mostly plugin projections, this path must never fall
// back to a directory copy because a copy would silently make new Skills
// session-local again.
func exposeCodexSharedDirectory(source, target string) error {
	return exposeSharedRuntimeDirectory(source, target)
}

func exposeSharedRuntimeDirectory(source, target string) error {
	if err := os.Symlink(source, target); err == nil {
		return nil
	} else if junctionErr := createCodexDirectoryJunction(source, target); junctionErr != nil {
		return fmt.Errorf("symlink failed: %v; junction failed: %w", err, junctionErr)
	}
	return nil
}

func sameSharedRuntimePath(left, right string) bool {
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}

func createCodexDirectoryJunction(source, target string) error {
	// `mklink /J` creates an NTFS directory junction for an ordinary user. Keep
	// the paths as separate process arguments; Go quotes paths with spaces for
	// cmd.exe, while mklink receives the two exact paths.
	command := exec.Command("cmd.exe", "/D", "/S", "/C", "mklink", "/J", target, source)
	output, err := command.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			return err
		}
		return fmt.Errorf("%w: %s", err, message)
	}
	return nil
}

func copyCodexDirectory(source, target string) error {
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("source is not a directory: %s", source)
	}
	if err := os.MkdirAll(target, 0o700); err != nil {
		return err
	}
	resolvedRoot, err := filepath.EvalSymlinks(source)
	if err != nil {
		return fmt.Errorf("resolve source root %s: %w", source, err)
	}
	return copyCodexDirectoryTree(source, target, filepath.Clean(resolvedRoot), map[string]bool{})
}

func copyCodexDirectoryTree(source, target, resolvedRoot string, active map[string]bool) error {
	resolvedSource, err := filepath.EvalSymlinks(source)
	if err != nil {
		// Go's Windows resolver does not consistently re-resolve descendants
		// below a junction. The subsequent os.Stat call still follows the
		// junction, while the lexical path remains fenced below resolvedRoot.
		resolvedSource = filepath.Clean(source)
	}
	resolvedSource = filepath.Clean(resolvedSource)
	relative, err := filepath.Rel(resolvedRoot, resolvedSource)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("source directory escapes plugin state root: %s", source)
	}
	key := strings.ToLower(resolvedSource)
	if active[key] {
		return fmt.Errorf("source directory contains a junction cycle: %s", source)
	}
	active[key] = true
	defer delete(active, key)

	if err := os.MkdirAll(target, 0o700); err != nil {
		return err
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return fmt.Errorf("read source directory %s: %w", source, err)
	}
	for _, entry := range entries {
		entryPath := filepath.Join(source, entry.Name())
		destination := filepath.Join(target, entry.Name())
		info, err := os.Stat(entryPath)
		if err != nil {
			return fmt.Errorf("stat source entry %s: %w", entryPath, err)
		}
		if info.IsDir() {
			if err := copyCodexDirectoryTree(entryPath, destination, resolvedRoot, active); err != nil {
				return fmt.Errorf("copy source directory %s: %w", entryPath, err)
			}
			continue
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("source contains unsupported entry: %s", entryPath)
		}
		content, err := os.ReadFile(entryPath)
		if err != nil {
			return fmt.Errorf("read source file %s: %w", entryPath, err)
		}
		if err := os.WriteFile(destination, content, 0o600); err != nil {
			return err
		}
	}
	return nil
}
