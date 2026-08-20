//go:build !windows

package runtimeprep

func extensionRuntimePlatformSourceHome(string) string {
	return ""
}
