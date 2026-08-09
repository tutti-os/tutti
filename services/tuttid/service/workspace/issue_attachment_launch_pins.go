package workspace

import (
	"context"
	"strings"
	"sync"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

// IssueAttachmentLaunchPins keeps managed source images alive between a Run's
// durable claim and the synchronous Agent adapter copy. Explicit launches also
// have durable intent pins; this transient fence covers automatic launches.
type IssueAttachmentLaunchPins struct {
	mu   sync.Mutex
	refs map[string]int
}

func NewIssueAttachmentLaunchPins() *IssueAttachmentLaunchPins {
	return &IssueAttachmentLaunchPins{refs: make(map[string]int)}
}

func (pins *IssueAttachmentLaunchPins) Pin(attachments []IssueRunImageAttachment) {
	if pins == nil {
		return
	}
	pins.mu.Lock()
	defer pins.mu.Unlock()
	if pins.refs == nil {
		pins.refs = make(map[string]int)
	}
	for path := range uniqueIssueRunAttachmentPaths(attachments) {
		pins.refs[path]++
	}
}

func (pins *IssueAttachmentLaunchPins) Release(attachments []IssueRunImageAttachment) {
	if pins == nil {
		return
	}
	pins.mu.Lock()
	defer pins.mu.Unlock()
	for path := range uniqueIssueRunAttachmentPaths(attachments) {
		if pins.refs[path] <= 1 {
			delete(pins.refs, path)
			continue
		}
		pins.refs[path]--
	}
}

func (pins *IssueAttachmentLaunchPins) IsPinned(path string) bool {
	if pins == nil {
		return false
	}
	pins.mu.Lock()
	defer pins.mu.Unlock()
	return pins.refs[strings.TrimSpace(path)] > 0
}

func uniqueIssueRunAttachmentPaths(attachments []IssueRunImageAttachment) map[string]struct{} {
	paths := make(map[string]struct{}, len(attachments))
	for _, attachment := range attachments {
		if path := strings.TrimSpace(attachment.Path); path != "" {
			paths[path] = struct{}{}
		}
	}
	return paths
}

func (s IssueManagerService) pinIssueRunAttachments(attachments []IssueRunImageAttachment) error {
	if len(attachments) == 0 {
		return nil
	}
	if s.AttachmentLaunchPins == nil {
		return workspaceissues.ErrStoreNotConfigured
	}
	s.AttachmentLaunchPins.Pin(attachments)
	return nil
}

func (s IssueManagerService) releaseIssueRunAttachmentPins(
	ctx context.Context,
	workspaceID string,
	attachments []IssueRunImageAttachment,
) {
	if len(attachments) == 0 || s.AttachmentLaunchPins == nil {
		return
	}
	s.AttachmentLaunchPins.Release(attachments)
	if err := s.removeIssueRunAttachments(ctx, attachments); err != nil {
		s.enqueueWorkspaceRunReconcile(workspaceID)
	}
}
