package workspace

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/runtimecmd"
)

func defaultTerminalHomeDir() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve terminal user home: %w", err)
	}
	homeDir = strings.TrimSpace(homeDir)
	if homeDir == "" {
		return "", errors.New("terminal user home directory is unavailable")
	}
	resolvedHomeDir, err := filepath.Abs(homeDir)
	if err != nil {
		return "", fmt.Errorf("resolve terminal user home: %w", err)
	}
	return resolvedHomeDir, nil
}

func resolveTerminalCwd(requested *string) (string, error) {
	root, err := defaultTerminalHomeDir()
	if err != nil {
		return "", err
	}

	cwd := root
	if requestedValue := strings.TrimSpace(derefString(requested)); requestedValue != "" {
		if filepath.IsAbs(requestedValue) {
			cwd = requestedValue
		} else {
			cwd = filepath.Join(root, requestedValue)
		}
	}

	cwd, err = filepath.Abs(cwd)
	if err != nil {
		return "", fmt.Errorf("resolve terminal cwd: %w", err)
	}
	return cwd, nil
}

func defaultShellPath() string {
	if runtime.GOOS == "windows" {
		return "cmd.exe"
	}
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		return shell
	}
	return "/bin/sh"
}

func resolveTerminalShellInvocation(shell string) []string {
	if runtime.GOOS == "windows" {
		return nil
	}

	shellName := filepath.Base(strings.TrimSpace(shell))
	switch shellName {
	case "bash", "zsh":
		return []string{"-il"}
	case "fish":
		return []string{"-l", "-i"}
	default:
		return nil
	}
}

func terminalProcessEnv(cwd string) []string {
	env := append(os.Environ(),
		"PWD="+cwd,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)
	// Ensure a UTF-8 locale so CJK and other multi-byte characters render
	// correctly.  Daemon processes launched outside a login shell (e.g. via
	// Finder/Spotlight) may not inherit the user's locale settings.
	lang := os.Getenv("LANG")
	if lang == "" || lang == "C" || lang == "POSIX" {
		env = append(env, "LANG=en_US.UTF-8")
	}
	return runtimecmd.InjectSystemProxyEnv(env)
}

func normalizeTerminalDimension(value *int, fallback int) int {
	if value == nil || *value <= 0 {
		return fallback
	}
	return *value
}

func isEndedTerminalStatus(status TerminalStatus) bool {
	return status == TerminalStatusExited || status == TerminalStatusFailed
}

func trimOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func cloneTimePointer(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
