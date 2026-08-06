//go:build windows

package agentstatus

import "strings"

// joinLoginShellCommand formats a command that will be typed into the
// Windows cmd.exe-backed workspace terminal. The generic shell formatter uses
// POSIX single quotes, which cmd.exe treats as literal characters. That made
// absolute CLI paths such as C:\\Users\\...\\opencode.CMD fail immediately
// when the user clicked Login.
func joinLoginShellCommand(parts []string) string {
	filtered := make([]string, 0, len(parts))
	for _, part := range parts {
		if strings.TrimSpace(part) == "" {
			continue
		}
		filtered = append(filtered, windowsCmdQuote(part))
	}
	return strings.Join(filtered, " ")
}

func windowsCmdQuote(value string) string {
	if isWindowsCmdSafeWord(value) {
		return value
	}
	// Login paths are normally simple Windows paths. For the remaining cases,
	// double quotes are understood by cmd.exe; escape embedded quotes with ^.
	return `"` + strings.ReplaceAll(value, `"`, `^"`) + `"`
}

func isWindowsCmdSafeWord(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case strings.ContainsRune(`@%_+=:,./\\-`, r):
		default:
			return false
		}
	}
	return true
}
