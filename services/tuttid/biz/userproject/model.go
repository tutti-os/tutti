package userproject

import (
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type Project struct {
	ID               string
	Path             string
	Label            string
	SectionKey       string
	CreatedAtUnixMS  int64
	UpdatedAtUnixMS  int64
	LastUsedAtUnixMS int64
	PinnedAtUnixMS   int64
	SortOrder        int
}

// SectionKeyFromPath returns the conversation-rail section key for a user
// project path. It must match storesqlite.RailSectionKeyForProject so list
// queries find sessions whose keys were classified with path normalization
// (for example macOS /var vs /private/var).
func SectionKeyFromPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	return storesqlite.RailSectionKeyForProject(path)
}

func LabelFromPath(path string) string {
	path = strings.TrimRight(strings.TrimSpace(path), "/\\")
	if path == "" {
		return ""
	}
	index := strings.LastIndexAny(path, "/\\")
	if index < 0 {
		return path
	}
	return strings.TrimSpace(path[index+1:])
}
