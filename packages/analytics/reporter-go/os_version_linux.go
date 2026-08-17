//go:build linux

package reporter

import "os"

func currentOSVersion() string {
	for _, path := range []string{"/etc/os-release", "/usr/lib/os-release"} {
		content, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if version := osReleaseVersion(string(content)); version != "" {
			return version
		}
	}
	return ""
}
