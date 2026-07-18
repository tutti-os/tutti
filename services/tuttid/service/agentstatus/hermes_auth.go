package agentstatus

import (
	"regexp"
	"strings"
)

var (
	hermesStatusHeadingPattern = regexp.MustCompile(`(?m)^\s*◆\s+(.+?)\s*$`)
	hermesStatusProviderField  = regexp.MustCompile(`(?m)^\s*Provider:\s+(.+?)\s*$`)
)

// hermesStatusProviderSections are the `hermes status` sections that report a
// provider's readiness, in active-provider lookup order. Hermes can be driven
// by an OAuth provider (Auth Providers), a configured inference provider
// (API-Key Providers), or a raw provider API key (API Keys); the active
// provider named under "◆ Environment" appears in exactly one of them, so the
// readiness signal is section-dependent — reading only Auth Providers marks a
// valid API-key setup as auth_required (and, via the marker-file fallback, a
// stale ~/.hermes/auth.json as ready). Live-probed against hermes-agent 0.18.2.
var hermesStatusProviderSections = []string{"Auth Providers", "API-Key Providers", "API Keys"}

// parseHermesAuthStatusOutput interprets `hermes status` output. Hermes has no
// machine-readable status format (no --json flag), so this reads the
// human-oriented report: the "Provider:" field under "◆ Environment" names the
// currently active inference provider, and that provider's row in one of the
// readiness sections reports login/config state with a ✓ / ✗ glyph (unset,
// unconfigured, and not-logged-in all render ✗). Any format this can't
// confidently resolve returns ok=false, which falls back to the
// ~/.hermes/auth.json marker-file check in resolveAuth — never guesses.
func parseHermesAuthStatusOutput(output []byte) (AuthInfo, bool) {
	plain := string(output)
	provider := hermesStatusActiveProvider(plain)
	if provider == "" {
		return AuthInfo{}, false
	}
	for _, heading := range hermesStatusProviderSections {
		section := hermesStatusSection(plain, heading)
		if section == "" {
			continue
		}
		authenticated, found := hermesProviderReadyInSection(section, provider)
		if !found {
			continue
		}
		if authenticated {
			return AuthInfo{Status: AuthAuthenticated, AccountLabel: provider}, true
		}
		return AuthInfo{Status: AuthRequired}, true
	}
	// Active provider not found in any readiness section (unknown label or
	// format drift): fall back to the marker-file check rather than guess.
	return AuthInfo{}, false
}

func hermesStatusActiveProvider(plain string) string {
	section := hermesStatusSection(plain, "Environment")
	if section == "" {
		section = plain
	}
	match := hermesStatusProviderField.FindStringSubmatch(section)
	if len(match) < 2 {
		return ""
	}
	return strings.TrimSpace(match[1])
}

// hermesProviderReadyInSection finds the active provider's row in a status
// section and reports whether it is ready. found is false when the section has
// no row whose label equals the provider; authenticated is true only when that
// row's status glyph is ✓.
func hermesProviderReadyInSection(section, provider string) (authenticated bool, found bool) {
	for _, line := range strings.Split(section, "\n") {
		glyphIndex := strings.IndexAny(line, "✓✗")
		if glyphIndex < 0 {
			continue
		}
		label := strings.TrimSpace(line[:glyphIndex])
		if label == "" || !strings.EqualFold(label, provider) {
			continue
		}
		return strings.HasPrefix(line[glyphIndex:], "✓"), true
	}
	return false, false
}

// hermesStatusSection returns the body of a "◆ <heading>" block: everything
// between that heading line and the next "◆ " heading (or end of output).
func hermesStatusSection(plain, heading string) string {
	lines := strings.Split(plain, "\n")
	start := -1
	for index, line := range lines {
		match := hermesStatusHeadingPattern.FindStringSubmatch(line)
		if len(match) == 2 && strings.TrimSpace(match[1]) == heading {
			start = index + 1
			break
		}
	}
	if start == -1 {
		return ""
	}
	end := len(lines)
	for index := start; index < len(lines); index++ {
		if hermesStatusHeadingPattern.MatchString(lines[index]) {
			end = index
			break
		}
	}
	return strings.Join(lines[start:end], "\n")
}
