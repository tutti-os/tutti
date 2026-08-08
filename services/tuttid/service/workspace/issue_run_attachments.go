package workspace

import (
	"context"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

// issueRunImageAttachments projects managed Issue and task ContextRefs into
// provider-neutral launch data. Issue-level screenshots are inherited by every
// task; task-scoped images are appended for that task only.
func (s IssueManagerService) issueRunImageAttachments(
	ctx context.Context,
	issue workspaceissues.Issue,
	task workspaceissues.Task,
) ([]IssueRunImageAttachment, error) {
	if s.Store == nil {
		return nil, workspaceissues.ErrInvalidArgument
	}
	refs, err := s.Store.ListContextRefs(ctx, issue.WorkspaceID, issue.IssueID, "", workspaceissues.ContextRefParentIssue)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(task.TaskID) != "" {
		taskRefs, err := s.Store.ListContextRefs(ctx, issue.WorkspaceID, issue.IssueID, task.TaskID, workspaceissues.ContextRefParentTask)
		if err != nil {
			return nil, err
		}
		refs = append(refs, taskRefs...)
	}
	attachments := make([]IssueRunImageAttachment, 0, len(refs))
	for _, ref := range refs {
		mimeType := strings.TrimSpace(ref.RefType)
		if s.AttachmentFiles == nil || !supportedIssueRunImageMimeType(mimeType) || !s.AttachmentFiles.IsManagedPath(ref.Path) {
			continue
		}
		attachments = append(attachments, IssueRunImageAttachment{
			MimeType: mimeType,
			Name:     strings.TrimSpace(ref.DisplayName),
			Path:     strings.TrimSpace(ref.Path),
		})
	}
	return attachments, nil
}

func supportedIssueRunImageMimeType(value string) bool {
	switch value {
	case "image/png", "image/jpeg", "image/webp":
		return true
	default:
		return false
	}
}
