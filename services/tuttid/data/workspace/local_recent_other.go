//go:build !darwin

package workspace

import (
	"context"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
)

// ListRecent returns an empty listing on non-macOS hosts, where there is no
// Spotlight-equivalent recently-used index wired up yet.
func (LocalFilesAdapter) ListRecent(
	_ context.Context,
	root workspacefiles.WorkspaceRoot,
	_ int,
) (workspacefiles.DirectoryListing, error) {
	return workspacefiles.DirectoryListing{
		WorkspaceID:   root.WorkspaceID,
		Root:          workspacefiles.NormalizeLogicalRoot(root.LogicalRoot),
		DirectoryPath: workspacefiles.NormalizeLogicalRoot(root.LogicalRoot),
		Entries:       []workspacefiles.FileEntry{},
	}, nil
}
