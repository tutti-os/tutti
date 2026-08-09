package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type IssueAttachmentReferenceReader interface {
	HasIssueAttachmentReferencePath(context.Context, string) (bool, error)
}

// IssueAttachmentFiles persists Qute attachment sources below the daemon state
// root. Product validation and ContextRef ownership remain in service/workspace.
type IssueAttachmentFiles struct {
	StateDir string
}

func (s IssueAttachmentFiles) Read(path string) ([]byte, error) {
	if !s.IsManagedPath(path) {
		return nil, errors.New("issue attachment path is not managed")
	}
	clean := filepath.Clean(strings.TrimSpace(path))
	info, err := os.Lstat(clean)
	if err != nil {
		return nil, fmt.Errorf("stat issue attachment: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("issue attachment is not a regular file")
	}
	data, err := os.ReadFile(clean)
	if err != nil {
		return nil, fmt.Errorf("read issue attachment: %w", err)
	}
	return data, nil
}

func (s IssueAttachmentFiles) WriteExclusive(attachmentID string, extension string, data []byte) (string, error) {
	root, err := s.root()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", fmt.Errorf("create issue attachment directory: %w", err)
	}
	path := filepath.Join(root, attachmentID+extension)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", fmt.Errorf("create issue attachment: %w", err)
	}
	published := false
	defer func() {
		if !published {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return "", fmt.Errorf("write issue attachment: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return "", fmt.Errorf("sync issue attachment: %w", err)
	}
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("close issue attachment: %w", err)
	}
	if err := syncIssueAttachmentDirectory(root); err != nil {
		return "", err
	}
	published = true
	return path, nil
}

func (s IssueAttachmentFiles) Remove(path string) error {
	if !s.IsManagedPath(path) {
		return nil
	}
	if err := os.Remove(filepath.Clean(strings.TrimSpace(path))); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove issue attachment: %w", err)
	}
	root, err := s.root()
	if err != nil {
		return err
	}
	return syncIssueAttachmentDirectory(root)
}

// Reconcile removes managed image files that have neither a durable ContextRef
// nor a prepared/leased Run launch snapshot. It runs before the daemon begins
// serving requests, closing the crash window between an exclusive file write
// and the SQLite transaction, and retrying prior cleanup failures.
func (s IssueAttachmentFiles) Reconcile(ctx context.Context, refs IssueAttachmentReferenceReader) error {
	if refs == nil {
		return errors.New("issue attachment reference reader is unavailable")
	}
	root, err := s.root()
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("list issue attachments: %w", err)
	}
	removed := false
	for _, entry := range entries {
		if entry.IsDir() || !isManagedIssueAttachmentName(entry.Name()) {
			continue
		}
		path := filepath.Join(root, entry.Name())
		referenced, err := refs.HasIssueAttachmentReferencePath(ctx, path)
		if err != nil {
			return fmt.Errorf("reconcile issue attachment %q: %w", entry.Name(), err)
		}
		if referenced {
			continue
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove orphan issue attachment %q: %w", entry.Name(), err)
		}
		removed = true
	}
	if removed {
		return syncIssueAttachmentDirectory(root)
	}
	return nil
}

func (s IssueAttachmentFiles) IsManagedPath(path string) bool {
	root, err := s.root()
	if err != nil {
		return false
	}
	clean := filepath.Clean(strings.TrimSpace(path))
	rel, err := filepath.Rel(root, clean)
	return err == nil && rel != "." && rel != ".." && !filepath.IsAbs(rel) && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func (s IssueAttachmentFiles) root() (string, error) {
	stateDir := filepath.Clean(strings.TrimSpace(s.StateDir))
	if stateDir == "" || stateDir == "." || stateDir == string(filepath.Separator) {
		return "", errors.New("issue attachment state directory is not configured")
	}
	root, err := filepath.Abs(filepath.Join(stateDir, "agent-prompt-assets", "issues"))
	if err != nil {
		return "", fmt.Errorf("resolve issue attachment directory: %w", err)
	}
	return root, nil
}

func isManagedIssueAttachmentName(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".webp":
		return true
	default:
		return false
	}
}
