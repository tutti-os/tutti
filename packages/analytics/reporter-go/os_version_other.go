//go:build !darwin && !linux && !windows

package reporter

func currentOSVersion() string {
	return ""
}
