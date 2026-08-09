package workspace

import (
	"context"
	"errors"
	"io/fs"
	"strings"

	"github.com/google/uuid"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

const (
	maxIssueImageAttachments       = 8
	maxIssueImageBytes       int64 = 20 << 20
)

// IssueAttachmentFiles is the persistence seam used by Issue orchestration.
// The concrete local filesystem adapter belongs to data/workspace.
type IssueAttachmentFiles interface {
	WriteExclusive(attachmentID string, extension string, data []byte) (string, error)
	Read(path string) ([]byte, error)
	Remove(path string) error
	IsManagedPath(path string) bool
}

type IssueManagerAttachmentContent struct {
	ContextRefID string
	MimeType     string
	DisplayName  string
	Data         []byte
}

type IssueManagerContextRefAccessKind string

const (
	IssueManagerContextRefAccessWorkspacePath     IssueManagerContextRefAccessKind = "workspace_path"
	IssueManagerContextRefAccessManagedAttachment IssueManagerContextRefAccessKind = "managed_attachment"
)

// IssueManagerContextRefView is the host-owned public projection of a stored
// ContextRef. Managed attachment paths stay private to tuttid.
type IssueManagerContextRefView struct {
	Ref        workspaceissues.ContextRef
	AccessKind IssueManagerContextRefAccessKind
	Path       *string
}

func (s IssueManagerService) ProjectIssueManagerContextRefs(
	items []workspaceissues.ContextRef,
) []IssueManagerContextRefView {
	views := make([]IssueManagerContextRefView, 0, len(items))
	for _, item := range items {
		path := item.Path
		view := IssueManagerContextRefView{
			Ref:        item,
			AccessKind: IssueManagerContextRefAccessWorkspacePath,
			Path:       &path,
		}
		if s.AttachmentFiles != nil && s.AttachmentFiles.IsManagedPath(item.Path) {
			view.AccessKind = IssueManagerContextRefAccessManagedAttachment
			view.Path = nil
		}
		views = append(views, view)
	}
	return views
}

type issueAttachmentContextRefReader interface {
	GetIssueAttachmentContextRef(context.Context, string, string, string) (workspaceissues.ContextRef, error)
}

func (s IssueManagerService) ReadIssueAttachment(
	ctx context.Context,
	workspaceID, issueID, contextRefID string,
) (IssueManagerAttachmentContent, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	issueID = strings.TrimSpace(issueID)
	contextRefID = strings.TrimSpace(contextRefID)
	if workspaceID == "" || issueID == "" || contextRefID == "" || s.AttachmentFiles == nil {
		return IssueManagerAttachmentContent{}, workspaceissues.ErrInvalidArgument
	}
	reader, ok := s.Store.(issueAttachmentContextRefReader)
	if !ok {
		return IssueManagerAttachmentContent{}, workspaceissues.ErrStoreNotConfigured
	}
	ref, err := reader.GetIssueAttachmentContextRef(ctx, workspaceID, issueID, contextRefID)
	if err != nil {
		return IssueManagerAttachmentContent{}, err
	}
	if !strings.HasPrefix(ref.RefType, "image/") || !s.AttachmentFiles.IsManagedPath(ref.Path) {
		return IssueManagerAttachmentContent{}, workspaceissues.ErrContextRefNotFound
	}
	data, err := s.AttachmentFiles.Read(ref.Path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return IssueManagerAttachmentContent{}, workspaceissues.ErrContextRefNotFound
		}
		return IssueManagerAttachmentContent{}, err
	}
	if int64(len(data)) > maxIssueImageBytes || !matchesIssueImageType(data, ref.RefType) {
		return IssueManagerAttachmentContent{}, workspaceissues.ErrInvalidArgument
	}
	return IssueManagerAttachmentContent{
		ContextRefID: ref.ContextRefID,
		MimeType:     ref.RefType,
		DisplayName:  ref.DisplayName,
		Data:         data,
	}, nil
}

func (s IssueManagerService) persistIssueAttachments(items []CreateIssueManagerImageAttachmentInput) ([]workspaceissues.AddContextRefInput, error) {
	if len(items) > maxIssueImageAttachments || (len(items) > 0 && s.AttachmentFiles == nil) {
		return nil, workspaceissues.ErrInvalidArgument
	}
	refs := make([]workspaceissues.AddContextRefInput, 0, len(items))
	for _, item := range items {
		ref, err := s.persistIssueAttachment(item)
		if err != nil {
			return nil, errors.Join(err, s.removePendingIssueAttachments(refs))
		}
		refs = append(refs, ref)
	}
	return refs, nil
}

