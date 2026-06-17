package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
)

const defaultWorkspaceFileSearchBudget = 1500 * time.Millisecond

type FileService struct {
	Adapter workspacefiles.FileAdapter
}

func (s FileService) ListDirectory(
	ctx context.Context,
	workspaceID string,
	input workspacefiles.DirectoryListInput,
) (workspacefiles.DirectoryListing, error) {
	return s.domainService().ListDirectory(ctx, workspaceID, input)
}

func (s FileService) ListRecent(
	ctx context.Context,
	workspaceID string,
	input workspacefiles.RecentListInput,
) (workspacefiles.DirectoryListing, error) {
	return s.domainService().ListRecent(ctx, workspaceID, input)
}

func (s FileService) GetDirectoryTreeSnapshot(
	ctx context.Context,
	workspaceID string,
	input workspacefiles.DirectoryTreeSnapshotInput,
) (workspacefiles.DirectoryTreeSnapshot, error) {
	return s.domainService().GetDirectoryTreeSnapshot(ctx, workspaceID, input)
}

func (s FileService) CreateFile(
	ctx context.Context,
	workspaceID string,
	path string,
) (workspacefiles.FileEntry, error) {
	return s.domainService().CreateFile(ctx, workspaceID, path)
}

func (s FileService) ReadFile(
	ctx context.Context,
	workspaceID string,
	path string,
	maxBytes int64,
) (workspacefiles.FileContent, error) {
	return s.domainService().ReadFile(ctx, workspaceID, path, maxBytes)
}

func (s FileService) WriteTextFile(
	ctx context.Context,
	workspaceID string,
	path string,
	content string,
) (workspacefiles.FileEntry, error) {
	return s.domainService().WriteTextFile(ctx, workspaceID, path, content)
}

func (s FileService) CreateDirectory(
	ctx context.Context,
	workspaceID string,
	path string,
) (workspacefiles.FileEntry, error) {
	return s.domainService().CreateDirectory(ctx, workspaceID, path)
}

func (s FileService) DeleteEntry(
	ctx context.Context,
	workspaceID string,
	path string,
	kind workspacefiles.EntryKind,
) error {
	return s.domainService().DeleteEntry(ctx, workspaceID, path, kind)
}

func (s FileService) MoveEntry(
	ctx context.Context,
	workspaceID string,
	path string,
	targetDirectoryPath string,
) (workspacefiles.FileEntry, error) {
	return s.domainService().MoveEntry(ctx, workspaceID, path, targetDirectoryPath)
}

func (s FileService) RenameEntry(
	ctx context.Context,
	workspaceID string,
	path string,
	newName string,
) (workspacefiles.FileEntry, error) {
	return s.domainService().RenameEntry(ctx, workspaceID, path, newName)
}

func (s FileService) CopyEntry(
	ctx context.Context,
	workspaceID string,
	path string,
) (workspacefiles.FileEntry, error) {
	return s.domainService().CopyEntry(ctx, workspaceID, path)
}

func (s FileService) UploadFiles(
	ctx context.Context,
	workspaceID string,
	input workspacefiles.UploadInput,
) (workspacefiles.UploadResult, error) {
	return s.domainService().UploadFiles(ctx, workspaceID, input)
}

func (s FileService) PreflightUploadFiles(
	ctx context.Context,
	workspaceID string,
	input workspacefiles.PreflightUploadInput,
) (workspacefiles.PreflightUploadResult, error) {
	return s.domainService().PreflightUploadFiles(ctx, workspaceID, input)
}

func (s FileService) Search(
	ctx context.Context,
	workspaceID string,
	input workspacefiles.SearchInput,
) (workspacefiles.SearchResult, error) {
	if input.Deadline.IsZero() {
		deadline := time.Now().Add(defaultWorkspaceFileSearchBudget)
		if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
			deadline = contextDeadline
		}
		input.Deadline = deadline
	}
	return s.domainService().Search(ctx, workspaceID, input)
}

func (FileService) ResolveWorkspaceRoot(
	ctx context.Context,
	workspaceID string,
) (workspacefiles.WorkspaceRoot, error) {
	_ = ctx
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return workspacefiles.WorkspaceRoot{}, errors.New("workspace id is required")
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		return workspacefiles.WorkspaceRoot{}, err
	}
	if strings.TrimSpace(homeDir) == "" {
		return workspacefiles.WorkspaceRoot{}, errors.New("user home directory is unavailable")
	}

	physicalRoot := filepath.Clean(homeDir)
	return workspacefiles.WorkspaceRoot{
		WorkspaceID:  workspaceID,
		LogicalRoot:  physicalRoot,
		PhysicalRoot: physicalRoot,
	}, nil
}

func (s FileService) domainService() workspacefiles.Service {
	return workspacefiles.Service{
		Resolver: s,
		Adapter:  s.Adapter,
	}
}
