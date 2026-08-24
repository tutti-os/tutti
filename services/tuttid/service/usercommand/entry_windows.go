//go:build windows

package usercommand

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const windowsLauncherMarker = "rem Tutti managed agent command v1"

func platformEntryName(commandName string) string {
	extension := filepath.Ext(commandName)
	if isWindowsExecutableExtension(extension) {
		commandName = strings.TrimSuffix(commandName, extension)
	}
	return commandName + ".cmd"
}

func platformSamePath(left, right string) bool { return strings.EqualFold(left, right) }

func validatePlatformEntry(path, runtimeRoot, label string) error {
	target, exists, err := readWindowsLauncher(path)
	if err != nil {
		return fmt.Errorf("%s is already occupied: %s", label, path)
	}
	if !exists {
		return nil
	}
	if !pathWithin(target, runtimeRoot) {
		return fmt.Errorf("%s points outside runtime root: %s", label, path)
	}
	return nil
}

func (e Entry) classifyUserEntry() (userEntryKind, error) {
	target, exists, err := readWindowsLauncher(e.UserPath)
	if err != nil {
		// The file exists but is not a Tutti launcher: a user-owned command
		// with the same name.
		return userEntryForeign, nil
	}
	if exists {
		if samePath(target, e.StablePath) {
			return userEntryManaged, nil
		}
		return userEntryForeign, nil
	}
	if err := validateWindowsCommandNamespace(e.UserPath); err != nil {
		// A same-stem command of higher PATH priority occupies the name:
		// a published launcher would be shadowed, so treat it as foreign.
		return userEntryForeign, nil
	}
	return userEntryAbsent, nil
}

func ensurePlatformEntry(path, target string) (bool, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	if err := validateWindowsCommandNamespace(path); err != nil {
		return false, err
	}
	_, exists, err := readWindowsLauncher(path)
	if err != nil {
		return false, err
	}
	if exists {
		return false, nil
	}
	return true, writeWindowsLauncherAtomic(path, target)
}

func replacePlatformEntry(path, target string) error {
	return writeWindowsLauncherAtomic(path, target)
}

func resolvePlatformEntry(path string) (string, error) {
	current := filepath.Clean(path)
	for range 2 {
		target, exists, err := readWindowsLauncher(current)
		if err != nil {
			return "", err
		}
		if !exists {
			return current, nil
		}
		current = target
	}
	return current, nil
}

func resolvePlatformFinalExecutable(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("managed command executable is a directory: %s", absolute)
	}
	return absolute, nil
}

func isPlatformManagedExecutable(executable, runtimeRoot string) bool {
	if pathWithin(executable, runtimeRoot) {
		return true
	}
	resolved, err := resolvePlatformEntry(executable)
	return err == nil && pathWithin(resolved, runtimeRoot)
}

func writeWindowsLauncherAtomic(path, target string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	content := windowsLauncherContent(target)
	temporary, err := os.CreateTemp(filepath.Dir(path), ".runtime-entry-*.cmd")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	_, writeErr := temporary.WriteString(content)
	closeErr := temporary.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return err
	}
	return replaceWindowsFile(path, temporaryPath)
}

func windowsLauncherContent(target string) string {
	verb := ""
	extension := strings.ToLower(filepath.Ext(target))
	if extension == ".cmd" || extension == ".bat" {
		verb = "call "
	}
	escaped := strings.ReplaceAll(target, "%", "%%")
	return "@echo off\r\n" + windowsLauncherMarker + "\r\n" + verb + "\"" + escaped + "\" %*\r\nexit /b %errorlevel%\r\n"
}

func readWindowsLauncher(path string) (string, bool, error) {
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	lines := strings.Split(strings.ReplaceAll(string(content), "\r\n", "\n"), "\n")
	if len(lines) < 4 || lines[0] != "@echo off" || lines[1] != windowsLauncherMarker {
		return "", true, errors.New("file is not a Tutti managed command launcher")
	}
	command := strings.TrimSpace(lines[2])
	command = strings.TrimPrefix(command, "call ")
	if !strings.HasPrefix(command, "\"") {
		return "", true, errors.New("managed command launcher target is invalid")
	}
	closing := strings.Index(command[1:], "\"")
	if closing < 0 || strings.TrimSpace(command[closing+2:]) != "%*" {
		return "", true, errors.New("managed command launcher arguments are invalid")
	}
	target := strings.ReplaceAll(command[1:closing+1], "%%", "%")
	if !filepath.IsAbs(target) {
		return "", true, errors.New("managed command launcher target is not absolute")
	}
	return filepath.Clean(target), true, nil
}

func replaceWindowsFile(path, temporaryPath string) error {
	return os.Rename(temporaryPath, path)
}

func validateWindowsCommandNamespace(path string) error {
	extension := filepath.Ext(path)
	stem := strings.TrimSuffix(path, extension)
	for _, candidateExtension := range windowsExecutableExtensions() {
		candidate := stem + candidateExtension
		if strings.EqualFold(candidate, path) {
			continue
		}
		if _, err := os.Lstat(candidate); err == nil {
			return fmt.Errorf("command path is already occupied: %s", candidate)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func isWindowsExecutableExtension(extension string) bool {
	for _, candidate := range windowsExecutableExtensions() {
		if strings.EqualFold(extension, candidate) {
			return true
		}
	}
	return false
}

func windowsExecutableExtensions() []string {
	extensions := []string{"", ".com", ".exe", ".bat", ".cmd", ".ps1"}
	seen := map[string]bool{"": true, ".com": true, ".exe": true, ".bat": true, ".cmd": true, ".ps1": true}
	for _, extension := range filepath.SplitList(strings.ReplaceAll(os.Getenv("PATHEXT"), ";", string(os.PathListSeparator))) {
		extension = strings.ToLower(strings.TrimSpace(extension))
		if extension == "" || extension[0] != '.' || seen[extension] {
			continue
		}
		seen[extension] = true
		extensions = append(extensions, extension)
	}
	return extensions
}
