//go:build !windows

package agentstatus

func materializeCodexWindowsAppsLauncher(path string) string {
	return path
}
