package types

import (
	"strings"

	"golang.org/x/mod/semver"
)

// NormalizeSemver converts a stable or prerelease SemVer to the v-prefixed
// form required by golang.org/x/mod/semver.
func NormalizeSemver(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", false
	}
	normalized := "v" + strings.TrimPrefix(value, "v")
	return normalized, semver.IsValid(normalized)
}
