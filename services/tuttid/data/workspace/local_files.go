package workspace

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
)

type LocalFilesAdapter struct {
	MaxSearchCandidates int
	IgnoredDirectories  map[string]struct{}
}

func (LocalFilesAdapter) ListDirectory(
	ctx context.Context,
	root workspacefiles.WorkspaceRoot,
	logicalPath workspacefiles.LogicalPath,
	includeHidden bool,
) (workspacefiles.DirectoryListing, error) {
	physicalPath, err := existingPhysicalPath(root, logicalPath)
	if err != nil {
		return workspacefiles.DirectoryListing{}, err
	}

	info, err := os.Stat(physicalPath)
	if err != nil {
		return workspacefiles.DirectoryListing{}, fileError(err, logicalPath)
	}
	if !info.IsDir() {
		return workspacefiles.DirectoryListing{}, fmt.Errorf("%w: %s", workspacefiles.ErrInvalidEntryKind, logicalPath)
	}

	dirEntries, err := os.ReadDir(physicalPath)
	if err != nil {
		return workspacefiles.DirectoryListing{}, fileError(err, logicalPath)
	}

	entries := make([]workspacefiles.FileEntry, 0, len(dirEntries))
	for _, dirEntry := range dirEntries {
		if err := ctx.Err(); err != nil {
			return workspacefiles.DirectoryListing{}, err
		}
		if !includeHidden && strings.HasPrefix(dirEntry.Name(), ".") {
			continue
		}

		childLogicalPath, err := workspacefiles.NormalizeLogicalPathWithinRoot(
			logicalPath.String()+"/"+dirEntry.Name(),
			root.LogicalRoot,
		)
		if err != nil {
			return workspacefiles.DirectoryListing{}, err
		}

		entry, err := localFileEntry(root, childLogicalPath)
		if err != nil {
			if errors.Is(err, workspacefiles.ErrPathEscapesRoot) || errors.Is(err, workspacefiles.ErrEntryNotFound) {
				continue
			}
			return workspacefiles.DirectoryListing{}, err
		}
		entries = append(entries, entry)
	}

	sortFileEntries(entries)
	return workspacefiles.DirectoryListing{
		WorkspaceID:   root.WorkspaceID,
		Root:          workspacefiles.NormalizeLogicalRoot(root.LogicalRoot),
		DirectoryPath: logicalPath,
		Entries:       entries,
	}, nil
}

func (LocalFilesAdapter) ShouldPrefetchDirectory(
	root workspacefiles.WorkspaceRoot,
	logicalPath workspacefiles.LogicalPath,
) bool {
	return !isMacOSProtectedDirectory(root, logicalPath)
}

func (LocalFilesAdapter) CreateFile(
	_ context.Context,
	root workspacefiles.WorkspaceRoot,
	logicalPath workspacefiles.LogicalPath,
) (workspacefiles.FileEntry, error) {
	physicalPath, err := creatablePhysicalPath(root, logicalPath)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}

	file, err := os.OpenFile(physicalPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return workspacefiles.FileEntry{}, fileError(err, logicalPath)
	}
	if err := file.Close(); err != nil {
		return workspacefiles.FileEntry{}, fmt.Errorf("close created workspace file: %w", err)
	}

	return localFileEntry(root, logicalPath)
}

func (LocalFilesAdapter) ReadFile(
	_ context.Context,
	root workspacefiles.WorkspaceRoot,
	logicalPath workspacefiles.LogicalPath,
	maxBytes int64,
) (workspacefiles.FileContent, error) {
	physicalPath, err := existingPhysicalPath(root, logicalPath)
	if err != nil {
		return workspacefiles.FileContent{}, err
	}

	info, err := os.Stat(physicalPath)
	if err != nil {
		return workspacefiles.FileContent{}, fileError(err, logicalPath)
	}
	if info.IsDir() {
		return workspacefiles.FileContent{}, fmt.Errorf("%w: %s", workspacefiles.ErrInvalidEntryKind, logicalPath)
	}
	if maxBytes > 0 && info.Size() > maxBytes {
		return workspacefiles.FileContent{}, fmt.Errorf("%w: %s", workspacefiles.ErrFileTooLarge, logicalPath)
	}

	bytes, err := os.ReadFile(physicalPath)
	if err != nil {
		return workspacefiles.FileContent{}, fileError(err, logicalPath)
	}
	if maxBytes > 0 && int64(len(bytes)) > maxBytes {
		return workspacefiles.FileContent{}, fmt.Errorf("%w: %s", workspacefiles.ErrFileTooLarge, logicalPath)
	}
	return workspacefiles.FileContent{
		Path:      logicalPath,
		Name:      workspacefiles.LogicalPathBase(logicalPath),
		Bytes:     bytes,
		SizeBytes: int64(len(bytes)),
	}, nil
}

