package workspace

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// shouldHideWorkspaceEntry is the single default-visibility policy used by
// directory listings and recursive search. includeHidden remains the explicit
// escape hatch for callers that need to select one of these files.
func shouldHideWorkspaceEntry(directoryPath string, entry fs.DirEntry) bool {
	name := entry.Name()
	if strings.HasPrefix(name, ".") {
		return true
	}
	if !entry.IsDir() {
		lowerName := strings.ToLower(name)
		if strings.HasPrefix(name, "~$") || strings.HasSuffix(lowerName, ".crdownload") {
			return true
		}
	}
	return platformFileIsHidden(filepath.Join(directoryPath, name))
}

// shouldHideWorkspacePathCached memoizes visibility for a single request.
// Indexed search returns many siblings, so checking every ancestor again for
// every candidate would otherwise multiply synchronous filesystem calls.
func shouldHideWorkspacePathCached(rootPath, physicalPath string, cache map[string]bool) bool {
	relativePath, err := filepath.Rel(rootPath, physicalPath)
	if err != nil || relativePath == "." || relativePath == ".." || strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) {
		return false
	}
	directoryPath := rootPath
	for _, name := range strings.Split(relativePath, string(filepath.Separator)) {
		entryPath := filepath.Join(directoryPath, name)
		cacheKey := filepath.Clean(entryPath)
		if hidden, ok := cache[cacheKey]; ok {
			if hidden {
				return true
			}
			directoryPath = entryPath
			continue
		}
		info, err := os.Lstat(entryPath)
		if err != nil {
			return false
		}
		hidden := shouldHideWorkspaceEntry(directoryPath, fs.FileInfoToDirEntry(info))
		if cache != nil {
			cache[cacheKey] = hidden
		}
		if hidden {
			return true
		}
		directoryPath = entryPath
	}
	return false
}
