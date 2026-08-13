//go:build windows

package usercommand

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestWindowsEntryPublishesAndRepointsCommandLauncher(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime root with spaces")
	userBinDir := filepath.Join(t.TempDir(), "user bin")
	firstTarget := writeWindowsTestCommand(t, root, "runtime-one", 37)
	secondTarget := writeWindowsTestCommand(t, root, "runtime-two", 23)

	first, err := NewEntry(root, userBinDir, "sample", firstTarget)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Ext(first.UserPath) != ".cmd" || filepath.Ext(first.StablePath) != ".cmd" {
		t.Fatalf("Windows entry paths = %q and %q, want .cmd launchers", first.UserPath, first.StablePath)
	}
	if err := first.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := first.Publish(); err != nil {
		t.Fatal(err)
	}
	if err := first.Verify(); err != nil {
		t.Fatal(err)
	}
	assertWindowsCommandExit(t, first.UserPath, 37)

	second, err := NewEntry(root, userBinDir, "sample", secondTarget)
	if err != nil {
		t.Fatal(err)
	}
	if err := second.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := second.Publish(); err != nil {
		t.Fatal(err)
	}
	if err := second.Verify(); err != nil {
		t.Fatal(err)
	}
	assertWindowsCommandExit(t, second.UserPath, 23)
	assertPowerShellCommandExit(t, second.UserPath, 23)
	leftovers, err := filepath.Glob(filepath.Join(filepath.Dir(second.StablePath), ".runtime-entry-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(leftovers) != 0 {
		t.Fatalf("atomic repoint left temporary files: %v", leftovers)
	}
	if !IsManagedExecutable(second.UserPath, root) {
		t.Fatal("published user launcher was not recognized as Tutti managed")
	}
}

func TestWindowsEntryRefusesForeignUserCommand(t *testing.T) {
	root := t.TempDir()
	userBinDir := t.TempDir()
	target := writeWindowsTestCommand(t, root, "runtime", 0)
	entry, err := NewEntry(root, userBinDir, "sample", target)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry.UserPath, []byte("@echo foreign\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := entry.Validate(); err == nil {
		t.Fatal("Validate() unexpectedly accepted a foreign user command")
	}
}

func TestWindowsEntryRefusesHigherPriorityCommandSibling(t *testing.T) {
	for _, extension := range []string{"", ".exe", ".ps1"} {
		t.Run(extension, func(t *testing.T) {
			root := t.TempDir()
			userBinDir := t.TempDir()
			target := writeWindowsTestCommand(t, root, "runtime", 0)
			entry, err := NewEntry(root, userBinDir, "sample.exe", target)
			if err != nil {
				t.Fatal(err)
			}
			if filepath.Base(entry.UserPath) != "sample.cmd" {
				t.Fatalf("UserPath = %q, want normalized sample.cmd", entry.UserPath)
			}
			foreignPath := filepath.Join(userBinDir, "sample"+extension)
			if err := os.WriteFile(foreignPath, []byte("foreign"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := entry.Publish(); err == nil {
				t.Fatal("Publish() unexpectedly accepted a higher-priority foreign command")
			}
			if _, err := os.Stat(entry.UserPath); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("managed launcher exists after collision: %v", err)
			}
		})
	}
}

func TestWindowsEntryVerifyRejectsMissingFinalExecutable(t *testing.T) {
	root := t.TempDir()
	target := writeWindowsTestCommand(t, root, "runtime", 0)
	entry, err := NewEntry(root, t.TempDir(), "sample", target)
	if err != nil {
		t.Fatal(err)
	}
	if err := entry.Publish(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if err := entry.Verify(); err == nil {
		t.Fatal("Verify() unexpectedly accepted a missing final executable")
	}
}

func writeWindowsTestCommand(t *testing.T, root, version string, exitCode int) string {
	t.Helper()
	dir := filepath.Join(root, version, "path with spaces")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "target.cmd")
	content := "@echo off\r\nif not \"%~1\"==\"hello-world\" exit /b 91\r\nexit /b " + strconv.Itoa(exitCode) + "\r\n"
	if err := os.WriteFile(path, []byte(content), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func assertWindowsCommandExit(t *testing.T, launcher string, want int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	commandLine := fmt.Sprintf(`%s hello-world`, strings.TrimSuffix(filepath.Base(launcher), filepath.Ext(launcher)))
	command := exec.CommandContext(ctx, "cmd.exe", "/d", "/c", commandLine)
	command.Env = append(os.Environ(), "PATH="+filepath.Dir(launcher)+";"+os.Getenv("PATH"))
	output, err := command.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != want {
		launcherContent, _ := os.ReadFile(launcher)
		stable, _, _ := readWindowsLauncher(launcher)
		stableContent, _ := os.ReadFile(stable)
		t.Fatalf("launcher exit error = %v output = %q command = %q launcher = %q stable = %q, want exit code %d", err, output, commandLine, launcherContent, stableContent, want)
	}
}

func assertPowerShellCommandExit(t *testing.T, launcher string, want int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "sample hello-world; exit $LASTEXITCODE")
	command.Env = append(os.Environ(), "PATH="+filepath.Dir(launcher)+";"+os.Getenv("PATH"))
	output, err := command.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != want {
		t.Fatalf("PowerShell launcher exit error = %v output = %q, want exit code %d", err, output, want)
	}
}
