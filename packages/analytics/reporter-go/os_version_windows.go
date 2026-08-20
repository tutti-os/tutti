//go:build windows

package reporter

import (
	"fmt"

	"golang.org/x/sys/windows"
)

func currentOSVersion() string {
	version := windows.RtlGetVersion()
	if version == nil {
		return ""
	}
	return fmt.Sprintf("%d.%d.%d", version.MajorVersion, version.MinorVersion, version.BuildNumber)
}