func (LocalFilesAdapter) WriteTextFile(
	_ context.Context,
	root workspacefiles.WorkspaceRoot,
	logicalPath workspacefiles.LogicalPath,
	content string,
) (workspacefiles.FileEntry, error) {
	physicalPath, err := existingPhysicalPath(root, logicalPath)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}

	info, err := os.Stat(physicalPath)
	if err != nil {
		return workspacefiles.FileEntry{}, fileError(err, logicalPath)
	}
	if info.IsDir() {
		return workspacefiles.FileEntry{}, fmt.Errorf("%w: %s", workspacefiles.ErrInvalidEntryKind, logicalPath)
	}

	if err := os.WriteFile(physicalPath, []byte(content), 0o644); err != nil {
		return workspacefiles.FileEntry{}, fileError(err, logicalPath)
	}
	return localFileEntry(root, logicalPath)
}

func (LocalFilesAdapter) CreateDirectory(
	_ context.Context,
	root workspacefiles.WorkspaceRoot,
	logicalPath workspacefiles.LogicalPath,
) (workspacefiles.FileEntry, error) {
	physicalPath, err := creatablePhysicalPath(root, logicalPath)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}

	if err := os.Mkdir(physicalPath, 0o755); err != nil {
		return workspacefiles.FileEntry{}, fileError(err, logicalPath)
	}

	return localFileEntry(root, logicalPath)
}

func (LocalFilesAdapter) DeleteEntry(
	_ context.Context,
	root workspacefiles.WorkspaceRoot,
	logicalPath workspacefiles.LogicalPath,
	kind workspacefiles.EntryKind,
) error {
	physicalPath, err := existingPhysicalPath(root, logicalPath)
	if err != nil {
		return err
	}

	info, err := os.Stat(physicalPath)
	if err != nil {
		return fileError(err, logicalPath)
	}
	switch kind {
	case workspacefiles.EntryKindFile:
		if info.IsDir() {
			return fmt.Errorf("%w: %s", workspacefiles.ErrInvalidEntryKind, logicalPath)
		}
	case workspacefiles.EntryKindDirectory:
		if !info.IsDir() {
			return fmt.Errorf("%w: %s", workspacefiles.ErrInvalidEntryKind, logicalPath)
		}
	}

	if err := os.RemoveAll(physicalPath); err != nil {
		return fileError(err, logicalPath)
	}
	return nil
}

func (LocalFilesAdapter) MoveEntry(
	_ context.Context,
	root workspacefiles.WorkspaceRoot,
	logicalPath workspacefiles.LogicalPath,
	targetDirectoryPath workspacefiles.LogicalPath,
) (workspacefiles.FileEntry, error) {
	sourcePhysicalPath, err := existingPhysicalPath(root, logicalPath)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}

	targetDirectoryPhysicalPath, err := existingPhysicalPath(root, targetDirectoryPath)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}
	targetDirectoryInfo, err := os.Stat(targetDirectoryPhysicalPath)
	if err != nil {
		return workspacefiles.FileEntry{}, fileError(err, targetDirectoryPath)
	}
	if !targetDirectoryInfo.IsDir() {
		return workspacefiles.FileEntry{}, fmt.Errorf("%w: %s", workspacefiles.ErrInvalidEntryKind, targetDirectoryPath)
	}

	targetLogicalPath, err := workspacefiles.NormalizeLogicalPathWithinRoot(
		targetDirectoryPath.String()+"/"+workspacefiles.LogicalPathBase(logicalPath),
		root.LogicalRoot,
	)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}
	if targetLogicalPath == logicalPath {
		return localFileEntry(root, logicalPath)
	}
	targetPhysicalPath, err := creatablePhysicalPath(root, targetLogicalPath)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}
	if _, err := os.Stat(targetPhysicalPath); err == nil {
		return workspacefiles.FileEntry{}, fmt.Errorf("%w: %s", workspacefiles.ErrEntryAlreadyExists, targetLogicalPath)
	} else if !errors.Is(err, os.ErrNotExist) {
		return workspacefiles.FileEntry{}, fileError(err, targetLogicalPath)
	}

	if err := os.Rename(sourcePhysicalPath, targetPhysicalPath); err != nil {
		return workspacefiles.FileEntry{}, fileError(err, logicalPath)
	}
	return localFileEntry(root, targetLogicalPath)
}

