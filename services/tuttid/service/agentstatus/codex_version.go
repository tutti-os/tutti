package agentstatus

import (
	"strconv"
	"strings"
)

// MinSupportedCodexVersion is the lowest Codex CLI version Tutti supports.
//
// Capability-derived: 0.126.0 is the release that introduced the newest
// app-server method our codex runtime integrates (the thread/goal API); every
// other app-server capability we call landed earlier, and the enrichment ones
// (account/models/rateLimits/collaborationMode/goal) degrade gracefully below
// their version. So 0.126.0 is the floor at which the full app-server feature
// set we wire up is present.
//
// Single tunable hard gate: a detected codex below this floor is flagged as
// too old (surfaced as CODEX_VERSION_TOO_OLD) and the server-side 400 is the
// backstop. Bump this constant when raising the floor; nothing else needs to
// change.
const MinSupportedCodexVersion = "0.126.0"

// compareCodexVersions compares two semver-ish version strings.
//
// It returns -1, 0, or 1 (a<b, a==b, a>b) and ok=true when both parse. A
// leading "v" is tolerated and missing components default to 0. A pre-release
// suffix (after "-") sorts below the same release core. ok is false when either
// version cannot be parsed into a numeric core.
func compareCodexVersions(a, b string) (int, bool) {
	coreA, preA, okA := parseCodexVersion(a)
	coreB, preB, okB := parseCodexVersion(b)
	if !okA || !okB {
		return 0, false
	}
	for i := 0; i < 3; i++ {
		if coreA[i] != coreB[i] {
			if coreA[i] < coreB[i] {
				return -1, true
			}
			return 1, true
		}
	}
	// Equal cores: a pre-release is lower than the release.
	switch {
	case preA && !preB:
		return -1, true
	case !preA && preB:
		return 1, true
	default:
		return 0, true
	}
}

// codexVersionMeetsMinimum reports whether a parseable version satisfies the
// floor. Unknown versions return false and are classified separately by the
// caller so they cannot silently bypass the compatibility check.
func codexVersionMeetsMinimum(version string) bool {
	cmp, ok := compareCodexVersions(version, MinSupportedCodexVersion)
	return ok && cmp >= 0
}

func codexVersionParseable(version string) bool {
	_, _, ok := parseCodexVersion(version)
	return ok
}

// parseCodexVersion returns the [major, minor, patch] core, whether a
// pre-release suffix is present, and ok when the core parsed.
func parseCodexVersion(version string) ([3]int, bool, bool) {
	v := strings.TrimSpace(version)
	v = strings.TrimPrefix(v, "v")
	if v == "" {
		return [3]int{}, false, false
	}
	pre := false
	if idx := strings.IndexAny(v, "-+"); idx >= 0 {
		pre = v[idx] == '-'
		v = v[:idx]
	}
	parts := strings.Split(v, ".")
	if len(parts) == 0 || len(parts) > 3 {
		return [3]int{}, false, false
	}
	var core [3]int
	for i := 0; i < len(parts); i++ {
		n, err := strconv.Atoi(parts[i])
		if err != nil || n < 0 {
			return [3]int{}, false, false
		}
		core[i] = n
	}
	return core, pre, true
}
