package workspace

import (
	"context"
	"os"
	"path/filepath"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
)

type filesystemSearchProvider struct{}

func (filesystemSearchProvider) Name() string {
	return "filesystem"
}

func (filesystemSearchProvider) Search(
	ctx context.Context,
	request localFileSearchRequest,
) ([]string, error) {
	includeKinds := make(map[workspacefiles.EntryKind]bool, len(request.IncludeKinds))
	for _, kind := range request.IncludeKinds {
		includeKinds[kind] = true
	}
	paths := make([]string, 0, request.CandidateLimit)
	queue := []string{request.SearchRootPath}
	for len(queue) > 0 {
		directoryPath := queue[0]
		queue = queue[1:]
		entries, err := os.ReadDir(directoryPath)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return paths, err
			}
			physicalPath := filepath.Join(directoryPath, entry.Name())
			if entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			kind := entryKind(entry.Type())
			if kind != workspacefiles.EntryKindFile && kind != workspacefiles.EntryKindDirectory {
				continue
			}
			if entry.IsDir() {
				if !request.IncludeHidden && localSearchPathIsIgnored(entry.Name()) {
					continue
				}
				queue = append(queue, physicalPath)
			}
			if !request.IncludeHidden && localSearchPathIsHidden(entry.Name()) {
				continue
			}
			if len(includeKinds) > 0 && !includeKinds[kind] {
				continue
			}
			if len(request.Filters) > 0 &&
				(kind == workspacefiles.EntryKindDirectory ||
					!matchesReferenceFilterCategories(entry.Name(), false, request.Filters)) {
				continue
			}
			paths = append(paths, physicalPath)
			if len(paths) >= request.CandidateLimit {
				return paths, nil
			}
		}
	}
	return paths, nil
}
