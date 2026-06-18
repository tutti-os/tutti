package workspacefiles

import (
	"context"
	"fmt"
	"strings"
)

type Service struct {
	Resolver WorkspaceResolver
	Adapter  FileAdapter
}

func (s Service) ListDirectory(ctx context.Context, workspaceID string, input DirectoryListInput) (DirectoryListing, error) {
	root, err := s.resolve(ctx, workspaceID)
	if err != nil {
		return DirectoryListing{}, err
	}
	logicalPath, err := NormalizeLogicalPathWithinRoot(input.Path, root.LogicalRoot)
	if err != nil {
		return DirectoryListing{}, err
	}
	listing, err := s.adapter().ListDirectory(ctx, root, logicalPath, input.IncludeHidden)
	if err != nil {
		return DirectoryListing{}, err
	}
	return normalizeDirectoryListing(root, logicalPath, listing), nil
}

func (s Service) CreateFile(ctx context.Context, workspaceID string, value string) (FileEntry, error) {
	root, logicalPath, err := s.resolvePath(ctx, workspaceID, value)
	if err != nil {
		return FileEntry{}, err
	}
	entry, err := s.adapter().CreateFile(ctx, root, logicalPath)
	if err != nil {
		return FileEntry{}, err
	}
	return normalizeFileEntry(root, logicalPath, entry), nil
}

func (s Service) ReadFile(ctx context.Context, workspaceID string, value string, maxBytes int64) (FileContent, error) {
	root, logicalPath, err := s.resolvePath(ctx, workspaceID, value)
	if err != nil {
		return FileContent{}, err
	}
	if maxBytes <= 0 {
		maxBytes = DefaultReadFileMaxBytes
	}
	content, err := s.adapter().ReadFile(ctx, root, logicalPath, maxBytes)
	if err != nil {
		return FileContent{}, err
	}
	content.Path = logicalPath
	if content.Name == "" {
		content.Name = LogicalPathBase(logicalPath)
	}
	content.SizeBytes = int64(len(content.Bytes))
	return content, nil
}

func (s Service) WriteTextFile(ctx context.Context, workspaceID string, value string, content string) (FileEntry, error) {
	root, logicalPath, err := s.resolvePath(ctx, workspaceID, value)
	if err != nil {
		return FileEntry{}, err
	}
	entry, err := s.adapter().WriteTextFile(ctx, root, logicalPath, content)
	if err != nil {
		return FileEntry{}, err
	}
	return normalizeFileEntry(root, logicalPath, entry), nil
}

func (s Service) CreateDirectory(ctx context.Context, workspaceID string, value string) (FileEntry, error) {
	root, logicalPath, err := s.resolvePath(ctx, workspaceID, value)
	if err != nil {
		return FileEntry{}, err
	}
	entry, err := s.adapter().CreateDirectory(ctx, root, logicalPath)
	if err != nil {
		return FileEntry{}, err
	}
	return normalizeFileEntry(root, logicalPath, entry), nil
}

func (s Service) DeleteEntry(ctx context.Context, workspaceID string, value string, kind EntryKind) error {
	root, logicalPath, err := s.resolvePath(ctx, workspaceID, value)
	if err != nil {
		return err
	}
	if IsLogicalRoot(logicalPath, root.LogicalRoot) {
		return ErrRootDeleteForbidden
	}
	if kind != "" && kind != EntryKindFile && kind != EntryKindDirectory && kind != EntryKindUnknown {
		return fmt.Errorf("%w: %q", ErrInvalidEntryKind, kind)
	}
	return s.adapter().DeleteEntry(ctx, root, logicalPath, kind)
}

func (s Service) MoveEntry(ctx context.Context, workspaceID string, value string, targetDirectoryValue string) (FileEntry, error) {
	root, logicalPath, err := s.resolvePath(ctx, workspaceID, value)
	if err != nil {
		return FileEntry{}, err
	}
	if IsLogicalRoot(logicalPath, root.LogicalRoot) {
		return FileEntry{}, ErrRootDeleteForbidden
	}
	targetDirectoryPath, err := NormalizeLogicalPathWithinRoot(targetDirectoryValue, root.LogicalRoot)
	if err != nil {
		return FileEntry{}, err
	}
	if logicalPath == targetDirectoryPath || strings.HasPrefix(targetDirectoryPath.String(), logicalPath.String()+"/") {
		return FileEntry{}, fmt.Errorf("%w: cannot move entry into itself", ErrInvalidPath)
	}
	entry, err := s.adapter().MoveEntry(ctx, root, logicalPath, targetDirectoryPath)
	if err != nil {
		return FileEntry{}, err
	}
	return normalizeFileEntry(root, entry.Path, entry), nil
}

