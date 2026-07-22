package managednpm

import (
	"regexp"
	"strconv"
	"strings"
)

var stableVersionPattern = regexp.MustCompile(`^(?:v)?([0-9]+)\.([0-9]+)\.([0-9]+)$`)
var embeddedVersionPattern = regexp.MustCompile(`(?:^|[^0-9A-Za-z.-])(?:v)?([0-9]+)\.([0-9]+)\.([0-9]+)(?:$|[^0-9A-Za-z.-])`)

type stableVersion [3]uint64

type VersionDecision string

const (
	VersionDecisionReady             VersionDecision = "ready"
	VersionDecisionInstallMissing    VersionDecision = "install_missing"
	VersionDecisionInstallUnknown    VersionDecision = "install_unknown"
	VersionDecisionInstallBelowFloor VersionDecision = "install_below_floor"
)

func DecideVersion(installedOutput string, minimumVersion string) VersionDecision {
	if strings.TrimSpace(installedOutput) == "" {
		return VersionDecisionInstallMissing
	}
	installed, ok := extractStableVersion(installedOutput)
	if !ok {
		return VersionDecisionInstallUnknown
	}
	minimum, ok := parseStableVersion(minimumVersion)
	if !ok || compareVersions(installed, minimum) < 0 {
		return VersionDecisionInstallBelowFloor
	}
	return VersionDecisionReady
}

func ExtractVersion(output string) (string, bool) {
	version, ok := extractStableVersion(output)
	if !ok {
		return "", false
	}
	return strconv.FormatUint(version[0], 10) + "." + strconv.FormatUint(version[1], 10) + "." + strconv.FormatUint(version[2], 10), true
}

func parseStableVersion(value string) (stableVersion, bool) {
	matches := stableVersionPattern.FindStringSubmatch(strings.TrimSpace(value))
	return versionFromMatches(matches)
}

func extractStableVersion(value string) (stableVersion, bool) {
	matches := embeddedVersionPattern.FindStringSubmatch(strings.TrimSpace(value))
	return versionFromMatches(matches)
}

func versionFromMatches(matches []string) (stableVersion, bool) {
	if len(matches) != 4 {
		return stableVersion{}, false
	}
	var result stableVersion
	for index := range result {
		part, err := strconv.ParseUint(matches[index+1], 10, 64)
		if err != nil {
			return stableVersion{}, false
		}
		result[index] = part
	}
	return result, true
}

func compareVersions(left stableVersion, right stableVersion) int {
	for index := range left {
		if left[index] < right[index] {
			return -1
		}
		if left[index] > right[index] {
			return 1
		}
	}
	return 0
}
