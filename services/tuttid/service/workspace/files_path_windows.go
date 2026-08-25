//go:build windows

package workspace

import (
	"path/filepath"
	"strings"
)

func workspaceFilePhysicalPathCandidate(value string) string {
	normalized := strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	if len(normalized) >= 4 && normalized[0] == '/' && isASCIILetter(normalized[1]) &&
		normalized[2] == ':' && normalized[3] == '/' {
		return filepath.FromSlash(normalized[1:])
	}
	return value
}

func isASCIILetter(value byte) bool {
	return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z'
}