func (LocalFilesAdapter) RenameEntry(
	_ context.Context,
	root workspacefiles.WorkspaceRoot,
	logicalPath workspacefiles.LogicalPath,
	newName string,
) (workspacefiles.FileEntry, error) {
	sourcePhysicalPath, err := existingPhysicalPath(root, logicalPath)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}

	parentDirectoryPath := workspacefiles.LogicalPathDir(logicalPath)
	targetLogicalPath, err := workspacefiles.NormalizeLogicalPathWithinRoot(
		parentDirectoryPath.String()+"/"+strings.TrimSpace(newName),
		root.LogicalRoot,
	)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}
	if targetLogicalPath == logicalPath {
		return localFileEntry(root, logicalPath)
	}
	targetPhysicalPath, err := creatablePhysicalPath(root, targetLogicalPath)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}
	if _, err := os.Stat(targetPhysicalPath); err == nil {
		return workspacefiles.FileEntry{}, fmt.Errorf("%w: %s", workspacefiles.ErrEntryAlreadyExists, targetLogicalPath)
	} else if !errors.Is(err, os.ErrNotExist) {
		return workspacefiles.FileEntry{}, fileError(err, targetLogicalPath)
	}

	if err := os.Rename(sourcePhysicalPath, targetPhysicalPath); err != nil {
		return workspacefiles.FileEntry{}, fileError(err, logicalPath)
	}
	return localFileEntry(root, targetLogicalPath)
}

func (LocalFilesAdapter) CopyEntry(
	ctx context.Context,
	root workspacefiles.WorkspaceRoot,
	logicalPath workspacefiles.LogicalPath,
) (workspacefiles.FileEntry, error) {
	sourcePhysicalPath, err := existingPhysicalPath(root, logicalPath)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}

	parentDirectoryPath := workspacefiles.LogicalPathDir(logicalPath)
	parentPhysicalPath, err := existingPhysicalPath(root, parentDirectoryPath)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}

	existingNames, err := directoryEntryNames(parentPhysicalPath)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}
	copyName := duplicateEntryName(
		workspacefiles.LogicalPathBase(logicalPath),
		existingNames,
	)
	targetLogicalPath, err := workspacefiles.NormalizeLogicalPathWithinRoot(
		parentDirectoryPath.String()+"/"+copyName,
		root.LogicalRoot,
	)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}
	targetPhysicalPath, err := creatablePhysicalPath(root, targetLogicalPath)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}

	sourceInfo, err := os.Stat(sourcePhysicalPath)
	if err != nil {
		return workspacefiles.FileEntry{}, fileError(err, logicalPath)
	}
	if sourceInfo.IsDir() {
		if err := copyPhysicalDirectory(ctx, sourcePhysicalPath, targetPhysicalPath); err != nil {
			return workspacefiles.FileEntry{}, fileError(err, targetLogicalPath)
		}
	} else if err := copyPhysicalFile(sourcePhysicalPath, targetPhysicalPath, sourceInfo.Mode()); err != nil {
		return workspacefiles.FileEntry{}, fileError(err, targetLogicalPath)
	}

	return localFileEntry(root, targetLogicalPath)
}

func localFileEntry(
	root workspacefiles.WorkspaceRoot,
	logicalPath workspacefiles.LogicalPath,
) (workspacefiles.FileEntry, error) {
	physicalPath, err := existingPhysicalPath(root, logicalPath)
	if err != nil {
		return workspacefiles.FileEntry{}, err
	}
	info, err := os.Stat(physicalPath)
	if err != nil {
		return workspacefiles.FileEntry{}, fileError(err, logicalPath)
	}

	kind := workspacefiles.EntryKindFile
	var sizeBytes *int64
	hasChildren := false
	if info.IsDir() {
		kind = workspacefiles.EntryKindDirectory
		if isMacOSProtectedDirectory(root, logicalPath) {
			hasChildren = true
		} else {
			hasChildren = directoryHasChildren(physicalPath)
		}
	} else if info.Mode().IsRegular() {
		size := info.Size()
		sizeBytes = &size
	} else {
		kind = workspacefiles.EntryKindUnknown
	}

	mtimeMs := info.ModTime().UnixMilli()
	createdTimeMs, lastOpenedMs := localFileTimeMetadata(info)
	return workspacefiles.FileEntry{
		Path:          logicalPath,
		Name:          workspacefiles.LogicalPathBase(logicalPath),
		Kind:          kind,
		HasChildren:   hasChildren,
		SizeBytes:     sizeBytes,
		MtimeMs:       &mtimeMs,
		CreatedTimeMs: createdTimeMs,
		LastOpenedMs:  lastOpenedMs,
	}, nil
}

