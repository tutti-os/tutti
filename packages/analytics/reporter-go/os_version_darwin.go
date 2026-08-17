//go:build darwin

package reporter

import (
	"strings"

	"golang.org/x/sys/unix"
)

func currentOSVersion() string {
	version, err := unix.Sysctl("kern.osproductversion")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(version)
}
