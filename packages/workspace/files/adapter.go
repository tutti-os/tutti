package workspacefiles

import "context"

type WorkspaceResolver interface {
	ResolveWorkspaceRoot(ctx context.Context, workspaceID string) (WorkspaceRoot, error)
}

type FileAdapter interface {
	ListDirectory(ctx context.Context, root WorkspaceRoot, path LogicalPath, includeHidden bool) (DirectoryListing, error)
	CreateFile(ctx context.Context, root WorkspaceRoot, path LogicalPath) (FileEntry, error)
	CreateDirectory(ctx context.Context, root WorkspaceRoot, path LogicalPath) (FileEntry, error)
	DeleteEntry(ctx context.Context, root WorkspaceRoot, path LogicalPath, kind EntryKind) error
	MoveEntry(ctx context.Context, root WorkspaceRoot, path LogicalPath, targetDirectoryPath LogicalPath) (FileEntry, error)
	RenameEntry(ctx context.Context, root WorkspaceRoot, path LogicalPath, newName string) (FileEntry, error)
	CopyEntry(ctx context.Context, root WorkspaceRoot, path LogicalPath) (FileEntry, error)
	PreflightUploadFiles(ctx context.Context, root WorkspaceRoot, targetDirectoryPath LogicalPath, sourcePaths []string) ([]UploadConflict, error)
	ReadFile(ctx context.Context, root WorkspaceRoot, path LogicalPath, maxBytes int64) (FileContent, error)
	UploadFiles(ctx context.Context, root WorkspaceRoot, targetDirectoryPath LogicalPath, sourcePaths []string, overwrite bool) ([]FileEntry, error)
	WriteTextFile(ctx context.Context, root WorkspaceRoot, path LogicalPath, content string) (FileEntry, error)
	Search(ctx context.Context, root WorkspaceRoot, input SearchInput) (SearchResult, error)
}

type DirectoryTreePrefetchPolicy interface {
	ShouldPrefetchDirectory(root WorkspaceRoot, path LogicalPath) bool
}

// RecentFilesLister is an optional FileAdapter capability: enumerate the
// workspace's recently accessed entries (most-recent first). Adapters that do
// not implement it (e.g. non-macOS hosts) are treated as "no recent files".
type RecentFilesLister interface {
	ListRecent(ctx context.Context, root WorkspaceRoot, limit int) (DirectoryListing, error)
}
