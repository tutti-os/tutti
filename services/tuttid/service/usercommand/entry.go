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

// userEntryKind classifies the state of the user-command hop.
type userEntryKind uint8

const (
	// userEntryAbsent: no command with this name exists in the user bin dir.
	userEntryAbsent userEntryKind = iota
	// userEntryManaged: the entry is Tutti's and points at the stable path.
	userEntryManaged
	// userEntryForeign: the user owns a command with the same name (e.g. a
	// locally installed CLI). It is preserved untouched, and user-command
	// publication is skipped instead of failing the managed runtime.
	userEntryForeign
)

func (e Entry) validateStablePath() error {
	return validatePlatformEntry(e.StablePath, e.RuntimeRoot, "managed runtime entry")
}

func (e Entry) Validate() error {
	if err := e.validateStablePath(); err != nil {
		return err
	}
	_, err := e.classifyUserEntry()
	return err
}

func (e Entry) Verify() error {
	if err := e.Validate(); err != nil {
		return err
	}
	kind, err := e.classifyUserEntry()
	if err != nil {
		return err
	}
	if kind != userEntryManaged {
		// No Tutti user command is installed (absent or foreign). The managed
		// runtime is still usable; there is nothing to verify on the user hop.
		return nil
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

// ActivateRuntime refreshes the private stable command hop without publishing
// or changing the user-level command. Callers use this when an independently
// installed command already owns the effective PATH namespace.
func (e Entry) ActivateRuntime() error {
	if err := e.validateStablePath(); err != nil {
		return err
	}
	return replacePlatformEntry(e.StablePath, e.FinalExecutable)
}

// Unpublish removes the user-level command only when it is still provably
// owned by this entry. Foreign or already-absent commands are preserved.
func (e Entry) Unpublish() (bool, error) {
	kind, err := e.classifyUserEntry()
	if err != nil {
		return false, err
	}
	if kind != userEntryManaged {
		return false, nil
	}
	return removePlatformEntry(e.UserPath, e.StablePath)
}

// Publish installs the managed command hops. It returns whether the
// user-command entry is owned by Tutti. A foreign occupant is preserved
// untouched: publication is then skipped (the internal stable hop is still
// refreshed) and the caller should treat the runtime as activated.
func (e Entry) Publish() (bool, error) {
	if err := e.validateStablePath(); err != nil {
		return false, err
	}
	kind, err := e.classifyUserEntry()
	if err != nil {
		return false, err
	}
	if kind == userEntryForeign {
		if err := e.ActivateRuntime(); err != nil {
			return false, err
		}
		return false, nil
	}
	createdUserEntry := false
	if kind == userEntryAbsent {
		created, err := ensurePlatformEntry(e.UserPath, e.StablePath)
		if err != nil {
			return false, err
		}
		createdUserEntry = created
	}
	if err := e.ActivateRuntime(); err != nil {
		if createdUserEntry {
			_ = os.Remove(e.UserPath)
		}
		return false, err
	}
	return true, nil
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

func newEntryQuarantinePath(path string) (string, error) {
	temporary, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tutti-unpublish-*")
	if err != nil {
		return "", err
	}
	temporaryPath := temporary.Name()
	if err := errors.Join(temporary.Close(), os.Remove(temporaryPath)); err != nil {
		return "", err
	}
	return temporaryPath, nil
}

func restoreQuarantinedEntry(path, quarantinePath string) error {
	// Creating the restored name is atomic and no-replace. A concurrent
	// installer that has already recreated path therefore wins; its entry is
	// never overwritten, and the quarantined command remains recoverable.
	info, err := os.Lstat(quarantinePath)
	if err != nil {
		return err
	}
	var restoreErr error
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(quarantinePath)
		if err != nil {
			return err
		}
		restoreErr = os.Symlink(target, path)
	} else {
		restoreErr = os.Link(quarantinePath, path)
	}
	if restoreErr != nil {
		return fmt.Errorf("restore changed user command; preserved at %s: %w", quarantinePath, restoreErr)
	}
	if err := os.Remove(quarantinePath); err != nil {
		return fmt.Errorf("remove restored command quarantine %s: %w", quarantinePath, err)
	}
	return nil
}

func removeQuarantinedManagedEntry(path, quarantinePath string) (bool, error) {
	if err := os.Remove(quarantinePath); err != nil {
		return false, errors.Join(err, restoreQuarantinedEntry(path, quarantinePath))
	}
	return true, nil
}
