package workspace

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
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
	// Inject the macOS system proxy so commands run in the workspace terminal —
	// notably agent `login` flows — reach the upstream API through the same proxy
	// as spawned agents, instead of connecting directly and hitting `403 Request
	// not allowed` from a restricted region.
	env := append(os.Environ(),
		"PWD="+cwd,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)
	return runtimecmd.InjectSystemProxyEnv(
		appendTerminalUTF8LocaleFallback(env, runtime.GOOS),
	)
}

func appendTerminalUTF8LocaleFallback(env []string, goos string) []string {
	if goos != "darwin" {
		return env
	}

	var lang, lcAll, lcCType string
	for _, entry := range env {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		switch key {
		case "LANG":
			lang = strings.TrimSpace(value)
		case "LC_ALL":
			lcAll = strings.TrimSpace(value)
		case "LC_CTYPE":
			lcCType = strings.TrimSpace(value)
		}
	}
	if lcAll != "" || lcCType != "" || lang != "" {
		return env
	}

	// Finder-launched macOS apps commonly have no locale variables. Without a
	// UTF-8 character type, interactive shells treat IME bytes as invalid or
	// control characters. LC_CTYPE fixes character decoding without changing
	// message language, sorting, dates, or other locale categories.
	return append(env, "LC_CTYPE=UTF-8")
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
