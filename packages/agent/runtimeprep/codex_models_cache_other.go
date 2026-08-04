//go:build !windows

package runtimeprep

func initializeCodexModelsCacheForWindows(_, _ string) error {
	return nil
}