func (s IssueManagerService) persistIssueAttachment(item CreateIssueManagerImageAttachmentInput) (workspaceissues.AddContextRefInput, error) {
	attachmentID := strings.TrimSpace(item.AttachmentID)
	if attachmentID == "" {
		attachmentID = uuid.NewString()
	} else if _, err := uuid.Parse(attachmentID); err != nil {
		return workspaceissues.AddContextRefInput{}, workspaceissues.ErrInvalidArgument
	}
	mimeType := strings.TrimSpace(item.MimeType)
	extension, err := issueImageExtension(mimeType)
	if err != nil {
		return workspaceissues.AddContextRefInput{}, err
	}
	if len(item.Data) == 0 || int64(len(item.Data)) > maxIssueImageBytes || !matchesIssueImageType(item.Data, mimeType) {
		return workspaceissues.AddContextRefInput{}, workspaceissues.ErrInvalidArgument
	}
	path, err := s.AttachmentFiles.WriteExclusive(attachmentID, extension, item.Data)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return workspaceissues.AddContextRefInput{}, workspaceissues.ErrInvalidArgument
		}
		return workspaceissues.AddContextRefInput{}, err
	}
	displayName := strings.TrimSpace(item.DisplayName)
	if displayName == "" {
		displayName = "Screenshot" + extension
	}
	return workspaceissues.AddContextRefInput{
		ContextRefID: "attachment-" + attachmentID,
		RefType:      mimeType,
		Path:         path,
		DisplayName:  displayName,
	}, nil
}

func (s IssueManagerService) removePendingIssueAttachments(refs []workspaceissues.AddContextRefInput) error {
	if s.AttachmentFiles == nil {
		return nil
	}
	var cleanupErr error
	for _, ref := range refs {
		if s.AttachmentFiles.IsManagedPath(ref.Path) {
			cleanupErr = errors.Join(cleanupErr, s.AttachmentFiles.Remove(ref.Path))
		}
	}
	return cleanupErr
}

type issueAttachmentReferenceReader interface {
	HasIssueAttachmentReferencePath(context.Context, string) (bool, error)
}

func (s IssueManagerService) removeIssueAttachmentRefs(ctx context.Context, refs []workspaceissues.ContextRef) error {
	if s.AttachmentFiles == nil {
		return nil
	}
	var cleanupErr error
	for _, ref := range refs {
		if !s.AttachmentFiles.IsManagedPath(ref.Path) {
			continue
		}
		if s.AttachmentLaunchPins.IsPinned(ref.Path) {
			continue
		}
		if reader, ok := s.Store.(issueAttachmentReferenceReader); ok {
			referenced, err := reader.HasIssueAttachmentReferencePath(ctx, ref.Path)
			if err != nil {
				cleanupErr = errors.Join(cleanupErr, err)
				continue
			}
			if referenced {
				continue
			}
		}
		cleanupErr = errors.Join(cleanupErr, s.AttachmentFiles.Remove(ref.Path))
	}
	return cleanupErr
}

func (s IssueManagerService) removeIssueRunAttachments(ctx context.Context, attachments []IssueRunImageAttachment) error {
	refs := make([]workspaceissues.ContextRef, 0, len(attachments))
	for _, attachment := range attachments {
		refs = append(refs, workspaceissues.ContextRef{Path: attachment.Path})
	}
	return s.removeIssueAttachmentRefs(ctx, refs)
}

func issueImageExtension(mimeType string) (string, error) {
	switch mimeType {
	case "image/png":
		return ".png", nil
	case "image/jpeg":
		return ".jpg", nil
	case "image/webp":
		return ".webp", nil
	default:
		return "", workspaceissues.ErrInvalidArgument
	}
}

func matchesIssueImageType(data []byte, mimeType string) bool {
	switch mimeType {
	case "image/png":
		return len(data) >= 8 && string(data[:8]) == "\x89PNG\r\n\x1a\n"
	case "image/jpeg":
		return len(data) >= 4 && data[0] == 0xff && data[1] == 0xd8 && data[len(data)-2] == 0xff && data[len(data)-1] == 0xd9
	case "image/webp":
		return len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP"
	default:
		return false
	}
}