func existingPhysicalPath(root workspacefiles.WorkspaceRoot, logicalPath workspacefiles.LogicalPath) (string, error) {
	physicalPath, err := workspacefiles.JoinPhysicalPath(root, logicalPath)
	if err != nil {
		return "", err
	}
	if _, err := workspacefiles.EvaluatePhysicalPathWithinRoot(root.PhysicalRoot, physicalPath); err != nil {
		return "", fileError(err, logicalPath)
	}
	return physicalPath, nil
}

func creatablePhysicalPath(root workspacefiles.WorkspaceRoot, logicalPath workspacefiles.LogicalPath) (string, error) {
	physicalPath, err := workspacefiles.JoinPhysicalPath(root, logicalPath)
	if err != nil {
		return "", err
	}

	parent := filepath.Dir(physicalPath)
	if _, err := workspacefiles.EvaluatePhysicalPathWithinRoot(root.PhysicalRoot, parent); err != nil {
		return "", fileError(err, logicalPath)
	}
	return physicalPath, nil
}

func directoryHasChildren(physicalPath string) bool {
	entries, err := os.ReadDir(physicalPath)
	return err == nil && len(entries) > 0
}

func entryKind(mode fs.FileMode) workspacefiles.EntryKind {
	if mode.IsDir() {
		return workspacefiles.EntryKindDirectory
	}
	if mode.IsRegular() {
		return workspacefiles.EntryKindFile
	}
	return workspacefiles.EntryKindUnknown
}

func sortFileEntries(entries []workspacefiles.FileEntry) {
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Kind != entries[j].Kind {
			return entries[i].Kind == workspacefiles.EntryKindDirectory
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
}

func fileError(err error, logicalPath workspacefiles.LogicalPath) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, os.ErrExist) {
		return fmt.Errorf("%w: %s", workspacefiles.ErrEntryAlreadyExists, logicalPath)
	}
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%w: %s", workspacefiles.ErrEntryNotFound, logicalPath)
	}
	if errors.Is(err, workspacefiles.ErrPathEscapesRoot) {
		return err
	}
	return err
}

func directoryEntryNames(physicalDirectoryPath string) (map[string]struct{}, error) {
	dirEntries, err := os.ReadDir(physicalDirectoryPath)
	if err != nil {
		return nil, err
	}
	names := make(map[string]struct{}, len(dirEntries))
	for _, dirEntry := range dirEntries {
		names[dirEntry.Name()] = struct{}{}
	}
	return names, nil
}

func duplicateEntryName(originalName string, existingNames map[string]struct{}) string {
	extension := filepath.Ext(originalName)
	baseName := strings.TrimSuffix(originalName, extension)
	candidate := baseName + " copy" + extension
	if _, exists := existingNames[candidate]; !exists {
		return candidate
	}
	for index := 2; ; index++ {
		candidate = fmt.Sprintf("%s copy %d%s", baseName, index, extension)
		if _, exists := existingNames[candidate]; !exists {
			return candidate
		}
	}
}

func copyPhysicalFile(sourcePhysicalPath, targetPhysicalPath string, mode fs.FileMode) error {
	sourceFile, err := os.Open(sourcePhysicalPath)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	targetFile, err := os.OpenFile(targetPhysicalPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode.Perm())
	if err != nil {
		return err
	}
	defer targetFile.Close()

	if _, err := io.Copy(targetFile, sourceFile); err != nil {
		_ = os.Remove(targetPhysicalPath)
		return err
	}
	return nil
}

func copyPhysicalDirectory(ctx context.Context, sourcePhysicalPath, targetPhysicalPath string) error {
	sourceInfo, err := os.Stat(sourcePhysicalPath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(targetPhysicalPath, sourceInfo.Mode().Perm()); err != nil {
		return err
	}

	return filepath.WalkDir(sourcePhysicalPath, func(walkedPath string, dirEntry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		relativePath, err := filepath.Rel(sourcePhysicalPath, walkedPath)
		if err != nil {
			return err
		}
		if relativePath == "." {
			return nil
		}

		targetPath := filepath.Join(targetPhysicalPath, relativePath)
		if dirEntry.IsDir() {
			info, err := dirEntry.Info()
			if err != nil {
				return err
			}
			return os.MkdirAll(targetPath, info.Mode().Perm())
		}

		info, err := dirEntry.Info()
		if err != nil {
			return err
		}
		return copyPhysicalFile(walkedPath, targetPath, info.Mode())
	})
}
