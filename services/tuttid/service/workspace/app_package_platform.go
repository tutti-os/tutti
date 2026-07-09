package workspace

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func appPackageFileIsExecutable(info os.FileInfo) bool {
	return runtime.GOOS == "windows" || info.Mode()&0o111 != 0
}

func appPackageScriptCommand(scriptPath string) (string, []string) {
	if runtime.GOOS == "windows" && strings.EqualFold(filepath.Ext(scriptPath), ".sh") {
		return appPackageWindowsShellCommand(scriptPath)
	}
	return scriptPath, nil
}

func appPackageWindowsShellCommand(scriptPath string) (string, []string) {
	return appPackageWindowsBashExecutable(), []string{filepath.ToSlash(scriptPath)}
}

func appPackageWindowsBashExecutable() string {
	for _, path := range appPackageWindowsGitBashCandidates() {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return "bash.exe"
}

func appPackageWindowsGitBashCandidates() []string {
	candidates := make([]string, 0, 4)
	for _, envName := range []string{"ProgramFiles", "ProgramFiles(x86)"} {
		root := strings.TrimSpace(os.Getenv(envName))
		if root == "" {
			continue
		}
		candidates = append(candidates, filepath.Join(root, "Git", "bin", "bash.exe"))
		candidates = append(candidates, filepath.Join(root, "Git", "usr", "bin", "bash.exe"))
	}
	return candidates
}

// replacePackageDir removes an existing package directory before copying a fresh
// version. On Windows, a previously-launched standalone server .exe can still be
// locked by the OS even after the process exits, so the directory is renamed
// aside and deleted asynchronously instead of blocking the caller.
func replacePackageDir(packageDir string, trashParentDir string) error {
	if packageDir == "" {
		return nil
	}

	if runtime.GOOS != "windows" {
		return os.RemoveAll(packageDir)
	}

	if _, err := os.Stat(packageDir); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	trashParentDir = strings.TrimSpace(trashParentDir)
	if trashParentDir == "" {
		trashParentDir = filepath.Dir(packageDir)
	}
	if err := os.MkdirAll(trashParentDir, 0o755); err != nil {
		return fmt.Errorf("create app package trash dir: %w", err)
	}

	trashBase := safeAppPathSegment(filepath.Base(filepath.Clean(packageDir)))
	trashDir := filepath.Join(trashParentDir, fmt.Sprintf("%s.trash.%d", trashBase, os.Getpid()))
	for i := 0; i < 10; i++ {
		trashDir = filepath.Join(trashParentDir, fmt.Sprintf("%s.trash.%d.%d", trashBase, os.Getpid(), i))
		if _, err := os.Stat(trashDir); os.IsNotExist(err) {
			break
		}
	}

	if err := os.Rename(packageDir, trashDir); err != nil {
		return os.RemoveAll(packageDir)
	}

	go func(dir string) {
		for attempt := 0; attempt < 20; attempt++ {
			if err := os.RemoveAll(dir); err == nil {
				return
			}
			time.Sleep(500 * time.Millisecond)
		}
	}(trashDir)

	return nil
}