func (s Service) RenameEntry(ctx context.Context, workspaceID string, value string, newName string) (FileEntry, error) {
	root, logicalPath, err := s.resolvePath(ctx, workspaceID, value)
	if err != nil {
		return FileEntry{}, err
	}
	if IsLogicalRoot(logicalPath, root.LogicalRoot) {
		return FileEntry{}, ErrRootDeleteForbidden
	}
	newName = strings.TrimSpace(newName)
	if newName == "" || strings.Contains(newName, "/") || strings.Contains(newName, "\\") || newName == "." || newName == ".." {
		return FileEntry{}, fmt.Errorf("%w: invalid entry name %q", ErrInvalidPath, newName)
	}
	renamedEntry, err := s.adapter().RenameEntry(ctx, root, logicalPath, newName)
	if err != nil {
		return FileEntry{}, err
	}
	return normalizeFileEntry(root, renamedEntry.Path, renamedEntry), nil
}

func (s Service) CopyEntry(ctx context.Context, workspaceID string, value string) (FileEntry, error) {
	root, logicalPath, err := s.resolvePath(ctx, workspaceID, value)
	if err != nil {
		return FileEntry{}, err
	}
	if IsLogicalRoot(logicalPath, root.LogicalRoot) {
		return FileEntry{}, ErrRootDeleteForbidden
	}
	copiedEntry, err := s.adapter().CopyEntry(ctx, root, logicalPath)
	if err != nil {
		return FileEntry{}, err
	}
	return normalizeFileEntry(root, copiedEntry.Path, copiedEntry), nil
}

func (s Service) UploadFiles(ctx context.Context, workspaceID string, input UploadInput) (UploadResult, error) {
	root, err := s.resolve(ctx, workspaceID)
	if err != nil {
		return UploadResult{}, err
	}

	targetDirectoryPath, err := NormalizeLogicalPathWithinRoot(input.TargetDirectoryPath, root.LogicalRoot)
	if err != nil {
		return UploadResult{}, err
	}

	sourcePaths := make([]string, 0, len(input.SourcePaths))
	for _, sourcePath := range input.SourcePaths {
		trimmed := strings.TrimSpace(sourcePath)
		if trimmed == "" {
			continue
		}
		sourcePaths = append(sourcePaths, trimmed)
	}
	if len(sourcePaths) == 0 {
		return UploadResult{}, fmt.Errorf("%w: source paths are required", ErrInvalidUploadSource)
	}

	entries, err := s.adapter().UploadFiles(ctx, root, targetDirectoryPath, sourcePaths, input.Overwrite)
	if err != nil {
		return UploadResult{}, err
	}
	if entries == nil {
		entries = []FileEntry{}
	}

	return UploadResult{
		WorkspaceID:         root.WorkspaceID,
		Root:                NormalizeLogicalRoot(root.LogicalRoot),
		TargetDirectoryPath: targetDirectoryPath,
		Entries:             entries,
	}, nil
}

func (s Service) PreflightUploadFiles(ctx context.Context, workspaceID string, input PreflightUploadInput) (PreflightUploadResult, error) {
	root, err := s.resolve(ctx, workspaceID)
	if err != nil {
		return PreflightUploadResult{}, err
	}

	targetDirectoryPath, err := NormalizeLogicalPathWithinRoot(input.TargetDirectoryPath, root.LogicalRoot)
	if err != nil {
		return PreflightUploadResult{}, err
	}

	sourcePaths := make([]string, 0, len(input.SourcePaths))
	for _, sourcePath := range input.SourcePaths {
		trimmed := strings.TrimSpace(sourcePath)
		if trimmed == "" {
			continue
		}
		sourcePaths = append(sourcePaths, trimmed)
	}
	if len(sourcePaths) == 0 {
		return PreflightUploadResult{}, fmt.Errorf("%w: source paths are required", ErrInvalidUploadSource)
	}

	conflicts, err := s.adapter().PreflightUploadFiles(ctx, root, targetDirectoryPath, sourcePaths)
	if err != nil {
		return PreflightUploadResult{}, err
	}
	if conflicts == nil {
		conflicts = []UploadConflict{}
	}

	return PreflightUploadResult{
		WorkspaceID:         root.WorkspaceID,
		Root:                NormalizeLogicalRoot(root.LogicalRoot),
		TargetDirectoryPath: targetDirectoryPath,
		Conflicts:           conflicts,
	}, nil
}

