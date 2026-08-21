//go:build windows

package workspace

// Windows does not provide portable directory fsync through os.File. The
// revision file itself is synced before publication.
func syncWorkflowRevisionDirectory(string) error {
	return nil
}
