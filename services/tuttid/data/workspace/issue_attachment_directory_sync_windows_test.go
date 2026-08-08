//go:build windows

package workspace

import "testing"

func TestSyncIssueAttachmentDirectoryIsPortableOnWindows(t *testing.T) {
	t.Parallel()
	if err := syncIssueAttachmentDirectory(`C:\path\need-not-exist`); err != nil {
		t.Fatalf("syncIssueAttachmentDirectory() error = %v", err)
	}
}
