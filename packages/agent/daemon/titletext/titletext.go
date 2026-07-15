// Package titletext owns the host-neutral canonical representation of agent
// session titles.
package titletext

import (
	"strings"
	"unicode/utf8"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

const MaxSessionTitleRunes = 120

// Normalize converts rich-text Markdown links to their human-readable labels
// and collapses whitespace. It intentionally does not apply UI-local labels or
// localization; session titles are shared by the daemon, CLI, Agent, and
// desktop surfaces.
// Normalize converts provider/Tutti rich-text serialization to a plain title.
// Call it only at a rich-text-to-title boundary; persisted canonical titles
// must flow through the rest of the system without being parsed again.
func Normalize(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}

	var output strings.Builder
	for index := 0; index < len(value); {
		labelStart, hrefStart, hrefEnd, ok := markdownLinkAt(value, index)
		if !ok {
			output.WriteByte(value[index])
			index++
			continue
		}
		output.WriteString(unescapeMarkdownLabel(value[labelStart : hrefStart-2]))
		index = hrefEnd + 1
	}
	return strings.Join(strings.Fields(strings.TrimSpace(output.String())), " ")
}

// DeriveInitial converts the first user-visible prompt into the canonical
// title for a session that still has no title. The empty result is a safe
// compare-and-set candidate: an established title is never overwritten.
func DeriveInitial(currentTitle string, visiblePrompt string) string {
	if strings.TrimSpace(currentTitle) != "" {
		return ""
	}
	title := Normalize(visiblePrompt)
	if title == "" {
		return ""
	}
	if utf8.RuneCountInString(title) <= MaxSessionTitleRunes {
		return title
	}
	const suffix = "..."
	runes := []rune(title)
	suffixRunes := utf8.RuneCountInString(suffix)
	return strings.TrimSpace(string(runes[:MaxSessionTitleRunes-suffixRunes])) + suffix
}

// IsLegacyPlaceholder recognizes historical provider/target identity titles.
// This is migration-only compatibility; live submit code must not use it.
func IsLegacyPlaceholder(value string, provider string, targetAliases ...string) bool {
	title := normalizeIdentity(value)
	provider = normalizeIdentity(provider)
	if title == "" || title == provider {
		return true
	}
	for _, candidate := range targetAliases {
		if title == normalizeIdentity(candidate) {
			return true
		}
	}
	descriptor, ok := providerregistry.Find(provider)
	if !ok {
		return false
	}
	for _, candidate := range append(
		[]string{descriptor.Identity.ID, descriptor.Identity.DisplayName},
		descriptor.Identity.Aliases...,
	) {
		if title == normalizeIdentity(candidate) {
			return true
		}
	}
	return false
}

func normalizeIdentity(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func markdownLinkAt(value string, start int) (labelStart, hrefStart, hrefEnd int, ok bool) {
	if start >= len(value) || value[start] != '[' {
		return 0, 0, 0, false
	}
	labelEnd := findUnescaped(value, start+1, ']')
	if labelEnd < 0 || labelEnd+1 >= len(value) || value[labelEnd+1] != '(' {
		return 0, 0, 0, false
	}
	hrefEnd = findBalancedHrefEnd(value, labelEnd+2)
	if hrefEnd < 0 {
		return 0, 0, 0, false
	}
	return start + 1, labelEnd + 2, hrefEnd, true
}

func findUnescaped(value string, start int, target byte) int {
	escaped := false
	for index := start; index < len(value); index++ {
		if escaped {
			escaped = false
			continue
		}
		if value[index] == '\\' {
			escaped = true
			continue
		}
		if value[index] == target {
			return index
		}
	}
	return -1
}

func findBalancedHrefEnd(value string, start int) int {
	depth := 0
	escaped := false
	for index := start; index < len(value); index++ {
		if escaped {
			escaped = false
			continue
		}
		switch value[index] {
		case '\\':
			escaped = true
		case '(':
			depth++
		case ')':
			if depth == 0 {
				return index
			}
			depth--
		}
	}
	return -1
}

func unescapeMarkdownLabel(value string) string {
	var output strings.Builder
	escaped := false
	for index := 0; index < len(value); index++ {
		char := value[index]
		if escaped {
			if strings.ContainsRune(`\\[]()`, rune(char)) {
				output.WriteByte(char)
			} else {
				output.WriteByte('\\')
				output.WriteByte(char)
			}
			escaped = false
			continue
		}
		if char == '\\' {
			escaped = true
			continue
		}
		output.WriteByte(char)
	}
	if escaped {
		output.WriteByte('\\')
	}
	return output.String()
}
