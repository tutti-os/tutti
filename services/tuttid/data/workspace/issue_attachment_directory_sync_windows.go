//go:build windows

package workspace

// Windows does not provide portable directory fsync through os.File. The
// attachment file itself is already synced before publication.
func syncIssueAttachmentDirectory(string) error {
	return nil
}