func (s Service) Search(ctx context.Context, workspaceID string, input SearchInput) (SearchResult, error) {
	root, err := s.resolve(ctx, workspaceID)
	if err != nil {
		return SearchResult{}, err
	}
	input.Query = strings.TrimSpace(input.Query)
	input.Limit = NormalizeSearchLimit(input.Limit)
	input.IncludeKinds, err = NormalizeSearchKinds(input.IncludeKinds)
	if err != nil {
		return SearchResult{}, err
	}
	input.Filters = NormalizeSearchFilters(input.Filters)
	// 筛选与搜索是同一能力:关键词与筛选同时为空才算空查询。仅选了类型筛选(query 空)时
	// 继续走 adapter,由其按类型 list-all。
	if input.Query == "" && len(input.Filters) == 0 {
		return SearchResult{
			WorkspaceID: root.WorkspaceID,
			Root:        NormalizeLogicalRoot(root.LogicalRoot),
			Entries:     []SearchEntry{},
		}, nil
	}
	result, err := s.adapter().Search(ctx, root, input)
	if err != nil {
		return SearchResult{}, err
	}
	result.WorkspaceID = root.WorkspaceID
	result.Root = NormalizeLogicalRoot(root.LogicalRoot)
	if result.Entries == nil {
		result.Entries = []SearchEntry{}
	}
	return result, nil
}

// ListRecent returns the workspace's recently accessed entries, most-recent
// first. When the adapter does not implement RecentFilesLister the result is an
// empty listing rooted at the workspace root.
func (s Service) ListRecent(ctx context.Context, workspaceID string, input RecentListInput) (DirectoryListing, error) {
	root, err := s.resolve(ctx, workspaceID)
	if err != nil {
		return DirectoryListing{}, err
	}
	normalizedRoot := NormalizeLogicalRoot(root.LogicalRoot)
	empty := DirectoryListing{
		WorkspaceID:   root.WorkspaceID,
		Root:          normalizedRoot,
		DirectoryPath: normalizedRoot,
		Entries:       []FileEntry{},
	}
	lister, ok := s.adapter().(RecentFilesLister)
	if !ok {
		return empty, nil
	}
	listing, err := lister.ListRecent(ctx, root, NormalizeRecentLimit(input.Limit))
	if err != nil {
		return DirectoryListing{}, err
	}
	listing.WorkspaceID = root.WorkspaceID
	listing.Root = normalizedRoot
	if listing.DirectoryPath == "" {
		listing.DirectoryPath = normalizedRoot
	}
	if listing.Entries == nil {
		listing.Entries = []FileEntry{}
	}
	return listing, nil
}

func (s Service) resolvePath(ctx context.Context, workspaceID string, value string) (WorkspaceRoot, LogicalPath, error) {
	root, err := s.resolve(ctx, workspaceID)
	if err != nil {
		return WorkspaceRoot{}, "", err
	}
	logicalPath, err := NormalizeLogicalPathWithinRoot(value, root.LogicalRoot)
	if err != nil {
		return WorkspaceRoot{}, "", err
	}
	return root, logicalPath, nil
}

func (s Service) resolve(ctx context.Context, workspaceID string) (WorkspaceRoot, error) {
	if s.Resolver == nil {
		return WorkspaceRoot{}, ErrResolverNotConfigured
	}
	if s.Adapter == nil {
		return WorkspaceRoot{}, ErrAdapterNotConfigured
	}
	root, err := s.Resolver.ResolveWorkspaceRoot(ctx, workspaceID)
	if err != nil {
		return WorkspaceRoot{}, err
	}
	root.WorkspaceID = strings.TrimSpace(root.WorkspaceID)
	if root.WorkspaceID == "" {
		root.WorkspaceID = strings.TrimSpace(workspaceID)
	}
	root.LogicalRoot = NormalizeLogicalRoot(root.LogicalRoot).String()
	return root, nil
}

func (s Service) adapter() FileAdapter {
	return s.Adapter
}

func normalizeDirectoryListing(root WorkspaceRoot, requested LogicalPath, listing DirectoryListing) DirectoryListing {
	listing.WorkspaceID = root.WorkspaceID
	listing.Root = NormalizeLogicalRoot(root.LogicalRoot)
	if listing.DirectoryPath == "" {
		listing.DirectoryPath = requested
	}
	if listing.Entries == nil {
		listing.Entries = []FileEntry{}
	}
	return listing
}

func normalizeFileEntry(_ WorkspaceRoot, requested LogicalPath, entry FileEntry) FileEntry {
	if entry.Path == "" {
		entry.Path = requested
	}
	if entry.Name == "" {
		entry.Name = LogicalPathBase(entry.Path)
	}
	return entry
}
