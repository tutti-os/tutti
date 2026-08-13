package usercommand

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Entry describes the two stable command hops owned by Tutti. Runtime updates
// replace StablePath while UserPath remains the command exposed on PATH.
type Entry struct {
	RuntimeRoot     string
	StablePath      string
	UserPath        string
	FinalExecutable string
}

func NewEntry(runtimeRoot, userBinDir, commandName, finalExecutable string) (Entry, error) {
	runtimeRoot = filepath.Clean(strings.TrimSpace(runtimeRoot))
	userBinDir = filepath.Clean(strings.TrimSpace(userBinDir))
	commandName = strings.TrimSpace(commandName)
	finalExecutable = filepath.Clean(strings.TrimSpace(finalExecutable))
	if runtimeRoot == "." || userBinDir == "." {
		return Entry{}, errors.New("managed command directories are not configured")
	}
	if !filepath.IsAbs(runtimeRoot) || !filepath.IsAbs(userBinDir) || !filepath.IsAbs(finalExecutable) {
		return Entry{}, errors.New("managed command paths must be absolute")
	}
	if commandName == "" || commandName != filepath.Base(commandName) || commandName == "." || commandName == string(filepath.Separator) {
		return Entry{}, errors.New("managed command name is invalid")
	}
	if finalExecutable == "." || !pathWithin(finalExecutable, runtimeRoot) {
		return Entry{}, errors.New("managed command executable escapes runtime root")
	}
	entryName := platformEntryName(commandName)
	return Entry{
		RuntimeRoot:     runtimeRoot,
		StablePath:      filepath.Join(runtimeRoot, "bin", entryName),
		UserPath:        filepath.Join(userBinDir, entryName),
		FinalExecutable: finalExecutable,
	}, nil
}

func (e Entry) Validate() error {
	if err := validatePlatformEntry(e.StablePath, e.RuntimeRoot, "managed runtime entry"); err != nil {
		return err
	}
	return validateExactPlatformEntry(e.UserPath, e.StablePath, "user executable entry")
}

func (e Entry) Verify() error {
	if err := e.Validate(); err != nil {
		return err
	}
	for label, path := range map[string]string{
		"managed runtime entry": e.StablePath,
		"user executable entry": e.UserPath,
	} {
		if _, err := os.Lstat(path); err != nil {
			return fmt.Errorf("%s is unavailable: %w", label, err)
		}
	}
	resolved, err := resolvePlatformEntry(e.UserPath)
	if err != nil {
		return fmt.Errorf("resolve user executable entry: %w", err)
	}
	expected, err := resolvePlatformFinalExecutable(e.FinalExecutable)
	if err != nil {
		return err
	}
	if !samePath(resolved, expected) {
		return fmt.Errorf("user executable entry resolves to unexpected runtime: %s", e.UserPath)
	}
	return nil
}

func (e Entry) Publish() error {
	if err := e.Validate(); err != nil {
		return err
	}
	createdUserEntry, err := ensurePlatformEntry(e.UserPath, e.StablePath)
	if err != nil {
		return err
	}
	if err := replacePlatformEntry(e.StablePath, e.FinalExecutable); err != nil {
		if createdUserEntry {
			_ = os.Remove(e.UserPath)
		}
		return err
	}
	return nil
}

func IsManagedExecutable(executable, runtimeRoot string) bool {
	executable = filepath.Clean(strings.TrimSpace(executable))
	runtimeRoot = filepath.Clean(strings.TrimSpace(runtimeRoot))
	if executable == "." || runtimeRoot == "." {
		return false
	}
	return isPlatformManagedExecutable(executable, runtimeRoot)
}

func pathWithin(path, root string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(path))
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func samePath(left, right string) bool {
	return platformSamePath(filepath.Clean(left), filepath.Clean(right))
}
