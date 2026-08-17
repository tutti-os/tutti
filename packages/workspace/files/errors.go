package workspacefiles

import "errors"

var (
	ErrAdapterNotConfigured  = errors.New("workspace file adapter is not configured")
	ErrEntryAlreadyExists    = errors.New("workspace file entry already exists")
	ErrEntryNotFound         = errors.New("workspace file entry not found")
	ErrInvalidEntryKind      = errors.New("workspace file entry kind is invalid")
	ErrInvalidPath           = errors.New("workspace file path is invalid")
	ErrFileTooLarge          = errors.New("workspace file is too large")
	ErrInvalidUploadSource   = errors.New("workspace file upload source is invalid")
	ErrPathEscapesRoot       = errors.New("workspace file path escapes root")
	ErrResolverNotConfigured = errors.New("workspace resolver is not configured")
	ErrRootDeleteForbidden   = errors.New("workspace root cannot be deleted")
	ErrSearchUnavailable     = errors.New("workspace file search is unavailable")
	ErrWorkspaceNotFound     = errors.New("workspace not found")
)
