//go:build !darwin && !windows

package workspace

func newPlatformLocalFileSearchProvider() localFileSearchProvider {
	return nil
}
